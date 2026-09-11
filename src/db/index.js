/**
 * ============================================================
 * CONEXION A LA BASE DE DATOS
 * ============================================================
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon/Railway/Render exigen SSL en produccion pero no firman con una CA
  // publica reconocida por Node - rejectUnauthorized:false es el mismo
  // trade-off que hace cualquier backend chico contra estos proveedores
  // (la conexion sigue cifrada, solo no valida la cadena de certificados).
  ssl: process.env.DATABASE_URL?.includes('sslmode=require') || process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
