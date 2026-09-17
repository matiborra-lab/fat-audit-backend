/**
 * ============================================================
 * COMUNICADOS - rutas (solo Admin)
 * ============================================================
 * Ver src/comunicados/index.js para la resolución de audiencia, la
 * interpolación de variables y el envío en sí (compartido con el scheduler).
 */

const db = require('../db');
const { requireAdmin } = require('../auth/middleware');
const { urlDeSubida } = require('../storage');
const { resolverDestinatarios, enviarComunicado } = require('../comunicados');

const PUESTOS = ['COCINA', 'CAJA', 'REFUERZO_COCINA'];

function validarAudiencia(criterios) {
  if (!Array.isArray(criterios) || !criterios.length) {
    const e = new Error('Elegí al menos un destinatario'); e.status = 400; throw e;
  }
  for (const c of criterios) {
    if (c.tipo === 'PERSONA') {
      if (!c.user_id) { const e = new Error('Falta user_id en un destinatario puntual'); e.status = 400; throw e; }
    } else if (c.tipo === 'PUESTO') {
      if (!c.sucursal_id || !PUESTOS.includes(c.puesto)) { const e = new Error('Sector inválido'); e.status = 400; throw e; }
    } else if (c.tipo === 'TODOS_SUCURSAL' || c.tipo === 'GERENTES_SUCURSAL') {
      if (!c.sucursal_id) { const e = new Error('Falta sucursal_id'); e.status = 400; throw e; }
    } else if (c.tipo !== 'TODOS' && c.tipo !== 'GERENTES') {
      const e = new Error('Criterio de audiencia inválido: ' + c.tipo); e.status = 400; throw e;
    }
  }
}

module.exports = function registrarRutasComunicados(app) {
  // Listado completo (sin el límite de 20 de /api/usuarios/buscar, pensado
  // para un buscador chico) - alimenta el selector de integrantes: con
  // sucursal_id trae los de esa sucursal, con todas=true trae de todas.
  app.get('/api/comunicados/miembros', requireAdmin, async (req, res) => {
    const { sucursal_id, todas } = req.query;
    if (!sucursal_id && todas !== 'true') return res.status(400).json({ error: 'Falta sucursal_id o todas=true' });
    try {
      const params = [];
      let sql = `SELECT u.id, u.nombre, u.email, u.rol, u.puesto, u.sucursal_id, s.nombre AS sucursal_nombre
                 FROM usuarios u LEFT JOIN sucursales s ON s.id = u.sucursal_id
                 WHERE u.activo = true`;
      if (sucursal_id) { params.push(sucursal_id); sql += ` AND u.sucursal_id = $${params.length}`; }
      sql += ` ORDER BY s.nombre NULLS FIRST, (u.rol = 'COLABORADOR'), (u.rol = 'GERENTE'), u.nombre`;
      const { rows } = await db.query(sql, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // URL firmada para subir la imagen opcional del comunicado (ver
  // src/storage - mismo mecanismo que la evidencia de auditorías/tareas,
  // carpeta propia para no mezclarlas).
  app.post('/api/comunicados/imagen/url-subida', requireAdmin, async (req, res) => {
    try {
      const resultado = await urlDeSubida({ contentType: req.body.content_type, runId: 'nuevo', carpeta: 'comunicados' });
      res.json(resultado);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/comunicados', requireAdmin, async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT c.*, u.nombre AS creado_por_nombre FROM comunicados c
         LEFT JOIN usuarios u ON u.id = c.creado_por
         ORDER BY COALESCE(c.fecha_envio, c.creado_en) DESC LIMIT 100`
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Body: { titulo, descripcion?, imagen_url?, enlace?, enlace_nombre?,
  // audiencia: [...criterios], fecha_envio?, hora_envio? } - sin fecha_envio
  // (o sin hora_envio) se manda de inmediato; con las dos, lo agarra el
  // scheduler cuando llegue el momento (ver src/comunicados).
  app.post('/api/comunicados', requireAdmin, async (req, res) => {
    const { titulo, descripcion, imagen_url, enlace, enlace_nombre, audiencia, fecha_envio, hora_envio } = req.body;
    if (!titulo?.trim()) return res.status(400).json({ error: 'Falta el título' });
    try {
      validarAudiencia(audiencia);
      const fechaEnvioFinal = fecha_envio && hora_envio ? new Date(`${fecha_envio}T${hora_envio}:00`) : null;
      if (fechaEnvioFinal && isNaN(fechaEnvioFinal.getTime())) return res.status(400).json({ error: 'Fecha/hora de envío inválida' });

      const { rows } = await db.query(
        `INSERT INTO comunicados (titulo, descripcion, imagen_url, enlace, enlace_nombre, audiencia_json, fecha_envio, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          titulo.trim(), descripcion?.trim() || null, imagen_url || null, enlace || null, enlace_nombre?.trim() || null,
          JSON.stringify(audiencia), fechaEnvioFinal, req.usuario.usuarioId,
        ]
      );
      let comunicado = rows[0];
      // Sin fecha futura (o ya vencida al momento de crearlo) - se manda ya.
      if (!fechaEnvioFinal || fechaEnvioFinal <= new Date()) {
        await enviarComunicado(comunicado);
        const { rows: actualizado } = await db.query('SELECT * FROM comunicados WHERE id = $1', [comunicado.id]);
        comunicado = actualizado[0];
      }
      res.status(201).json(comunicado);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // Solo se puede borrar uno que todavía no salió (programado a futuro) -
  // uno ya enviado queda como historial, no se puede "deshacer" el envío.
  app.delete('/api/comunicados/:id', requireAdmin, async (req, res) => {
    try {
      const { rows } = await db.query('SELECT enviado_en FROM comunicados WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Comunicado no encontrado' });
      if (rows[0].enviado_en) return res.status(400).json({ error: 'Este comunicado ya se envió, no se puede eliminar' });
      await db.query('DELETE FROM comunicados WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Vista previa de "a cuántos les llegaría" antes de mandar - se usa en el
  // formulario para mostrar un conteo mientras se arma la audiencia.
  app.post('/api/comunicados/contar-destinatarios', requireAdmin, async (req, res) => {
    try {
      validarAudiencia(req.body.audiencia);
      const ids = await resolverDestinatarios(req.body.audiencia, new Date());
      res.json({ cantidad: ids.length });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });
};
