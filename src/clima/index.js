/**
 * ============================================================
 * CLIMA (Open-Meteo)
 * ============================================================
 * Pronóstico informativo por sucursal, mostrado en la esquina de cada día
 * del calendario - no depende de ninguna cuenta/API key (Open-Meteo es
 * gratuito para uso no comercial). Se cachea en memoria por sucursal para no
 * golpear la API en cada carga del calendario; el cache es best-effort y se
 * resetea si el server reinicia, sin problema (el próximo pedido lo rellena).
 */

const TTL_MS = 3 * 60 * 60 * 1000; // 3 horas - el pronóstico no cambia tan seguido como para justificar menos
const cache = new Map(); // `${lat},${lon}` -> { expiraEn, datos }

async function obtenerPronostico(lat, lon) {
  const clave = `${lat},${lon}`;
  const enCache = cache.get(clave);
  if (enCache && enCache.expiraEn > Date.now()) return enCache.datos;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=America%2FArgentina%2FCordoba&forecast_days=16`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('No se pudo obtener el pronóstico');
  const datos = await resp.json();
  const dias = (datos.daily?.time || []).map((fecha, i) => ({
    fecha,
    temp_max: datos.daily.temperature_2m_max[i],
    temp_min: datos.daily.temperature_2m_min[i],
    weather_code: datos.daily.weather_code[i],
    precipitacion_prob: datos.daily.precipitation_probability_max[i],
  }));
  cache.set(clave, { expiraEn: Date.now() + TTL_MS, datos: dias });
  return dias;
}

module.exports = { obtenerPronostico };
