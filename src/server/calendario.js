/**
 * ============================================================
 * CALENDARIO
 * ============================================================
 * Un evento = una ocurrencia concreta (fecha/hora puntual). Una serie
 * recurrente se resuelve en el momento de crearla: se generan N filas (una
 * por ocurrencia) con el mismo serie_id, en vez de guardar una regla que se
 * expande en cada lectura - simplifica mucho la consulta del mes a cambio
 * de pedir una fecha límite obligatoria en toda serie (ver generarFechas).
 *
 * Admin y Auditor ven/filtran todas las sucursales; Gerente solo la suya
 * (mismo criterio que el resto de la API, ver scopeSucursal).
 */

const db = require('../db');
const { puedeAccederSucursal, scopeSucursal } = require('../auth/middleware');
const { urlDeSubida } = require('../storage');
const { crearRun } = require('./runs');
const { crearNotificacion, crearNotificaciones } = require('./notificaciones');

const MAX_OCURRENCIAS = 200; // limite de seguridad para no crear series gigantes por error

// Un Gerente puede gestionar turnos solo de su propia sucursal; Admin, de
// cualquiera. Se usa en las rutas de turnos en vez de restringir a solo
// ADMIN/AUDITOR (que es la regla del resto del calendario).
function puedeGestionarTurnos(usuario, sucursalId) {
  if (usuario.rol === 'ADMIN') return true;
  if (usuario.rol === 'GERENTE') return usuario.sucursal_id === Number(sucursalId);
  return false;
}

// Además de los turnos, un Gerente puede editar/borrar lo que el mismo creó
// en su sucursal (sus auditorías internas y tareas programadas) - no lo que
// programó Admin/Auditor (auditorías de marca, seguimientos).
function puedeGestionarEvento(usuario, evento) {
  if (usuario.rol === 'ADMIN' || usuario.rol === 'AUDITOR') return true;
  if (evento.tipo === 'TURNO') return puedeGestionarTurnos(usuario, evento.sucursal_id);
  if (usuario.rol === 'GERENTE') return usuario.sucursal_id === evento.sucursal_id && evento.creado_por === usuario.usuarioId;
  return false;
}

const MOTIVOS_SOLICITUD_PRESET = ['Baja por malestar', 'Problemas personales', 'Evento especial'];

// Si no se da fecha_hasta en una "asignación programada", se materializa
// igual una ventana fija hacia adelante (no infinita: este modelo genera una
// fila por ocurrencia al crear la serie, no una regla que se expande sola -
// ver comentario de la tabla). Pasada esta ventana habría que volver a
// entrar y "correrla" - queda señalado como simplificación explícita.
const DIAS_VENTANA_SIN_FIN = 90;

// Genera las fechas de una serie recurrente a partir de la primera
// ocurrencia. `recurrencia` = { tipo: 'DIARIA'|'SEMANAL'|'MENSUAL', hasta: 'YYYY-MM-DD' }.
function generarFechas(fechaHoraInicial, recurrencia) {
  const fechas = [new Date(fechaHoraInicial)];
  if (!recurrencia || recurrencia.tipo === 'NINGUNA' || !recurrencia.hasta) return fechas;
  const limite = new Date(recurrencia.hasta + 'T23:59:59');
  const incrementar = (d) => {
    const nueva = new Date(d);
    if (recurrencia.tipo === 'DIARIA') nueva.setDate(nueva.getDate() + 1);
    else if (recurrencia.tipo === 'SEMANAL') nueva.setDate(nueva.getDate() + 7);
    else if (recurrencia.tipo === 'MENSUAL') nueva.setMonth(nueva.getMonth() + 1);
    return nueva;
  };
  let actual = incrementar(fechas[0]);
  while (actual <= limite && fechas.length < MAX_OCURRENCIAS) {
    fechas.push(actual);
    actual = incrementar(actual);
  }
  return fechas;
}

// Para "programar asignaciones": una ocurrencia por cada día entre
// fechaDesde y fechaHasta (o fechaDesde + DIAS_VENTANA_SIN_FIN si no hay
// fechaHasta) cuyo día de semana (0=domingo..6=sábado, igual que
// Date#getDay) esté en diasSemana Y tenga ese turno habilitado en
// `horarios` (ver obtenerHorariosSucursal) - un día sin ese turno
// habilitado simplemente no genera ocurrencia ahí.
function generarOcurrenciasTurnoProgramado(fechaDesde, fechaHasta, diasSemana, horarios, turnoTipo) {
  const desde = new Date(`${fechaDesde}T00:00:00`);
  const hasta = fechaHasta ? new Date(`${fechaHasta}T00:00:00`) : new Date(desde.getTime() + DIAS_VENTANA_SIN_FIN * 86400000);
  const set = new Set(diasSemana.map(Number));
  const ocurrencias = [];
  const cursor = new Date(desde);
  while (cursor <= hasta && ocurrencias.length < MAX_OCURRENCIAS) {
    const dia = cursor.getDay();
    if (set.has(dia)) {
      const horario = horarios.get(`${dia}|${turnoTipo}`);
      if (horario?.habilitado) ocurrencias.push(armarOcurrencia(cursor, horario));
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return ocurrencias;
}

// Horario de turnos: única fuente de verdad es sucursal_horarios_turno,
// configurable por día de semana desde la ficha de Sucursales (ver
// server/index.js) - acá solo se LEE para saber si un día+turno está
// habilitado y con qué horario, nunca se edita desde el calendario.
async function obtenerHorariosSucursal(sucursalId) {
  const { rows } = await db.query(
    'SELECT dia_semana, turno_tipo, habilitado, hora_desde, hora_hasta FROM sucursal_horarios_turno WHERE sucursal_id = $1',
    [sucursalId]
  );
  const mapa = new Map();
  for (const r of rows) {
    mapa.set(`${r.dia_semana}|${r.turno_tipo}`, { habilitado: r.habilitado, desde: r.hora_desde.slice(0, 5), hasta: r.hora_hasta.slice(0, 5) });
  }
  return mapa;
}

function diaSemanaDeFecha(fechaISO) {
  return new Date(`${fechaISO}T00:00:00`).getDay();
}

// fechaBase (Date, solo se usan año/mes/día) + horario {desde,hasta} (HH:MM)
// -> { inicio, duracionMinutos }. hasta <= desde se interpreta como que el
// turno cruza la medianoche.
function armarOcurrencia(fechaBase, horario) {
  const [h, m] = horario.desde.split(':').map(Number);
  const inicio = new Date(fechaBase.getFullYear(), fechaBase.getMonth(), fechaBase.getDate(), h, m);
  const [h2, m2] = horario.hasta.split(':').map(Number);
  const fin = new Date(fechaBase.getFullYear(), fechaBase.getMonth(), fechaBase.getDate(), h2, m2);
  if (fin <= inicio) fin.setDate(fin.getDate() + 1);
  return { inicio, duracionMinutos: Math.round((fin - inicio) / 60000) };
}

// Un Gerente no puede asignar una tarea/auditoría a un Admin (ni a un
// Auditor) - solo a otro Gerente de su misma sucursal o a un Colaborador.
// Admin/Auditor no tienen esta restricción.
async function validarResponsablePermitido(usuarioCreador, responsableUserId) {
  if (!responsableUserId || usuarioCreador.rol !== 'GERENTE') return;
  const { rows } = await db.query('SELECT rol, sucursal_id FROM usuarios WHERE id = $1', [responsableUserId]);
  const responsable = rows[0];
  if (!responsable || !['GERENTE', 'COLABORADOR'].includes(responsable.rol) || responsable.sucursal_id !== usuarioCreador.sucursal_id) {
    const error = new Error('Como gerente solo podés asignar a otro gerente de tu sucursal o a un colaborador');
    error.status = 403;
    throw error;
  }
}

module.exports = function registrarRutasCalendario(app) {
  app.get('/api/calendario', async (req, res) => {
    const { desde, hasta, sucursal_id, tipo, estado, responsable_id } = req.query;
    let sql = `SELECT e.*, s.nombre AS sucursal_nombre, u.nombre AS responsable_nombre,
                      t.nombre AS plantilla_nombre, t.tipo AS plantilla_tipo,
                      CASE WHEN e.estado = 'PENDIENTE' AND e.fecha_hora < now() THEN 'VENCIDA' ELSE e.estado END AS estado_efectivo
               FROM schedule_events e
               JOIN sucursales s ON s.id = e.sucursal_id
               LEFT JOIN usuarios u ON u.id = e.responsable_user_id
               LEFT JOIN audit_templates t ON t.id = e.template_id
               WHERE 1=1`;
    let params = [];
    if (req.usuario.rol === 'COLABORADOR') {
      // Un Colaborador solo ve lo que tiene asignado (sus turnos y las
      // tareas/auditorías donde es responsable) - nunca el calendario
      // completo de la sucursal.
      params.push(req.usuario.usuarioId); sql += ` AND e.responsable_user_id = $${params.length}`;
    } else if (req.usuario.rol === 'GERENTE') {
      const scoped = scopeSucursal(req.usuario, 'e.sucursal_id', params);
      sql += scoped.sql; params = scoped.params;
    } else if (sucursal_id) {
      params.push(sucursal_id); sql += ` AND e.sucursal_id = $${params.length}`;
    }
    if (desde) { params.push(desde); sql += ` AND e.fecha_hora >= $${params.length}`; }
    if (hasta) { params.push(hasta); sql += ` AND e.fecha_hora <= $${params.length}`; }
    // `tipo` acepta uno o varios valores separados por coma (filtro multi-select del calendario).
    if (tipo) { params.push(String(tipo).split(',')); sql += ` AND e.tipo = ANY($${params.length})`; }
    if (estado) { params.push(estado); sql += ` AND e.estado = $${params.length}`; }
    if (responsable_id) { params.push(responsable_id); sql += ` AND e.responsable_user_id = $${params.length}`; }
    sql += ' ORDER BY e.fecha_hora';
    try {
      const { rows } = await db.query(sql, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Body: { sucursal_id, tipo, template_id (AUDITORIA), titulo, descripcion,
  // responsable_user_id, fecha_hora, duracion_minutos, recurrencia }
  app.post('/api/calendario', async (req, res) => {
    const { sucursal_id, tipo, template_id, titulo, descripcion, responsable_user_id, fecha_hora, duracion_minutos, recurrencia } = req.body;
    if (!sucursal_id || !tipo || !fecha_hora) return res.status(400).json({ error: 'Faltan campos: sucursal_id, tipo, fecha_hora' });
    if (!['AUDITORIA', 'SEGUIMIENTO', 'TAREA'].includes(tipo)) return res.status(400).json({ error: 'tipo inválido' });
    if (tipo !== 'TAREA' && !template_id) return res.status(400).json({ error: 'Falta template_id para una auditoría/seguimiento' });
    if (!puedeAccederSucursal(req.usuario, sucursal_id)) return res.status(403).json({ error: 'No tenés acceso a esa sucursal' });

    let plantilla = null;
    if (template_id) {
      const { rows } = await db.query('SELECT nombre, tipo FROM audit_templates WHERE id = $1', [template_id]);
      plantilla = rows[0];
    }
    // Un Gerente solo puede programar cosas de su propia sucursal, y solo
    // auditorías internas (nunca de marca) o tareas - las de marca las
    // programa Admin/Auditor.
    if (req.usuario.rol === 'GERENTE') {
      if (Number(sucursal_id) !== req.usuario.sucursal_id) return res.status(403).json({ error: 'Solo podés programar en tu propia sucursal' });
      if (tipo !== 'TAREA' && plantilla?.tipo !== 'INTERNA') return res.status(403).json({ error: 'Como gerente solo podés programar auditorías internas o tareas' });
    } else if (req.usuario.rol !== 'ADMIN' && req.usuario.rol !== 'AUDITOR') {
      return res.status(403).json({ error: 'Solo Administrador, Auditor o Gerente pueden programar el calendario' });
    }

    let tituloFinal = titulo || plantilla?.nombre;
    if (!tituloFinal) return res.status(400).json({ error: 'Falta el título' });

    const fechas = generarFechas(fecha_hora, recurrencia);
    try {
      await validarResponsablePermitido(req.usuario, responsable_user_id);
      const filas = fechas.map((f) => [
        sucursal_id, tipo, tipo === 'TAREA' ? null : template_id, tituloFinal, descripcion || null,
        responsable_user_id || null, f.toISOString(), duracion_minutos || null, req.usuario.usuarioId,
      ]);
      const insertados = await db.bulkInsert(db.pool, 'schedule_events',
        ['sucursal_id', 'tipo', 'template_id', 'titulo', 'descripcion', 'responsable_user_id', 'fecha_hora', 'duracion_minutos', 'creado_por'],
        filas, 'id');
      if (insertados.length > 1) {
        const serieId = insertados[0].id;
        await db.query('UPDATE schedule_events SET serie_id = $1 WHERE id = ANY($2)', [serieId, insertados.map((r) => r.id)]);
      }
      if (responsable_user_id) {
        await crearNotificacion(responsable_user_id, 'ASIGNACION', `Te asignaron: ${tituloFinal}`,
          `Nueva ${tipo === 'TAREA' ? 'tarea' : 'auditoría'} programada en el calendario.`, { evento_id: insertados[0].id });
      }
      res.status(201).json({ creados: insertados.length });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  async function obtenerEventoOForbidden(req, res) {
    const { rows } = await db.query('SELECT * FROM schedule_events WHERE id = $1', [req.params.id]);
    const evento = rows[0];
    if (!evento) { res.status(404).json({ error: 'Evento no encontrado' }); return null; }
    if (!puedeAccederSucursal(req.usuario, evento.sucursal_id)) { res.status(403).json({ error: 'No tenés acceso' }); return null; }
    return evento;
  }

  app.patch('/api/calendario/:id', async (req, res) => {
    const evento = await obtenerEventoOForbidden(req, res);
    if (!evento) return;
    if (!puedeGestionarEvento(req.usuario, evento)) return res.status(403).json({ error: 'No tenés permiso para editar este evento' });
    const { titulo, descripcion, responsable_user_id, fecha_hora, estado } = req.body;
    // Reasignar el responsable de un turno con una solicitud de revisión
    // pendiente la da por resuelta - es la forma mas comun de resolverla
    // (sacar a la persona y poner a otra), sin necesitar un paso aparte.
    const resuelveSolicitud = evento.tipo === 'TURNO' && evento.solicitud_revision_estado === 'PENDIENTE'
      && responsable_user_id !== undefined && Number(responsable_user_id) !== evento.responsable_user_id;
    try {
      await validarResponsablePermitido(req.usuario, responsable_user_id);
      const { rows } = await db.query(
        `UPDATE schedule_events SET titulo = COALESCE($1,titulo), descripcion = COALESCE($2,descripcion),
         responsable_user_id = COALESCE($3,responsable_user_id), fecha_hora = COALESCE($4,fecha_hora),
         estado = COALESCE($5,estado),
         solicitud_revision_estado = CASE WHEN $7 THEN 'RESUELTA' ELSE solicitud_revision_estado END
         WHERE id = $6 RETURNING *`,
        [titulo ?? null, descripcion ?? null, responsable_user_id ?? null, fecha_hora ?? null, estado ?? null, req.params.id, resuelveSolicitud]
      );
      res.json(rows[0]);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // ?serie=true borra esta ocurrencia y las futuras de la misma serie.
  app.delete('/api/calendario/:id', async (req, res) => {
    const evento = await obtenerEventoOForbidden(req, res);
    if (!evento) return;
    if (!puedeGestionarEvento(req.usuario, evento)) return res.status(403).json({ error: 'No tenés permiso para eliminar este evento' });
    try {
      if (req.query.serie === 'true' && evento.serie_id) {
        await db.query('DELETE FROM schedule_events WHERE serie_id = $1 AND fecha_hora >= $2', [evento.serie_id, evento.fecha_hora]);
      } else {
        await db.query('DELETE FROM schedule_events WHERE id = $1', [req.params.id]);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Arranca la auditoria/seguimiento real de un evento del calendario -
  // reusa la misma validacion/armado de snapshot que POST /api/runs (ver
  // crearRun en runs.js). El evento del calendario queda COMPLETADA en
  // cuanto se inicia la ejecucion (no espera a que la auditoria termine) -
  // simplificacion: si el auditor abandona la auditoria a mitad de camino,
  // el evento del calendario igual queda marcado como atendido.
  app.post('/api/calendario/:id/iniciar', async (req, res) => {
    const evento = await obtenerEventoOForbidden(req, res);
    if (!evento) return;
    if (evento.tipo === 'TAREA') return res.status(400).json({ error: 'Este evento es una tarea, no una auditoría - usá /completar' });
    if (!evento.template_id) return res.status(400).json({ error: 'El evento no tiene una plantilla asociada' });
    try {
      // tipo 'AUDITORIA' (evento de calendario) no es un audit_runs.tipo
      // valido - se omite para que crearRun use el tipo propio de la
      // plantilla (MARCA/INTERNA). 'SEGUIMIENTO' sí es valido en ambos.
      const run = await crearRun({
        templateId: evento.template_id, sucursalId: evento.sucursal_id,
        tipo: evento.tipo === 'SEGUIMIENTO' ? 'SEGUIMIENTO' : undefined,
        rol: req.usuario.rol, auditorUserId: req.usuario.usuarioId, responsableNombre: null,
      });
      await db.query(`UPDATE schedule_events SET estado = 'COMPLETADA', run_id = $1 WHERE id = $2`, [run.id, req.params.id]);
      res.status(201).json(run);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post('/api/calendario/:id/evidencia/url-subida', async (req, res) => {
    const evento = await obtenerEventoOForbidden(req, res);
    if (!evento) return;
    try {
      const resultado = await urlDeSubida({ contentType: req.body.content_type, runId: `tarea-${req.params.id}` });
      res.json(resultado);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Cumplimiento de una TAREA: { comentario, evidencia_url, evidencia_tipo }.
  app.post('/api/calendario/:id/completar', async (req, res) => {
    const evento = await obtenerEventoOForbidden(req, res);
    if (!evento) return;
    if (evento.tipo !== 'TAREA') return res.status(400).json({ error: 'Solo las tareas se completan así - una auditoría se inicia con /iniciar' });
    const { comentario, evidencia_url, evidencia_tipo } = req.body;
    try {
      const { rows } = await db.query(
        `UPDATE schedule_events SET estado = 'COMPLETADA', completado_en = now(), completado_por = $1,
         completado_comentario = $2, evidencia_url = $3, evidencia_tipo = $4 WHERE id = $5 RETURNING *`,
        [req.usuario.usuarioId, comentario || null, evidencia_url || null, evidencia_tipo || null, req.params.id]
      );
      res.json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ------------------------------------------------------------
  // Turnos (tipo TURNO de schedule_events) - gestión de un Gerente (o Admin)
  // para su sucursal. El horario de cada turno sale de sucursales.turno_* -
  // acá solo se elige día y DIURNO/NOCTURNO (ver obtenerHorariosSucursal).
  // ------------------------------------------------------------

  async function obtenerSucursalOError(sucursalId) {
    const { rows } = await db.query('SELECT * FROM sucursales WHERE id = $1', [sucursalId]);
    if (!rows[0]) { const e = new Error('Sucursal no encontrada'); e.status = 404; throw e; }
    return rows[0];
  }

  // Alta rápida de un turno (el "+" de la grilla semanal/mensual): un solo
  // colaborador, un solo día.
  // Body: { sucursal_id, fecha (YYYY-MM-DD), turno_tipo, responsable_user_id, puesto, notificar }
  app.post('/api/calendario/turnos', async (req, res) => {
    const { sucursal_id, fecha, turno_tipo, responsable_user_id, puesto, notificar } = req.body;
    if (!sucursal_id || !fecha || !turno_tipo || !responsable_user_id || !puesto) {
      return res.status(400).json({ error: 'Faltan campos: sucursal_id, fecha, turno_tipo, responsable_user_id, puesto' });
    }
    if (!['DIURNO', 'NOCTURNO'].includes(turno_tipo)) return res.status(400).json({ error: 'turno_tipo inválido' });
    if (!puedeGestionarTurnos(req.usuario, sucursal_id)) return res.status(403).json({ error: 'No podés gestionar los turnos de esta sucursal' });

    try {
      await validarResponsablePermitido(req.usuario, responsable_user_id);
      await obtenerSucursalOError(sucursal_id);
      const horarios = await obtenerHorariosSucursal(sucursal_id);
      const horario = horarios.get(`${diaSemanaDeFecha(fecha)}|${turno_tipo}`);
      if (!horario?.habilitado) return res.status(400).json({ error: 'Este turno no está habilitado ese día para esta sucursal (configuralo en la ficha de la sucursal)' });
      const { inicio, duracionMinutos } = armarOcurrencia(new Date(`${fecha}T00:00:00`), horario);
      const { rows } = await db.query(
        `INSERT INTO schedule_events (sucursal_id, tipo, titulo, responsable_user_id, puesto, turno_tipo, fecha_hora, duracion_minutos, creado_por)
         VALUES ($1,'TURNO',$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [sucursal_id, `Turno ${turno_tipo === 'DIURNO' ? 'diurno' : 'nocturno'}`, responsable_user_id, puesto, turno_tipo, inicio.toISOString(), duracionMinutos, req.usuario.usuarioId]
      );
      if (notificar) {
        await crearNotificacion(responsable_user_id, 'TURNOS_ASIGNADOS', 'Nuevo turno asignado',
          'Ya podés ver tu turno asignado en el calendario.', { sucursal_id, evento_id: rows[0].id });
      }
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // "Programar asignaciones": un patrón que se repite en ciertos días de la
  // semana, entre una fecha desde y una fecha hasta (opcional - ver
  // generarOcurrenciasTurnoProgramado y DIAS_VENTANA_SIN_FIN si se omite).
  // Body: { sucursal_id, responsable_user_id, puesto, turno_tipo, dias_semana: [0..6],
  //         fecha_desde, fecha_hasta (opcional), notificar }
  app.post('/api/calendario/turnos/programar', async (req, res) => {
    const { sucursal_id, responsable_user_id, puesto, turno_tipo, dias_semana, fecha_desde, fecha_hasta, notificar } = req.body;
    if (!sucursal_id || !responsable_user_id || !puesto || !turno_tipo || !Array.isArray(dias_semana) || !dias_semana.length || !fecha_desde) {
      return res.status(400).json({ error: 'Faltan campos: sucursal_id, responsable_user_id, puesto, turno_tipo, dias_semana, fecha_desde' });
    }
    if (!['DIURNO', 'NOCTURNO'].includes(turno_tipo)) return res.status(400).json({ error: 'turno_tipo inválido' });
    if (!puedeGestionarTurnos(req.usuario, sucursal_id)) return res.status(403).json({ error: 'No podés gestionar los turnos de esta sucursal' });

    try {
      await validarResponsablePermitido(req.usuario, responsable_user_id);
      await obtenerSucursalOError(sucursal_id);
      const horarios = await obtenerHorariosSucursal(sucursal_id);
      const diasPedidos = dias_semana.map(Number);
      const diasHabilitados = diasPedidos.filter((d) => horarios.get(`${d}|${turno_tipo}`)?.habilitado);
      const diasOmitidos = diasPedidos.filter((d) => !diasHabilitados.includes(d));
      if (!diasHabilitados.length) {
        return res.status(400).json({ error: 'Ninguno de los días elegidos tiene este turno habilitado en esta sucursal (configuralo en la ficha de la sucursal)' });
      }

      const ocurrencias = generarOcurrenciasTurnoProgramado(fecha_desde, fecha_hasta || null, diasHabilitados, horarios, turno_tipo);
      if (!ocurrencias.length) return res.status(400).json({ error: 'El rango de fechas no incluye ninguno de los días elegidos' });
      const filas = ocurrencias.map(({ inicio, duracionMinutos }) => [
        sucursal_id, 'TURNO', `Turno ${turno_tipo === 'DIURNO' ? 'diurno' : 'nocturno'}`, responsable_user_id, puesto, turno_tipo,
        inicio.toISOString(), duracionMinutos, req.usuario.usuarioId,
      ]);
      const insertados = await db.bulkInsert(db.pool, 'schedule_events',
        ['sucursal_id', 'tipo', 'titulo', 'responsable_user_id', 'puesto', 'turno_tipo', 'fecha_hora', 'duracion_minutos', 'creado_por'],
        filas, 'id');
      const serieId = insertados[0].id;
      await db.query('UPDATE schedule_events SET serie_id = $1 WHERE id = ANY($2)', [serieId, insertados.map((r) => r.id)]);

      if (notificar) {
        await crearNotificacion(responsable_user_id, 'TURNOS_ASIGNADOS', 'Nuevos turnos asignados',
          `Se te asignaron ${insertados.length} turnos.`, { sucursal_id });
      }
      res.status(201).json({
        creados: insertados.length,
        ventanaSinFin: !fecha_hasta ? DIAS_VENTANA_SIN_FIN : null,
        diasOmitidos: diasOmitidos.length ? diasOmitidos : undefined,
      });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // Un Colaborador pide no asistir a un turno propio.
  app.post('/api/calendario/:id/solicitar-revision', async (req, res) => {
    const evento = await obtenerEventoOForbidden(req, res);
    if (!evento) return;
    if (evento.tipo !== 'TURNO') return res.status(400).json({ error: 'Solo se puede solicitar revisión de un turno' });
    if (evento.responsable_user_id !== req.usuario.usuarioId) return res.status(403).json({ error: 'Este turno no es tuyo' });
    const motivo = (req.body.motivo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'Falta el motivo (podés usar uno de los sugeridos: ' + MOTIVOS_SOLICITUD_PRESET.join(', ') + ')' });

    try {
      const { rows } = await db.query(
        `UPDATE schedule_events SET solicitud_revision_motivo = $1, solicitud_revision_en = now(),
         solicitud_revision_estado = 'PENDIENTE' WHERE id = $2 RETURNING *`,
        [motivo, req.params.id]
      );
      const { rows: gerentes } = await db.query(
        `SELECT id FROM usuarios WHERE activo = true AND sucursal_id = $1 AND rol = 'GERENTE'`,
        [evento.sucursal_id]
      );
      const destinatarios = gerentes.map((g) => g.id);
      if (destinatarios.length) {
        await crearNotificaciones(destinatarios, 'SOLICITUD_REVISION_TURNO',
          `${req.usuario.nombre || req.usuario.email} no puede asistir a su turno`,
          motivo, { evento_id: evento.id, sucursal_id: evento.sucursal_id });
      }
      res.json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Solicitudes de revisión pendientes, para que Gerente/Admin/Auditor las resuelva.
  app.get('/api/calendario/solicitudes', async (req, res) => {
    let sql = `SELECT e.*, s.nombre AS sucursal_nombre, u.nombre AS responsable_nombre
               FROM schedule_events e
               JOIN sucursales s ON s.id = e.sucursal_id
               LEFT JOIN usuarios u ON u.id = e.responsable_user_id
               WHERE e.tipo = 'TURNO' AND e.solicitud_revision_estado = 'PENDIENTE'`;
    let params = [];
    if (req.usuario.rol === 'GERENTE') {
      const scoped = scopeSucursal(req.usuario, 'e.sucursal_id', params);
      sql += scoped.sql; params = scoped.params;
    } else if (req.usuario.rol !== 'ADMIN' && req.usuario.rol !== 'AUDITOR') {
      return res.status(403).json({ error: 'No tenés acceso a las solicitudes de revisión' });
    }
    sql += ' ORDER BY e.solicitud_revision_en';
    try {
      const { rows } = await db.query(sql, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Descarta una solicitud sin reasignar (ej: se habló con la persona y sigue en el turno).
  app.post('/api/calendario/:id/resolver-solicitud', async (req, res) => {
    const evento = await obtenerEventoOForbidden(req, res);
    if (!evento) return;
    if (!puedeGestionarTurnos(req.usuario, evento.sucursal_id) && req.usuario.rol !== 'AUDITOR') {
      return res.status(403).json({ error: 'No tenés permiso para resolver esta solicitud' });
    }
    try {
      const { rows } = await db.query(
        `UPDATE schedule_events SET solicitud_revision_estado = 'RESUELTA' WHERE id = $1 RETURNING *`,
        [req.params.id]
      );
      res.json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
};

module.exports.MOTIVOS_SOLICITUD_PRESET = MOTIVOS_SOLICITUD_PRESET;
