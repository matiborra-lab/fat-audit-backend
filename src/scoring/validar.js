/**
 * Valida el motor de puntaje contra los numeros reales de la auditoria de
 * ejemplo del Excel (sucursal "nueva cordoba", hoja Dashboard): puntaje
 * total 0.8410598874 y resultado DESAPROBADA (el sector Cocina no alcanza
 * su umbral minimo del 80%, aunque el total de la auditoria haya dado
 * "verde"). No toca la base de datos - corre standalone:
 *
 *   node src/scoring/validar.js
 */

const { calcularPuntaje } = require('./index');
const { ITEMS, SECTORES, AREAS, UMBRALES_CRITICOS } = require('../db/seed-data');

// Puntuaciones (escala 1-5) tal como estan cargadas en la hoja "Ponderación"
// del Excel, en el mismo orden que ITEMS.
const SCORES = [
  2, 5, 4, 4, 5, 5, 5, 4, 3, 5,
  5, 4, 5, 5, 5, 5, 4, 2, 5, 3,
  2, 2, 5, 5, 3, 5, 5, 5, 5, 5,
  5, 5, 5, 3, 5, 5, 5, 5, 5, 5,
  5, 5, 1, 5, 1, 1, 5, 1, 5, 5,
  1, 5, 5, 5, 5, 5, 1, 5, 5, 1,
  1, 5, 2, 5, 5, 2, 3, 5, 2, 5,
  5, 5, 5, 5, 5, 5, 2, 5, 5, 5,
  5, 5, 1, 1, 5, 3, 5, 3, 5, 2,
  5, 5, 5, 1, 3, 5, 5, 5, 5, 5,
];

if (SCORES.length !== ITEMS.length) {
  throw new Error(`SCORES tiene ${SCORES.length} valores, ITEMS tiene ${ITEMS.length}`);
}

let idAuto = 1;
const sectorIds = {};
const sectores = SECTORES.map((s) => {
  const id = idAuto++;
  sectorIds[s.nombre] = id;
  return { id, nombre: s.nombre, peso: s.peso };
});
const areaIds = {};
const areas = AREAS.map((a) => {
  const id = idAuto++;
  areaIds[a.nombre] = id;
  return { id, nombre: a.nombre, peso: a.peso };
});
const items = ITEMS.map(([sector, area, texto, peso, critico, informeInSitu], i) => ({
  id: i + 1,
  sector_id: sectorIds[sector],
  area_id: areaIds[area],
  texto,
  tipo_respuesta: 'ESCALA_5',
  peso,
}));
const respuestas = items.map((item, i) => ({ item_id: item.id, valor_json: SCORES[i], no_aplica: false }));
const umbrales = UMBRALES_CRITICOS.map((u) => ({
  tipo: u.tipo,
  sector_id: u.tipo === 'SECTOR' ? sectorIds[u.sector] : null,
  area_id: u.tipo === 'AREA' ? areaIds[u.area] : null,
  porcentaje_minimo: u.porcentaje_minimo,
}));
const semaforoConfig = [
  { rango_min: 0, rango_max: 49, etiqueta: 'Rojo' },
  { rango_min: 50, rango_max: 59, etiqueta: 'Naranja' },
  { rango_min: 60, rango_max: 79, etiqueta: 'Amarillo' },
  { rango_min: 80, rango_max: 94, etiqueta: 'Verde' },
  { rango_min: 95, rango_max: 100, etiqueta: 'Dorado' },
];

const resultado = calcularPuntaje({ sectores, areas, items, respuestas, umbrales, semaforoConfig });

const ESPERADO_PUNTAJE = 0.8410598874;
const ESPERADO_RESULTADO = 'DESAPROBADA';

console.log('Puntaje total calculado:', resultado.puntajeTotal);
console.log('Puntaje total esperado: ', ESPERADO_PUNTAJE);
console.log('Diferencia:', Math.abs(resultado.puntajeTotal - ESPERADO_PUNTAJE));
console.log('Semáforo:', resultado.semaforo);
console.log('Resultado:', resultado.resultado, '(esperado:', ESPERADO_RESULTADO + ')');
console.log('Umbrales fallidos:', resultado.detalle.umbralesFallidos.map((u) => `${u.tipo} ${u.sector_id || u.area_id} -> ${(u.score * 100).toFixed(2)}% < ${(u.porcentaje_minimo * 100)}%`));

const okPuntaje = Math.abs(resultado.puntajeTotal - ESPERADO_PUNTAJE) < 0.0001;
const okResultado = resultado.resultado === ESPERADO_RESULTADO;

if (okPuntaje && okResultado) {
  console.log('\n✅ El motor de puntaje reproduce el Excel correctamente.');
  process.exit(0);
} else {
  console.error('\n❌ El motor de puntaje NO coincide con el Excel.');
  process.exit(1);
}
