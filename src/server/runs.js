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
const { calcularPuntaje } = require('../scoring');

async function obtenerRunOForbidden(req, res) {
  const { rows } = await db.query('SELECT * FROM audit_runs WHERE id = $1', [req.params.id]);
  const run = rows[0];
  if (!run) { res.status(404).json({ error: 'Auditoría no encontrada' }); return null; }
  if (!puedeAccederSucursal(req.usuario, run.sucursal_id)) { res.status(403).json({ error: 'No tenés acceso a esta sucursal' }); return null; }
  return run;
}

function evaluarCondicion(operador, valorRespuesta, valorCondicion) {
  if (valorRespuesta == null) return false;
  switch (operador) {
    case '=': return valorRespuesta === valorCondicion;
    case '!=': return valorRespuesta !== valorCondicion;
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

module.exports = function registrarRutasRuns(app) {
  // Plantillas PUBLICADAS que el usuario puede ejecutar para una sucursal dada.
  app.get('/api/runs/disponibles', async (req, res) => {
    const sucursalId = Number(req.query.sucursal_id);
    if (!sucursalId || !puedeAccederSucursal(req.usuario, sucursalId)) {
      return res.status(403).json({ error: 'No tenés acceso a esa sucursal' });
    }
    try {
      const { rows } = await db.query(
        `SELECT t.* FROM audit_templates t
         WHERE t.estado = 'PUBLICADA'
           AND $1 = ANY(t.roles_permitidos)
           AND (t.aplica_todas_sucursales OR EXISTS (SELECT 1 FROM template_sucursales ts WHERE ts.template_id = t.id AND ts.sucursal_id = $2))
         ORDER BY t.nombre`,
        [req.usuario.rol, sucursalId]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/runs', async (req, res) => {
    const { template_id, sucursal_id, tipo, responsable_nombre } = req.body;
    if (!template_id || !sucursal_id || !tipo) return res.status(400).json({ error: 'Faltan campos: template_id, sucursal_id, tipo' });
    if (!puedeAccederSucursal(req.usuario, sucursal_id)) return res.status(403).json({ error: 'No tenés acceso a esa sucursal' });
    try {
      const { rows: plantillaRows } = await db.query('SELECT * FROM audit_templates WHERE id = $1 AND estado = $2', [template_id, 'PUBLICADA']);
      const plantilla = plantillaRows[0];
      if (!plantilla) return res.status(400).json({ error: 'La plantilla no existe o no está publicada' });
      if (!plantilla.roles_permitidos.includes(req.usuario.rol)) return res.status(403).json({ error: 'Tu rol no puede ejecutar esta plantilla' });

      const estructura = await cargarEstructura(template_id);
      const { rows } = await db.query(
        `INSERT INTO audit_runs (template_id, estructura_snapshot, sucursal_id, tipo, auditor_user_id, responsable_nombre)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [template_id, JSON.stringify(estructura), sucursal_id, tipo, req.usuario.usuarioId, responsable_nombre || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
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

  // Crea una auditoria de seguimiento a partir de los hallazgos elegidos de
  // una ya completada - el snapshot nuevo solo incluye esos items (y los
  // sectores/areas a los que pertenecen), sin duplicar toda la auditoria.
  app.post('/api/runs/:id/seguimiento', async (req, res) => {
    const run = await obtenerRunOForbidden(req, res);
    if (!run) return;
    if (run.estado !== 'COMPLETADA') return res.status(400).json({ error: 'Solo se puede crear un seguimiento de una auditoría completada' });
    const { item_ids = [], responsable_nombre } = req.body;
    if (item_ids.length === 0) return res.status(400).json({ error: 'Elegí al menos un hallazgo para el seguimiento' });
    try {
      const origen = run.estructura_snapshot;
      const itemsSeleccionados = origen.items.filter((i) => item_ids.includes(i.id));
      const sectorIdsUsados = new Set(itemsSeleccionados.map((i) => i.sector_id));
      const areaIdsUsados = new Set(itemsSeleccionados.map((i) => i.area_id));
      const snapshotSeguimiento = {
        sectores: origen.sectores.filter((s) => sectorIdsUsados.has(s.id)),
        areas: origen.areas.filter((a) => areaIdsUsados.has(a.id)),
        items: itemsSeleccionados,
        umbrales: [], // el seguimiento no vuelve a evaluar aprobado/desaprobado por umbral, solo corrige puntos
        sucursal_ids: origen.sucursal_ids,
      };
      const { rows } = await db.query(
        `INSERT INTO audit_runs (template_id, estructura_snapshot, sucursal_id, tipo, auditor_user_id, responsable_nombre, origen_run_id)
         VALUES ($1,$2,$3,'SEGUIMIENTO',$4,$5,$6) RETURNING *`,
        [run.template_id, JSON.stringify(snapshotSeguimiento), run.sucursal_id, req.usuario.usuarioId, responsable_nombre || run.responsable_nombre, run.id]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
};
