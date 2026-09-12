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
const { obtenerPronostico } = require('../clima');
const { actualizarFeriados } = require('../feriados');

const app = express();

// FRONTEND_URL admite varias URLs separadas por coma (ej: la del dominio
// propio + la de vercel.app de respaldo) - así migrar a un dominio nuevo no
// corta el acceso desde la URL vieja mientras el DNS todavia propaga.
const origenesPermitidos = new Set(
  ['http://localhost:5173', ...(process.env.FRONTEND_URL || '').split(',').map((u) => u.trim())].filter(Boolean)
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
const USUARIO_REGEX = /^[a-zA-Z0-9._-]{3,30}$/;
const ROLES_VALIDOS = ['ADMIN', 'AUDITOR', 'GERENTE', 'COLABORADOR'];
const PUESTOS_VALIDOS = ['COCINA', 'CAJA', 'REFUERZO_COCINA'];

// Un Gerente puede administrar SOLO colaboradores de su propia sucursal -
// nunca otros gerentes, auditores o admins (eso sigue siendo exclusivo de
// Admin). Se usa en las rutas de usuarios en vez de requireAdmin.
function requireAdminOGerente(req, res, next) {
  if (req.usuario.rol !== 'ADMIN' && req.usuario.rol !== 'GERENTE') {
    return res.status(403).json({ error: 'Esta acción es solo para administradores o gerentes' });
  }
  next();
}

function linkDefinirPassword(token) {
  // FRONTEND_URL puede traer varias URLs separadas por coma (ver
  // origenesPermitidos) - la primera es la canónica, la que va en los
  // links de los mails.
  const base = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim();
  return base.replace(/\/$/, '') + '/definir-clave?token=' + token;
}

// ------------------------------------------------------------
// Auth (publico)
// ------------------------------------------------------------

app.post('/api/auth/login', async (req, res) => {
  // Se puede ingresar con email o con nombre de usuario (usuarios.usuario) -
  // el campo llega como `identificador`, pero se acepta `email` tambien por
  // compatibilidad con el body viejo.
  const identificador = req.body.identificador ?? req.body.email;
  const { password } = req.body;
  if (!identificador || !password) return res.status(400).json({ error: 'Faltan campos: identificador, password' });
  try {
    const valor = String(identificador).toLowerCase().trim();
    const { rows } = await db.query(
      'SELECT id, email, nombre, password_hash, rol, sucursal_id, activo FROM usuarios WHERE email = $1 OR LOWER(usuario) = $1',
      [valor]
    );
    const usuario = rows[0];
    if (!canAccessFatAudit(usuario) || !(await verificarPassword(password, usuario.password_hash))) {
      return res.status(401).json({ error: 'Usuario/email o contraseña incorrectos' });
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
    // Horario por defecto (los 7 días, 08-16 diurno / 16-00 nocturno,
    // habilitados) - se edita después desde la ficha de la sucursal.
    const filasHorario = [];
    for (let dia = 0; dia <= 6; dia++) {
      filasHorario.push([rows[0].id, dia, 'DIURNO', true, '08:00', '16:00']);
      filasHorario.push([rows[0].id, dia, 'NOCTURNO', true, '16:00', '00:00']);
    }
    await db.bulkInsert(db.pool, 'sucursal_horarios_turno',
      ['sucursal_id', 'dia_semana', 'turno_tipo', 'habilitado', 'hora_desde', 'hora_hasta'], filasHorario, 'id');
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ya existe una sucursal con ese código' });
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/sucursales/:id', requireAdmin, async (req, res) => {
  const { nombre, codigo, direccion, activo, latitud, longitud } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE sucursales SET nombre = COALESCE($1,nombre), codigo = COALESCE($2,codigo),
       direccion = COALESCE($3,direccion), activo = COALESCE($4,activo),
       latitud = COALESCE($5,latitud), longitud = COALESCE($6,longitud)
       WHERE id = $7 RETURNING *`,
      [nombre ?? null, codigo ?? null, direccion ?? null, activo ?? null, latitud ?? null, longitud ?? null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Sucursal no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Pronóstico informativo (16 días) para el calendario - array vacío si la
// sucursal no tiene coordenadas cargadas (ver clima/index.js).
app.get('/api/sucursales/:id/clima', async (req, res) => {
  if (!puedeAccederSucursal(req.usuario, req.params.id)) return res.status(403).json({ error: 'No tenés acceso a esa sucursal' });
  try {
    const { rows } = await db.query('SELECT latitud, longitud FROM sucursales WHERE id = $1', [req.params.id]);
    const sucursal = rows[0];
    if (!sucursal?.latitud || !sucursal?.longitud) return res.json([]);
    const dias = await obtenerPronostico(sucursal.latitud, sucursal.longitud);
    res.json(dias);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cumpleaños de Gerente/Colaborador de una sucursal, como fecha especial
// recurrente en su calendario - fecha recalculada al año pedido (default el
// actual). Array vacío si nadie tiene fecha_nacimiento cargada.
app.get('/api/sucursales/:id/cumpleanos', async (req, res) => {
  if (!puedeAccederSucursal(req.usuario, req.params.id)) return res.status(403).json({ error: 'No tenés acceso a esa sucursal' });
  const anio = Number(req.query.anio) || new Date().getFullYear();
  try {
    const { rows } = await db.query(
      `SELECT id AS usuario_id, nombre, email, fecha_nacimiento
       FROM usuarios
       WHERE sucursal_id = $1 AND activo = true AND rol IN ('GERENTE','COLABORADOR') AND fecha_nacimiento IS NOT NULL`,
      [req.params.id]
    );
    // Se recalcula la fecha en JS (no con make_date en SQL) para poder
    // correr un 29/feb al 28 en un año no bisiesto sin que eso rompa toda
    // la consulta (make_date tira error ante una fecha inválida).
    const bisiesto = (anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0;
    const resultado = rows.map((u) => {
      const fn = new Date(u.fecha_nacimiento);
      const mes = fn.getUTCMonth();
      const dia = mes === 1 && fn.getUTCDate() === 29 && !bisiesto ? 28 : fn.getUTCDate();
      return { usuario_id: u.usuario_id, nombre: u.nombre, email: u.email, fecha: `${anio}-${String(mes + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}` };
    });
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Feriados nacionales/trasladables/puentes (ArgentinaDatos, cacheados en la
// tabla feriados) - no son de una sucursal en particular, cualquier usuario
// autenticado los puede ver.
app.get('/api/feriados', async (req, res) => {
  const { desde, hasta } = req.query;
  try {
    // to_char en vez de devolver la columna DATE cruda - pg la serializa como
    // timestamp completo (medianoche UTC) y el frontend compara por fecha
    // exacta 'YYYY-MM-DD' (mismo formato que aClaveDia).
    let sql = "SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, nombre, tipo FROM feriados WHERE 1=1";
    const params = [];
    if (desde) { params.push(desde); sql += ` AND fecha >= $${params.length}`; }
    if (hasta) { params.push(hasta); sql += ` AND fecha <= $${params.length}`; }
    sql += ' ORDER BY fecha';
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Actualización manual (fuerza el refresco aunque ya haya datos cacheados) -
// solo Admin, desde Configuración.
app.post('/api/feriados/actualizar', requireAdmin, async (req, res) => {
  const anio = Number(req.body.anio) || new Date().getFullYear();
  try {
    const cantidad = await actualizarFeriados(anio);
    res.json({ anio, actualizados: cantidad });
  } catch (err) {
    res.status(502).json({ error: 'No se pudo actualizar desde ArgentinaDatos: ' + err.message });
  }
});

// Un Gerente puede configurar el horario de turnos SOLO de su propia
// sucursal; Admin, de cualquiera. Única fuente de verdad de horarios (ver
// sucursal_horarios_turno) - Gestionar turnos solo lee esto.
function puedeConfigurarHorarioTurnos(usuario, sucursalId) {
  if (usuario.rol === 'ADMIN') return true;
  return usuario.rol === 'GERENTE' && usuario.sucursal_id === Number(sucursalId);
}

app.get('/api/sucursales/:id/horario-turnos', async (req, res) => {
  if (!puedeAccederSucursal(req.usuario, req.params.id)) return res.status(403).json({ error: 'No tenés acceso a esa sucursal' });
  try {
    const { rows } = await db.query(
      'SELECT dia_semana, turno_tipo, habilitado, hora_desde, hora_hasta FROM sucursal_horarios_turno WHERE sucursal_id = $1 ORDER BY dia_semana, turno_tipo',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reemplaza toda la configuración semanal de una sucursal de una vez.
// Body: { dias: [{ dia_semana, turno_tipo, habilitado, hora_desde, hora_hasta }, ...] } (14 entradas: 7 días x 2 turnos)
app.put('/api/sucursales/:id/horario-turnos', async (req, res) => {
  if (!puedeConfigurarHorarioTurnos(req.usuario, req.params.id)) return res.status(403).json({ error: 'No tenés permiso para configurar el horario de esta sucursal' });
  const { dias } = req.body;
  if (!Array.isArray(dias) || !dias.length) return res.status(400).json({ error: 'Falta el campo: dias' });
  for (const d of dias) {
    if (d.dia_semana < 0 || d.dia_semana > 6 || !['DIURNO', 'NOCTURNO'].includes(d.turno_tipo) || !d.hora_desde || !d.hora_hasta) {
      return res.status(400).json({ error: 'Cada entrada necesita: dia_semana (0-6), turno_tipo, hora_desde, hora_hasta' });
    }
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const d of dias) {
      await client.query(
        `INSERT INTO sucursal_horarios_turno (sucursal_id, dia_semana, turno_tipo, habilitado, hora_desde, hora_hasta)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (sucursal_id, dia_semana, turno_tipo)
         DO UPDATE SET habilitado = EXCLUDED.habilitado, hora_desde = EXCLUDED.hora_desde, hora_hasta = EXCLUDED.hora_hasta`,
        [req.params.id, d.dia_semana, d.turno_tipo, d.habilitado !== false, d.hora_desde, d.hora_hasta]
      );
    }
    await client.query('COMMIT');
    const { rows } = await client.query(
      'SELECT dia_semana, turno_tipo, habilitado, hora_desde, hora_hasta FROM sucursal_horarios_turno WHERE sucursal_id = $1 ORDER BY dia_semana, turno_tipo',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// Usuarios (admin)
// ------------------------------------------------------------

app.get('/api/admin/usuarios', requireAdminOGerente, async (req, res) => {
  try {
    // to_char en fecha_nacimiento - una columna DATE cruda serializa como
    // timestamp completo via pg/JSON, y el frontend la usa tal cual en un
    // <input type="date"> (mismo ajuste que GET /api/feriados).
    let sql = `SELECT u.id, u.email, u.usuario, u.nombre, u.rol, u.sucursal_id, s.nombre AS sucursal_nombre, u.puesto,
              to_char(u.fecha_nacimiento, 'YYYY-MM-DD') AS fecha_nacimiento,
              u.activo, u.eliminado_en, u.ultimo_login, u.ultima_actividad_en, u.creado_en, (u.password_hash IS NOT NULL) AS clave_definida
       FROM usuarios u LEFT JOIN sucursales s ON s.id = u.sucursal_id WHERE 1=1`;
    const params = [];
    // Un Gerente solo ve/administra los colaboradores de su propia sucursal.
    if (req.usuario.rol === 'GERENTE') {
      params.push(req.usuario.sucursal_id, 'COLABORADOR');
      sql += ` AND u.sucursal_id = $1 AND u.rol = $2`;
    } else {
      // Admin/Auditor: filtros opcionales por sucursal y/o rol.
      if (req.query.sucursal_id) { params.push(req.query.sucursal_id); sql += ` AND u.sucursal_id = $${params.length}`; }
      if (req.query.rol) { params.push(req.query.rol); sql += ` AND u.rol = $${params.length}`; }
    }
    sql += ' ORDER BY u.creado_en DESC';
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/usuarios', requireAdminOGerente, async (req, res) => {
  let { email, usuario: nombreUsuario, nombre, rol, sucursal_id, puesto, fecha_nacimiento } = req.body;
  if (!email || !EMAIL_REGEX.test(email)) return res.status(400).json({ error: 'El email no es valido' });
  if (nombreUsuario && !USUARIO_REGEX.test(nombreUsuario)) return res.status(400).json({ error: 'El nombre de usuario tiene que tener 3-30 caracteres (letras, numeros, puntos, guiones)' });

  // Un Gerente solo puede invitar colaboradores, y siempre a su propia
  // sucursal (se ignora cualquier sucursal_id que mande - no se puede pedir
  // "confiar" en el body para esto).
  if (req.usuario.rol === 'GERENTE') {
    rol = 'COLABORADOR';
    sucursal_id = req.usuario.sucursal_id;
  }
  if (!ROLES_VALIDOS.includes(rol)) return res.status(400).json({ error: 'Rol invalido, tiene que ser uno de: ' + ROLES_VALIDOS.join(', ') });
  if ((rol === 'GERENTE' || rol === 'COLABORADOR') && !sucursal_id) return res.status(400).json({ error: 'Este rol necesita una sucursal asignada' });
  if (rol === 'COLABORADOR' && !PUESTOS_VALIDOS.includes(puesto)) return res.status(400).json({ error: 'Un colaborador necesita un puesto válido: ' + PUESTOS_VALIDOS.join(', ') });

  try {
    const { rows } = await db.query(
      `INSERT INTO usuarios (email, usuario, nombre, rol, sucursal_id, puesto, fecha_nacimiento) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, email, usuario, nombre, rol, sucursal_id, puesto, fecha_nacimiento, activo, creado_en`,
      [String(email).toLowerCase().trim(), nombreUsuario ? nombreUsuario.trim() : null, nombre || null, rol, (rol === 'GERENTE' || rol === 'COLABORADOR') ? sucursal_id : null, rol === 'COLABORADOR' ? puesto : null, fecha_nacimiento || null]
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
    if (err.code === '23505') {
      const campo = err.constraint?.includes('usuario') ? 'nombre de usuario' : 'email';
      return res.status(400).json({ error: `Ya existe un usuario con ese ${campo}` });
    }
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/admin/usuarios/:id', requireAdminOGerente, async (req, res) => {
  try {
    const { rows: actualRows } = await db.query('SELECT rol, sucursal_id FROM usuarios WHERE id = $1', [req.params.id]);
    if (!actualRows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (req.usuario.rol === 'GERENTE') {
      // Un Gerente solo puede tocar activo/puesto/nombre de SUS colaboradores
      // - nunca el rol ni la sucursal (evita que se "traspase" a otro local
      // o se autoascienda pisando el rol).
      if (actualRows[0].rol !== 'COLABORADOR' || actualRows[0].sucursal_id !== req.usuario.sucursal_id) {
        return res.status(403).json({ error: 'No podés editar este usuario' });
      }
      if (req.body.rol !== undefined || req.body.sucursal_id !== undefined) {
        return res.status(403).json({ error: 'Un gerente no puede cambiar el rol ni la sucursal de un colaborador' });
      }
      if (req.body.puesto !== undefined && !PUESTOS_VALIDOS.includes(req.body.puesto)) {
        return res.status(400).json({ error: 'Puesto inválido: ' + PUESTOS_VALIDOS.join(', ') });
      }
      if (req.body.usuario && !USUARIO_REGEX.test(req.body.usuario)) {
        return res.status(400).json({ error: 'El nombre de usuario tiene que tener 3-30 caracteres (letras, numeros, puntos, guiones)' });
      }
      const { rows } = await db.query(
        `UPDATE usuarios SET nombre = COALESCE($1,nombre), puesto = COALESCE($2,puesto), activo = COALESCE($3,activo),
         usuario = COALESCE($5,usuario), fecha_nacimiento = COALESCE($6,fecha_nacimiento)
         WHERE id = $4 RETURNING id, email, usuario, nombre, rol, sucursal_id, puesto, fecha_nacimiento, activo`,
        [req.body.nombre ?? null, req.body.puesto ?? null, req.body.activo ?? null, req.params.id, req.body.usuario ? req.body.usuario.trim() : null, req.body.fecha_nacimiento ?? null]
      );
      return res.json(rows[0]);
    }

    const { rol, sucursal_id, activo, nombre, puesto, usuario: nombreUsuario, fecha_nacimiento } = req.body;
    if (rol !== undefined && !ROLES_VALIDOS.includes(rol)) return res.status(400).json({ error: 'Rol invalido' });
    if (rol === 'GERENTE' && sucursal_id === undefined) return res.status(400).json({ error: 'Un gerente necesita una sucursal asignada' });
    if (rol === 'COLABORADOR' && sucursal_id === undefined) return res.status(400).json({ error: 'Un colaborador necesita una sucursal asignada' });
    if (rol === 'COLABORADOR' && puesto !== undefined && !PUESTOS_VALIDOS.includes(puesto)) return res.status(400).json({ error: 'Puesto inválido: ' + PUESTOS_VALIDOS.join(', ') });
    if (nombreUsuario && !USUARIO_REGEX.test(nombreUsuario)) return res.status(400).json({ error: 'El nombre de usuario tiene que tener 3-30 caracteres (letras, numeros, puntos, guiones)' });
    const { rows } = await db.query(
      `UPDATE usuarios SET rol = COALESCE($1,rol), nombre = COALESCE($2,nombre),
       sucursal_id = CASE WHEN $1 IN ('GERENTE','COLABORADOR') THEN $3 WHEN $1 IS NOT NULL THEN NULL ELSE sucursal_id END,
       puesto = CASE WHEN $1 = 'COLABORADOR' THEN COALESCE($6,puesto) WHEN $1 IS NOT NULL THEN NULL ELSE puesto END,
       activo = COALESCE($4,activo), usuario = COALESCE($7,usuario), fecha_nacimiento = COALESCE($8,fecha_nacimiento)
       WHERE id = $5 RETURNING id, email, usuario, nombre, rol, sucursal_id, puesto, fecha_nacimiento, activo`,
      [rol ?? null, nombre ?? null, sucursal_id ?? null, activo ?? null, req.params.id, puesto ?? null, nombreUsuario ? nombreUsuario.trim() : null, fecha_nacimiento ?? null]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      const campo = err.constraint?.includes('usuario') ? 'nombre de usuario' : 'email';
      return res.status(400).json({ error: `Ya existe un usuario con ese ${campo}` });
    }
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/usuarios/:id/resetear', requireAdminOGerente, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, email, activo, rol, sucursal_id FROM usuarios WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (req.usuario.rol === 'GERENTE' && (rows[0].rol !== 'COLABORADOR' || rows[0].sucursal_id !== req.usuario.sucursal_id)) {
      return res.status(403).json({ error: 'No podés resetear la clave de este usuario' });
    }
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

// ------------------------------------------------------------
// Buscador de responsables (para el picker de auditorías, turnos y
// eventos de calendario) - devuelve gente que pertenece a esa sucursal
// (Gerente + Colaboradores) mas Admin/Auditor, que pueden ser responsables
// de cualquier sucursal.
// ------------------------------------------------------------
app.get('/api/usuarios/buscar', async (req, res) => {
  let sucursalId = req.query.sucursal_id ? Number(req.query.sucursal_id) : null;
  const q = (req.query.q || '').trim();

  if (req.usuario.rol === 'GERENTE' || req.usuario.rol === 'COLABORADOR') {
    sucursalId = req.usuario.sucursal_id;
  }
  // "Todas las sucursales": solo Admin/Auditor, para elegir responsable de un
  // Evento especial que no está atado a una sucursal en particular.
  const todasLasSucursales = !sucursalId && req.query.todas === 'true' && (req.usuario.rol === 'ADMIN' || req.usuario.rol === 'AUDITOR');
  if (!sucursalId && !todasLasSucursales) return res.status(400).json({ error: 'Falta el parámetro: sucursal_id' });

  try {
    const params = [];
    let sql;
    if (todasLasSucursales) {
      sql = `SELECT u.id, u.nombre, u.email, u.rol, u.puesto, s.nombre AS sucursal_nombre
             FROM usuarios u LEFT JOIN sucursales s ON s.id = u.sucursal_id WHERE u.activo = true`;
    } else {
      params.push(sucursalId);
      // Un Gerente no puede elegir Admin ni Auditor como responsable (solo a
      // otro Gerente de su sucursal o a un Colaborador) - Admin/Auditor
      // siguen viendo a todos, incluidos ellos mismos.
      sql = req.usuario.rol === 'GERENTE'
        ? `SELECT id, nombre, email, rol, puesto FROM usuarios
           WHERE activo = true AND sucursal_id = $1 AND rol IN ('GERENTE','COLABORADOR')`
        : `SELECT id, nombre, email, rol, puesto FROM usuarios
           WHERE activo = true AND (sucursal_id = $1 OR rol IN ('ADMIN','AUDITOR'))`;
    }
    if (q) {
      params.push(`%${q}%`);
      sql += ` AND (${todasLasSucursales ? 'u.nombre' : 'nombre'} ILIKE $${params.length} OR ${todasLasSucursales ? 'u.email' : 'email'} ILIKE $${params.length})`;
    }
    sql += ` ORDER BY (${todasLasSucursales ? 'u.rol' : 'rol'} = 'COLABORADOR') DESC, (${todasLasSucursales ? 'u.rol' : 'rol'} = 'GERENTE') DESC, ${todasLasSucursales ? 'u.nombre' : 'nombre'} LIMIT 20`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const plantillas = require('./plantillas');
const runs = require('./runs');
const historial = require('./historial');
const calendario = require('./calendario');
const notificaciones = require('./notificaciones');
const reportes = require('./reportes');
const tareas = require('./tareas');
plantillas(app);
runs(app);
historial(app);
calendario(app);
notificaciones(app);
reportes(app);
tareas(app);

const { iniciarScheduler } = require('../reportes');
iniciarScheduler();

const { iniciarSchedulerRecordatorios } = require('../recordatorios');
iniciarSchedulerRecordatorios();

const { iniciarSchedulerFeriados } = require('../feriados');
iniciarSchedulerFeriados();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FAT Audit backend escuchando en :${PORT}`));

module.exports = app;
