/**
 * Tokens de un solo uso para "aceptar invitacion" y "olvide mi contraseña".
 */

const crypto = require('crypto');
const db = require('../db');

const HORAS_EXPIRACION = 48;

async function crearToken(usuarioId, tipo) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiraEn = new Date(Date.now() + HORAS_EXPIRACION * 60 * 60 * 1000);
  await db.query(
    'INSERT INTO tokens_usuario (usuario_id, token, tipo, expira_en) VALUES ($1, $2, $3, $4)',
    [usuarioId, token, tipo, expiraEn]
  );
  return token;
}

async function validarToken(token, tipo) {
  const { rows } = await db.query(
    `SELECT * FROM tokens_usuario
     WHERE token = $1 AND tipo = $2 AND usado_en IS NULL AND expira_en > now()`,
    [token, tipo]
  );
  return rows[0] || null;
}

async function marcarTokenUsado(id) {
  await db.query('UPDATE tokens_usuario SET usado_en = now() WHERE id = $1', [id]);
}

module.exports = { crearToken, validarToken, marcarTokenUsado };
