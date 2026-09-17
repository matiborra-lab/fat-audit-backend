/**
 * ============================================================
 * COMUNICADOS (Admin -> notificaciones masivas)
 * ============================================================
 * Un comunicado se envía de inmediato al crearlo (fecha_envio null) o queda
 * pendiente para que lo mande el scheduler de acá cuando llegue su fecha -
 * mismo patrón setInterval en memoria que reportes/recordatorios/feriados
 * (ver server/index.js). La audiencia (audiencia_json) se resuelve a una
 * lista de usuarios recién en el momento de mandarlo, no al crearlo - así
 * un comunicado programado con "Responsables del sector Cocina" para dentro
 * de dos semanas le llega a quien esté REALMENTE de turno ese día, no a
 * quien estaba de turno cuando se armó el comunicado.
 */

const db = require('../db');
const { empujarPushSeguro } = require('../server/notificaciones');
const { enviarPush } = require('../push');

const INTERVALO_CHEQUEO_MS = 5 * 60 * 1000; // 5 minutos
const ZONA = 'America/Argentina/Buenos_Aires';

// Mismos criterios que resolverResponsablesTarea (ver calendario.js), mas
// tres variantes exclusivas de comunicados: TODOS_SUCURSAL/GERENTES_SUCURSAL
// (alcance de una sucursal puntual) y TODOS/GERENTES (todas las sucursales).
async function resolverDestinatarios(criterios, fechaReferencia) {
  const ids = new Set();
  for (const c of criterios || []) {
    if (c.tipo === 'PERSONA' && c.user_id) {
      ids.add(Number(c.user_id));
    } else if (c.tipo === 'TODOS') {
      const { rows } = await db.query(`SELECT id FROM usuarios WHERE activo = true`);
      rows.forEach((r) => ids.add(r.id));
    } else if (c.tipo === 'GERENTES') {
      const { rows } = await db.query(`SELECT id FROM usuarios WHERE activo = true AND rol = 'GERENTE'`);
      rows.forEach((r) => ids.add(r.id));
    } else if (c.tipo === 'TODOS_SUCURSAL' && c.sucursal_id) {
      const { rows } = await db.query(`SELECT id FROM usuarios WHERE activo = true AND sucursal_id = $1`, [c.sucursal_id]);
      rows.forEach((r) => ids.add(r.id));
    } else if (c.tipo === 'GERENTES_SUCURSAL' && c.sucursal_id) {
      const { rows } = await db.query(`SELECT id FROM usuarios WHERE activo = true AND rol = 'GERENTE' AND sucursal_id = $1`, [c.sucursal_id]);
      rows.forEach((r) => ids.add(r.id));
    } else if (c.tipo === 'PUESTO' && c.sucursal_id && c.puesto) {
      // Responsables de un sector: quien tenga un TURNO real de ese puesto
      // ese día en esa sucursal - igual criterio que la tarea "por sector"
      // (ver resolverResponsablesTarea), sin fallback al puesto de base del
      // usuario: si todavía no está armado el turno de ese día, no hay a
      // quién avisarle todavía.
      const diaISO = fechaReferencia.toISOString().slice(0, 10);
      const { rows } = await db.query(
        `SELECT DISTINCT responsable_user_id AS id FROM schedule_events
         WHERE tipo = 'TURNO' AND sucursal_id = $1 AND puesto = $2
           AND fecha_hora::date = $3::date AND responsable_user_id IS NOT NULL`,
        [c.sucursal_id, c.puesto, diaISO]
      );
      rows.forEach((r) => ids.add(r.id));
    }
  }
  return [...ids];
}

function interpolar(texto, valores) {
  if (!texto) return texto;
  return texto
    .replaceAll('{nombre}', valores.nombre || '')
    .replaceAll('{usuario}', valores.usuario || '')
    .replaceAll('{sucursal}', valores.sucursal || '')
    .replaceAll('{fecha}', valores.fecha || '');
}

// Arma y manda las notificaciones de un comunicado ya creado - lo llaman
// tanto POST /api/comunicados (envío inmediato) como el scheduler (envío
// programado). Idempotente en el sentido de que solo actualiza enviado_en
// al final; el caller es responsable de no llamarla dos veces para el mismo
// comunicado (ver verificarComunicadosPendientes, que filtra enviado_en IS NULL).
async function enviarComunicado(comunicado) {
  const fechaReferencia = comunicado.fecha_envio ? new Date(comunicado.fecha_envio) : new Date();
  const destinatarioIds = await resolverDestinatarios(comunicado.audiencia_json, fechaReferencia);
  if (!destinatarioIds.length) {
    await db.query('UPDATE comunicados SET enviado_en = now(), cantidad_enviados = 0 WHERE id = $1', [comunicado.id]);
    return { enviados: 0 };
  }

  const { rows: usuarios } = await db.query(
    `SELECT u.id, u.nombre, u.email, u.usuario, s.nombre AS sucursal_nombre
     FROM usuarios u LEFT JOIN sucursales s ON s.id = u.sucursal_id
     WHERE u.id = ANY($1) AND u.activo = true`,
    [destinatarioIds]
  );
  if (!usuarios.length) {
    await db.query('UPDATE comunicados SET enviado_en = now(), cantidad_enviados = 0 WHERE id = $1', [comunicado.id]);
    return { enviados: 0 };
  }

  const fechaTexto = fechaReferencia.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: ZONA });
  const esSoloPush = !comunicado.descripcion && !comunicado.imagen_url && !comunicado.enlace;

  const filas = usuarios.map((u) => {
    const valores = { nombre: u.nombre || u.email, usuario: u.usuario || u.email, sucursal: u.sucursal_nombre || '', fecha: fechaTexto };
    const titulo = interpolar(comunicado.titulo, valores);
    const cuerpo = interpolar(comunicado.descripcion, valores) || null;
    const payload = {
      comunicado_id: comunicado.id,
      imagen_url: comunicado.imagen_url || null,
      enlace: comunicado.enlace || null,
      enlace_nombre: comunicado.enlace_nombre || null,
      solo_push: esSoloPush,
    };
    return [u.id, 'COMUNICADO', titulo, cuerpo, JSON.stringify(payload)];
  });

  const insertadas = await db.bulkInsert(db.pool, 'notificaciones', ['usuario_id', 'tipo', 'titulo', 'cuerpo', 'payload_json'], filas, 'id');

  await Promise.all(insertadas.map((fila, i) => empujarPushSeguro(() => enviarPush(usuarios[i].id, {
    titulo: filas[i][2],
    cuerpo: filas[i][3],
    tipo: 'COMUNICADO',
    url: esSoloPush ? undefined : `/comunicados/${fila.id}`,
  }))));

  await db.query('UPDATE comunicados SET enviado_en = now(), cantidad_enviados = $2 WHERE id = $1', [comunicado.id, usuarios.length]);
  return { enviados: usuarios.length };
}

async function verificarComunicadosPendientes() {
  try {
    const { rows } = await db.query(
      `SELECT * FROM comunicados WHERE enviado_en IS NULL AND fecha_envio IS NOT NULL AND fecha_envio <= now()`
    );
    for (const comunicado of rows) {
      try {
        await enviarComunicado(comunicado);
      } catch (err) {
        console.error(`[comunicados] error enviando comunicado ${comunicado.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[comunicados] error verificando pendientes:', err.message);
  }
}

function iniciarSchedulerComunicados() {
  verificarComunicadosPendientes();
  setInterval(verificarComunicadosPendientes, INTERVALO_CHEQUEO_MS);
}

module.exports = { resolverDestinatarios, interpolar, enviarComunicado, verificarComunicadosPendientes, iniciarSchedulerComunicados };
