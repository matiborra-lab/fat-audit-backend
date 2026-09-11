/**
 * ============================================================
 * MIDDLEWARE DE AUTENTICACION Y ALCANCE
 * ============================================================
 */

const { verificarToken } = require('./sesion');
const db = require('../db');

function canAccessFatAudit(usuario) {
  return !!usuario && usuario.activo === true;
}

// Exige un token valido y deja los datos del usuario en
// req.usuario = { usuarioId, rol, sucursal_id, activo, email, nombre }.
// rol/sucursal_id/activo se leen FRESCOS de la base en cada request (no del
// JWT, que puede durar hasta 30 dias).
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Falta el token de autenticacion' });

  try {
    const payload = verificarToken(token);
    const { rows } = await db.query(
      'SELECT rol, sucursal_id, activo, email, nombre FROM usuarios WHERE id = $1',
      [payload.usuarioId]
    );
    const fila = rows[0];
    if (!canAccessFatAudit(fila)) {
      return res.status(401).json({ error: 'Tu cuenta fue deshabilitada' });
    }
    req.usuario = {
      usuarioId: payload.usuarioId,
      rol: fila.rol,
      sucursal_id: fila.sucursal_id,
      activo: fila.activo,
      email: fila.email,
      nombre: fila.nombre,
    };
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token invalido o vencido' });
  }
}

function requireAdmin(req, res, next) {
  if (req.usuario?.rol !== 'ADMIN') {
    return res.status(403).json({ error: 'Esta accion es solo para administradores' });
  }
  next();
}

// Admin y Auditor tienen alcance global; solo Gerente esta limitado a su
// propia sucursal.
function puedeAccederSucursal(usuario, sucursalId) {
  if (!usuario || sucursalId == null) return false;
  if (usuario.rol === 'ADMIN' || usuario.rol === 'AUDITOR') return true;
  return usuario.sucursal_id === Number(sucursalId);
}

// Agrega el filtro "AND sucursal_id = $N" a una query cuando el usuario es
// GERENTE (y no agrega nada para ADMIN/AUDITOR, que ven todo). Devuelve el
// fragmento SQL y el valor a agregar a los params, para que el caller lo
// interpole en la posicion correcta.
function scopeSucursal(usuario, columna, params) {
  if (usuario.rol !== 'GERENTE') return { sql: '', params };
  const nuevosParams = [...params, usuario.sucursal_id];
  return { sql: ` AND ${columna} = $${nuevosParams.length}`, params: nuevosParams };
}

module.exports = { requireAuth, requireAdmin, puedeAccederSucursal, scopeSucursal, canAccessFatAudit };
