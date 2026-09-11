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

const MAX_OCURRENCIAS = 200; // limite de seguridad para no crear series gigantes por error

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

module.exports = function registrarRutasCalendario(app) {
  app.get('/api/calendario', async (req, res) => {
    const { desde, hasta, sucursal_id, tipo, estado, responsable_id } = req.query;
    let sql = `SELECT e.*, s.nombre AS sucursal_nombre, u.nombre AS responsable_nombre,
                      t.nombre AS plantilla_nombre,
                      CASE WHEN e.estado = 'PENDIENTE' AND e.fecha_hora < now() THEN 'VENCIDA' ELSE e.estado END AS estado_efectivo
               FROM schedule_events e
               JOIN sucursales s ON s.id = e.sucursal_id
               LEFT JOIN usuarios u ON u.id = e.responsable_user_id
               LEFT JOIN audit_templates t ON t.id = e.template_id
               WHERE 1=1`;
    let params = [];
    if (req.usuario.rol === 'GERENTE') {
      const scoped = scopeSucursal(req.usuario, 'e.sucursal_id', params);
      sql += scoped.sql; params = scoped.params;
    } else if (sucursal_id) {
      params.push(sucursal_id); sql += ` AND e.sucursal_id = $${params.length}`;
    }
    if (desde) { params.push(desde); sql += ` AND e.fecha_hora >= $${params.length}`; }
    if (hasta) { params.push(hasta); sql += ` AND e.fecha_hora <= $${params.length}`; }
    if (tipo) { params.push(tipo); sql += ` AND e.tipo = $${params.length}`; }
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
    if (req.usuario.rol !== 'ADMIN' && req.usuario.rol !== 'AUDITOR') return res.status(403).json({ error: 'Solo Administrador o Auditor pueden programar el calendario' });

    let tituloFinal = titulo;
    if (!tituloFinal && template_id) {
      const { rows } = await db.query('SELECT nombre FROM audit_templates WHERE id = $1', [template_id]);
      tituloFinal = rows[0]?.nombre;
    }
    if (!tituloFinal) return res.status(400).json({ error: 'Falta el título' });

    const fechas = generarFechas(fecha_hora, recurrencia);
    try {
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
      res.status(201).json({ creados: insertados.length });
    } catch (err) {
      res.status(400).json({ error: err.message });
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
    if (req.usuario.rol !== 'ADMIN' && req.usuario.rol !== 'AUDITOR') return res.status(403).json({ error: 'Solo Administrador o Auditor pueden editar el calendario' });
    const evento = await obtenerEventoOForbidden(req, res);
    if (!evento) return;
    const { titulo, descripcion, responsable_user_id, fecha_hora, estado } = req.body;
    try {
      const { rows } = await db.query(
        `UPDATE schedule_events SET titulo = COALESCE($1,titulo), descripcion = COALESCE($2,descripcion),
         responsable_user_id = COALESCE($3,responsable_user_id), fecha_hora = COALESCE($4,fecha_hora),
         estado = COALESCE($5,estado) WHERE id = $6 RETURNING *`,
        [titulo ?? null, descripcion ?? null, responsable_user_id ?? null, fecha_hora ?? null, estado ?? null, req.params.id]
      );
      res.json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ?serie=true borra esta ocurrencia y las futuras de la misma serie.
  app.delete('/api/calendario/:id', async (req, res) => {
    if (req.usuario.rol !== 'ADMIN' && req.usuario.rol !== 'AUDITOR') return res.status(403).json({ error: 'Solo Administrador o Auditor pueden editar el calendario' });
    const evento = await obtenerEventoOForbidden(req, res);
    if (!evento) return;
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
};
