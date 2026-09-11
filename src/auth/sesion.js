/**
 * SESION - emitir y verificar el token (JWT) que identifica al usuario.
 * Va en el header "Authorization: Bearer <token>" de cada pedido. Adentro
 * lleva solo el id - rol/sucursal_id se resuelven frescos de la base en
 * cada request (ver auth/middleware.js), asi un cambio de rol o un bloqueo
 * surte efecto de inmediato en vez de recien cuando el token venza.
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const DURACION = '30d';

function emitirToken(usuario) {
  if (!JWT_SECRET) throw new Error('Falta JWT_SECRET en las variables de entorno');
  return jwt.sign({ usuarioId: usuario.id }, JWT_SECRET, { expiresIn: DURACION });
}

function verificarToken(token) {
  if (!JWT_SECRET) throw new Error('Falta JWT_SECRET en las variables de entorno');
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { emitirToken, verificarToken };
