/**
 * ============================================================
 * MIGRACION - aplica src/db/schema.sql a la base de datos
 * ============================================================
 * Se corre una sola vez (o cada vez que schema.sql cambie, contra una base
 * limpia) con:
 *   npm run migrate
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./index');

async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  await pool.query(sql);
  console.log('Esquema aplicado correctamente.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Error aplicando el esquema:', err.message);
  process.exit(1);
});
