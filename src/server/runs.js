/**
 * ============================================================
 * EJECUCION DE AUDITORIAS (runs)
 * ============================================================
 * Al iniciar una auditoria se copia la estructura VIVA de la plantilla a
 * audit_runs.estructura_snapshot (JSONB) - de ahi en mas esa auditoria ya
 * no depende de la plantilla: si alguien la edita despues, esta ejecucion
 * no cambia. Las respuestas (audit_respuestas) guardan item_id apuntando a
 * un id DENTRO de ese snapshot, no a audit_items (que puede no existir mas).
 */

const db = require('../db');
const { puedeAccederSucursal, scopeSucursal } = require('../auth/middleware');
const { cargarEstructura } = require('./plantillas');
const { urlDeSubida } = require('../storage');
const { generarPdfAuditoria } = require('../pdf');
const { enviarMail } = require('../mailer');
const { calcularPuntaje } = require('../scoring');
const { crearNotificacion } = require('./notificaciones');

async function obtenerRunOForbidden(req, res) {
  const { rows } = await db.query(
    'SELECT r.*, s.nombre AS sucursal_nombre FROM audit_runs r JOIN sucursales s ON s.id = r.sucursal_id WHERE r.id = $1',
    [req.params.id]
  );
  const run = rows[0];
  if (!run) { res.status(404).json({ error: 'Auditoría no encontrada' }); return null; }
  if (!puedeAccederSucursal(req.usuario, run.sucursal_id)) { res.status(403).json({ error: 'No tenés acceso a esta sucursal' }); return null; }
  return run;
}

function evaluarCondicion(operador, valorRespuesta, valorCondicion) {
  if (valorRespuesta == null) return false;
  switch (operador) {
    // Comparación por texto, no estricta: el valor de la condición se carga
    // como texto en el constructor (ver ReglasEditor en el frontend) pero la
    // respuesta puede ser numérica (ESCALA_5) o booleana (CHECKBOX) - "3" y 3
    // tienen que matchear igual.
    case '=': return String(valorRespuesta) === String(valorCondicion);
    case '!=': return String(valorRespuesta) !== String(valorCondicion);
    case '<': return Number(valorRespuesta) < Number(valorCondicion);
    case '<=': return Number(valorRespuesta) <= Number(valorCondicion);
    case '>': return Number(valorRespuesta) > Number(valorCondicion);
    case '>=': return Number(valorRespuesta) >= Number(valorCondicion);
    case 'entre': return Number(valorRespuesta) >= Number(valorCondicion[0]) && Number(valorRespuesta) <= Number(valorCondicion[1]);
    case 'contiene': return String(valorRespuesta).toLowerCase().includes(String(valorCondicion).toLowerCase());
    default: return false;
  }
}

// Revisa que no falten respuestas obligatorias, evidencia requerida por
// item, ni las acciones que disparan las reglas condicionales (comentario/
// foto/video obligatorios). Devuelve la lista de problemas encontrados -
// vacia si esta todo en orden y se puede finalizar.
function validarCierre(estructura, respuestas, evidenciasPorRespuesta) {
  const problemas = [];
  const respuestaPorItem = new Map(respuestas.map((r) => [r.item_id, r]));
  for (const item of estructura.items) {
    const resp = respuestaPorItem.get(item.id);
    if (!resp || (resp.valor_json == null && !resp.no_aplica)) {
      if (item.tipo_respuesta !== 'TEXTO' || item.critico) {
        problemas.push(`"${item.texto}": falta responder`);
      }
      continue;
    }
    if (resp.no_aplica) continue;

    const evidencias = evidenciasPorRespuesta.get(resp.id) || [];
    if (item.evidencia_requerida !== 'NINGUNA') {
      const tieneFoto = evidencias.some((e) => e.tipo === 'FOTO');
      const tieneVideo = evidencias.some((e) => e.tipo === 'VIDEO');
      const cumple = item.evidencia_requerida === 'FOTO' ? tieneFoto
        : item.evidencia_requerida === 'VIDEO' ? tieneVideo
        : tieneFoto || tieneVideo;
      if (!cumple) problemas.push(`"${item.texto}": falta evidencia (${item.evidencia_requerida.toLowerCase().replace('_', ' ')})`);
    }

    for (const regla of item.reglas || []) {
      const dispara = evaluarCondicion(regla.condicion_json.operador, resp.valor_json, regla.condicion_json.valor);
      if (!dispara) continue;
      const acciones = regla.acciones_json;
      if (acciones.comentario_obligatorio && !resp.comentario) problemas.push(`"${item.texto}": la regla exige un comentario`);
      if (acciones.foto_obligatoria && !evidencias.some((e) => e.tipo === 'FOTO')) problemas.push(`"${item.texto}": la regla exige una foto`);
      if (acciones.video_obligatoria && !evidencias.some((e) => e.tipo === 'VIDEO')) problemas.push(`"${item.texto}": la regla exige un video`);
    }
  }
  return problemas;
}

// Crea una auditoria (o seguimiento) a partir de una plantilla publicada -
// factoreado de POST /api/runs para que el calendario (ver calendario.js,
// "iniciar auditoria" de un evento) pueda arrancar una de la misma forma
// sin duplicar la validacion de plantilla/rol ni el armado del snapshot.
// `tipo` es OPCIONAL: audit_runs.tipo solo acepta 'MARCA'|'INTERNA'|'SEGUIMIENTO'
// (distinto del tipo de evento de calendario, que tiene 'AUDITORIA' en vez
// de 'MARCA'/'INTERNA' - ver calendario.js). Si no se pasa, se usa el tipo
// propio de la plantilla.
async function crearRun({ templateId, sucursalId, tipo, rol, auditorUserId, responsableNombre }) {
  const { rows: plantillaRows } = await db.query('SELECT * FROM audit_templates WHERE id = $1 AND estado = $2', [templateId, 'PUBLICADA']);
  const plantilla = plantillaRows[0];
  if (!plantilla) throw Object.assign(new Error('La plantilla no existe o no está publicada'), { status: 400 });
  if (!plantilla.roles_permitidos.includes(rol)) throw Object.assign(new Error('Tu rol no puede ejecutar esta plantilla'), { status: 403 });

  const tipoFinal = tipo || plantilla.tipo;
  // Un Gerente nunca puede ejecutar una auditoría de marca, sin importar lo
  // que diga roles_permitidos de la plantilla (esa lista habilita quién
  // puede correr la plantilla, pero esta regla de tipo es absoluta y no se
  // configura por plantilla). Sí puede hacer internas y seguimientos.
  if (rol === 'GERENTE' && tipoFinal === 'MARCA') {
    throw Object.assign(new Error('Como gerente no podés ejecutar una auditoría de marca'), { status: 403 });
  }
  const estructura = await cargarEstructura(templateId);
  estructura.puntaje_minimo_aprobacion = plantilla.puntaje_minimo_aprobacion;
  const { rows } = await db.query(
    `INSERT INTO audit_runs (template_id, estructura_snapshot, sucursal_id, tipo, auditor_user_id, responsable_nombre)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [templateId, JSON.stringify(estructura), sucursalId, tipoFinal, auditorUserId, responsableNombre || null]
  );
  return rows[0];
}

// Arma el snapshot de un seguimiento a partir de los hallazgos elegidos de
// una auditoria de marca ya completada: solo esos items (y los sectores/
// areas a los que pertenecen) - sin duplicar toda la estructura original.
// El seguimiento no vuelve a evaluar aprobado/desaprobado por umbral, solo
// corrige puntos puntuales.
function construirSnapshotSeguimiento(origen, itemIds) {
  const itemsSeleccionados = origen.items.filter((i) => itemIds.includes(i.id));
  const sectorIdsUsados = new Set(itemsSeleccionados.map((i) => i.sector_id));
  const areaIdsUsados = new Set(itemsSeleccionados.map((i) => i.area_id));
  return {
    sectores: origen.sectores.filter((s) => sectorIdsUsados.has(s.id)),
    areas: origen.areas.filter((a) => areaIdsUsados.has(a.id)),
    items: itemsSeleccionados,
    umbrales: [],
    puntaje_minimo_aprobacion: null,
  };
}

// Crea el audit_run de un seguimiento ya PROGRAMADO desde el calendario (ver
// /api/calendario/:id/iniciar) - a diferencia de crearRun, no lee una
// plantilla viva: arma el snapshot a partir de la auditoria de marca de
// origen y los items que se eligieron al programarlo.
async function crearRunDesdeHallazgos({ origenRunId, itemIds, sucursalId, auditorUserId, responsableNombre }) {
  const { rows } = await db.query('SELECT * FROM audit_runs WHERE id = $1', [origenRunId]);
  const origen = rows[0];
  if (!origen) throw Object.assign(new Error('No se encontró la auditoría de marca de origen'), { status: 400 });
  const snapshot = construirSnapshotSeguimiento(origen.estructura_snapshot, itemIds || []);
  const { rows: creado } = await db.query(
    `INSERT INTO audit_runs (template_id, estructura_snapshot, sucursal_id, tipo, auditor_user_id, responsable_nombre, origen_run_id)
     VALUES ($1,$2,$3,'SEGUIMIENTO',$4,$5,$6) RETURNING *`,
    [origen.template_id, JSON.stringify(snapshot), sucursalId, auditorUserId, responsableNombre || null, origen.id]
  );
  return creado[0];
}

module.exports = function registrarRutasRuns(app) {
  // Plantillas PUBLICADAS que el usuario puede ejecutar para una sucursal dada.
  app.get('/api/runs/disponibles', async (req, res) => {
    const sucursalId = Number(req.query.sucursal_id);
    if (!sucursalId || !puedeAccederSucursal(req.usuario, sucursalId)) {
      return res.status(403).json({ error: 'No tenés acceso a esa sucursal' });
    }
    try {
      // Un Gerente nunca ve plantillas de marca acá, sin importar
      // roles_permitidos (ver misma regla en crearRun).
      const params = [req.usuario.rol, sucursalId];
      let filtroTipo = '';
      if (req.usuario.rol === 'GERENTE') filtroTipo = ` AND t.tipo != 'MARCA'`;
      const { rows } = await db.query(
        `SELECT t.* FROM audit_templates t
         WHERE t.estado = 'PUBLICADA'
           AND $1 = ANY(t.roles_permitidos)
           AND (t.aplica_todas_sucursales OR EXISTS (SELECT 1 FROM template_sucursales ts WHERE ts.template_id = t.id AND ts.sucursal_id = $2))
           ${filtroTipo}
         ORDER BY t.nombre`,
        params
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/runs', async (req, res) => {
    const { template_id, sucursal_id, responsable_nombre } = req.body;
    if (!template_id || !sucursal_id) return res.status(400).json({ error: 'Faltan campos: template_id, sucursal_id' });
    if (!puedeAccederSucursal(req.usuario, sucursal_id)) return res.status(403).json({ error: 'No tenés acceso a esa sucursal' });
    try {
      // El tipo NO se pide acá: lo hereda siempre de la plantilla elegida
      // (ver crearRun) - así no hay forma de que el usuario lo contradiga.
      const run = await crearRun({ templateId: template_id, sucursalId: sucursal_id, rol: req.usuario.rol, auditorUserId: req.usuario.usuarioId, responsableNombre: responsable_nombre });
      res.status(201).json(run);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // Última auditoría de MARCA completada de una sucursal - usada por el
  // seguimiento programado desde el calendario (sin plantilla: sale de los
  // hallazgos de esta auditoría, ver crearRunDesdeHallazgos).
  app.get('/api/runs/ultima-marca', async (req, res) => {
    const sucursalId = Number(req.query.sucursal_id);
    if (!sucursalId || !puedeAccederSucursal(req.usuario, sucursalId)) {
      return res.status(403).json({ error: 'No tenés acceso a esa sucursal' });
    }
    try {
      const { rows } = await db.query(
        `SELECT r.*, s.nombre AS sucursal_nombre FROM audit_runs r JOIN sucursales s ON s.id = r.sucursal_id
         WHERE r.sucursal_id = $1 AND r.tipo = 'MARCA' AND r.estado = 'COMPLETADA'
         ORDER BY r.completada_en DESC LIMIT 1`,
        [sucursalId]
      );
      const run = rows[0];
      if (!run) return res.status(404).json({ error: 'Todavía no hay ninguna auditoría de marca completada en esta sucursal' });
      const { rows: respuestas } = await db.query('SELECT * FROM audit_respuestas WHERE run_id = $1', [run.id]);
      res.json({ ...run, respuestas });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/runs/:id', async (req, res) => {
    const run = await obtenerRunOForbidden(req, res);
    if (!run) return;
    try {
      const { rows: respuestas } = await db.query('SELECT * FROM audit_respuestas WHERE run_id = $1', [req.params.id]);
      const respuestaIds = respuestas.map((r) => r.id);
      const { rows: evidencias } = respuestaIds.length
        ? await db.query('SELECT * FROM evidencias WHERE respuesta_id = ANY($1) ORDER BY creado_en', [respuestaIds])
        : { rows: [] };
      res.json({ ...run, respuestas, evidencias });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Arma el mismo objeto que GET /api/runs/:id pero con los nombres
  // (sucursal, auditor) que necesita el PDF y no vienen en audit_runs.
  async function cargarRunParaPdf(runId) {
    const { rows } = await db.query(
      `SELECT r.*, s.nombre AS sucursal_nombre, u.nombre AS auditor_nombre
       FROM audit_runs r JOIN sucursales s ON s.id = r.sucursal_id JOIN usuarios u ON u.id = r.auditor_user_id
       WHERE r.id = $1`,
      [runId]
    );
    const run = rows[0];
    if (!run) return null;
    const { rows: respuestas } = await db.query('SELECT * FROM audit_respuestas WHERE run_id = $1', [runId]);
    const respuestaIds = respuestas.map((r) => r.id);
    const { rows: evidencias } = respuestaIds.length
      ? await db.query('SELECT * FROM evidencias WHERE respuesta_id = ANY($1)', [respuestaIds])
      : { rows: [] };
    return { ...run, respuestas, evidencias };
  }

  app.get('/api/runs/:id/pdf', async (req, res) => {
    const run = await obtenerRunOForbidden(req, res);
    if (!run) return;
    if (run.estado !== 'COMPLETADA') return res.status(400).json({ error: 'Solo se puede generar el PDF de una auditoría completada' });
    try {
      const runCompleto = await cargarRunParaPdf(req.params.id);
      const buffer = await generarPdfAuditoria(runCompleto);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="auditoria-${req.params.id}.pdf"`);
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/runs/:id/enviar-informe', async (req, res) => {
    const run = await obtenerRunOForbidden(req, res);
    if (!run) return;
    if (run.estado !== 'COMPLETADA') return res.status(400).json({ error: 'Solo se puede enviar el informe de una auditoría completada' });
    const destinatarios = (req.body.destinatarios || []).map((d) => String(d).trim()).filter(Boolean);
    if (destinatarios.length === 0) return res.status(400).json({ error: 'Falta al menos un destinatario' });
    try {
      const runCompleto = await cargarRunParaPdf(req.params.id);
      const buffer = await generarPdfAuditoria(runCompleto);
      await enviarMail({
        to: destinatarios,
        subject: `Informe de auditoría — ${runCompleto.sucursal_nombre} — ${new Date(runCompleto.completada_en).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`,
        html: `<p>Adjuntamos el informe de la auditoría realizada en <strong>${runCompleto.sucursal_nombre}</strong>.</p>
               <p>Puntaje total: <strong>${Math.round((runCompleto.puntaje_total || 0) * 100)}%</strong> · Resultado: <strong>${runCompleto.resultado}</strong></p>`,
        attachments: [{ filename: `auditoria-${req.params.id}.pdf`, content: buffer }],
      });
      res.json({ ok: true, destinatarios });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Autoguardado: una respuesta por vez. itemId es el id DENTRO del snapshot.
  app.put('/api/runs/:id/respuestas/:itemId', async (req, res) => {
    const run = await obtenerRunOForbidden(req, res);
    if (!run) return;
    if (run.estado !== 'EN_PROGRESO') return res.status(400).json({ error: 'Esta auditoría ya no está en progreso' });
    const { valor_json, comentario, no_aplica } = req.body;
    try {
      const { rows } = await db.query(
        `INSERT INTO audit_respuestas (run_id, item_id, valor_json, comentario, no_aplica)
         VALUES ($1,$2,$3,$4,COALESCE($5,false))
         ON CONFLICT (run_id, item_id) DO UPDATE SET
           valor_json = EXCLUDED.valor_json, comentario = EXCLUDED.comentario,
           no_aplica = EXCLUDED.no_aplica, actualizado_en = now()
         RETURNING *`,
        [req.params.id, req.params.itemId, valor_json ?? null, comentario ?? null, no_aplica]
      );
      res.json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/runs/:id/evidencia/url-subida', async (req, res) => {
    const run = await obtenerRunOForbidden(req, res);
    if (!run) return;
    try {
      const resultado = await urlDeSubida({ contentType: req.body.content_type, runId: req.params.id });
      res.json(resultado);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/runs/:id/evidencia', async (req, res) => {
    const run = await obtenerRunOForbidden(req, res);
    if (!run) return;
    const { item_id, tipo, url, thumbnail_url } = req.body;
    if (!item_id || !tipo || !url) return res.status(400).json({ error: 'Faltan campos: item_id, tipo, url' });
    try {
      const { rows: respuestaRows } = await db.query(
        `INSERT INTO audit_respuestas (run_id, item_id) VALUES ($1,$2)
         ON CONFLICT (run_id, item_id) DO UPDATE SET actualizado_en = now() RETURNING id`,
        [req.params.id, item_id]
      );
      const { rows } = await db.query(
        'INSERT INTO evidencias (respuesta_id, tipo, url, thumbnail_url) VALUES ($1,$2,$3,$4) RETURNING *',
        [respuestaRows[0].id, tipo, url, thumbnail_url || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/evidencias/:id', async (req, res) => {
    try {
      const { rows } = await db.query(
        `DELETE FROM evidencias e USING audit_respuestas r, audit_runs run
         WHERE e.id = $1 AND e.respuesta_id = r.id AND r.run_id = run.id RETURNING run.sucursal_id`,
        [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Evidencia no encontrada' });
      if (!puedeAccederSucursal(req.usuario, rows[0].sucursal_id)) return res.status(403).json({ error: 'No tenés acceso' });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/runs/:id/finalizar', async (req, res) => {
    const run = await obtenerRunOForbidden(req, res);
    if (!run) return;
    if (run.estado !== 'EN_PROGRESO') return res.status(400).json({ error: 'Esta auditoría ya no está en progreso' });
    try {
      const { rows: respuestas } = await db.query('SELECT * FROM audit_respuestas WHERE run_id = $1', [req.params.id]);
      const respuestaIds = respuestas.map((r) => r.id);
      const { rows: evidencias } = respuestaIds.length
        ? await db.query('SELECT * FROM evidencias WHERE respuesta_id = ANY($1)', [respuestaIds])
        : { rows: [] };
      const evidenciasPorRespuesta = new Map();
      for (const e of evidencias) {
        if (!evidenciasPorRespuesta.has(e.respuesta_id)) evidenciasPorRespuesta.set(e.respuesta_id, []);
        evidenciasPorRespuesta.get(e.respuesta_id).push(e);
      }

      const estructura = run.estructura_snapshot;
      const problemas = validarCierre(estructura, respuestas, evidenciasPorRespuesta);
      if (problemas.length > 0) return res.status(400).json({ error: 'Faltan datos obligatorios para finalizar', detalle: problemas });

      const semaforoConfig = (await db.query('SELECT * FROM semaforo_config ORDER BY orden')).rows;
      const resultadoCalculo = calcularPuntaje({
        sectores: estructura.sectores, areas: estructura.areas, items: estructura.items,
        respuestas, umbrales: estructura.umbrales, semaforoConfig,
        puntajeMinimoAprobacion: estructura.puntaje_minimo_aprobacion,
      });

      const { firma_nombre, firma_responsable } = req.body;
      const { rows } = await db.query(
        `UPDATE audit_runs SET estado = 'COMPLETADA', completada_en = now(), puntaje_total = $1,
         semaforo = $2, resultado = $3, detalle_calculo = $4, firma_nombre = $5, firma_responsable = $6
         WHERE id = $7 RETURNING *`,
        [resultadoCalculo.puntajeTotal, resultadoCalculo.semaforo, resultadoCalculo.resultado,
          JSON.stringify(resultadoCalculo.detalle), firma_nombre || null, firma_responsable || null, req.params.id]
      );
      res.json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Programa una auditoria de seguimiento a partir de los hallazgos
  // elegidos de una auditoria de MARCA ya completada - no la ejecuta al
  // toque: crea un evento de calendario (PENDIENTE) para una fecha/hora y
  // responsable concretos, que se inicia mas adelante desde el calendario
  // (ver /api/calendario/:id/iniciar y crearRunDesdeHallazgos). El
  // responsable recibe una notificacion ahora y un recordatorio el dia de
  // la fecha programada (ver src/recordatorios). Un Gerente tambien puede
  // generarlo (limitado a su propia sucursal, via obtenerRunOForbidden).
  app.post('/api/runs/:id/seguimiento', async (req, res) => {
    if (!['ADMIN', 'AUDITOR', 'GERENTE'].includes(req.usuario.rol)) {
      return res.status(403).json({ error: 'Solo administrador, auditor o gerente pueden generar un seguimiento' });
    }
    const run = await obtenerRunOForbidden(req, res);
    if (!run) return;
    if (run.estado !== 'COMPLETADA') return res.status(400).json({ error: 'Solo se puede generar un seguimiento de una auditoría completada' });
    if (run.tipo !== 'MARCA') return res.status(400).json({ error: 'El seguimiento se genera solo a partir de una auditoría de marca' });
    const { item_ids = [], responsable_user_id, fecha_hora, notificar = true } = req.body;
    if (item_ids.length === 0) return res.status(400).json({ error: 'Elegí al menos un hallazgo para el seguimiento' });
    if (!responsable_user_id || !fecha_hora) return res.status(400).json({ error: 'Faltan campos: responsable_user_id, fecha_hora' });
    try {
      const { rows: plantillaRows } = await db.query('SELECT nombre FROM audit_templates WHERE id = $1', [run.template_id]);
      const tituloBase = plantillaRows[0]?.nombre || 'Auditoría';
      const { rows } = await db.query(
        `INSERT INTO schedule_events (sucursal_id, tipo, template_id, titulo, responsable_user_id, fecha_hora, origen_run_id, items_seleccionados, creado_por)
         VALUES ($1,'SEGUIMIENTO',$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [run.sucursal_id, run.template_id, `Seguimiento — ${tituloBase}`, responsable_user_id, fecha_hora, run.id, item_ids, req.usuario.usuarioId]
      );
      const evento = rows[0];
      if (notificar) {
        await crearNotificacion(responsable_user_id, 'ASIGNACION', 'Seguimiento asignado',
          `Se te asignó un seguimiento para el ${new Date(fecha_hora).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour12: false })}.`,
          { evento_id: evento.id, sucursal_id: run.sucursal_id });
      }
      res.status(201).json(evento);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
};

module.exports.crearRun = crearRun;
module.exports.crearRunDesdeHallazgos = crearRunDesdeHallazgos;
