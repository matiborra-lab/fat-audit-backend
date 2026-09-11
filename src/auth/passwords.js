const bcrypt = require('bcryptjs');

function hashearPassword(password) {
  return bcrypt.hash(password, 10);
}

function verificarPassword(password, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(password, hash);
}

module.exports = { hashearPassword, verificarPassword };
