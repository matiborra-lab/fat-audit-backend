/**
 * ============================================================
 * NOTIFICACIONES (in-app + Web Push)
 * ============================================================
 * crearNotificacion/crearNotificaciones se llaman desde otros modulos
 * (calendario.js - turnos publicados, solicitud de revision, asignacion) y
 * disparan las dos cosas a la vez: la fila in-app (para la campana) y el
 * push (ver src/push) - un mismo punto de llamada para ambas.
 */

const db = require('../db');
const { enviarPush, enviarPushMultiple, vapidPublicKey } = require('../push');

// El push nunca hace fallar la creacion de la notificacion in-app (es
// best-effort - si el navegador rechaza el push o el usuario no tiene
// suscripciones, la notificacion en la campana ya quedo guardada igual).
async function empujarPushSeguro(fn) {
  try { await fn(); } catch (err) { console.error('[push] error:', err.message); }
}

// Usuarios que apagaron explícitamente esta preferencia (falta de fila =
// habilitado por default, ver notificacion-preferencias.js) - un solo query
// por lote en vez de uno por usuario.
async function usuariosConPreferenciaDeshabilitada(usuarioIds, preferenciaTipo) {
  if (!preferenciaTipo || !usuarioIds.length) return new Set();
  const { rows } = await db.query(
    'SELECT usuario_id FROM notificacion_preferencias WHERE usuario_id = ANY($1) AND tipo = $2 AND habilitado = false',
    [usuarioIds, preferenciaTipo]
  );
  return new Set(rows.map((r) => r.usuario_id));
}

// `preferenciaTipo` (opcional) es la clave de notificacion_preferencias que
// gatea esta notificación (ej. 'ASIGNACION_TAREA') - no confundir con
// `tipo`, que es el tipo de la fila en `notificaciones` (ej. 'ASIGNACION').
// Se omite en tipos que no tienen preferencia configurable (ej. solicitud de
// revisión de turno), que siempre se disparan.
async function crearNotificacion(usuarioId, tipo, titulo, cuerpo, payload, preferenciaTipo) {
  if (!usuarioId) return;
  if (preferenciaTipo && (await usuariosConPreferenciaDeshabilitada([usuarioId], preferenciaTipo)).has(usuarioId)) return;
  await db.query(
    'INSERT INTO notificaciones (usuario_id, tipo, titulo, cuerpo, payload_json) VALUES ($1,$2,$3,$4,$5)',
    [usuarioId, tipo, titulo, cuerpo || null, payload ? JSON.stringify(payload) : null]
  );
  await empujarPushSeguro(() => enviarPush(usuarioId, { titulo, cuerpo, tipo, ...payload }));
}

async function crearNotificaciones(usuarioIds, tipo, titulo, cuerpo, payload, preferenciaTipo) {
  let ids = [...new Set(usuarioIds.filter(Boolean))];
  if (!ids.length) return;
  if (preferenciaTipo) {
    const deshabilitados = await usuariosConPreferenciaDeshabilitada(ids, preferenciaTipo);
    ids = ids.filter((id) => !deshabilitados.has(id));
    if (!ids.length) return;
  }
  const filas = ids.map((id) => [id, tipo, titulo, cuerpo || null, payload ? JSON.stringify(payload) : null]);
  await db.bulkInsert(db.pool, 'notificaciones', ['usuario_id', 'tipo', 'titulo', 'cuerpo', 'payload_json'], filas);
  await empujarPushSeguro(() => enviarPushMultiple(ids, { titulo, cuerpo, tipo, ...payload }));
}

module.exports = function registrarRutasNotificaciones(app) {
  // El navegador la necesita para suscribirse via PushManager. Solo tiene
  // sentido pedirla ya logueado (la suscripción se asocia al usuario).
  app.get('/api/push/vapid-public-key', (req, res) => {
    res.json({ publicKey: vapidPublicKey() });
  });

  // Alta/actualización de una suscripción push de ESTE navegador/dispositivo.
  // Body: { endpoint, keys: { p256dh, auth } } (la forma nativa de PushSubscription.toJSON()).
  app.post('/api/push/suscripciones', async (req, res) => {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'Faltan campos: endpoint, keys.p256dh, keys.auth' });
    try {
      await db.query(
        `INSERT INTO push_subscriptions (usuario_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (endpoint) DO UPDATE SET usuario_id = $1, p256dh = $3, auth = $4, user_agent = $5`,
        [req.usuario.usuarioId, endpoint, keys.p256dh, keys.auth, req.headers['user-agent'] || null]
      );
      res.status(201).json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // El navegador manda esto cuando el usuario desactiva las notificaciones
  // (o al desinstalar/limpiar sitio) - borra la suscripción de ESTE dispositivo.
  app.post('/api/push/desuscribirse', async (req, res) => {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'Falta el campo: endpoint' });
    try {
      await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND usuario_id = $2', [endpoint, req.usuario.usuarioId]);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

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
