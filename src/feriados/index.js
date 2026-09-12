/**
 * ============================================================
 * FERIADOS (ArgentinaDatos)
 * ============================================================
 * Feriados nacionales, trasladables y puentes turísticos - informativos en
 * el calendario, no atados a ninguna sucursal. Se cachean en la tabla
 * `feriados` (mismo espíritu que src/clima, pero acá el cache es en base en
 * vez de en memoria, para sobrevivir un reinicio del server) y se
 * actualizan solos al arrancar y una vez por día (ver iniciarScheduler).
 */

const db = require('../db');

// Reemplaza TODO el año de una - si el fetch falla, tira el error antes de
// tocar la tabla, así lo que ya había queda intacto ("si la API no
// responde, conservar la última información descargada").
async function actualizarFeriados(anio) {
  const resp = await fetch(`https://api.argentinadatos.com/v1/feriados/${anio}`);
  if (!resp.ok) throw new Error(`ArgentinaDatos respondió ${resp.status}`);
  const datos = await resp.json();
  if (!Array.isArray(datos)) throw new Error('Respuesta inesperada de ArgentinaDatos');

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM feriados WHERE anio = $1', [anio]);
    if (datos.length) {
      await db.bulkInsert(client, 'feriados', ['fecha', 'nombre', 'tipo', 'anio'],
        datos.map((d) => [d.fecha, d.nombre, d.tipo, anio]));
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return datos.length;
}

// Solo descarga si todavía no hay nada guardado para ese año - no pisa datos
// buenos ya cacheados solo porque pasó el tiempo (eso lo decide el admin
// manualmente, o el propio cambio de año).
async function asegurarFeriadosDelAnio(anio) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM feriados WHERE anio = $1', [anio]);
  if (rows[0].n > 0) return;
  try {
    await actualizarFeriados(anio);
  } catch (err) {
    console.error(`[feriados] no se pudo descargar el año ${anio}:`, err.message);
  }
}

// Al arrancar (y una vez por día) asegura el año actual y el siguiente - así
// "actualizar al empezar cada año" queda cubierto sin depender de un cron
// exacto a medianoche del 1/1.
function iniciarSchedulerFeriados() {
  const chequear = () => {
    const anioActual = new Date().getFullYear();
    asegurarFeriadosDelAnio(anioActual);
    asegurarFeriadosDelAnio(anioActual + 1);
  };
  chequear();
  setInterval(chequear, 24 * 60 * 60 * 1000);
}

module.exports = { actualizarFeriados, asegurarFeriadosDelAnio, iniciarSchedulerFeriados };
