/**
 * ============================================================
 * REPORTES PROGRAMADOS (rutas)
 * ============================================================
 * CRUD de la configuración - el envío en sí lo hace el scheduler de
 * src/reportes (arrancado desde server/index.js).
 */

const db = require('../db');
const { puedeAccederSucursal } = require('../auth/middleware');
const { enviarReporte } = require('../reportes');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function puedeGestionarReportes(usuario) {
  return usuario.rol === 'ADMIN' || usuario.rol === 'AUDITOR' || usuario.rol === 'GERENTE';
}

function validarBody(req) {
  const { nombre, sucursal_id, frecuencia, dia_semana, dia_mes, hora, destinatarios, activo } = req.body;
  if (!nombre) throw Object.assign(new Error('Falta el campo: nombre'), { status: 400 });
  if (!['SEMANAL', 'MENSUAL'].includes(frecuencia)) throw Object.assign(new Error('frecuencia inválida (SEMANAL o MENSUAL)'), { status: 400 });
  if (frecuencia === 'SEMANAL' && (dia_semana === undefined || dia_semana < 0 || dia_semana > 6)) {
    throw Object.assign(new Error('Falta dia_semana (0=domingo..6=sábado)'), { status: 400 });
  }
  if (frecuencia === 'MENSUAL' && (dia_mes === undefined || dia_mes < 1 || dia_mes > 28)) {
    throw Object.assign(new Error('Falta dia_mes (1 a 28)'), { status: 400 });
  }
  const listaDestinatarios = (destinatarios || []).map((d) => String(d).trim()).filter(Boolean);
  if (!listaDestinatarios.length) throw Object.assign(new Error('Falta al menos un destinatario'), { status: 400 });
  const invalido = listaDestinatarios.find((d) => !EMAIL_REGEX.test(d));
  if (invalido) throw Object.assign(new Error(`Email inválido: ${invalido}`), { status: 400 });

  // Un Gerente solo puede armar reportes de su propia sucursal (nunca "todas").
  let sucursalFinal = sucursal_id ?? null;
  if (req.usuario.rol === 'GERENTE') sucursalFinal = req.usuario.sucursal_id;
  else if (sucursalFinal && !puedeAccederSucursal(req.usuario, sucursalFinal)) {
    throw Object.assign(new Error('No tenés acceso a esa sucursal'), { status: 403 });
  }

  return {
    nombre, sucursal_id: sucursalFinal, frecuencia,
    dia_semana: frecuencia === 'SEMANAL' ? dia_semana : null,
    dia_mes: frecuencia === 'MENSUAL' ? dia_mes : null,
    hora: hora || '08:00', destinatarios: listaDestinatarios, activo: activo ?? true,
  };
}

module.exports = function registrarRutasReportes(app) {
  app.get('/api/reportes-programados', async (req, res) => {
    if (!puedeGestionarReportes(req.usuario)) return res.status(403).json({ error: 'No tenés acceso a los reportes programados' });
    try {
      let sql = `SELECT rp.*, s.nombre AS sucursal_nombre FROM reportes_programados rp
                 LEFT JOIN sucursales s ON s.id = rp.sucursal_id WHERE 1=1`;
      const params = [];
      if (req.usuario.rol === 'GERENTE') {
        params.push(req.usuario.sucursal_id);
        sql += ` AND rp.sucursal_id = $${params.length}`;
      }
      sql += ' ORDER BY rp.creado_en DESC';
      const { rows } = await db.query(sql, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/reportes-programados', async (req, res) => {
    if (!puedeGestionarReportes(req.usuario)) return res.status(403).json({ error: 'No tenés acceso a los reportes programados' });
    try {
      const datos = validarBody(req);
      const { rows } = await db.query(
        `INSERT INTO reportes_programados (nombre, sucursal_id, frecuencia, dia_semana, dia_mes, hora, destinatarios, activo, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [datos.nombre, datos.sucursal_id, datos.frecuencia, datos.dia_semana, datos.dia_mes, datos.hora, datos.destinatarios, datos.activo, req.usuario.usuarioId]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  async function obtenerReporteOForbidden(req, res) {
    const { rows } = await db.query('SELECT * FROM reportes_programados WHERE id = $1', [req.params.id]);
    const reporte = rows[0];
    if (!reporte) { res.status(404).json({ error: 'Reporte no encontrado' }); return null; }
    const propio = req.usuario.rol === 'GERENTE' && reporte.sucursal_id === req.usuario.sucursal_id;
    if (!puedeGestionarReportes(req.usuario) || (req.usuario.rol === 'GERENTE' && !propio)) {
      res.status(403).json({ error: 'No tenés acceso a este reporte' }); return null;
    }
    return reporte;
  }

  app.patch('/api/reportes-programados/:id', async (req, res) => {
    const existente = await obtenerReporteOForbidden(req, res);
    if (!existente) return;
    try {
      // PATCH parcial: si no vienen frecuencia/destinatarios, se reusan los
      // que ya tenía para poder validar el body completo con validarBody.
      const datos = validarBody({
        usuario: req.usuario,
        body: {
          nombre: req.body.nombre ?? existente.nombre,
          sucursal_id: req.body.sucursal_id !== undefined ? req.body.sucursal_id : existente.sucursal_id,
          frecuencia: req.body.frecuencia ?? existente.frecuencia,
          dia_semana: req.body.dia_semana !== undefined ? req.body.dia_semana : existente.dia_semana,
          dia_mes: req.body.dia_mes !== undefined ? req.body.dia_mes : existente.dia_mes,
          hora: req.body.hora ?? existente.hora,
          destinatarios: req.body.destinatarios ?? existente.destinatarios,
          activo: req.body.activo !== undefined ? req.body.activo : existente.activo,
        },
      });
      const { rows } = await db.query(
        `UPDATE reportes_programados SET nombre=$1, sucursal_id=$2, frecuencia=$3, dia_semana=$4, dia_mes=$5,
         hora=$6, destinatarios=$7, activo=$8 WHERE id=$9 RETURNING *`,
        [datos.nombre, datos.sucursal_id, datos.frecuencia, datos.dia_semana, datos.dia_mes, datos.hora, datos.destinatarios, datos.activo, req.params.id]
      );
      res.json(rows[0]);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.delete('/api/reportes-programados/:id', async (req, res) => {
    const existente = await obtenerReporteOForbidden(req, res);
    if (!existente) return;
    try {
      await db.query('DELETE FROM reportes_programados WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Envía el reporte ya mismo (fuera de su horario programado) - útil para
  // probar destinatarios/contenido sin esperar al próximo disparo.
  app.post('/api/reportes-programados/:id/enviar-ahora', async (req, res) => {
    const existente = await obtenerReporteOForbidden(req, res);
    if (!existente) return;
    try {
      const { rows } = await db.query(
        `SELECT rp.*, s.nombre AS sucursal_nombre FROM reportes_programados rp
         LEFT JOIN sucursales s ON s.id = rp.sucursal_id WHERE rp.id = $1`,
        [req.params.id]
      );
      const cantidad = await enviarReporte(rows[0], new Date());
      res.json({ ok: true, cantidad });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
};
