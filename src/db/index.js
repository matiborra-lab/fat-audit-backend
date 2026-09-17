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
  // Sin esto, `CURRENT_DATE`, `now()` y cualquier `::date`/`::time` sobre una
  // columna TIMESTAMPTZ (ej. el chequeo de recordatorios de hoy) usan el
  // huso horario por default del servidor Postgres (normalmente UTC en
  // Railway/Neon), no el de Argentina - un evento a las 23:30 ART cae en el
  // dia siguiente en UTC y esos chequeos comparan mal el "dia de hoy". Se
  // fija via startup parameter (no con un `SET TIME ZONE` en 'connect', que
  // corre en paralelo con la primera query del cliente recien conectado).
  options: '-c TimeZone=America/Argentina/Buenos_Aires',
});

function query(text, params) {
  return pool.query(text, params);
}

// Inserta muchas filas en UNA sola query (un solo INSERT con varios grupos
// VALUES) en vez de una query por fila - evita N viajes de ida y vuelta a
// la base, que contra una base remota (Railway, etc.) se nota mucho en
// tablas como audit_items (decenas o cientos de filas por plantilla).
// IMPORTANTE: no usar await en un loop llamando a esto con el mismo client
// sin esperar cada llamada - pg no pipelinea queries concurrentes en una
// misma conexión (las encola y avisa que es una practica deprecada).
// `filas` es un array de arrays de valores, en el mismo orden que
// `columnas`. Devuelve las filas de RETURNING en el MISMO ORDEN que
// `filas` (Postgres preserva el orden de entrada en un INSERT ... VALUES
// simple, sin ON CONFLICT ni triggers que puedan reordenar).
async function bulkInsert(client, tabla, columnas, filas, returning = 'id') {
  if (filas.length === 0) return [];
  const params = [];
  const placeholders = filas.map((fila) => {
    const grupo = fila.map((valor) => {
      params.push(valor);
      return '$' + params.length;
    });
    return '(' + grupo.join(',') + ')';
  });
  const { rows } = await client.query(
    `INSERT INTO ${tabla} (${columnas.join(',')}) VALUES ${placeholders.join(',')} RETURNING ${returning}`,
    params
  );
  return rows;
}

// Fragmento SQL para el nombre completo de un usuario (nombre de pila +
// apellido opcional) - `alias` es el alias de tabla de `usuarios` en el
// JOIN (ej. 'u', 'cu', 'cp'). Se usa en todos los SELECT que muestran el
// nombre de una persona a otro usuario (historial, calendario, licencias,
// etc.) para que el apellido aparezca ahi tambien en cuanto se carga.
function nombreCompletoSql(alias) {
  return `TRIM(${alias}.nombre || ' ' || COALESCE(${alias}.apellido, ''))`;
}

module.exports = { pool, query, bulkInsert, nombreCompletoSql };
