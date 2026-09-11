/**
 * ============================================================
 * SERVIDOR - FAT Audit
 * ============================================================
 * API para el frontend: sucursales, usuarios, plantillas de auditoria
 * (constructor), ejecucion de auditorias (runs), historial y dashboard -
 * con autenticacion multiusuario y alcance por rol/sucursal.
 *
 * Todo lo que esta despues de `app.use(requireAuth)` exige estar logueado.
 * Un GERENTE solo puede leer/escribir datos de su propia sucursal (ver
 * puedeAccederSucursal/scopeSucursal en auth/middleware.js).
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('../db');
const { hashearPassword, verificarPassword } = require('../auth/passwords');
const { emitirToken } = require('../auth/sesion');
const { crearToken, validarToken, marcarTokenUsado } = require('../auth/tokensUsuario');
const { requireAuth, requireAdmin, puedeAccederSucursal, scopeSucursal, canAccessFatAudit } = require('../auth/middleware');
const { enviarMail } = require('../mailer');
const { urlDeSubida } = require('../storage');
const { calcularPuntaje } = require('../scoring');

const app = express();

const origenesPermitidos = new Set(
  ['http://localhost:5173', process.env.FRONTEND_URL].filter(Boolean)
);
app.use(cors({
  origin(origin, callback) {
    if (!origin || origenesPermitidos.has(origin)) return callback(null, true);
    callback(new Error('Origen no permitido por CORS: ' + origin));
  },
}));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/health/db', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES_VALIDOS = ['ADMIN', 'AUDITOR', 'GERENTE'];

function linkDefinirPassword(token) {
  const base = process.env.FRONTEND_URL || 'http://localhost:5173';
  return base.replace(/\/$/, '') + '/definir-clave?token=' + token;
}

// ------------------------------------------------------------
// Auth (publico)
// ------------------------------------------------------------

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Faltan campos: email, password' });
  try {
    const { rows } = await db.query(
      'SELECT id, email, nombre, password_hash, rol, sucursal_id, activo FROM usuarios WHERE email = $1',
      [String(email).toLowerCase().trim()]
    );
    const usuario = rows[0];
    if (!canAccessFatAudit(usuario) || !(await verificarPassword(password, usuario.password_hash))) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }
    await db.query('UPDATE usuarios SET ultimo_login = now() WHERE id = $1', [usuario.id]);
    const token = emitirToken(usuario);
    res.json({
      token,
      usuario: { id: usuario.id, email: usuario.email, nombre: usuario.nombre, rol: usuario.rol, sucursal_id: usuario.sucursal_id },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/olvide-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Falta el campo: email' });
  try {
    const { rows } = await db.query('SELECT id, email FROM usuarios WHERE email = $1 AND activo = true', [String(email).toLowerCase().trim()]);
    if (rows[0]) {
      const token = await crearToken(rows[0].id, 'RESET');
      await enviarMail({
        to: rows[0].email,
        subject: 'FAT Audit - Restablecer tu contraseña',
        html: `<p>Pediste restablecer tu contraseña en FAT Audit.</p><p><a href="${linkDefinirPassword(token)}">Elegir una contraseña nueva</a></p><p>Este link vence en 48 horas.</p>`,
      });
    }
    res.json({ message: 'Si el mail existe, te llega un link para restablecer la contraseña.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/definir-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Faltan campos: token, password' });
  if (String(password).length < 8) return res.status(400).json({ error: 'La contraseña tiene que tener al menos 8 caracteres' });
  try {
    const registro = (await validarToken(token, 'INVITACION')) || (await validarToken(token, 'RESET'));
    if (!registro) return res.status(400).json({ error: 'El link es invalido o ya vencio' });

    const { rows: usuarioRows } = await db.query('SELECT activo FROM usuarios WHERE id = $1', [registro.usuario_id]);
    if (!canAccessFatAudit(usuarioRows[0])) {
      return res.status(403).json({ error: 'Tu usuario se encuentra deshabilitado. Contactate con el administrador.' });
    }

    const hash = await hashearPassword(password);
    const { rows } = await db.query(
      `UPDATE usuarios SET password_hash = $1, ultimo_login = now() WHERE id = $2
       RETURNING id, email, nombre, rol, sucursal_id`,
      [hash, registro.usuario_id]
    );
    await marcarTokenUsado(registro.id);
    const usuario = rows[0];
    const nuevoToken = emitirToken({ id: usuario.id });
    res.json({ token: nuevoToken, usuario });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// A partir de aca, todo requiere estar logueado
// ------------------------------------------------------------
app.use(requireAuth);

app.get('/api/auth/yo', (req, res) => {
  res.json({
    id: req.usuario.usuarioId, email: req.usuario.email, nombre: req.usuario.nombre,
    rol: req.usuario.rol, sucursal_id: req.usuario.sucursal_id,
  });
});

app.post('/api/auth/cambiar-password', async (req, res) => {
  const { passwordActual, passwordNueva } = req.body;
  if (!passwordActual || !passwordNueva) return res.status(400).json({ error: 'Faltan campos' });
  if (String(passwordNueva).length < 8) return res.status(400).json({ error: 'La contraseña nueva tiene que tener al menos 8 caracteres' });
  try {
    const { rows } = await db.query('SELECT password_hash FROM usuarios WHERE id = $1', [req.usuario.usuarioId]);
    if (!rows[0] || !(await verificarPassword(passwordActual, rows[0].password_hash))) {
      return res.status(401).json({ error: 'La contraseña actual no es correcta' });
    }
    const hash = await hashearPassword(passwordNueva);
    await db.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [hash, req.usuario.usuarioId]);
    res.json({ message: 'Contraseña actualizada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// Sucursales
// ------------------------------------------------------------

app.get('/api/sucursales', async (req, res) => {
  try {
    let sql = 'SELECT * FROM sucursales WHERE activo = true';
    let params = [];
    if (req.usuario.rol === 'GERENTE') {
      const scoped = scopeSucursal(req.usuario, 'id', params);
      sql += scoped.sql;
      params = scoped.params;
    }
    const { rows } = await db.query(sql + ' ORDER BY nombre', params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sucursales', requireAdmin, async (req, res) => {
  const { nombre, codigo, direccion } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Falta el campo: nombre' });
  try {
    const { rows } = await db.query(
      'INSERT INTO sucursales (nombre, codigo, direccion) VALUES ($1,$2,$3) RETURNING *',
      [nombre, codigo || null, direccion || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ya existe una sucursal con ese código' });
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/sucursales/:id', requireAdmin, async (req, res) => {
  const { nombre, codigo, direccion, activo } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE sucursales SET nombre = COALESCE($1,nombre), codigo = COALESCE($2,codigo),
       direccion = COALESCE($3,direccion), activo = COALESCE($4,activo) WHERE id = $5 RETURNING *`,
      [nombre ?? null, codigo ?? null, direccion ?? null, activo ?? null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Sucursal no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// Usuarios (admin)
// ------------------------------------------------------------

app.get('/api/admin/usuarios', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.nombre, u.rol, u.sucursal_id, s.nombre AS sucursal_nombre,
              u.activo, u.eliminado_en, u.ultimo_login, u.creado_en, (u.password_hash IS NOT NULL) AS clave_definida
       FROM usuarios u LEFT JOIN sucursales s ON s.id = u.sucursal_id
       ORDER BY u.creado_en DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/usuarios', requireAdmin, async (req, res) => {
  const { email, nombre, rol, sucursal_id } = req.body;
  if (!email || !EMAIL_REGEX.test(email)) return res.status(400).json({ error: 'El email no es valido' });
  if (!ROLES_VALIDOS.includes(rol)) return res.status(400).json({ error: 'Rol invalido, tiene que ser uno de: ' + ROLES_VALIDOS.join(', ') });
  if (rol === 'GERENTE' && !sucursal_id) return res.status(400).json({ error: 'Un gerente necesita una sucursal asignada' });

  try {
    const { rows } = await db.query(
      `INSERT INTO usuarios (email, nombre, rol, sucursal_id) VALUES ($1,$2,$3,$4)
       RETURNING id, email, nombre, rol, sucursal_id, activo, creado_en`,
      [String(email).toLowerCase().trim(), nombre || null, rol, rol === 'GERENTE' ? sucursal_id : null]
    );
    const usuario = rows[0];
    try {
      const token = await crearToken(usuario.id, 'INVITACION');
      await enviarMail({
        to: usuario.email,
        subject: 'FAT Audit - Te invitaron a la plataforma',
        html: `<p>Te dieron acceso a FAT Audit como <strong>${rol}</strong>.</p><p><a href="${linkDefinirPassword(token)}">Crear mi contraseña</a></p><p>Este link vence en 48 horas.</p>`,
      });
      res.status(201).json(usuario);
    } catch (mailErr) {
      res.status(201).json({ ...usuario, advertencia: 'El usuario se creo pero no se pudo mandar el mail de invitacion: ' + mailErr.message });
    }
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ya existe un usuario con ese email' });
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/admin/usuarios/:id', requireAdmin, async (req, res) => {
  const { rol, sucursal_id, activo, nombre } = req.body;
  if (rol !== undefined && !ROLES_VALIDOS.includes(rol)) return res.status(400).json({ error: 'Rol invalido' });
  if (rol === 'GERENTE' && sucursal_id === undefined) return res.status(400).json({ error: 'Un gerente necesita una sucursal asignada' });
  try {
    const { rows } = await db.query(
      `UPDATE usuarios SET rol = COALESCE($1,rol), nombre = COALESCE($2,nombre),
       sucursal_id = CASE WHEN $1 = 'GERENTE' THEN $3 WHEN $1 IS NOT NULL THEN NULL ELSE sucursal_id END,
       activo = COALESCE($4,activo)
       WHERE id = $5 RETURNING id, email, nombre, rol, sucursal_id, activo`,
      [rol ?? null, nombre ?? null, sucursal_id ?? null, activo ?? null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/usuarios/:id/resetear', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, email, activo FROM usuarios WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!rows[0].activo) return res.status(400).json({ error: 'Este usuario esta deshabilitado - reactivalo antes de reenviar la invitacion' });
    const token = await crearToken(rows[0].id, 'RESET');
    await enviarMail({
      to: rows[0].email,
      subject: 'FAT Audit - Restablecer tu contraseña',
      html: `<p>Un administrador pidió restablecer tu contraseña.</p><p><a href="${linkDefinirPassword(token)}">Elegir una contraseña nueva</a></p>`,
    });
    res.json({ message: 'Mail de reseteo enviado a ' + rows[0].email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const plantillas = require('./plantillas');
const runs = require('./runs');
const historial = require('./historial');
const calendario = require('./calendario');
plantillas(app);
runs(app);
historial(app);
calendario(app);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FAT Audit backend escuchando en :${PORT}`));

module.exports = app;
