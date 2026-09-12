/**
 * ============================================================
 * REPORTES PROGRAMADOS
 * ============================================================
 * Resumen periódico (semanal/mensual) de las auditorías completadas, por
 * mail. Se evalúa con un chequeo en memoria cada N minutos (verificarPendientes,
 * arrancado desde server/index.js) en vez de un cron de sistema operativo -
 * no hace falta infraestructura extra y alcanza para este volumen.
 *
 * Si el proceso del servidor se reinicia justo antes de que un reporte
 * tuviera que salir, ese envío se hace en el próximo chequeo (como mucho
 * INTERVALO_CHEQUEO_MS más tarde) - no hay una cola persistente de envíos
 * pendientes, es una simplificación deliberada acorde al tamaño del proyecto.
 */

const db = require('../db');
const { enviarMail } = require('../mailer');

const INTERVALO_CHEQUEO_MS = 15 * 60 * 1000; // 15 minutos

function etiquetaSemaforo(semaforo) {
  return { ROJO: 'Rojo', NARANJA: 'Naranja', AMARILLO: 'Amarillo', VERDE: 'Verde', DORADO: 'Dorado' }[semaforo] || semaforo || '—';
}

// ¿Le tocaba salir a este reporte en algún momento entre la última vez que
// se evaluó (haceMinutos atrás) y ahora? Corre cada INTERVALO_CHEQUEO_MS,
// así que alcanza con mirar si "ahora" ya pasó el horario de hoy Y todavía
// no se mandó en este período (semana o mes).
function debeEnviarse(reporte, ahora) {
  const [h, m] = reporte.hora.slice(0, 5).split(':').map(Number);
  const horarioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), h, m);
  if (ahora < horarioHoy) return false;
  if (reporte.frecuencia === 'SEMANAL' && ahora.getDay() !== reporte.dia_semana) return false;
  if (reporte.frecuencia === 'MENSUAL' && ahora.getDate() !== reporte.dia_mes) return false;
  if (reporte.ultimo_envio_en && new Date(reporte.ultimo_envio_en) >= horarioHoy) return false;
  return true;
}

// Desde cuándo cubre el resumen: desde el último envío (así no se pierde ni
// se duplica nada entre reportes consecutivos), o si es el primero, una
// semana/mes atrás según la frecuencia.
function inicioPeriodo(reporte, ahora) {
  if (reporte.ultimo_envio_en) return new Date(reporte.ultimo_envio_en);
  const dias = reporte.frecuencia === 'SEMANAL' ? 7 : 30;
  return new Date(ahora.getTime() - dias * 86400000);
}

async function generarResumenHtml({ sucursalId, desde, hasta }) {
  const params = [desde, hasta];
  let sql = `SELECT r.id, r.sucursal_id, s.nombre AS sucursal_nombre, r.tipo, r.puntaje_total, r.semaforo, r.resultado,
                    r.completada_en, r.detalle_calculo, t.nombre AS plantilla_nombre
             FROM audit_runs r
             JOIN sucursales s ON s.id = r.sucursal_id
             JOIN audit_templates t ON t.id = r.template_id
             WHERE r.estado = 'COMPLETADA' AND r.completada_en > $1 AND r.completada_en <= $2`;
  if (sucursalId) { params.push(sucursalId); sql += ` AND r.sucursal_id = $${params.length}`; }
  sql += ' ORDER BY r.completada_en DESC';
  const { rows } = await db.query(sql, params);

  if (rows.length === 0) {
    return { html: `<p>No hubo auditorías completadas en este período.</p>`, cantidad: 0 };
  }

  const aprobadas = rows.filter((r) => r.resultado === 'APROBADA').length;
  const desaprobadas = rows.length - aprobadas;
  const promedio = rows.reduce((acc, r) => acc + Number(r.puntaje_total || 0), 0) / rows.length;
  const conUmbralFallido = rows.filter((r) => r.detalle_calculo?.umbralesFallidos?.length > 0);

  const filas = rows.map((r) => `
    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;">${r.sucursal_nombre}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;">${r.plantilla_nombre}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;">${new Date(r.completada_en).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;">${Math.round((r.puntaje_total || 0) * 100)}%</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;">${etiquetaSemaforo(r.semaforo)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;">${r.resultado}</td>
    </tr>`).join('');

  const html = `
    <p><strong>${rows.length}</strong> auditorías completadas · <strong>${aprobadas}</strong> aprobadas · <strong>${desaprobadas}</strong> desaprobadas · promedio <strong>${Math.round(promedio * 100)}%</strong></p>
    ${conUmbralFallido.length > 0 ? `<p style="color:#86152D;">${conUmbralFallido.length} auditoría(s) no alcanzaron un umbral crítico de sector/área.</p>` : ''}
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <thead>
        <tr style="text-align:left;background:#f5f5f4;">
          <th style="padding:4px 8px;">Sucursal</th><th style="padding:4px 8px;">Plantilla</th>
          <th style="padding:4px 8px;">Fecha</th><th style="padding:4px 8px;">Puntaje</th>
          <th style="padding:4px 8px;">Semáforo</th><th style="padding:4px 8px;">Resultado</th>
        </tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>`;
  return { html, cantidad: rows.length };
}

async function enviarReporte(reporte, ahora) {
  const desde = inicioPeriodo(reporte, ahora);
  const { html, cantidad } = await generarResumenHtml({ sucursalId: reporte.sucursal_id, desde, hasta: ahora });
  const alcance = reporte.sucursal_id ? reporte.sucursal_nombre : 'todas las sucursales';
  await enviarMail({
    to: reporte.destinatarios,
    subject: `FAT Audit — Reporte ${reporte.frecuencia === 'SEMANAL' ? 'semanal' : 'mensual'}: ${reporte.nombre}`,
    html: `<p>Resumen de auditorías (${alcance}) del ${desde.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })} al ${ahora.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}.</p>${html}`,
  });
  await db.query('UPDATE reportes_programados SET ultimo_envio_en = $1 WHERE id = $2', [ahora.toISOString(), reporte.id]);
  return cantidad;
}

async function verificarPendientes() {
  const ahora = new Date();
  try {
    const { rows } = await db.query(
      `SELECT rp.*, s.nombre AS sucursal_nombre FROM reportes_programados rp
       LEFT JOIN sucursales s ON s.id = rp.sucursal_id WHERE rp.activo = true`
    );
    for (const reporte of rows) {
      if (!debeEnviarse(reporte, ahora)) continue;
      try {
        await enviarReporte(reporte, ahora);
        console.log(`[reportes] enviado "${reporte.nombre}" a ${reporte.destinatarios.join(', ')}`);
      } catch (err) {
        console.error(`[reportes] error enviando "${reporte.nombre}":`, err.message);
      }
    }
  } catch (err) {
    console.error('[reportes] error verificando pendientes:', err.message);
  }
}

function iniciarScheduler() {
  verificarPendientes();
  setInterval(verificarPendientes, INTERVALO_CHEQUEO_MS);
}

module.exports = { iniciarScheduler, verificarPendientes, enviarReporte, generarResumenHtml, debeEnviarse };
