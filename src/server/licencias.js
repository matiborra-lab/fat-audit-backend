/**
 * ============================================================
 * LICENCIAS (vacaciones/salud/asuntos familiares)
 * ============================================================
 * Las carga un Admin/Gerente para un Gerente o Colaborador de su alcance -
 * nunca el propio interesado (no es un pedido tipo "solicitar licencia",
 * es un registro administrativo). Se usan como overlay de solo lectura en
 * el calendario de esa persona y como advertencia en Gestionar turnos.
 */

const db = require('../db');
const { puedeAccederSucursal } = require('../auth/middleware');

const MOTIVOS_VALIDOS = ['VACACIONES', 'SALUD', 'FAMILIAR', 'OTRO'];

// Mismo criterio que puedeGestionarTurnos (calendario.js) - deliberadamente
// sin Auditor ni Colaborador.
function puedeGestionarLicencias(usuario, sucursalId) {
  if (usuario.rol === 'ADMIN') return true;
  if (usuario.rol === 'GERENTE') return usuario.sucursal_id === Number(sucursalId);
  return false;
}

module.exports = function registrarRutasLicencias(app) {
  // Listado administrativo (pantalla Turnos > Licencias) - Admin ve todas
  // las sucursales o filtra por una, Gerente siempre queda forzado a la suya.
  app.get('/api/licencias', async (req, res) => {
    if (req.usuario.rol !== 'ADMIN' && req.usuario.rol !== 'GERENTE') {
      return res.status(403).json({ error: 'Esta acción es solo para administradores o gerentes' });
    }
    const { usuario_id, motivo, desde, hasta } = req.query;
    // to_char en fecha_desde/fecha_hasta - una columna DATE cruda serializa
    // como timestamp completo vía pg/JSON (medianoche UTC), rompiendo tanto
    // la comparación por string como el <input type="date"> del frontend
    // (mismo ajuste que ya usan feriados/fecha_nacimiento).
    let sql = `SELECT l.id, l.usuario_id, l.motivo, l.detalle, l.creado_por, l.creado_en,
                      to_char(l.fecha_desde, 'YYYY-MM-DD') AS fecha_desde, to_char(l.fecha_hasta, 'YYYY-MM-DD') AS fecha_hasta,
                      u.nombre AS usuario_nombre, u.email AS usuario_email, u.rol AS usuario_rol,
                      u.sucursal_id, s.nombre AS sucursal_nombre, cp.nombre AS creado_por_nombre
               FROM licencias l
               JOIN usuarios u ON u.id = l.usuario_id
               LEFT JOIN sucursales s ON s.id = u.sucursal_id
               LEFT JOIN usuarios cp ON cp.id = l.creado_por
               WHERE 1=1`;
    const params = [];
    if (req.usuario.rol === 'GERENTE') {
      params.push(req.usuario.sucursal_id); sql += ` AND u.sucursal_id = $${params.length}`;
    } else if (req.query.sucursal_id) {
      params.push(req.query.sucursal_id); sql += ` AND u.sucursal_id = $${params.length}`;
    }
    if (usuario_id) { params.push(usuario_id); sql += ` AND l.usuario_id = $${params.length}`; }
    if (motivo) { params.push(motivo); sql += ` AND l.motivo = $${params.length}`; }
    if (desde) { params.push(desde); sql += ` AND l.fecha_hasta >= $${params.length}`; }
    if (hasta) { params.push(hasta); sql += ` AND l.fecha_desde <= $${params.length}`; }
    sql += ' ORDER BY l.fecha_desde DESC';
    try {
      const { rows } = await db.query(sql, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Body: { usuario_id, fecha_desde, fecha_hasta, motivo, detalle (opcional) }
  app.post('/api/licencias', async (req, res) => {
    const { usuario_id, fecha_desde, fecha_hasta, motivo, detalle } = req.body;
    if (!usuario_id || !fecha_desde || !fecha_hasta || !motivo) {
      return res.status(400).json({ error: 'Faltan campos: usuario_id, fecha_desde, fecha_hasta, motivo' });
    }
    if (!MOTIVOS_VALIDOS.includes(motivo)) return res.status(400).json({ error: 'motivo inválido' });
    if (fecha_hasta < fecha_desde) return res.status(400).json({ error: 'La fecha hasta no puede ser anterior a la fecha desde' });
    try {
      const { rows: destRows } = await db.query('SELECT sucursal_id, rol FROM usuarios WHERE id = $1 AND activo = true', [usuario_id]);
      const destino = destRows[0];
      if (!destino) return res.status(404).json({ error: 'Usuario no encontrado' });
      if (!['GERENTE', 'COLABORADOR'].includes(destino.rol)) {
        return res.status(400).json({ error: 'Una licencia solo se puede cargar para un gerente o colaborador' });
      }
      if (!puedeGestionarLicencias(req.usuario, destino.sucursal_id)) {
        return res.status(403).json({ error: 'No podés cargar licencias para esta persona' });
      }
      const { rows } = await db.query(
        `INSERT INTO licencias (usuario_id, fecha_desde, fecha_hasta, motivo, detalle, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, usuario_id, motivo, detalle, creado_por, creado_en,
                   to_char(fecha_desde, 'YYYY-MM-DD') AS fecha_desde, to_char(fecha_hasta, 'YYYY-MM-DD') AS fecha_hasta`,
        [usuario_id, fecha_desde, fecha_hasta, motivo, detalle || null, req.usuario.usuarioId]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/licencias/:id', async (req, res) => {
    try {
      const { rows: existentes } = await db.query(
        'SELECT l.id, u.sucursal_id FROM licencias l JOIN usuarios u ON u.id = l.usuario_id WHERE l.id = $1',
        [req.params.id]
      );
      const licencia = existentes[0];
      if (!licencia) return res.status(404).json({ error: 'Licencia no encontrada' });
      if (!puedeGestionarLicencias(req.usuario, licencia.sucursal_id)) {
        return res.status(403).json({ error: 'No podés eliminar esta licencia' });
      }
      await db.query('DELETE FROM licencias WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Overlay de solo lectura para el calendario y Gestionar turnos - un
  // Colaborador solo ve las propias (nunca las de sus compañeros), el
  // resto de roles ve todas las de la sucursal (mismo criterio que
  // feriados/cumpleaños de esa misma sucursal).
  app.get('/api/sucursales/:id/licencias', async (req, res) => {
    if (!puedeAccederSucursal(req.usuario, req.params.id)) return res.status(403).json({ error: 'No tenés acceso a esa sucursal' });
    const { desde, hasta } = req.query;
    let sql = `SELECT l.id, l.usuario_id, l.motivo, l.detalle,
                      to_char(l.fecha_desde, 'YYYY-MM-DD') AS fecha_desde, to_char(l.fecha_hasta, 'YYYY-MM-DD') AS fecha_hasta,
                      u.nombre AS usuario_nombre
               FROM licencias l JOIN usuarios u ON u.id = l.usuario_id
               WHERE u.sucursal_id = $1`;
    const params = [req.params.id];
    if (req.usuario.rol === 'COLABORADOR') {
      params.push(req.usuario.usuarioId); sql += ` AND l.usuario_id = $${params.length}`;
    }
    if (desde) { params.push(desde); sql += ` AND l.fecha_hasta >= $${params.length}`; }
    if (hasta) { params.push(hasta); sql += ` AND l.fecha_desde <= $${params.length}`; }
    sql += ' ORDER BY l.fecha_desde';
    try {
      const { rows } = await db.query(sql, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};

module.exports.MOTIVOS_VALIDOS = MOTIVOS_VALIDOS;
module.exports.puedeGestionarLicencias = puedeGestionarLicencias;
