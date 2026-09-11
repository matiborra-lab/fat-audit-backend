/**
 * WEB PUSH - notificaciones push del navegador/PWA. Mismo patron que
 * src/mailer: si no hay claves VAPID configuradas (desarrollo local sin
 * generarlas todavia), se loguea en consola en vez de fallar.
 */

const db = require('../db');

let webpush = null;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush = require('web-push');
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:soporte@fataudit.com.ar',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// payload: objeto chico que arma la notificacion en el navegador (ver
// public/sw.js del frontend) - { titulo, cuerpo, url? }.
async function enviarPush(usuarioId, payload) {
  if (!webpush) {
    console.log(`[push] VAPID no configurada - push simulado a usuario ${usuarioId}:`, payload);
    return;
  }
  const { rows } = await db.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE usuario_id = $1', [usuarioId]);
  const cuerpo = JSON.stringify(payload);
  await Promise.all(rows.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, cuerpo);
    } catch (err) {
      // 404/410 = la suscripcion ya no existe del lado del navegador (se
      // desinstaló la app, se borró el sitio, etc.) - se limpia sola.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
      } else {
        console.error('[push] error enviando a', s.endpoint, err.message);
      }
    }
  }));
}

async function enviarPushMultiple(usuarioIds, payload) {
  await Promise.all([...new Set(usuarioIds.filter(Boolean))].map((id) => enviarPush(id, payload)));
}

module.exports = { enviarPush, enviarPushMultiple, vapidPublicKey: () => process.env.VAPID_PUBLIC_KEY || null };
