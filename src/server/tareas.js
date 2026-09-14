/**
 * ============================================================
 * CATALOGO DE TAREAS (tipo -> tareas)
 * ============================================================
 * Administrable por Admin desde Configuracion. Una TAREA del calendario
 * puede salir de acá (tarea_catalogo_id) o ser libre ("Otro", con
 * titulo/descripcion propios) - ver server/calendario.js.
 */

const db = require('../db');
const { requireAdmin, puedeAccederSucursal } = require('../auth/middleware');

async function cargarSucursalIds(tareaIds) {
  if (!tareaIds.length) return new Map();
  const { rows } = await db.query('SELECT tarea_id, sucursal_id FROM tarea_sucursales WHERE tarea_id = ANY($1)', [tareaIds]);
  const mapa = new Map();
  for (const r of rows) {
    if (!mapa.has(r.tarea_id)) mapa.set(r.tarea_id, []);
    mapa.get(r.tarea_id).push(r.sucursal_id);
  }
  return mapa;
}

module.exports = function registrarRutasTareas(app) {
  // Catálogo filtrado por alcance - lo usa el modal de "nueva tarea" del
  // calendario, para cualquier rol con acceso a esa sucursal.
  app.get('/api/tipos-tarea/disponibles', async (req, res) => {
    const { sucursal_id } = req.query;
    if (!sucursal_id) return res.status(400).json({ error: 'Falta sucursal_id' });
    if (!puedeAccederSucursal(req.usuario, sucursal_id)) return res.status(403).json({ error: 'No tenés acceso a esa sucursal' });
    try {
      const { rows: tareas } = await db.query(
        `SELECT t.id, t.nombre, t.foto_requerida, t.tipo_tarea_id
         FROM tareas_catalogo t
         WHERE t.activo = true AND (
           t.aplica_todas_sucursales = true
           OR EXISTS (SELECT 1 FROM tarea_sucursales ts WHERE ts.tarea_id = t.id AND ts.sucursal_id = $1)
         )
         ORDER BY t.orden`,
        [sucursal_id]
      );
      const { rows: tipos } = await db.query('SELECT id, nombre FROM tipos_tarea WHERE activo = true ORDER BY orden');
      const tareasPorTipo = new Map();
      for (const t of tareas) {
        if (!tareasPorTipo.has(t.tipo_tarea_id)) tareasPorTipo.set(t.tipo_tarea_id, []);
        tareasPorTipo.get(t.tipo_tarea_id).push({ id: t.id, nombre: t.nombre, foto_requerida: t.foto_requerida });
      }
      const resultado = tipos
        .map((tipo) => ({ id: tipo.id, nombre: tipo.nombre, tareas: tareasPorTipo.get(tipo.id) || [] }))
        .filter((tipo) => tipo.tareas.length > 0);
      res.json(resultado);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Catálogo completo (incluye inactivos y el alcance por sucursal de cada
  // tarea) - solo para la pantalla de administración en Configuración.
  app.get('/api/tipos-tarea', requireAdmin, async (req, res) => {
    try {
      const { rows: tipos } = await db.query('SELECT * FROM tipos_tarea ORDER BY orden');
      const { rows: tareas } = await db.query('SELECT * FROM tareas_catalogo ORDER BY orden');
      const sucursalIdsPorTarea = await cargarSucursalIds(tareas.map((t) => t.id));
      const tareasPorTipo = new Map();
      for (const t of tareas) {
        if (!tareasPorTipo.has(t.tipo_tarea_id)) tareasPorTipo.set(t.tipo_tarea_id, []);
        tareasPorTipo.get(t.tipo_tarea_id).push({ ...t, sucursal_ids: sucursalIdsPorTarea.get(t.id) || [] });
      }
      res.json(tipos.map((tipo) => ({ ...tipo, tareas: tareasPorTipo.get(tipo.id) || [] })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/tipos-tarea', requireAdmin, async (req, res) => {
    const nombre = (req.body.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'Falta el nombre' });
    try {
      const { rows: max } = await db.query('SELECT COALESCE(MAX(orden), -1) + 1 AS siguiente FROM tipos_tarea');
      const { rows } = await db.query(
        'INSERT INTO tipos_tarea (nombre, orden, icono) VALUES ($1,$2,$3) RETURNING *',
        [nombre, max[0].siguiente, req.body.icono || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/tipos-tarea/:id', requireAdmin, async (req, res) => {
    const { nombre, orden, activo, icono } = req.body;
    try {
      const { rows } = await db.query(
        `UPDATE tipos_tarea SET nombre = COALESCE($1,nombre), orden = COALESCE($2,orden), activo = COALESCE($3,activo),
         icono = COALESCE($5,icono)
         WHERE id = $4 RETURNING *`,
        [nombre ?? null, orden ?? null, activo ?? null, req.params.id, icono ?? null]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Tipo de tarea no encontrado' });
      res.json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Body: { tipo_tarea_id, nombre, aplica_todas_sucursales, foto_requerida, sucursal_ids,
  // descripcion, enlace, enlace_nombre } - descripcion/enlace/enlace_nombre son opcionales,
  // instrucciones puntuales de ESTA tarea (no del tipo) que se muestran al completarla.
  app.post('/api/tareas-catalogo', requireAdmin, async (req, res) => {
    const { tipo_tarea_id, nombre, aplica_todas_sucursales = true, foto_requerida = false, sucursal_ids = [] } = req.body;
    if (!tipo_tarea_id || !nombre?.trim()) return res.status(400).json({ error: 'Faltan campos: tipo_tarea_id, nombre' });
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: max } = await client.query('SELECT COALESCE(MAX(orden), -1) + 1 AS siguiente FROM tareas_catalogo WHERE tipo_tarea_id = $1', [tipo_tarea_id]);
      const { rows } = await client.query(
        `INSERT INTO tareas_catalogo (tipo_tarea_id, nombre, orden, aplica_todas_sucursales, foto_requerida, descripcion, enlace, enlace_nombre)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [tipo_tarea_id, nombre.trim(), max[0].siguiente, !!aplica_todas_sucursales, !!foto_requerida, req.body.descripcion || null, req.body.enlace || null, req.body.enlace_nombre || null]
      );
      const tarea = rows[0];
      if (!aplica_todas_sucursales && sucursal_ids.length) {
        await db.bulkInsert(client, 'tarea_sucursales', ['tarea_id', 'sucursal_id'], sucursal_ids.map((sId) => [tarea.id, sId]));
      }
      await client.query('COMMIT');
      res.status(201).json({ ...tarea, sucursal_ids: aplica_todas_sucursales ? [] : sucursal_ids });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // Update dinámico en vez de COALESCE: alternarTareaActiva manda solo
  // `{activo}` - con COALESCE ahí, descripcion/enlace/enlace_nombre (que sí
  // necesitan poder mandarse vacíos para borrarlos) obligarían a elegir entre
  // "nunca se puede limpiar un enlace" o "el toggle de activo lo borra sin
  // querer". Acá solo se toca una columna si su clave vino en el body.
  app.patch('/api/tareas-catalogo/:id', requireAdmin, async (req, res) => {
    const { sucursal_ids } = req.body;
    const campos = [];
    const params = [];
    function set(columna, valor) { params.push(valor); campos.push(`${columna} = $${params.length}`); }
    if (req.body.nombre !== undefined) set('nombre', req.body.nombre);
    if (req.body.orden !== undefined) set('orden', req.body.orden);
    if (req.body.activo !== undefined) set('activo', req.body.activo);
    if (req.body.aplica_todas_sucursales !== undefined) set('aplica_todas_sucursales', req.body.aplica_todas_sucursales);
    if (req.body.foto_requerida !== undefined) set('foto_requerida', req.body.foto_requerida);
    if (req.body.descripcion !== undefined) set('descripcion', req.body.descripcion || null);
    if (req.body.enlace !== undefined) set('enlace', req.body.enlace || null);
    if (req.body.enlace_nombre !== undefined) set('enlace_nombre', req.body.enlace_nombre || null);
    if (!campos.length && sucursal_ids === undefined) return res.status(400).json({ error: 'Nada para actualizar' });
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      let tarea;
      if (campos.length) {
        params.push(req.params.id);
        const { rows } = await client.query(`UPDATE tareas_catalogo SET ${campos.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
        tarea = rows[0];
      } else {
        const { rows } = await client.query('SELECT * FROM tareas_catalogo WHERE id = $1', [req.params.id]);
        tarea = rows[0];
      }
      if (!tarea) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tarea no encontrada' }); }
      if (sucursal_ids !== undefined) {
        await client.query('DELETE FROM tarea_sucursales WHERE tarea_id = $1', [tarea.id]);
        if (!tarea.aplica_todas_sucursales && sucursal_ids.length) {
          await db.bulkInsert(client, 'tarea_sucursales', ['tarea_id', 'sucursal_id'], sucursal_ids.map((sId) => [tarea.id, sId]));
        }
      }
      await client.query('COMMIT');
      res.json(tarea);
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });
};
