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
const { crearRun, crearRunDesdeHallazgos } = require('./runs');
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

// Recurrencia rica compartida por TAREA y AUDITORIA (a diferencia de los
// turnos, acá la hora la elige libremente quien programa - no depende de
// sucursal_horarios_turno). Si no se pasa horaHHMM, cada ocurrencia queda al
// inicio del día (00:00) y el caller marca hora_definida = false (ver POST
// /api/calendario/tareas/programar y el bloque usaRecurrenciaRica de POST
// /api/calendario).
// Repetición diaria (sin elegir días puntuales) - una ocurrencia por cada
// día del rango, todos los días de la semana.
function generarFechasTareaDiaria(fechaDesde, fechaHasta, horaHHMM) {
  const desde = new Date(`${fechaDesde}T00:00:00`);
  const hasta = fechaHasta ? new Date(`${fechaHasta}T23:59:59`) : new Date(desde.getTime() + DIAS_VENTANA_SIN_FIN * 86400000);
  const [h, m] = horaHHMM ? horaHHMM.split(':').map(Number) : [0, 0];
  const fechas = [];
  const cursor = new Date(desde);
  while (cursor <= hasta && fechas.length < MAX_OCURRENCIAS) {
    fechas.push(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), h, m));
    cursor.setDate(cursor.getDate() + 1);
  }
  return fechas;
}

function generarFechasTareaPorDiaSemana(fechaDesde, fechaHasta, diasSemana, horaHHMM) {
  const desde = new Date(`${fechaDesde}T00:00:00`);
  const hasta = fechaHasta ? new Date(`${fechaHasta}T23:59:59`) : new Date(desde.getTime() + DIAS_VENTANA_SIN_FIN * 86400000);
  const set = new Set(diasSemana.map(Number));
  const [h, m] = horaHHMM ? horaHHMM.split(':').map(Number) : [0, 0];
  const fechas = [];
  const cursor = new Date(desde);
  while (cursor <= hasta && fechas.length < MAX_OCURRENCIAS) {
    if (set.has(cursor.getDay())) fechas.push(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), h, m));
    cursor.setDate(cursor.getDate() + 1);
  }
  return fechas;
}

// Un día-del-mes que no existe en un mes dado (ej. 31 en febrero) simplemente
// no genera ocurrencia ese mes - no se corre al mes siguiente.
function generarFechasTareaPorDiaDelMes(fechaDesde, fechaHasta, diasMes, horaHHMM) {
  const desde = new Date(`${fechaDesde}T00:00:00`);
  const hasta = fechaHasta ? new Date(`${fechaHasta}T23:59:59`) : new Date(desde.getTime() + DIAS_VENTANA_SIN_FIN * 86400000);
  const [h, m] = horaHHMM ? horaHHMM.split(':').map(Number) : [0, 0];
  const fechas = [];
  const cursorMes = new Date(desde.getFullYear(), desde.getMonth(), 1);
  while (cursorMes <= hasta && fechas.length < MAX_OCURRENCIAS) {
    for (const dia of diasMes) {
      const candidata = new Date(cursorMes.getFullYear(), cursorMes.getMonth(), dia, h, m);
      if (candidata.getMonth() !== cursorMes.getMonth()) continue; // desbordó (ej. 31 en un mes de 30)
      if (candidata >= desde && candidata <= hasta) fechas.push(candidata);
    }
    cursorMes.setMonth(cursorMes.getMonth() + 1);
  }
  fechas.sort((a, b) => a - b);
  return fechas;
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

// Para TAREA: arma la lista de "responsables" a cruzar con las fechas de la
// ocurrencia (una fila por combinación fecha×responsable, mismo patrón que
// "todas las sucursales" en EVENTO_ESPECIAL). `responsables` es una lista
// mixta armada en el frontend (ver SelectorResponsablesTarea en
// Calendario.jsx): entradas { tipo: 'PERSONA', user_id } (alguien puntual) y/o
// { tipo: 'PUESTO', puesto, turno_tipo } (sin nadie fijo todavía - se
// resuelve solo, día a día, contra quien tenga ESE turno real, ver el bloque
// COLABORADOR de GET /api/calendario; turno_tipo ya viene resuelto por el
// frontend a partir de la hora de la tarea, no se vuelve a inferir acá -
// turno_tipo null es válido a propósito: sin hora puesta, el criterio no
// queda atado a un turno puntual y aplica a cualquiera de ese puesto en
// todo el día).
// Sin `responsables`, cae al responsable_user_id suelto de siempre (incluye
// "sin responsable", null) - lo usan también AUDITORIA/SEGUIMIENTO.
function resolverResponsablesTarea({ responsable_user_id, responsables }) {
  if (Array.isArray(responsables) && responsables.length) {
    return responsables.map((r) => {
      if (r.tipo === 'PUESTO') {
        if (!['COCINA', 'CAJA', 'REFUERZO_COCINA'].includes(r.puesto)) { const e = new Error('puesto inválido'); e.status = 400; throw e; }
        if (r.turno_tipo != null && !['DIURNO', 'NOCTURNO'].includes(r.turno_tipo)) { const e = new Error('turno_tipo inválido'); e.status = 400; throw e; }
        return { userId: null, puesto: r.puesto, turnoTipo: r.turno_tipo ?? null };
      }
      return { userId: Number(r.user_id), puesto: null, turnoTipo: null };
    });
  }
  return [{ userId: responsable_user_id || null, puesto: null, turnoTipo: null }];
}

module.exports = function registrarRutasCalendario(app) {
  app.get('/api/calendario', async (req, res) => {
    const { desde, hasta, sucursal_id, tipo, estado, responsable_id, tipo_tarea_id } = req.query;
    let sql = `SELECT e.*, s.nombre AS sucursal_nombre, ${db.nombreCompletoSql('u')} AS responsable_nombre,
                      ${db.nombreCompletoSql('cu')} AS creado_por_nombre,
                      t.nombre AS plantilla_nombre, t.tipo AS plantilla_tipo,
                      tt.id AS tipo_tarea_id, tt.nombre AS tipo_tarea_nombre, tt.icono AS tipo_tarea_icono,
                      tc.descripcion AS tarea_descripcion, tc.enlace AS tarea_enlace, tc.enlace_nombre AS tarea_enlace_nombre,
                      CASE
                        WHEN e.estado != 'PENDIENTE' THEN e.estado
                        WHEN e.tipo = 'TAREA' AND e.hora_definida AND now() > e.fecha_hora + interval '12 hours' THEN 'DEMORADA'
                        WHEN e.tipo = 'TAREA' AND NOT e.hora_definida AND now() > date_trunc('day', e.fecha_hora) + interval '1 day' THEN 'DEMORADA'
                        -- Auditoría sin hora (agendada "para hoy", sin horario puntual): igual
                        -- criterio que una tarea sin hora - vencida recién al otro día, no a
                        -- medianoche del mismo día que se agendó.
                        WHEN e.tipo != 'TAREA' AND NOT e.hora_definida AND now() > date_trunc('day', e.fecha_hora) + interval '1 day' THEN 'VENCIDA'
                        WHEN e.tipo != 'TAREA' AND e.hora_definida AND e.fecha_hora < now() THEN 'VENCIDA'
                        ELSE e.estado
                      END AS estado_efectivo
               FROM schedule_events e
               JOIN sucursales s ON s.id = e.sucursal_id
               LEFT JOIN usuarios u ON u.id = e.responsable_user_id
               LEFT JOIN usuarios cu ON cu.id = e.creado_por
               LEFT JOIN audit_templates t ON t.id = e.template_id
               LEFT JOIN tareas_catalogo tc ON tc.id = e.tarea_catalogo_id
               LEFT JOIN tipos_tarea tt ON tt.id = tc.tipo_tarea_id
               WHERE 1=1`;
    let params = [];
    if (req.usuario.rol === 'COLABORADOR') {
      // Un Colaborador solo ve lo que tiene asignado (sus turnos y las
      // tareas/auditorías donde es responsable), más los Eventos especiales
      // sin responsable de su propia sucursal (feriados/promos, visibles a
      // todos), más los turnos de OTROS que caen el mismo día y mismo
      // turno_tipo que uno propio (para saber con quién le toca compartir),
      // más las TAREA sin responsable fijo asignadas "por puesto" (ver
      // resolverResponsablesTarea) cuando ese día efectivamente tiene un
      // turno propio con ese mismo puesto - si la tarea además especificó
      // turno_tipo, tiene que coincidir también; si no (turno_tipo null),
      // aplica a cualquier turno de ese puesto ese día - nunca el
      // calendario completo de la sucursal.
      params.push(req.usuario.usuarioId); params.push(req.usuario.sucursal_id);
      const pUsuario = params.length - 1, pSucursal = params.length;
      sql += ` AND (e.responsable_user_id = $${pUsuario}
                    OR (e.tipo = 'EVENTO_ESPECIAL' AND e.responsable_user_id IS NULL AND e.sucursal_id = $${pSucursal})
                    OR (e.tipo = 'TURNO' AND EXISTS (
                          SELECT 1 FROM schedule_events e2
                          WHERE e2.tipo = 'TURNO' AND e2.responsable_user_id = $${pUsuario}
                            AND e2.sucursal_id = e.sucursal_id AND e2.turno_tipo = e.turno_tipo
                            AND e2.fecha_hora::date = e.fecha_hora::date
                        ))
                    OR (e.tipo = 'TAREA' AND e.responsable_user_id IS NULL AND e.puesto IS NOT NULL
                        AND EXISTS (
                          SELECT 1 FROM schedule_events e3
                          WHERE e3.tipo = 'TURNO' AND e3.responsable_user_id = $${pUsuario}
                            AND e3.sucursal_id = e.sucursal_id AND e3.puesto = e.puesto
                            AND (e.turno_tipo IS NULL OR e3.turno_tipo = e.turno_tipo)
                            AND e3.fecha_hora::date = e.fecha_hora::date
                        )))`;
    } else if (req.usuario.rol === 'GERENTE') {
      const scoped = scopeSucursal(req.usuario, 'e.sucursal_id', params);
      sql += scoped.sql; params = scoped.params;
    } else if (sucursal_id) {
      // Acepta uno o varios ids separados por coma (filtro multi-sucursal del calendario).
      params.push(String(sucursal_id).split(',').map(Number)); sql += ` AND e.sucursal_id = ANY($${params.length})`;
    }
    if (desde) { params.push(desde); sql += ` AND e.fecha_hora >= $${params.length}`; }
    // `hasta` es una fecha 'YYYY-MM-DD' sin hora - compararla con <= la
    // interpreta como medianoche de ese día y descarta cualquier evento más
    // tarde ese mismo día (el último de la semana/mes visible, típicamente).
    // Con < día+1 el límite queda inclusive de todo el día.
    if (hasta) { params.push(hasta); sql += ` AND e.fecha_hora < ($${params.length}::date + 1)`; }
    // `tipo` acepta uno o varios valores separados por coma (filtro multi-select del calendario).
    if (tipo) { params.push(String(tipo).split(',')); sql += ` AND e.tipo = ANY($${params.length})`; }
    if (estado) { params.push(estado); sql += ` AND e.estado = $${params.length}`; }
    if (responsable_id) { params.push(responsable_id); sql += ` AND e.responsable_user_id = $${params.length}`; }
    // Filtro de "tipo de tarea" del catálogo (Limpieza, etc.) - distinto de
    // `tipo` (AUDITORIA/TAREA/...), se usa en el historial de Tareas.
    if (tipo_tarea_id) { params.push(String(tipo_tarea_id).split(',').map(Number)); sql += ` AND tt.id = ANY($${params.length})`; }
    sql += ' ORDER BY e.fecha_hora';
    try {
      const { rows } = await db.query(sql, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Body: { sucursal_id, tipo, template_id (AUDITORIA), tarea_catalogo_id (TAREA),
  // foto_requerida (TAREA "Otro"), titulo, descripcion, responsable_user_id,
  // TAREA/EVENTO_ESPECIAL: fecha_hora, duracion_minutos, recurrencia simple {tipo,hasta},
  // AUDITORIA: misma recurrencia rica que /api/calendario/tareas/programar -
  //   fecha_desde (obligatorio, el frontend ya lo manda "hoy" si no se eligió),
  //   fecha_hasta (opcional), hora (opcional - sin hora = "pendiente para hoy",
  //   ver hora_definida), frecuencia: 'NINGUNA'|'DIARIA'|'SEMANAL'|'MENSUAL',
  //   dias_semana[] (SEMANAL) | dias_mes[] (MENSUAL),
  // todas_sucursales | sucursal_ids[] | sucursal_id (EVENTO_ESPECIAL) }
  app.post('/api/calendario', async (req, res) => {
    const {
      sucursal_id, sucursal_ids, tipo, template_id, tarea_catalogo_id, foto_requerida, titulo, descripcion,
      responsable_user_id, fecha_hora, duracion_minutos, recurrencia, todas_sucursales, hora_definida,
      fecha_desde, fecha_hasta, frecuencia, dias_semana, dias_mes, hora,
    } = req.body;
    if (!tipo) return res.status(400).json({ error: 'Falta el campo: tipo' });
    if (!['AUDITORIA', 'SEGUIMIENTO', 'TAREA', 'EVENTO_ESPECIAL'].includes(tipo)) return res.status(400).json({ error: 'tipo inválido' });
    // Una AUDITORIA agendada desde el calendario usa la misma recurrencia
    // rica que las tareas (dias puntuales + hora opcional) - el resto sigue
    // con fecha_hora obligatoria + `recurrencia` simple (repite indefinido
    // en el mismo dia de semana/mes hasta una fecha limite).
    const usaRecurrenciaRica = tipo === 'AUDITORIA';
    if (!usaRecurrenciaRica && !fecha_hora) return res.status(400).json({ error: 'Faltan campos: tipo, fecha_hora' });
    if (usaRecurrenciaRica && !fecha_desde) return res.status(400).json({ error: 'Falta fecha_desde' });

    // Evento especial (feriado/promo): sin plantilla, alcance de una sucursal,
    // varias elegidas a mano, o todas a la vez (una fila por sucursal,
    // agrupadas en una serie), responsable opcional, sin recurrencia, ícono
    // elegido del banco (default 🎉) - solo Admin lo crea.
    if (tipo === 'EVENTO_ESPECIAL') {
      if (req.usuario.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo Administrador puede crear un evento especial' });
      if (!titulo) return res.status(400).json({ error: 'Falta el título' });
      try {
        let sucursalIds;
        if (todas_sucursales) {
          const { rows } = await db.query('SELECT id FROM sucursales WHERE activo = true');
          sucursalIds = rows.map((r) => r.id);
        } else if (Array.isArray(sucursal_ids) && sucursal_ids.length) {
          sucursalIds = sucursal_ids.map(Number);
        } else {
          if (!sucursal_id) return res.status(400).json({ error: 'Falta sucursal_id, sucursal_ids o todas_sucursales' });
          sucursalIds = [Number(sucursal_id)];
        }
        const icono = req.body.icono || '🎉';
        const filas = sucursalIds.map((sId) => [sId, 'EVENTO_ESPECIAL', titulo, descripcion || null, responsable_user_id || null, fecha_hora, req.usuario.usuarioId, icono]);
        const insertados = await db.bulkInsert(db.pool, 'schedule_events',
          ['sucursal_id', 'tipo', 'titulo', 'descripcion', 'responsable_user_id', 'fecha_hora', 'creado_por', 'icono'],
          filas, 'id');
        const serieId = insertados[0].id;
        await db.query('UPDATE schedule_events SET serie_id = $1 WHERE id = ANY($2)', [serieId, insertados.map((r) => r.id)]);
        if (responsable_user_id) {
          await crearNotificacion(responsable_user_id, 'ASIGNACION', `Te asignaron: ${titulo}`,
            'Nuevo evento especial programado en el calendario.', { evento_id: insertados[0].id }, 'ASIGNACION_EVENTO_ESPECIAL');
        }
        return res.status(201).json({ creados: insertados.length });
      } catch (err) {
        return res.status(err.status || 400).json({ error: err.message });
      }
    }

    if (!sucursal_id) return res.status(400).json({ error: 'Falta sucursal_id' });
    if (tipo !== 'TAREA' && !template_id) return res.status(400).json({ error: 'Falta template_id para una auditoría/seguimiento' });
    if (!puedeAccederSucursal(req.usuario, sucursal_id)) return res.status(403).json({ error: 'No tenés acceso a esa sucursal' });

    let plantilla = null;
    if (template_id) {
      const { rows } = await db.query('SELECT nombre, tipo FROM audit_templates WHERE id = $1', [template_id]);
      plantilla = rows[0];
    }
    let tareaCatalogo = null;
    if (tipo === 'TAREA' && tarea_catalogo_id) {
      const { rows } = await db.query('SELECT nombre, foto_requerida FROM tareas_catalogo WHERE id = $1', [tarea_catalogo_id]);
      tareaCatalogo = rows[0];
      if (!tareaCatalogo) return res.status(400).json({ error: 'Tarea de catálogo no encontrada' });
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

    let tituloFinal = titulo || tareaCatalogo?.nombre || plantilla?.nombre;
    if (!tituloFinal) return res.status(400).json({ error: 'Falta el título' });
    const evidenciaObligatoria = tipo === 'TAREA' ? !!(tareaCatalogo ? tareaCatalogo.foto_requerida : foto_requerida) : false;

    let fechas;
    let horaDefinidaFinal;
    if (usaRecurrenciaRica) {
      if (frecuencia === 'SEMANAL') {
        if (!Array.isArray(dias_semana) || !dias_semana.length) return res.status(400).json({ error: 'Falta dias_semana' });
        fechas = generarFechasTareaPorDiaSemana(fecha_desde, fecha_hasta || null, dias_semana, hora || null);
      } else if (frecuencia === 'MENSUAL') {
        if (!Array.isArray(dias_mes) || !dias_mes.length) return res.status(400).json({ error: 'Falta dias_mes' });
        fechas = generarFechasTareaPorDiaDelMes(fecha_desde, fecha_hasta || null, dias_mes, hora || null);
      } else if (frecuencia === 'DIARIA') {
        fechas = generarFechasTareaDiaria(fecha_desde, fecha_hasta || null, hora || null);
      } else {
        // NINGUNA - una sola ocurrencia, el mismo dia como desde y hasta.
        fechas = generarFechasTareaDiaria(fecha_desde, fecha_desde, hora || null);
      }
      if (!fechas.length) return res.status(400).json({ error: 'El rango de fechas no generó ninguna ocurrencia' });
      horaDefinidaFinal = !!hora;
    } else {
      fechas = generarFechas(fecha_hora, recurrencia);
      horaDefinidaFinal = tipo === 'TAREA' ? hora_definida !== false : true;
    }
    try {
      const responsables = tipo === 'TAREA'
        ? resolverResponsablesTarea(req.body)
        : [{ userId: responsable_user_id || null, puesto: null, turnoTipo: null }];
      for (const r of responsables) await validarResponsablePermitido(req.usuario, r.userId);
      const filas = fechas.flatMap((f) => responsables.map((r) => [
        sucursal_id, tipo, tipo === 'TAREA' ? null : template_id, tituloFinal, descripcion || null,
        r.userId, f.toISOString(), duracion_minutos || null, req.usuario.usuarioId,
        tipo === 'TAREA' ? (tarea_catalogo_id || null) : null, evidenciaObligatoria,
        horaDefinidaFinal, r.puesto, r.turnoTipo,
      ]));
      const insertados = await db.bulkInsert(db.pool, 'schedule_events',
        ['sucursal_id', 'tipo', 'template_id', 'titulo', 'descripcion', 'responsable_user_id', 'fecha_hora', 'duracion_minutos', 'creado_por', 'tarea_catalogo_id', 'evidencia_obligatoria', 'hora_definida', 'puesto', 'turno_tipo'],
        filas, 'id');
      if (insertados.length > 1) {
        const serieId = insertados[0].id;
        await db.query('UPDATE schedule_events SET serie_id = $1 WHERE id = ANY($2)', [serieId, insertados.map((r) => r.id)]);
      }
      const idsANotificar = [...new Set(responsables.map((r) => r.userId).filter(Boolean))];
      for (const uid of idsANotificar) {
        await crearNotificacion(uid, 'ASIGNACION', `Te asignaron: ${tituloFinal}`,
          `Nueva ${tipo === 'TAREA' ? 'tarea' : 'auditoría'} programada en el calendario.`, { evento_id: insertados[0].id },
          tipo === 'TAREA' ? 'ASIGNACION_TAREA' : 'ASIGNACION_AUDITORIA');
      }
      res.status(201).json({ creados: insertados.length });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // Tarea rutinaria recurrente (diaria, semanal o mensual) - a diferencia de
  // la recurrencia genérica de POST /api/calendario (que solo repite en el
  // mismo día de la semana/mes indefinidamente), acá se eligen días
  // puntuales y, opcionalmente, si la tarea no tiene horario fijo
  // (hora_definida = false, ver panel Tareas para el cálculo de demora).
  // Body: { sucursal_id, tarea_catalogo_id | (titulo + foto_requerida para "Otro"),
  // descripcion, responsable_user_id | responsables, frecuencia: 'DIARIA'|'SEMANAL'|'MENSUAL',
  // dias_semana[] (SEMANAL) | dias_mes[] (MENSUAL), hora (opcional 'HH:MM'), fecha_desde, fecha_hasta (opcional) }
  app.post('/api/calendario/tareas/programar', async (req, res) => {
    const {
      sucursal_id, tarea_catalogo_id, titulo, descripcion, foto_requerida,
      frecuencia, dias_semana, dias_mes, hora, fecha_desde, fecha_hasta,
    } = req.body;
    if (!sucursal_id || !frecuencia || !fecha_desde) return res.status(400).json({ error: 'Faltan campos: sucursal_id, frecuencia, fecha_desde' });
    if (!['DIARIA', 'SEMANAL', 'MENSUAL'].includes(frecuencia)) return res.status(400).json({ error: 'frecuencia inválida' });
    if (frecuencia === 'SEMANAL' && (!Array.isArray(dias_semana) || !dias_semana.length)) return res.status(400).json({ error: 'Falta dias_semana' });
    if (frecuencia === 'MENSUAL' && (!Array.isArray(dias_mes) || !dias_mes.length)) return res.status(400).json({ error: 'Falta dias_mes' });
    if (!puedeAccederSucursal(req.usuario, sucursal_id)) return res.status(403).json({ error: 'No tenés acceso a esa sucursal' });
    if (req.usuario.rol === 'GERENTE' && Number(sucursal_id) !== req.usuario.sucursal_id) return res.status(403).json({ error: 'Solo podés programar en tu propia sucursal' });
    if (!['ADMIN', 'AUDITOR', 'GERENTE'].includes(req.usuario.rol)) return res.status(403).json({ error: 'Solo Administrador, Auditor o Gerente pueden programar tareas' });

    try {
      let tituloFinal = titulo;
      let evidenciaObligatoria = !!foto_requerida;
      if (tarea_catalogo_id) {
        const { rows } = await db.query('SELECT nombre, foto_requerida FROM tareas_catalogo WHERE id = $1', [tarea_catalogo_id]);
        if (!rows[0]) return res.status(400).json({ error: 'Tarea de catálogo no encontrada' });
        tituloFinal = rows[0].nombre;
        evidenciaObligatoria = rows[0].foto_requerida;
      }
      if (!tituloFinal) return res.status(400).json({ error: 'Falta el título' });

      const responsables = resolverResponsablesTarea(req.body);
      for (const r of responsables) await validarResponsablePermitido(req.usuario, r.userId);
      const fechas = frecuencia === 'DIARIA'
        ? generarFechasTareaDiaria(fecha_desde, fecha_hasta || null, hora || null)
        : frecuencia === 'SEMANAL'
          ? generarFechasTareaPorDiaSemana(fecha_desde, fecha_hasta || null, dias_semana, hora || null)
          : generarFechasTareaPorDiaDelMes(fecha_desde, fecha_hasta || null, dias_mes, hora || null);
      if (!fechas.length) return res.status(400).json({ error: 'El rango de fechas no generó ninguna ocurrencia' });

      const filas = fechas.flatMap((f) => responsables.map((r) => [
        sucursal_id, 'TAREA', tituloFinal, descripcion || null, r.userId, f.toISOString(),
        req.usuario.usuarioId, tarea_catalogo_id || null, evidenciaObligatoria, !!hora, r.puesto, r.turnoTipo,
      ]));
      const insertados = await db.bulkInsert(db.pool, 'schedule_events',
        ['sucursal_id', 'tipo', 'titulo', 'descripcion', 'responsable_user_id', 'fecha_hora', 'creado_por', 'tarea_catalogo_id', 'evidencia_obligatoria', 'hora_definida', 'puesto', 'turno_tipo'],
        filas, 'id');
      const serieId = insertados[0].id;
      await db.query('UPDATE schedule_events SET serie_id = $1 WHERE id = ANY($2)', [serieId, insertados.map((r) => r.id)]);
      const idsANotificar = [...new Set(responsables.map((r) => r.userId).filter(Boolean))];
      for (const uid of idsANotificar) {
        await crearNotificacion(uid, 'ASIGNACION',
          insertados.length === 1 ? `Te asignaron: ${tituloFinal}` : `Tarea recurrente asignada: ${tituloFinal}`,
          insertados.length === 1 ? 'Nueva tarea programada en el calendario.' : `Se programaron ${insertados.length} ocurrencias en el calendario.`,
          { evento_ids: insertados.map((r) => r.id) }, 'ASIGNACION_TAREA');
      }
      res.status(201).json({ creados: insertados.length, ventanaSinFin: !fecha_hasta ? DIAS_VENTANA_SIN_FIN : null });
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
      let eliminados;
      if (req.query.serie === 'true' && evento.serie_id) {
        eliminados = await db.query('DELETE FROM schedule_events WHERE serie_id = $1 AND fecha_hora >= $2 RETURNING *', [evento.serie_id, evento.fecha_hora]);
      } else {
        eliminados = await db.query('DELETE FROM schedule_events WHERE id = $1 RETURNING *', [req.params.id]);
      }
      // Un turno que ya se le había notificado a su responsable (confirmado
      // y avisado) y ahora se da de baja necesita un aviso aparte - si nunca
      // llegó a notificarse (todavía pendiente de "Asignar turnos"), no hace
      // falta: esa persona nunca supo que existía.
      const turnosAAvisar = eliminados.rows.filter((e) => e.tipo === 'TURNO' && e.responsable_user_id && e.notificado_en);
      for (const t of turnosAAvisar) {
        try {
          await crearNotificacion(t.responsable_user_id, 'TURNOS_ASIGNADOS', 'Turno dado de baja',
            `Tu turno del ${new Date(t.fecha_hora).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' })} fue dado de baja.`,
            { evento_id: t.id }, 'TURNOS_ASIGNADOS');
        } catch (err) {
          console.error(`[calendario] error avisando baja de turno ${t.id}:`, err.message);
        }
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
    // Gerente/Colaborador no pueden adelantar una auditoría antes del
    // día/hora programado - Admin/Auditor sí, para poder resolver casos
    // excepcionales (mismo criterio asimétrico que ya existe en otras rutas).
    if ((req.usuario.rol === 'GERENTE' || req.usuario.rol === 'COLABORADOR') && new Date(evento.fecha_hora) > new Date()) {
      return res.status(400).json({ error: 'Todavía no se puede iniciar - no llegó la fecha/hora programada' });
    }
    try {
      let run;
      if (evento.tipo === 'SEGUIMIENTO' && evento.origen_run_id) {
        // Seguimiento programado a partir de los hallazgos de una auditoria
        // de marca (ver POST /api/runs/:id/seguimiento) - el snapshot sale
        // de esa auditoria de origen, no de una plantilla viva.
        run = await crearRunDesdeHallazgos({
          origenRunId: evento.origen_run_id, itemIds: evento.items_seleccionados,
          sucursalId: evento.sucursal_id, auditorUserId: req.usuario.usuarioId, responsableNombre: null,
        });
      } else {
        if (!evento.template_id) return res.status(400).json({ error: 'El evento no tiene una plantilla asociada' });
        // tipo 'AUDITORIA' (evento de calendario) no es un audit_runs.tipo
        // valido - se omite para que crearRun use el tipo propio de la
        // plantilla (MARCA/INTERNA). 'SEGUIMIENTO' sí es valido en ambos.
        run = await crearRun({
          templateId: evento.template_id, sucursalId: evento.sucursal_id,
          tipo: evento.tipo === 'SEGUIMIENTO' ? 'SEGUIMIENTO' : undefined,
          rol: req.usuario.rol, auditorUserId: req.usuario.usuarioId, responsableNombre: null,
        });
      }
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
  // No se puede marcar cumplida antes de la fecha/hora programada (para una
  // tarea sin horario, fecha_hora queda al inicio de ese día - ver
  // hora_definida - así que esto la habilita apenas empieza el día). Si la
  // tarea exige evidencia (ver evidencia_obligatoria), la foto es obligatoria.
  app.post('/api/calendario/:id/completar', async (req, res) => {
    const evento = await obtenerEventoOForbidden(req, res);
    if (!evento) return;
    if (evento.tipo !== 'TAREA') return res.status(400).json({ error: 'Solo las tareas se completan así - una auditoría se inicia con /iniciar' });
    if (new Date(evento.fecha_hora) > new Date()) return res.status(400).json({ error: 'Todavía no se puede marcar cumplida - no llegó la fecha/hora programada' });
    const { comentario, evidencia_url, evidencia_tipo } = req.body;
    if (evento.evidencia_obligatoria && !evidencia_url) return res.status(400).json({ error: 'Esta tarea requiere una foto de evidencia' });
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
  // colaborador, un solo día. Queda PENDIENTE de confirmar (gris, sin
  // notificar) hasta que el gerente lo confirme con "Asignar turnos" (ver
  // POST /api/calendario/turnos/asignar) - así nunca se notifica antes de
  // que la asignación esté efectivamente confirmada.
  // Body: { sucursal_id, fecha (YYYY-MM-DD), turno_tipo, responsable_user_id, puesto }
  app.post('/api/calendario/turnos', async (req, res) => {
    const { sucursal_id, fecha, turno_tipo, responsable_user_id, puesto } = req.body;
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
        `INSERT INTO schedule_events (sucursal_id, tipo, titulo, responsable_user_id, puesto, turno_tipo, fecha_hora, duracion_minutos, creado_por, asignacion_confirmada)
         VALUES ($1,'TURNO',$2,$3,$4,$5,$6,$7,$8,false) RETURNING *`,
        [sucursal_id, `Turno ${turno_tipo === 'DIURNO' ? 'diurno' : 'nocturno'}`, responsable_user_id, puesto, turno_tipo, inicio.toISOString(), duracionMinutos, req.usuario.usuarioId]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // "Programar asignaciones": un patrón que se repite en ciertos días de la
  // semana, entre una fecha desde y una fecha hasta (opcional - ver
  // generarOcurrenciasTurnoProgramado y DIAS_VENTANA_SIN_FIN si se omite).
  // Igual que el alta rápida, quedan PENDIENTES de confirmar (ver arriba).
  // Body: { sucursal_id, responsable_user_id, puesto, turno_tipo, dias_semana: [0..6],
  //         fecha_desde, fecha_hasta (opcional) }
  app.post('/api/calendario/turnos/programar', async (req, res) => {
    const { sucursal_id, responsable_user_id, puesto, turno_tipo, dias_semana, fecha_desde, fecha_hasta } = req.body;
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
        inicio.toISOString(), duracionMinutos, req.usuario.usuarioId, false,
      ]);
      const insertados = await db.bulkInsert(db.pool, 'schedule_events',
        ['sucursal_id', 'tipo', 'titulo', 'responsable_user_id', 'puesto', 'turno_tipo', 'fecha_hora', 'duracion_minutos', 'creado_por', 'asignacion_confirmada'],
        filas, 'id');
      const serieId = insertados[0].id;
      await db.query('UPDATE schedule_events SET serie_id = $1 WHERE id = ANY($2)', [serieId, insertados.map((r) => r.id)]);

      res.status(201).json({
        creados: insertados.length,
        ventanaSinFin: !fecha_hasta ? DIAS_VENTANA_SIN_FIN : null,
        diasOmitidos: diasOmitidos.length ? diasOmitidos : undefined,
      });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // Agrupa una lista de turnos (con responsable_user_id + responsable_nombre
  // ya resueltos) por responsable y le manda UNA notificación consolidada a
  // cada uno - si crearNotificacion tira (falla el insert/push), ese
  // responsable queda en `fallidos` para que el gerente pueda reintentar
  // (ver POST /api/calendario/turnos/notificar) en vez de perderse el aviso
  // en silencio.
  async function notificarResponsablesDeTurnos(turnos) {
    const porResponsable = new Map(); // responsable_user_id -> { nombre, eventoIds: [] }
    for (const t of turnos) {
      if (!t.responsable_user_id) continue;
      if (!porResponsable.has(t.responsable_user_id)) porResponsable.set(t.responsable_user_id, { nombre: t.responsable_nombre, eventoIds: [] });
      porResponsable.get(t.responsable_user_id).eventoIds.push(t.id);
    }
    const notificados = [];
    const fallidos = [];
    for (const [usuarioId, { nombre, eventoIds }] of porResponsable) {
      try {
        await crearNotificacion(usuarioId, 'TURNOS_ASIGNADOS',
          eventoIds.length === 1 ? 'Turno asignado' : 'Turnos asignados',
          eventoIds.length === 1 ? 'Ya podés ver tu turno asignado en el calendario.' : `Se te asignaron ${eventoIds.length} turnos.`,
          { evento_ids: eventoIds }, 'TURNOS_ASIGNADOS');
        await db.query('UPDATE schedule_events SET notificado_en = now() WHERE id = ANY($1)', [eventoIds]);
        notificados.push({ usuario_id: usuarioId, nombre, evento_ids: eventoIds });
      } catch (err) {
        fallidos.push({ usuario_id: usuarioId, nombre, evento_ids: eventoIds });
      }
    }
    return { notificados, fallidos };
  }

  // "Asignar turnos": confirma TODOS los turnos pendientes (asignacion_
  // confirmada = false) de una sucursal dentro de un rango de fechas (la
  // vista/período que el gerente tiene abierto) y, si se pide, notifica a
  // cada responsable que recibió un turno nuevo o modificado en esta tanda -
  // nunca a quienes no tuvieron cambios (porque esos ya estaban confirmados).
  // Body: { sucursal_id, desde, hasta (YYYY-MM-DD), notificar }
  app.post('/api/calendario/turnos/asignar', async (req, res) => {
    const { sucursal_id, desde, hasta, notificar = true } = req.body;
    if (!sucursal_id || !desde || !hasta) return res.status(400).json({ error: 'Faltan campos: sucursal_id, desde, hasta' });
    if (!puedeGestionarTurnos(req.usuario, sucursal_id)) return res.status(403).json({ error: 'No podés gestionar los turnos de esta sucursal' });
    try {
      const { rows: pendientes } = await db.query(
        `SELECT e.*, ${db.nombreCompletoSql('u')} AS responsable_nombre FROM schedule_events e LEFT JOIN usuarios u ON u.id = e.responsable_user_id
         WHERE e.tipo = 'TURNO' AND e.sucursal_id = $1 AND e.asignacion_confirmada = false
           AND e.fecha_hora >= $2 AND e.fecha_hora < ($3::date + 1)`,
        [sucursal_id, desde, hasta]
      );
      if (pendientes.length === 0) return res.json({ confirmados: 0, notificados: [], fallidos: [] });
      await db.query(
        `UPDATE schedule_events SET asignacion_confirmada = true WHERE id = ANY($1)`,
        [pendientes.map((t) => t.id)]
      );
      const { notificados, fallidos } = notificar ? await notificarResponsablesDeTurnos(pendientes) : { notificados: [], fallidos: [] };
      res.json({ confirmados: pendientes.length, notificados, fallidos });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // Reintento manual de notificación (para los responsables que quedaron en
  // `fallidos` en /asignar) - reusa el mismo agrupador, sin volver a tocar
  // asignacion_confirmada (ya estaba en true).
  app.post('/api/calendario/turnos/notificar', async (req, res) => {
    const { ids = [] } = req.body;
    if (!ids.length) return res.status(400).json({ error: 'Falta el campo: ids' });
    try {
      const { rows: eventos } = await db.query(
        `SELECT e.*, ${db.nombreCompletoSql('u')} AS responsable_nombre FROM schedule_events e LEFT JOIN usuarios u ON u.id = e.responsable_user_id
         WHERE e.id = ANY($1) AND e.tipo = 'TURNO'`,
        [ids]
      );
      const sucursalIds = new Set(eventos.map((e) => e.sucursal_id));
      for (const sId of sucursalIds) {
        if (!puedeGestionarTurnos(req.usuario, sId)) return res.status(403).json({ error: 'No podés gestionar los turnos de esta sucursal' });
      }
      const { notificados, fallidos } = await notificarResponsablesDeTurnos(eventos);
      res.json({ notificados, fallidos });
    } catch (err) {
      res.status(400).json({ error: err.message });
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
    let sql = `SELECT e.*, s.nombre AS sucursal_nombre, ${db.nombreCompletoSql('u')} AS responsable_nombre
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
