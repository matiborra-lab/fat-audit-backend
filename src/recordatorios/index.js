/**
 * ============================================================
 * RECORDATORIOS (motor de preferencias de notificación)
 * ============================================================
 * Chequeo periódico (mismo patrón que src/feriados/src/reportes - setInterval
 * en memoria, sin cron del SO) que cubre 3 tipos de recordatorio, cada uno
 * gateado por notificacion_preferencias del usuario que lo recibe:
 *
 * 1. Evento puntual (Tarea/Auditoría/Seguimiento/Evento especial): avisa
 *    `anticipacion_horas` antes de la fecha_hora del evento.
 * 2. Cumpleaños: avisa a las 00:00 del día de cumpleaños de un colaborador,
 *    a todos los usuarios de su sucursal.
 * 3. Clima: evalúa las reglas de notificacion_reglas_clima de cada usuario
 *    contra el pronóstico de su sucursal.
 *
 * Dedup vía recordatorios_enviados - por evento+usuario para (1), por una
 * clave lógica de texto para (2)/(3) (no hay un schedule_event al que
 * atarse). Todo corre en huso Argentina (ver TZ fijado en server/index.js).
 */

const db = require('../db');
const { crearNotificacion } = require('../server/notificaciones');
const { obtenerPronostico } = require('../clima');

const INTERVALO_CHEQUEO_MS = 30 * 60 * 1000; // 30 minutos
const ZONA = 'America/Argentina/Buenos_Aires';

const ANTICIPACION_HORAS_DEFAULT = { RECORDATORIO_TAREA: 1, RECORDATORIO_AUDITORIA: 24, RECORDATORIO_EVENTO_ESPECIAL: 24 };

const ETIQUETA_TIPO_EVENTO = { TAREA: 'una tarea', AUDITORIA: 'una auditoría', SEGUIMIENTO: 'un seguimiento' };

// Códigos WMO que devuelve Open-Meteo (ver src/clima) - etiquetas cortas
// para el texto del aviso, no hace falta cubrir todos, solo los frecuentes.
const ETIQUETA_CLIMA_WMO = {
  0: 'Despejado', 1: 'Mayormente despejado', 2: 'Parcialmente nublado', 3: 'Nublado',
  45: 'Niebla', 48: 'Niebla',
  51: 'Llovizna', 53: 'Llovizna', 55: 'Llovizna',
  61: 'Lluvia', 63: 'Lluvia', 65: 'Lluvia fuerte',
  71: 'Nieve', 73: 'Nieve', 75: 'Nieve fuerte',
  80: 'Chubascos', 81: 'Chubascos', 82: 'Chubascos fuertes',
  95: 'Tormenta', 96: 'Tormenta con granizo', 99: 'Tormenta con granizo',
};

function aClaveDia(d) {
  // Se arma a partir de los componentes en huso Argentina (no
  // toISOString, que es UTC) - con TZ fijado en el proceso, los
  // getFullYear/Month/Date de un Date ya vienen en huso Argentina.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Trae de una, para varios usuarios, las preferencias de varios tipos -
// devuelve un Map `${usuario_id}|${tipo}` -> fila.
async function obtenerPreferencias(usuarioIds, tipos) {
  if (!usuarioIds.length) return new Map();
  const { rows } = await db.query(
    'SELECT usuario_id, tipo, habilitado, anticipacion_horas FROM notificacion_preferencias WHERE usuario_id = ANY($1) AND tipo = ANY($2)',
    [usuarioIds, tipos]
  );
  return new Map(rows.map((r) => [`${r.usuario_id}|${r.tipo}`, r]));
}

function preferenciaEfectiva(mapa, usuarioId, tipo) {
  const fila = mapa.get(`${usuarioId}|${tipo}`);
  if (fila) return { habilitado: fila.habilitado, anticipacionHoras: fila.anticipacion_horas ?? ANTICIPACION_HORAS_DEFAULT[tipo] };
  return { habilitado: true, anticipacionHoras: ANTICIPACION_HORAS_DEFAULT[tipo] };
}

async function yaEnviado({ scheduleEventId = null, usuarioId, tipo, clave = null }) {
  const { rows } = await db.query(
    scheduleEventId
      ? 'SELECT 1 FROM recordatorios_enviados WHERE schedule_event_id = $1 AND usuario_id = $2 AND tipo = $3'
      : 'SELECT 1 FROM recordatorios_enviados WHERE usuario_id = $1 AND tipo = $2 AND clave = $3',
    scheduleEventId ? [scheduleEventId, usuarioId, tipo] : [usuarioId, tipo, clave]
  );
  return rows.length > 0;
}

async function marcarEnviado({ scheduleEventId = null, usuarioId, tipo, clave = null }) {
  await db.query(
    'INSERT INTO recordatorios_enviados (schedule_event_id, usuario_id, tipo, clave) VALUES ($1,$2,$3,$4)',
    [scheduleEventId, usuarioId, tipo, clave]
  );
}

// ------------------------------------------------------------
// 1) Recordatorio de evento puntual (Tarea/Auditoría/Seguimiento/Evento especial)
// ------------------------------------------------------------
async function verificarRecordatoriosDeEvento() {
  const { rows: eventos } = await db.query(
    `SELECT se.id, se.tipo, se.sucursal_id, se.fecha_hora, se.responsable_user_id, se.titulo, s.nombre AS sucursal_nombre
     FROM schedule_events se JOIN sucursales s ON s.id = se.sucursal_id
     WHERE se.tipo IN ('TAREA', 'AUDITORIA', 'SEGUIMIENTO') AND se.estado = 'PENDIENTE'
       AND se.responsable_user_id IS NOT NULL
       AND (se.tipo != 'TAREA' OR se.hora_definida)
       AND se.fecha_hora > now()`
  );
  const eventosEspeciales = await db.query(
    `SELECT se.id, se.sucursal_id, se.fecha_hora, se.responsable_user_id, se.titulo, s.nombre AS sucursal_nombre
     FROM schedule_events se JOIN sucursales s ON s.id = se.sucursal_id
     WHERE se.tipo = 'EVENTO_ESPECIAL' AND se.fecha_hora > now()`
  );

  // Arma la lista de (evento, usuarioDestino, preferenciaTipo) a evaluar -
  // Tarea/Auditoría solo al responsable; Evento especial al responsable si
  // hay uno, o a todo el personal de la sucursal si no.
  const candidatos = [];
  for (const e of eventos) {
    candidatos.push({ evento: e, usuarioId: e.responsable_user_id, preferenciaTipo: e.tipo === 'TAREA' ? 'RECORDATORIO_TAREA' : 'RECORDATORIO_AUDITORIA' });
  }
  const sucursalesYaResueltas = new Map(); // sucursal_id -> [usuario_id]
  for (const e of eventosEspeciales.rows) {
    if (e.responsable_user_id) {
      candidatos.push({ evento: e, usuarioId: e.responsable_user_id, preferenciaTipo: 'RECORDATORIO_EVENTO_ESPECIAL' });
      continue;
    }
    if (!sucursalesYaResueltas.has(e.sucursal_id)) {
      const { rows: personal } = await db.query(
        `SELECT id FROM usuarios WHERE activo = true AND sucursal_id = $1 AND rol IN ('GERENTE','COLABORADOR')`,
        [e.sucursal_id]
      );
      sucursalesYaResueltas.set(e.sucursal_id, personal.map((p) => p.id));
    }
    for (const usuarioId of sucursalesYaResueltas.get(e.sucursal_id)) {
      candidatos.push({ evento: e, usuarioId, preferenciaTipo: 'RECORDATORIO_EVENTO_ESPECIAL' });
    }
  }
  if (!candidatos.length) return;

  const usuarioIds = [...new Set(candidatos.map((c) => c.usuarioId))];
  const prefMap = await obtenerPreferencias(usuarioIds, ['RECORDATORIO_TAREA', 'RECORDATORIO_AUDITORIA', 'RECORDATORIO_EVENTO_ESPECIAL']);

  for (const { evento, usuarioId, preferenciaTipo } of candidatos) {
    try {
      const pref = preferenciaEfectiva(prefMap, usuarioId, preferenciaTipo);
      if (!pref.habilitado) continue;
      const disparaEn = new Date(evento.fecha_hora).getTime() - pref.anticipacionHoras * 3600000;
      if (disparaEn > Date.now()) continue;
      if (await yaEnviado({ scheduleEventId: evento.id, usuarioId, tipo: preferenciaTipo })) continue;

      const hora = new Date(evento.fecha_hora).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: ZONA });
      const cuerpo = preferenciaTipo === 'RECORDATORIO_EVENTO_ESPECIAL'
        ? `${evento.titulo} en ${evento.sucursal_nombre}, hoy a las ${hora}.`
        : `Tenés ${ETIQUETA_TIPO_EVENTO[evento.tipo]} programada en ${evento.sucursal_nombre} a las ${hora}: ${evento.titulo}.`;
      await crearNotificacion(usuarioId, 'RECORDATORIO', 'Recordatorio', cuerpo, { evento_id: evento.id, sucursal_id: evento.sucursal_id });
      await marcarEnviado({ scheduleEventId: evento.id, usuarioId, tipo: preferenciaTipo });
    } catch (err) {
      console.error(`[recordatorios] error en evento ${evento.id} / usuario ${usuarioId}:`, err.message);
    }
  }
}

// ------------------------------------------------------------
// 2) Cumpleaños - una vez por día, a las 00:xx ART
// ------------------------------------------------------------
function esCumpleanosHoy(fechaNacimiento, hoy) {
  const fn = new Date(fechaNacimiento);
  const bisiesto = (hoy.getFullYear() % 4 === 0 && hoy.getFullYear() % 100 !== 0) || hoy.getFullYear() % 400 === 0;
  const dia = fn.getUTCMonth() === 1 && fn.getUTCDate() === 29 && !bisiesto ? 28 : fn.getUTCDate();
  return fn.getUTCMonth() === hoy.getMonth() && dia === hoy.getDate();
}

async function verificarRecordatoriosCumpleanos() {
  const ahora = new Date(); // ya en huso ART (TZ del proceso)
  if (ahora.getHours() !== 0) return; // corre una sola vez por día, ventana [00:00, 01:00)

  const { rows: sucursales } = await db.query('SELECT id FROM sucursales WHERE activo = true');
  for (const s of sucursales) {
    const { rows: colaboradores } = await db.query(
      `SELECT id AS usuario_id, nombre, fecha_nacimiento FROM usuarios
       WHERE sucursal_id = $1 AND activo = true AND rol IN ('GERENTE','COLABORADOR') AND fecha_nacimiento IS NOT NULL`,
      [s.id]
    );
    const cumpleanerosDeHoy = colaboradores.filter((u) => esCumpleanosHoy(u.fecha_nacimiento, ahora));
    if (!cumpleanerosDeHoy.length) continue;

    const { rows: destinatarios } = await db.query(
      `SELECT id FROM usuarios WHERE activo = true AND sucursal_id = $1 AND rol IN ('GERENTE','COLABORADOR')`,
      [s.id]
    );
    if (!destinatarios.length) continue;
    const prefMap = await obtenerPreferencias(destinatarios.map((d) => d.id), ['CUMPLEANOS']);

    for (const destinatario of destinatarios) {
      const pref = preferenciaEfectiva(prefMap, destinatario.id, 'CUMPLEANOS');
      if (!pref.habilitado) continue;
      for (const cumpleanero of cumpleanerosDeHoy) {
        try {
          const clave = `CUMPLEANOS-${cumpleanero.usuario_id}-${ahora.getFullYear()}`;
          if (await yaEnviado({ usuarioId: destinatario.id, tipo: 'CUMPLEANOS', clave })) continue;
          await crearNotificacion(destinatario.id, 'CUMPLEANOS', 'Cumpleaños', `Hoy es el cumpleaños de ${cumpleanero.nombre}.`, { usuario_id: cumpleanero.usuario_id });
          await marcarEnviado({ usuarioId: destinatario.id, tipo: 'CUMPLEANOS', clave });
        } catch (err) {
          console.error(`[recordatorios] error avisando cumpleaños de ${cumpleanero.usuario_id} a ${destinatario.id}:`, err.message);
        }
      }
    }
  }
}

// ------------------------------------------------------------
// 3) Clima - una vez por día, evalúa las reglas de cada usuario
// ------------------------------------------------------------
function cumpleRegla(regla, dia) {
  if (regla.campo === 'weather_code') return Number(dia.weather_code) === Number(regla.valor);
  const temp = regla.operador === 'gte' ? dia.temp_max : dia.temp_min;
  return regla.operador === 'gte' ? Number(temp) >= Number(regla.valor) : Number(temp) <= Number(regla.valor);
}

function etiquetaRegla(regla) {
  if (regla.campo === 'weather_code') return ETIQUETA_CLIMA_WMO[regla.valor] || 'condición climática configurada';
  return `temperatura ${regla.operador === 'gte' ? '≥' : '≤'} ${regla.valor}°C`;
}

async function verificarRecordatoriosClima() {
  const ahora = new Date();
  if (ahora.getHours() !== 0) return; // una sola vez por día

  const { rows: reglas } = await db.query(
    `SELECT r.*, u.sucursal_id FROM notificacion_reglas_clima r
     JOIN usuarios u ON u.id = r.usuario_id
     WHERE u.activo = true AND u.sucursal_id IS NOT NULL`
  );
  if (!reglas.length) return;

  const prefMap = await obtenerPreferencias([...new Set(reglas.map((r) => r.usuario_id))], ['CLIMA']);
  const pronosticoPorSucursal = new Map();

  for (const regla of reglas) {
    try {
      const pref = preferenciaEfectiva(prefMap, regla.usuario_id, 'CLIMA');
      if (!pref.habilitado) continue;

      if (!pronosticoPorSucursal.has(regla.sucursal_id)) {
        const { rows: [sucursal] } = await db.query('SELECT latitud, longitud FROM sucursales WHERE id = $1', [regla.sucursal_id]);
        pronosticoPorSucursal.set(regla.sucursal_id, sucursal?.latitud && sucursal?.longitud ? await obtenerPronostico(sucursal.latitud, sucursal.longitud) : []);
      }
      const pronostico = pronosticoPorSucursal.get(regla.sucursal_id);

      for (const dia of pronostico) {
        if (!cumpleRegla(regla, dia)) continue;
        const fechaObjetivo = new Date(`${dia.fecha}T00:00:00`);
        fechaObjetivo.setDate(fechaObjetivo.getDate() - regla.anticipacion_dias);
        if (aClaveDia(fechaObjetivo) !== aClaveDia(ahora)) continue;

        const clave = `CLIMA-${regla.id}-${dia.fecha}`;
        if (await yaEnviado({ usuarioId: regla.usuario_id, tipo: 'CLIMA', clave })) continue;
        const cuandoTexto = regla.anticipacion_dias === 0 ? 'hoy' : `el ${dia.fecha}`;
        await crearNotificacion(regla.usuario_id, 'CLIMA', 'Aviso de clima', `Pronóstico de ${etiquetaRegla(regla)} para ${cuandoTexto}.`, { fecha: dia.fecha, regla_id: regla.id });
        await marcarEnviado({ usuarioId: regla.usuario_id, tipo: 'CLIMA', clave });
      }
    } catch (err) {
      console.error(`[recordatorios] error evaluando regla de clima ${regla.id}:`, err.message);
    }
  }
}

async function verificarRecordatorios() {
  try {
    await verificarRecordatoriosDeEvento();
  } catch (err) {
    console.error('[recordatorios] error verificando eventos:', err.message);
  }
  try {
    await verificarRecordatoriosCumpleanos();
  } catch (err) {
    console.error('[recordatorios] error verificando cumpleaños:', err.message);
  }
  try {
    await verificarRecordatoriosClima();
  } catch (err) {
    console.error('[recordatorios] error verificando clima:', err.message);
  }
}

function iniciarSchedulerRecordatorios() {
  verificarRecordatorios();
  setInterval(verificarRecordatorios, INTERVALO_CHEQUEO_MS);
}

module.exports = { iniciarSchedulerRecordatorios, verificarRecordatorios };
