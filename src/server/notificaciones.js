/**
 * ============================================================
 * NOTIFICACIONES (in-app, base compartida con Web Push a futuro)
 * ============================================================
 * crearNotificacion/crearNotificaciones se llaman desde otros modulos
 * (calendario.js hoy - turnos publicados, solicitud de revision) en el
 * mismo punto donde mas adelante se va a disparar tambien el push.
 */

const db = require('../db');

async function crearNotificacion(usuarioId, tipo, titulo, cuerpo, payload) {
  if (!usuarioId) return;
  await db.query(
    'INSERT INTO notificaciones (usuario_id, tipo, titulo, cuerpo, payload_json) VALUES ($1,$2,$3,$4,$5)',
    [usuarioId, tipo, titulo, cuerpo || null, payload ? JSON.stringify(payload) : null]
  );
}

async function crearNotificaciones(usuarioIds, tipo, titulo, cuerpo, payload) {
  const ids = [...new Set(usuarioIds.filter(Boolean))];
  if (!ids.length) return;
  const filas = ids.map((id) => [id, tipo, titulo, cuerpo || null, payload ? JSON.stringify(payload) : null]);
  await db.bulkInsert(db.pool, 'notificaciones', ['usuario_id', 'tipo', 'titulo', 'cuerpo', 'payload_json'], filas);
}

module.exports = function registrarRutasNotificaciones(app) {
  app.get('/api/notificaciones', async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT * FROM notificaciones WHERE usuario_id = $1 ORDER BY (leida_en IS NULL) DESC, creado_en DESC LIMIT 50`,
        [req.usuario.usuarioId]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/notificaciones/:id/leida', async (req, res) => {
    try {
      const { rows } = await db.query(
        `UPDATE notificaciones SET leida_en = now() WHERE id = $1 AND usuario_id = $2 RETURNING *`,
        [req.params.id, req.usuario.usuarioId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Notificación no encontrada' });
      res.json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/notificaciones/marcar-todas-leidas', async (req, res) => {
    try {
      await db.query('UPDATE notificaciones SET leida_en = now() WHERE usuario_id = $1 AND leida_en IS NULL', [req.usuario.usuarioId]);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
};

module.exports.crearNotificacion = crearNotificacion;
module.exports.crearNotificaciones = crearNotificaciones;
