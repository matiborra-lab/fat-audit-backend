/**
 * ============================================================
 * RECORDATORIOS DE SEGUIMIENTO PROGRAMADO
 * ============================================================
 * Cuando se programa una auditoría de seguimiento desde los hallazgos de
 * una auditoría de marca (ver server/runs.js, POST /api/runs/:id/seguimiento)
 * el responsable recibe una notificación al momento de programarlo Y un
 * recordatorio el día de la fecha programada. Este chequeo en memoria (igual
 * patrón que src/reportes) es el que manda ese recordatorio, una sola vez
 * por evento (ver recordatorio_enviado_en).
 */

const db = require('../db');
const { crearNotificacion } = require('../server/notificaciones');

const INTERVALO_CHEQUEO_MS = 30 * 60 * 1000; // 30 minutos

async function verificarRecordatorios() {
  try {
    const { rows } = await db.query(
      `SELECT se.id, se.sucursal_id, se.fecha_hora, se.responsable_user_id, s.nombre AS sucursal_nombre
       FROM schedule_events se JOIN sucursales s ON s.id = se.sucursal_id
       WHERE se.tipo = 'SEGUIMIENTO' AND se.origen_run_id IS NOT NULL AND se.estado = 'PENDIENTE'
         AND se.responsable_user_id IS NOT NULL AND se.recordatorio_enviado_en IS NULL
         AND se.fecha_hora::date = CURRENT_DATE`
    );
    for (const evento of rows) {
      try {
        const hora = new Date(evento.fecha_hora).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
        await crearNotificacion(evento.responsable_user_id, 'RECORDATORIO_SEGUIMIENTO',
          'Recordatorio: seguimiento programado hoy',
          `Tenés un seguimiento programado hoy en ${evento.sucursal_nombre} a las ${hora}.`,
          { evento_id: evento.id, sucursal_id: evento.sucursal_id });
        await db.query('UPDATE schedule_events SET recordatorio_enviado_en = now() WHERE id = $1', [evento.id]);
      } catch (err) {
        console.error(`[recordatorios] error notificando evento ${evento.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[recordatorios] error verificando pendientes:', err.message);
  }
}

function iniciarSchedulerRecordatorios() {
  verificarRecordatorios();
  setInterval(verificarRecordatorios, INTERVALO_CHEQUEO_MS);
}

module.exports = { iniciarSchedulerRecordatorios, verificarRecordatorios };
