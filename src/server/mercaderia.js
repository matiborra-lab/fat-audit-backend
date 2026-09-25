/**
 * ============================================================
 * MERCADERIA FAT - pedidos de las sucursales a la marca
 * ============================================================
 * Tres conceptos siempre separados:
 *  1) estado operativo del pedido (merc_pedidos.estado) - solo lo cambia
 *     Personal de Marca, y cada cambio queda en merc_pedido_movimientos;
 *  2) estado financiero - derivado del saldo (PENDIENTE_COBRO si total >
 *     abonado, ABONADO si no). Una sucursal solo tiene deuda desde que el
 *     pedido está RETIRADO: antes (o si se cancela) el saldo pendiente es 0,
 *     el pedido no se puede cobrar y no entra en los totales de deuda;
 *  3) el saldo (total - abonado) - se mueve UNICAMENTE al registrar un pago
 *     (POST /api/merc/pagos); no existe ninguna acción "marcar como pagado".
 *
 * Permisos (validados acá, no solo en el frontend):
 *  - Gerente: crea pedidos y ve/abre SOLO los de su sucursal.
 *  - Personal de Marca (usuarios.personal_marca, lo asigna un Admin): ve todo,
 *    cambia estados, cobra, administra el catálogo y descarga reportes.
 * Todo el dinero se calcula en centavos enteros (nunca con floats).
 */

const db = require('../db');
const { urlDeSubida } = require('../storage');
const { crearNotificaciones, crearNotificacion } = require('./notificaciones');
const { generarPdfSaldos, generarPdfDocumentos } = require('../pdf/mercaderia');

const ESTADOS = ['PENDIENTE_CONFIRMAR', 'CONFIRMADO', 'LISTO_RETIRAR', 'RETIRADO', 'CANCELADO'];
const ETIQUETA_ESTADO = {
  PENDIENTE_CONFIRMAR: 'Pendiente de confirmar', CONFIRMADO: 'Confirmado', LISTO_RETIRAR: 'Listo para retirar', RETIRADO: 'Retirado', CANCELADO: 'Cancelado',
};

const esMarca = (u) => u.personal_marca === true;
const puedePedir = (u) => u.rol === 'GERENTE' || esMarca(u);

function requireMarca(req, res, next) {
  if (!esMarca(req.usuario)) return res.status(403).json({ error: 'Esta acción es solo para Personal de Marca' });
  next();
}
function requirePedir(req, res, next) {
  if (!puedePedir(req.usuario)) return res.status(403).json({ error: 'No tenés acceso a Mercadería FAT' });
  next();
}

const aCentavos = (n) => Math.round(Number(n) * 100);
const deCentavos = (c) => (c / 100).toFixed(2);
const numeroPedido = (id) => '#' + String(id).padStart(5, '0');
function pesos(n) {
  return '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

async function auditar(cliente, accion, entidad, entidadId, usuarioId, detalle) {
  await cliente.query(
    'INSERT INTO merc_auditoria (accion, entidad, entidad_id, usuario_id, detalle) VALUES ($1,$2,$3,$4,$5)',
    [accion, entidad, entidadId, usuarioId, detalle ? JSON.stringify(detalle) : null]
  );
}

const SELECT_PEDIDO = `
  SELECT p.id, p.sucursal_id, s.nombre AS sucursal_nombre, p.usuario_id,
         ${db.nombreCompletoSql('u')} AS responsable_nombre,
         p.creado_en, p.total::float8 AS total, p.abonado::float8 AS abonado,
         -- la deuda existe SOLO desde que el pedido fue retirado: antes (o si se canceló) el saldo pendiente es 0
         (CASE WHEN p.estado = 'RETIRADO' THEN p.total - p.abonado ELSE 0 END)::float8 AS saldo,
         p.estado,
         CASE WHEN p.estado <> 'RETIRADO' THEN 'NO_APLICA' WHEN p.total > p.abonado THEN 'PENDIENTE_COBRO' ELSE 'ABONADO' END AS estado_cobro,
         EXISTS (SELECT 1 FROM merc_pedido_ediciones e WHERE e.pedido_id = p.id) AS editado,
         p.retirado_en,
         CASE WHEN p.retirado_en IS NOT NULL THEN (now()::date - p.retirado_en::date) END AS dias_demora
  FROM merc_pedidos p
  JOIN sucursales s ON s.id = p.sucursal_id
  JOIN usuarios u ON u.id = p.usuario_id`;

// Filtros compartidos por el historial, Gestión de pagos y los reportes.
// Un Gerente (sin Personal de Marca) queda SIEMPRE limitado a su sucursal,
// sin importar lo que mande en la query.
function armarFiltros(usuario, q) {
  const cond = [];
  const params = [];
  const agregar = (sql, valor) => { params.push(valor); cond.push(sql.replace('?', '$' + params.length)); };
  if (!esMarca(usuario)) agregar('p.sucursal_id = ?', usuario.sucursal_id);
  else if (q.sucursal_id) agregar('p.sucursal_id = ?', Number(q.sucursal_id));
  if (q.estado) agregar('p.estado = ?', q.estado);
  if (q.cobro === 'PENDIENTE_COBRO') cond.push("p.estado = 'RETIRADO' AND p.total > p.abonado");
  if (q.cobro === 'ABONADO') cond.push("p.estado = 'RETIRADO' AND p.total <= p.abonado");
  if (q.con_saldo === '1') cond.push("p.estado = 'RETIRADO' AND p.total > p.abonado");
  if (q.usuario_id) agregar('p.usuario_id = ?', Number(q.usuario_id));
  if (q.desde) agregar('p.creado_en >= ?::date', q.desde);
  if (q.hasta) agregar("p.creado_en < (?::date + 1)", q.hasta);
  return { where: cond.length ? 'WHERE ' + cond.join(' AND ') : '', params };
}

module.exports = function registrarRutasMercaderia(app) {
  // ------------------------------------------------------------
  // Catálogo
  // ------------------------------------------------------------

  // Los productos activos los ve quien puede pedir (para armar el pedido);
  // con ?todos=1 (solo Personal de Marca) vienen también los deshabilitados.
  app.get('/api/merc/productos', requirePedir, async (req, res) => {
    const todos = req.query.todos === '1';
    if (todos && !esMarca(req.usuario)) return res.status(403).json({ error: 'Esta acción es solo para Personal de Marca' });
    try {
      const { rows } = await db.query(
        `SELECT p.id, p.nombre, p.descripcion, p.imagen_url, p.precio::float8 AS precio, p.activo, p.actualizado_en,
                p.categoria_id, c.nombre AS categoria_nombre
         FROM merc_productos p LEFT JOIN merc_categorias c ON c.id = p.categoria_id
         ${todos ? '' : 'WHERE p.activo = true'}
         ORDER BY c.orden NULLS LAST, c.id NULLS LAST, p.orden, p.nombre`
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/merc/imagen/url-subida', requireMarca, async (req, res) => {
    try {
      res.json(await urlDeSubida({ contentType: req.body.content_type, runId: 'catalogo', carpeta: 'mercaderia' }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/merc/productos', requireMarca, async (req, res) => {
    const { nombre, descripcion, imagen_url, precio, categoria_id } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ error: 'Falta el nombre del producto' });
    if (precio === undefined || precio === '' || !(Number(precio) >= 0)) return res.status(400).json({ error: 'El precio no es válido' });
    const cliente = await db.pool.connect();
    try {
      await cliente.query('BEGIN');
      const catId = categoria_id ? Number(categoria_id) : null;
      if (catId && !(await cliente.query('SELECT 1 FROM merc_categorias WHERE id = $1', [catId])).rows[0]) {
        await cliente.query('ROLLBACK');
        return res.status(400).json({ error: 'La categoría no existe' });
      }
      // Va al final de su categoría.
      const { rows: [ord] } = await cliente.query('SELECT COALESCE(MAX(orden), -1) + 1 AS siguiente FROM merc_productos WHERE categoria_id IS NOT DISTINCT FROM $1', [catId]);
      const { rows } = await cliente.query(
        `INSERT INTO merc_productos (nombre, descripcion, imagen_url, precio, creado_por, categoria_id, orden) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, nombre, descripcion, imagen_url, precio::float8 AS precio, activo, categoria_id`,
        [nombre.trim(), descripcion?.trim() || null, imagen_url || null, deCentavos(aCentavos(precio)), req.usuario.usuarioId, catId, ord.siguiente]
      );
      await auditar(cliente, 'PRODUCTO_CREADO', 'producto', rows[0].id, req.usuario.usuarioId, { nombre: rows[0].nombre, precio: rows[0].precio });
      await cliente.query('COMMIT');
      res.status(201).json(rows[0]);
    } catch (err) {
      await cliente.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      cliente.release();
    }
  });

  // Editar datos, cambiar el precio rápido o (des)habilitar - nunca se borra
  // un producto (los pedidos históricos lo siguen referenciando).
  app.patch('/api/merc/productos/:id', requireMarca, async (req, res) => {
    const { nombre, descripcion, imagen_url, precio, activo, categoria_id } = req.body;
    if (nombre !== undefined && !String(nombre).trim()) return res.status(400).json({ error: 'El nombre no puede quedar vacío' });
    if (precio !== undefined && !(Number(precio) >= 0 && precio !== '')) return res.status(400).json({ error: 'El precio no es válido' });
    if (activo !== undefined && typeof activo !== 'boolean') return res.status(400).json({ error: 'activo tiene que ser true o false' });
    const cliente = await db.pool.connect();
    try {
      await cliente.query('BEGIN');
      const { rows: actual } = await cliente.query('SELECT * FROM merc_productos WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!actual[0]) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'Producto no encontrado' }); }
      const p = actual[0];
      const precioNuevo = precio !== undefined ? deCentavos(aCentavos(precio)) : p.precio;
      let catNueva = p.categoria_id;
      let ordenNuevo = p.orden;
      if (categoria_id !== undefined) {
        catNueva = categoria_id ? Number(categoria_id) : null;
        if (catNueva && !(await cliente.query('SELECT 1 FROM merc_categorias WHERE id = $1', [catNueva])).rows[0]) {
          await cliente.query('ROLLBACK');
          return res.status(400).json({ error: 'La categoría no existe' });
        }
        if (catNueva !== p.categoria_id) {
          // Cambia de categoría: queda al final de la nueva.
          const { rows: [ord] } = await cliente.query('SELECT COALESCE(MAX(orden), -1) + 1 AS siguiente FROM merc_productos WHERE categoria_id IS NOT DISTINCT FROM $1', [catNueva]);
          ordenNuevo = ord.siguiente;
        }
      }
      const { rows } = await cliente.query(
        `UPDATE merc_productos SET nombre = $1, descripcion = $2, imagen_url = $3, precio = $4, activo = $5, categoria_id = $7, orden = $8, actualizado_en = now()
         WHERE id = $6 RETURNING id, nombre, descripcion, imagen_url, precio::float8 AS precio, activo, categoria_id`,
        [
          nombre !== undefined ? String(nombre).trim() : p.nombre,
          descripcion !== undefined ? (descripcion?.trim() || null) : p.descripcion,
          imagen_url !== undefined ? (imagen_url || null) : p.imagen_url,
          precioNuevo, activo !== undefined ? activo : p.activo, req.params.id, catNueva, ordenNuevo,
        ]
      );
      if (aCentavos(precioNuevo) !== aCentavos(p.precio)) {
        await auditar(cliente, 'PRECIO_CAMBIADO', 'producto', p.id, req.usuario.usuarioId, { nombre: p.nombre, anterior: Number(p.precio), nuevo: Number(precioNuevo) });
      }
      if (activo !== undefined && activo !== p.activo) {
        await auditar(cliente, activo ? 'PRODUCTO_HABILITADO' : 'PRODUCTO_DESHABILITADO', 'producto', p.id, req.usuario.usuarioId, { nombre: p.nombre });
      }
      if ((nombre !== undefined && String(nombre).trim() !== p.nombre) || descripcion !== undefined || imagen_url !== undefined) {
        await auditar(cliente, 'PRODUCTO_EDITADO', 'producto', p.id, req.usuario.usuarioId, { nombre: p.nombre });
      }
      await cliente.query('COMMIT');
      res.json(rows[0]);
    } catch (err) {
      await cliente.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      cliente.release();
    }
  });

  // Mueve una fila una posición dentro de su lista ordenada. Se renumera la
  // lista completa (0..n-1) para que un orden repetido o con huecos no
  // impida el intercambio.
  async function moverEnLista(cliente, tabla, whereSql, params, id, direccion) {
    const { rows } = await cliente.query(`SELECT id FROM ${tabla} ${whereSql} ORDER BY orden, id`, params);
    const ids = rows.map((r) => r.id);
    const i = ids.indexOf(Number(id));
    if (i < 0) return false;
    const j = direccion === 'arriba' ? i - 1 : i + 1;
    if (j >= 0 && j < ids.length) {
      [ids[i], ids[j]] = [ids[j], ids[i]];
      for (let k = 0; k < ids.length; k++) await cliente.query(`UPDATE ${tabla} SET orden = $1 WHERE id = $2`, [k, ids[k]]);
    }
    return true;
  }

  app.get('/api/merc/categorias', requirePedir, async (req, res) => {
    try {
      const { rows } = await db.query('SELECT id, nombre, orden FROM merc_categorias ORDER BY orden, id');
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/merc/categorias', requireMarca, async (req, res) => {
    const nombre = req.body.nombre?.trim();
    if (!nombre) return res.status(400).json({ error: 'Falta el nombre de la categoría' });
    try {
      const { rows } = await db.query(
        'INSERT INTO merc_categorias (nombre, orden) VALUES ($1, (SELECT COALESCE(MAX(orden), -1) + 1 FROM merc_categorias)) RETURNING id, nombre, orden', [nombre]
      );
      await auditar(db, 'CATEGORIA_CREADA', 'categoria', rows[0].id, req.usuario.usuarioId, { nombre });
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/merc/categorias/:id', requireMarca, async (req, res) => {
    const nombre = req.body.nombre?.trim();
    if (!nombre) return res.status(400).json({ error: 'Falta el nombre de la categoría' });
    try {
      const { rows } = await db.query('UPDATE merc_categorias SET nombre = $1 WHERE id = $2 RETURNING id, nombre, orden', [nombre, req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
      await auditar(db, 'CATEGORIA_RENOMBRADA', 'categoria', rows[0].id, req.usuario.usuarioId, { nombre });
      res.json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Solo se elimina una categoría vacía (ningún producto, ni deshabilitado):
  // los productos no se pierden ni quedan huérfanos.
  app.delete('/api/merc/categorias/:id', requireMarca, async (req, res) => {
    try {
      const { rows: [uso] } = await db.query('SELECT COUNT(*)::int AS n FROM merc_productos WHERE categoria_id = $1', [req.params.id]);
      if (uso.n > 0) return res.status(400).json({ error: 'La categoría todavía tiene productos - movelos a otra categoría antes de eliminarla' });
      const { rows } = await db.query('DELETE FROM merc_categorias WHERE id = $1 RETURNING id, nombre', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
      await auditar(db, 'CATEGORIA_ELIMINADA', 'categoria', rows[0].id, req.usuario.usuarioId, { nombre: rows[0].nombre });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Body: { direccion: 'arriba' | 'abajo' } (flechas del catálogo)
  app.post('/api/merc/categorias/:id/mover', requireMarca, async (req, res) => {
    if (!['arriba', 'abajo'].includes(req.body.direccion)) return res.status(400).json({ error: 'Dirección inválida' });
    const cliente = await db.pool.connect();
    try {
      await cliente.query('BEGIN');
      const ok = await moverEnLista(cliente, 'merc_categorias', '', [], req.params.id, req.body.direccion);
      await cliente.query(ok ? 'COMMIT' : 'ROLLBACK');
      res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'Categoría no encontrada' });
    } catch (err) {
      await cliente.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      cliente.release();
    }
  });

  // Mueve un producto dentro de su categoría (entre los habilitados).
  app.post('/api/merc/productos/:id/mover', requireMarca, async (req, res) => {
    if (!['arriba', 'abajo'].includes(req.body.direccion)) return res.status(400).json({ error: 'Dirección inválida' });
    const cliente = await db.pool.connect();
    try {
      await cliente.query('BEGIN');
      const { rows: [p] } = await cliente.query('SELECT categoria_id FROM merc_productos WHERE id = $1', [req.params.id]);
      if (!p) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'Producto no encontrado' }); }
      await moverEnLista(cliente, 'merc_productos', 'WHERE activo = true AND categoria_id IS NOT DISTINCT FROM $1', [p.categoria_id], req.params.id, req.body.direccion);
      await cliente.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await cliente.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      cliente.release();
    }
  });

  // ------------------------------------------------------------
  // Pedidos
  // ------------------------------------------------------------

  // Body: { sucursal_id? (solo Personal de Marca), items: [{ producto_id, cantidad }] }
  app.post('/api/merc/pedidos', requirePedir, async (req, res) => {
    const usuario = req.usuario;
    // Un Gerente pide siempre para SU sucursal (se ignora lo que mande el
    // body); Personal de Marca puede elegir sucursal.
    const sucursalId = esMarca(usuario) && req.body.sucursal_id ? Number(req.body.sucursal_id) : usuario.sucursal_id;
    if (!sucursalId) return res.status(400).json({ error: 'Elegí la sucursal del pedido' });
    const solicitados = new Map();
    for (const it of Array.isArray(req.body.items) ? req.body.items : []) {
      const cantidad = Number(it.cantidad);
      if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 9999) return res.status(400).json({ error: 'Hay una cantidad inválida en el pedido' });
      solicitados.set(Number(it.producto_id), (solicitados.get(Number(it.producto_id)) || 0) + cantidad);
    }
    if (!solicitados.size) return res.status(400).json({ error: 'El pedido está vacío' });

    const cliente = await db.pool.connect();
    let pedido;
    let sucursalNombre;
    try {
      await cliente.query('BEGIN');
      const { rows: suc } = await cliente.query('SELECT nombre FROM sucursales WHERE id = $1 AND activo = true', [sucursalId]);
      if (!suc[0]) { await cliente.query('ROLLBACK'); return res.status(400).json({ error: 'La sucursal no existe' }); }
      sucursalNombre = suc[0].nombre;

      // Se toma el precio vigente AHORA y se guarda en el pedido (precio
      // histórico): cambios posteriores del catálogo no lo tocan.
      const { rows: productos } = await cliente.query(
        'SELECT id, nombre, descripcion, imagen_url, precio FROM merc_productos WHERE id = ANY($1) AND activo = true', [[...solicitados.keys()]]
      );
      if (productos.length !== solicitados.size) {
        await cliente.query('ROLLBACK');
        return res.status(400).json({ error: 'Algún producto ya no está disponible - actualizá el catálogo y revisá el pedido' });
      }
      const totalCentavos = productos.reduce((s, p) => s + aCentavos(p.precio) * solicitados.get(p.id), 0);

      const { rows } = await cliente.query(
        `INSERT INTO merc_pedidos (sucursal_id, usuario_id, total) VALUES ($1,$2,$3) RETURNING id, creado_en`,
        [sucursalId, usuario.usuarioId, deCentavos(totalCentavos)]
      );
      pedido = { id: rows[0].id, total: totalCentavos / 100 };
      for (const p of productos) {
        await cliente.query(
          `INSERT INTO merc_pedido_items (pedido_id, producto_id, nombre, descripcion, imagen_url, precio_unitario, cantidad)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [pedido.id, p.id, p.nombre, p.descripcion, p.imagen_url, p.precio, solicitados.get(p.id)]
        );
      }
      await cliente.query(
        'INSERT INTO merc_pedido_movimientos (pedido_id, estado_anterior, estado_nuevo, usuario_id) VALUES ($1,NULL,$2,$3)',
        [pedido.id, 'PENDIENTE_CONFIRMAR', usuario.usuarioId]
      );
      await auditar(cliente, 'PEDIDO_CREADO', 'pedido', pedido.id, usuario.usuarioId, { sucursal_id: sucursalId, total: pedido.total });
      await cliente.query('COMMIT');
    } catch (err) {
      await cliente.query('ROLLBACK');
      return res.status(400).json({ error: err.message });
    } finally {
      cliente.release();
    }

    // El gerente recibe su confirmación ya; el aviso a Personal de Marca sale
    // después (enviar los push tarda varios segundos y no tiene por qué
    // demorar la respuesta).
    res.status(201).json({ id: pedido.id, numero: numeroPedido(pedido.id), total: pedido.total });

    // Aviso a Personal de Marca (respeta su preferencia "Nuevos pedidos de
    // mercadería", activada por default) - nunca hace fallar el pedido ya
    // registrado, y el push abre directo el detalle (payload.url, ver sw.js).
    try {
      const { rows: marca } = await db.query('SELECT id FROM usuarios WHERE personal_marca = true AND activo = true AND id <> $1', [usuario.usuarioId]);
      await crearNotificaciones(
        marca.map((m) => m.id), 'PEDIDO_MERCADERIA', `NUEVO PEDIDO – ${sucursalNombre}`,
        `Pedido ${numeroPedido(pedido.id)} recibido por ${pesos(pedido.total)}.`,
        { pedido_id: pedido.id, url: `/mercaderia/pedidos/${pedido.id}` }, 'NUEVOS_PEDIDOS_MERCADERIA'
      );
    } catch (err) {
      console.error('[mercaderia] no se pudo notificar el pedido nuevo:', err.message);
    }
  });

  // Listado (Historial y Gestión de pagos). Query: sucursal_id, estado, cobro
  // (PENDIENTE_COBRO|ABONADO), usuario_id, desde, hasta, con_saldo=1,
  // orden=antiguos|recientes.
  app.get('/api/merc/pedidos', requirePedir, async (req, res) => {
    if (req.query.estado && !ESTADOS.includes(req.query.estado)) return res.status(400).json({ error: 'Estado inválido' });
    try {
      const { where, params } = armarFiltros(req.usuario, req.query);
      const orden = req.query.orden === 'antiguos' ? 'ASC' : 'DESC';
      const { rows } = await db.query(`${SELECT_PEDIDO} ${where} ORDER BY p.creado_en ${orden}, p.id ${orden} LIMIT 1000`, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Responsables (gerentes) que alguna vez hicieron un pedido - para el
  // filtro "Responsable" del historial de Personal de Marca.
  app.get('/api/merc/responsables', requireMarca, async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT DISTINCT u.id, ${db.nombreCompletoSql('u')} AS nombre FROM merc_pedidos p JOIN usuarios u ON u.id = p.usuario_id ORDER BY nombre`
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/merc/pedidos/:id', requirePedir, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Pedido no encontrado' });
    try {
      const { rows } = await db.query(`${SELECT_PEDIDO} WHERE p.id = $1`, [req.params.id]);
      const pedido = rows[0];
      // Un Gerente no puede ni confirmar que existe un pedido de otra sucursal.
      if (!pedido || (!esMarca(req.usuario) && pedido.sucursal_id !== req.usuario.sucursal_id)) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }
      const { rows: items } = await db.query(
        `SELECT id, producto_id, nombre, descripcion, imagen_url, precio_unitario::float8 AS precio_unitario, cantidad,
                (precio_unitario * cantidad)::float8 AS subtotal
         FROM merc_pedido_items WHERE pedido_id = $1 ORDER BY id`, [pedido.id]
      );
      const { rows: movimientos } = await db.query(
        `SELECT m.id, m.estado_anterior, m.estado_nuevo, m.creado_en, ${db.nombreCompletoSql('u')} AS usuario_nombre
         FROM merc_pedido_movimientos m JOIN usuarios u ON u.id = m.usuario_id WHERE m.pedido_id = $1 ORDER BY m.creado_en, m.id`, [pedido.id]
      );
      const { rows: pagos } = await db.query(
        `SELECT a.id, a.pago_id, a.saldo_anterior::float8 AS saldo_anterior, a.importe::float8 AS importe,
                pg.monto::float8 AS monto_pago, pg.observaciones, pg.creado_en, ${db.nombreCompletoSql('u')} AS usuario_nombre
         FROM merc_pago_aplicaciones a JOIN merc_pagos pg ON pg.id = a.pago_id JOIN usuarios u ON u.id = pg.usuario_id
         WHERE a.pedido_id = $1 ORDER BY pg.creado_en, a.id`, [pedido.id]
      );
      const { rows: ediciones } = await db.query(
        `SELECT e.id, e.creado_en, e.total_anterior::float8 AS total_anterior, e.total_nuevo::float8 AS total_nuevo, e.cambios,
                ${db.nombreCompletoSql('u')} AS usuario_nombre
         FROM merc_pedido_ediciones e JOIN usuarios u ON u.id = e.usuario_id WHERE e.pedido_id = $1 ORDER BY e.creado_en, e.id`, [pedido.id]
      );
      res.json({ ...pedido, numero: numeroPedido(pedido.id), items, movimientos, pagos, ediciones });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Solo estado operativo - el estado de cobro no se toca acá (ver /pagos).
  app.post('/api/merc/pedidos/:id/estado', requireMarca, async (req, res) => {
    const { estado } = req.body;
    if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Pedido no encontrado' });
    const cliente = await db.pool.connect();
    try {
      await cliente.query('BEGIN');
      const { rows } = await cliente.query('SELECT id, estado, abonado, usuario_id FROM merc_pedidos WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!rows[0]) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'Pedido no encontrado' }); }
      if (rows[0].estado === estado) { await cliente.query('ROLLBACK'); return res.status(400).json({ error: 'El pedido ya está en ese estado' }); }
      // Cancelar solo tiene sentido antes del retiro y sin cobros ya
      // registrados (un pedido con pagos no se puede "desaparecer").
      if (estado === 'CANCELADO') {
        if (rows[0].estado === 'RETIRADO') { await cliente.query('ROLLBACK'); return res.status(400).json({ error: 'Un pedido ya retirado no se puede cancelar' }); }
        if (aCentavos(rows[0].abonado) > 0) { await cliente.query('ROLLBACK'); return res.status(400).json({ error: 'Este pedido ya tiene pagos registrados, no se puede cancelar' }); }
      }
      // Los días de demora corren desde el momento en que pasa a RETIRADO.
      await cliente.query(
        `UPDATE merc_pedidos SET estado = $1, retirado_en = CASE WHEN $1 = 'RETIRADO' THEN now() ELSE NULL END WHERE id = $2`,
        [estado, req.params.id]
      );
      await cliente.query(
        'INSERT INTO merc_pedido_movimientos (pedido_id, estado_anterior, estado_nuevo, usuario_id) VALUES ($1,$2,$3,$4)',
        [req.params.id, rows[0].estado, estado, req.usuario.usuarioId]
      );
      await auditar(cliente, 'ESTADO_CAMBIADO', 'pedido', Number(req.params.id), req.usuario.usuarioId, { anterior: rows[0].estado, nuevo: estado });
      await cliente.query('COMMIT');
      res.json({ ok: true, estado });
      // Que la marca cancele un pedido le llega al gerente que lo hizo.
      if (estado === 'CANCELADO' && rows[0].usuario_id !== req.usuario.usuarioId) {
        try {
          await crearNotificacion(rows[0].usuario_id, 'PEDIDO_MERCADERIA', `Pedido ${numeroPedido(rows[0].id)} cancelado`,
            'La marca canceló este pedido.', { pedido_id: rows[0].id, url: `/mercaderia/pedidos/${rows[0].id}` });
        } catch (err) {
          console.error('[mercaderia] no se pudo avisar la cancelación:', err.message);
        }
      }
    } catch (err) {
      await cliente.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      cliente.release();
    }
  });

  // Edición del contenido de un pedido por Personal de Marca, mientras no
  // haya sido retirado (ni cancelado). Body: { items: [{ producto_id,
  // cantidad, precio_unitario? }] } = cómo tiene que quedar el pedido
  // completo. Se puede quitar mercadería, cambiar cantidades o el precio de
  // una línea, y agregar otro producto. Recalcula el total (que no puede
  // quedar por debajo de lo ya abonado), deja registrado qué cambió y avisa
  // al gerente que hizo el pedido.
  app.put('/api/merc/pedidos/:id/items', requireMarca, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Pedido no encontrado' });
    const deseados = new Map();
    for (const it of Array.isArray(req.body.items) ? req.body.items : []) {
      const cantidad = Number(it.cantidad);
      if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 9999) return res.status(400).json({ error: 'Hay una cantidad inválida' });
      if (it.precio_unitario !== undefined && it.precio_unitario !== null && !(Number(it.precio_unitario) >= 0)) return res.status(400).json({ error: 'Hay un precio inválido' });
      if (deseados.has(Number(it.producto_id))) return res.status(400).json({ error: 'Un producto aparece repetido' });
      deseados.set(Number(it.producto_id), { cantidad, precio: it.precio_unitario === undefined || it.precio_unitario === null ? null : aCentavos(it.precio_unitario) });
    }
    if (!deseados.size) return res.status(400).json({ error: 'El pedido no puede quedar vacío - si no se puede tomar, cancelalo' });

    const cliente = await db.pool.connect();
    let resultado;
    try {
      await cliente.query('BEGIN');
      const { rows: [pedido] } = await cliente.query('SELECT id, estado, total, abonado, usuario_id FROM merc_pedidos WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!pedido) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'Pedido no encontrado' }); }
      if (pedido.estado === 'RETIRADO') { await cliente.query('ROLLBACK'); return res.status(400).json({ error: 'El pedido ya fue retirado, no se puede editar' }); }
      if (pedido.estado === 'CANCELADO') { await cliente.query('ROLLBACK'); return res.status(400).json({ error: 'El pedido está cancelado, no se puede editar' }); }

      const { rows: actuales } = await cliente.query('SELECT id, producto_id, nombre, cantidad, precio_unitario FROM merc_pedido_items WHERE pedido_id = $1', [pedido.id]);
      const actualPorProducto = new Map(actuales.map((a) => [a.producto_id, a]));
      const cambios = [];
      let totalNuevo = 0;
      const altas = [];
      const modificaciones = [];

      for (const a of actuales) {
        if (!deseados.has(a.producto_id)) cambios.push({ tipo: 'QUITADO', nombre: a.nombre, texto: `Quitado: ${a.nombre} (${a.cantidad})` });
      }
      for (const [productoId, d] of deseados) {
        const actual = actualPorProducto.get(productoId);
        if (actual) {
          const precioC = d.precio ?? aCentavos(actual.precio_unitario);
          totalNuevo += precioC * d.cantidad;
          if (d.cantidad !== actual.cantidad) cambios.push({ tipo: 'CANTIDAD', nombre: actual.nombre, de: actual.cantidad, a: d.cantidad, texto: `${actual.nombre}: cantidad ${actual.cantidad} → ${d.cantidad}` });
          if (precioC !== aCentavos(actual.precio_unitario)) cambios.push({ tipo: 'PRECIO', nombre: actual.nombre, de: Number(actual.precio_unitario), a: precioC / 100, texto: `${actual.nombre}: precio ${pesos(actual.precio_unitario)} → ${pesos(precioC / 100)}` });
          if (d.cantidad !== actual.cantidad || precioC !== aCentavos(actual.precio_unitario)) modificaciones.push({ id: actual.id, cantidad: d.cantidad, precioC });
        } else {
          const { rows: [prod] } = await cliente.query('SELECT id, nombre, descripcion, imagen_url, precio FROM merc_productos WHERE id = $1 AND activo = true', [productoId]);
          if (!prod) { await cliente.query('ROLLBACK'); return res.status(400).json({ error: 'Algún producto agregado no existe o está deshabilitado' }); }
          const precioC = d.precio ?? aCentavos(prod.precio);
          totalNuevo += precioC * d.cantidad;
          altas.push({ prod, cantidad: d.cantidad, precioC });
          cambios.push({ tipo: 'AGREGADO', nombre: prod.nombre, cantidad: d.cantidad, precio: precioC / 100, texto: `Agregado: ${prod.nombre} (${d.cantidad} × ${pesos(precioC / 100)})` });
        }
      }
      if (!cambios.length) { await cliente.query('ROLLBACK'); return res.status(400).json({ error: 'No hay cambios para guardar' }); }
      if (totalNuevo < aCentavos(pedido.abonado)) {
        await cliente.query('ROLLBACK');
        return res.status(400).json({ error: `El nuevo total (${pesos(totalNuevo / 100)}) no puede ser menor a lo ya abonado (${pesos(pedido.abonado)})` });
      }

      const quitar = actuales.filter((a) => !deseados.has(a.producto_id)).map((a) => a.id);
      if (quitar.length) await cliente.query('DELETE FROM merc_pedido_items WHERE id = ANY($1)', [quitar]);
      for (const m of modificaciones) await cliente.query('UPDATE merc_pedido_items SET cantidad = $1, precio_unitario = $2 WHERE id = $3', [m.cantidad, deCentavos(m.precioC), m.id]);
      for (const a of altas) {
        await cliente.query(
          `INSERT INTO merc_pedido_items (pedido_id, producto_id, nombre, descripcion, imagen_url, precio_unitario, cantidad) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [pedido.id, a.prod.id, a.prod.nombre, a.prod.descripcion, a.prod.imagen_url, deCentavos(a.precioC), a.cantidad]
        );
      }
      await cliente.query('UPDATE merc_pedidos SET total = $1 WHERE id = $2', [deCentavos(totalNuevo), pedido.id]);
      await cliente.query(
        'INSERT INTO merc_pedido_ediciones (pedido_id, usuario_id, total_anterior, total_nuevo, cambios) VALUES ($1,$2,$3,$4,$5)',
        [pedido.id, req.usuario.usuarioId, pedido.total, deCentavos(totalNuevo), JSON.stringify(cambios)]
      );
      await auditar(cliente, 'PEDIDO_EDITADO', 'pedido', pedido.id, req.usuario.usuarioId, { total_anterior: Number(pedido.total), total_nuevo: totalNuevo / 100, cambios: cambios.map((c) => c.texto) });
      await cliente.query('COMMIT');
      resultado = { pedido, cambios, totalNuevo: totalNuevo / 100 };
    } catch (err) {
      await cliente.query('ROLLBACK');
      return res.status(400).json({ error: err.message });
    } finally {
      cliente.release();
    }
    res.json({ ok: true, total: resultado.totalNuevo, cambios: resultado.cambios.map((c) => c.texto) });

    // Aviso al gerente que hizo el pedido, con el resumen de lo que cambió.
    if (resultado.pedido.usuario_id !== req.usuario.usuarioId) {
      try {
        const resumen = resultado.cambios.map((c) => c.texto).join('; ');
        await crearNotificacion(
          resultado.pedido.usuario_id, 'PEDIDO_MERCADERIA', `Pedido ${numeroPedido(resultado.pedido.id)} editado`,
          `${resumen}. Nuevo total: ${pesos(resultado.totalNuevo)}.`, { pedido_id: resultado.pedido.id, url: `/mercaderia/pedidos/${resultado.pedido.id}` }
        );
      } catch (err) {
        console.error('[mercaderia] no se pudo avisar la edición:', err.message);
      }
    }
  });

  // ------------------------------------------------------------
  // Gestión de pagos (solo Personal de Marca)
  // ------------------------------------------------------------

  app.get('/api/merc/pagos/resumen', requireMarca, async (req, res) => {
    try {
      const { rows: [tot] } = await db.query(
        `SELECT COALESCE(SUM(total - abonado), 0)::float8 AS total_pendiente, COUNT(*)::int AS pedidos_con_saldo,
                COUNT(DISTINCT sucursal_id)::int AS sucursales_con_deuda
         FROM merc_pedidos WHERE total > abonado AND estado = 'RETIRADO'`
      );
      const { rows: porSucursal } = await db.query(
        `SELECT p.sucursal_id, s.nombre AS sucursal_nombre, COUNT(*)::int AS pedidos, SUM(p.total - p.abonado)::float8 AS saldo
         FROM merc_pedidos p JOIN sucursales s ON s.id = p.sucursal_id WHERE p.total > p.abonado AND p.estado = 'RETIRADO'
         GROUP BY p.sucursal_id, s.nombre ORDER BY s.nombre`
      );
      res.json({ ...tot, por_sucursal: porSucursal });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // "Cancelar saldo". Body: { sucursal_id, pedido_ids: [...], monto, observaciones }.
  // El monto se aplica del pedido más antiguo al más nuevo: cada pedido se
  // cubre completo antes de pasar al siguiente, así el saldo remanente queda
  // solamente en el último pedido alcanzado. No se puede pagar de más.
  app.post('/api/merc/pagos', requireMarca, async (req, res) => {
    const { sucursal_id, pedido_ids, monto, observaciones } = req.body;
    const ids = [...new Set((Array.isArray(pedido_ids) ? pedido_ids : []).map(Number))];
    if (!sucursal_id || !ids.length || ids.some((i) => !Number.isInteger(i))) return res.status(400).json({ error: 'Elegí la sucursal y al menos un pedido' });
    const montoCentavos = aCentavos(monto);
    if (!Number.isFinite(montoCentavos) || montoCentavos <= 0) return res.status(400).json({ error: 'El monto a cancelar tiene que ser mayor a cero' });

    const cliente = await db.pool.connect();
    try {
      await cliente.query('BEGIN');
      const { rows: pedidos } = await cliente.query(
        `SELECT id, total, abonado, estado FROM merc_pedidos WHERE id = ANY($1) AND sucursal_id = $2 ORDER BY creado_en, id FOR UPDATE`,
        [ids, Number(sucursal_id)]
      );
      if (pedidos.length !== ids.length) { await cliente.query('ROLLBACK'); return res.status(400).json({ error: 'Algún pedido no existe o no es de esa sucursal' }); }
      if (pedidos.some((p) => p.estado !== 'RETIRADO')) { await cliente.query('ROLLBACK'); return res.status(400).json({ error: 'Solo se pueden cobrar pedidos ya retirados (la deuda se genera con el retiro)' }); }
      const saldos = pedidos.map((p) => ({ id: p.id, saldo: aCentavos(p.total) - aCentavos(p.abonado) }));
      if (saldos.some((s) => s.saldo <= 0)) { await cliente.query('ROLLBACK'); return res.status(400).json({ error: 'Algún pedido seleccionado ya no tiene saldo pendiente - actualizá la lista' }); }
      const saldoTotal = saldos.reduce((s, x) => s + x.saldo, 0);
      if (montoCentavos > saldoTotal) { await cliente.query('ROLLBACK'); return res.status(400).json({ error: `El monto supera el saldo pendiente seleccionado (${pesos(saldoTotal / 100)})` }); }

      const { rows: [pago] } = await cliente.query(
        `INSERT INTO merc_pagos (sucursal_id, monto, observaciones, usuario_id) VALUES ($1,$2,$3,$4) RETURNING id, creado_en`,
        [Number(sucursal_id), deCentavos(montoCentavos), observaciones?.trim() || null, req.usuario.usuarioId]
      );
      let restante = montoCentavos;
      const aplicaciones = [];
      for (const s of saldos) { // ya vienen del más antiguo al más nuevo
        if (restante <= 0) break;
        const importe = Math.min(s.saldo, restante);
        await cliente.query('UPDATE merc_pedidos SET abonado = abonado + $1 WHERE id = $2', [deCentavos(importe), s.id]);
        await cliente.query(
          'INSERT INTO merc_pago_aplicaciones (pago_id, pedido_id, saldo_anterior, importe) VALUES ($1,$2,$3,$4)',
          [pago.id, s.id, deCentavos(s.saldo), deCentavos(importe)]
        );
        aplicaciones.push({ pedido_id: s.id, numero: numeroPedido(s.id), saldo_anterior: s.saldo / 100, importe: importe / 100, saldo: (s.saldo - importe) / 100 });
        restante -= importe;
      }
      await auditar(cliente, 'PAGO_REGISTRADO', 'pago', pago.id, req.usuario.usuarioId, { sucursal_id: Number(sucursal_id), monto: montoCentavos / 100, aplicaciones });
      await cliente.query('COMMIT');
      res.status(201).json({ id: pago.id, monto: montoCentavos / 100, creado_en: pago.creado_en, aplicaciones });
    } catch (err) {
      await cliente.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      cliente.release();
    }
  });

  // ------------------------------------------------------------
  // Reportes PDF (solo Personal de Marca)
  // ------------------------------------------------------------

  // Saldos pendientes: siempre la situación de hoy (sin fechas), agrupado por sucursal.
  app.get('/api/merc/reportes/saldos', requireMarca, async (req, res) => {
    try {
      const { where, params } = armarFiltros(req.usuario, { sucursal_id: req.query.sucursal_id, con_saldo: '1' });
      const { rows } = await db.query(`${SELECT_PEDIDO} ${where} ORDER BY s.nombre, p.creado_en, p.id`, params);
      const buffer = await generarPdfSaldos({ pedidos: rows, todasLasSucursales: !req.query.sucursal_id });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'inline; filename="mercaderia-saldos-pendientes.pdf"');
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Todos los documentos emitidos en un período (desde/hasta, sin hora).
  app.get('/api/merc/reportes/documentos', requireMarca, async (req, res) => {
    const { desde, hasta } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || '')) return res.status(400).json({ error: 'Elegí la fecha desde y hasta' });
    if (desde > hasta) return res.status(400).json({ error: 'La fecha desde no puede ser posterior a la fecha hasta' });
    try {
      const { where, params } = armarFiltros(req.usuario, { sucursal_id: req.query.sucursal_id, desde, hasta });
      const { rows } = await db.query(`${SELECT_PEDIDO} ${where} ORDER BY s.nombre, p.creado_en, p.id`, params);
      const buffer = await generarPdfDocumentos({ pedidos: rows, desde, hasta, todasLasSucursales: !req.query.sucursal_id });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'inline; filename="mercaderia-documentos.pdf"');
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};

module.exports.ETIQUETA_ESTADO = ETIQUETA_ESTADO;
