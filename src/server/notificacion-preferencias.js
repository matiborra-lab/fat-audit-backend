/**
 * ============================================================
 * PREFERENCIAS DE NOTIFICACION
 * ============================================================
 * Personales - cualquier usuario logueado administra las suyas (no hay
 * gate de rol, a diferencia de Usuarios/Tareas en Configuración). Sin fila
 * en notificacion_preferencias, un tipo se considera habilitado=true (ver
 * mismo default en src/server/notificaciones.js y src/recordatorios).
 */

const db = require('../db');

const TIPOS_VALIDOS = [
  'ASIGNACION_TAREA', 'RECORDATORIO_TAREA',
  'ASIGNACION_AUDITORIA', 'RECORDATORIO_AUDITORIA',
  'ASIGNACION_EVENTO_ESPECIAL', 'RECORDATORIO_EVENTO_ESPECIAL',
  'TURNOS_ASIGNADOS', 'CUMPLEANOS', 'CLIMA',
  'NUEVOS_PEDIDOS_MERCADERIA',
];

module.exports = function registrarRutasNotificacionPreferencias(app) {
  app.get('/api/notificacion-preferencias', async (req, res) => {
    try {
      const { rows: preferencias } = await db.query(
        'SELECT tipo, habilitado, anticipacion_horas FROM notificacion_preferencias WHERE usuario_id = $1',
        [req.usuario.usuarioId]
      );
      const { rows: reglasClima } = await db.query(
        'SELECT id, campo, operador, valor, anticipacion_dias FROM notificacion_reglas_clima WHERE usuario_id = $1 ORDER BY orden, id',
        [req.usuario.usuarioId]
      );
      res.json({ preferencias, reglasClima });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Body: { habilitado, anticipacion_horas (opcional) }
  app.put('/api/notificacion-preferencias/:tipo', async (req, res) => {
    const { tipo } = req.params;
    if (!TIPOS_VALIDOS.includes(tipo)) return res.status(400).json({ error: 'tipo inválido' });
    const { habilitado, anticipacion_horas } = req.body;
    try {
      const { rows } = await db.query(
        `INSERT INTO notificacion_preferencias (usuario_id, tipo, habilitado, anticipacion_horas)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (usuario_id, tipo) DO UPDATE SET habilitado = $3, anticipacion_horas = $4
         RETURNING tipo, habilitado, anticipacion_horas`,
        [req.usuario.usuarioId, tipo, habilitado !== false, anticipacion_horas ?? null]
      );
      res.json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Body: { campo: 'weather_code'|'temperatura', operador: 'eq'|'gte'|'lte', valor, anticipacion_dias }
  app.post('/api/notificacion-preferencias/reglas-clima', async (req, res) => {
    const { campo, operador, valor, anticipacion_dias = 0 } = req.body;
    if (!['weather_code', 'temperatura'].includes(campo)) return res.status(400).json({ error: 'campo inválido' });
    if (!['eq', 'gte', 'lte'].includes(operador)) return res.status(400).json({ error: 'operador inválido' });
    if (valor === undefined || valor === null || valor === '') return res.status(400).json({ error: 'Falta el campo: valor' });
    if (anticipacion_dias < 0 || anticipacion_dias > 10) return res.status(400).json({ error: 'anticipacion_dias debe estar entre 0 y 10' });
    try {
      const { rows: max } = await db.query('SELECT COALESCE(MAX(orden), -1) + 1 AS siguiente FROM notificacion_reglas_clima WHERE usuario_id = $1', [req.usuario.usuarioId]);
      const { rows } = await db.query(
        `INSERT INTO notificacion_reglas_clima (usuario_id, campo, operador, valor, anticipacion_dias, orden)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, campo, operador, valor, anticipacion_dias`,
        [req.usuario.usuarioId, campo, operador, valor, anticipacion_dias, max[0].siguiente]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/notificacion-preferencias/reglas-clima/:id', async (req, res) => {
    try {
      const { rows } = await db.query(
        'DELETE FROM notificacion_reglas_clima WHERE id = $1 AND usuario_id = $2 RETURNING id',
        [req.params.id, req.usuario.usuarioId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Regla no encontrada' });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
};
