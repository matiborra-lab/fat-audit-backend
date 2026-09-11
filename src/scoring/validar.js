/**
 * Valida el motor de puntaje simplificado (peso solo a nivel área, sector
 * puramente de navegación) contra un caso sintético calculable a mano:
 *
 * Sectores: A, B (sin peso)
 * Áreas: X (peso 60%), Y (peso 40%)
 * Items:
 *   1) sector A, área X, ESCALA_5, sin peso propio -> score 5 (valor 1.0)
 *   2) sector B, área X, ESCALA_5, sin peso propio -> score 1 (valor 0.0)
 *   3) sector A, área Y, SI_NO                     -> "SI"    (valor 1.0)
 *
 * Área X = equal split entre item 1 y 2 = (1.0 + 0.0) / 2 = 0.5
 * Área Y = solo item 3 = 1.0
 * Total  = 0.6*0.5 + 0.4*1.0 = 0.3 + 0.4 = 0.7  (AMARILLO, 60-79%)
 *
 * Sector A (item1 peso_efectivo=0.5 en X, item3 peso_efectivo=1.0 en Y,
 *           unico item de Y) = (0.5*1.0 + 1.0*1.0) / (0.5+1.0) = 1.0
 * Sector B (item2 peso_efectivo=0.5) = (0.5*0.0) / 0.5 = 0.0
 *
 * Umbral crítico: sector B >= 50% -> FALLA (0.0 < 0.5) -> DESAPROBADA,
 * aunque el total (70%) sea "amarillo" y no rojo.
 *
 *   node src/scoring/validar.js
 */

const { calcularPuntaje } = require('./index');

const sectores = [{ id: 1, nombre: 'A' }, { id: 2, nombre: 'B' }];
const areas = [{ id: 1, nombre: 'X', peso: 0.6 }, { id: 2, nombre: 'Y', peso: 0.4 }];
const items = [
  { id: 1, sector_id: 1, area_id: 1, tipo_respuesta: 'ESCALA_5', peso: null },
  { id: 2, sector_id: 2, area_id: 1, tipo_respuesta: 'ESCALA_5', peso: null },
  { id: 3, sector_id: 1, area_id: 2, tipo_respuesta: 'SI_NO', peso: null },
];
const respuestas = [
  { item_id: 1, valor_json: 5, no_aplica: false },
  { item_id: 2, valor_json: 1, no_aplica: false },
  { item_id: 3, valor_json: 'SI', no_aplica: false },
];
const umbrales = [{ tipo: 'SECTOR', sector_id: 2, porcentaje_minimo: 0.5 }];
const semaforoConfig = [
  { rango_min: 0, rango_max: 49, etiqueta: 'Rojo' },
  { rango_min: 50, rango_max: 59, etiqueta: 'Naranja' },
  { rango_min: 60, rango_max: 79, etiqueta: 'Amarillo' },
  { rango_min: 80, rango_max: 94, etiqueta: 'Verde' },
  { rango_min: 95, rango_max: 100, etiqueta: 'Dorado' },
];

const resultado = calcularPuntaje({ sectores, areas, items, respuestas, umbrales, semaforoConfig });

const ESPERADO_PUNTAJE = 0.7;
const ESPERADO_RESULTADO = 'DESAPROBADA';
const ESPERADO_SEMAFORO = 'AMARILLO';

console.log('Puntaje total:', resultado.puntajeTotal, '(esperado', ESPERADO_PUNTAJE + ')');
console.log('Semáforo:', resultado.semaforo, '(esperado', ESPERADO_SEMAFORO + ')');
console.log('Resultado:', resultado.resultado, '(esperado', ESPERADO_RESULTADO + ')');
console.log('Áreas:', resultado.detalle.areas.map((a) => `${a.nombre}=${a.score}`));
console.log('Sectores:', resultado.detalle.sectores.map((s) => `${s.nombre}=${s.score}`));

const ok =
  Math.abs(resultado.puntajeTotal - ESPERADO_PUNTAJE) < 1e-9 &&
  resultado.resultado === ESPERADO_RESULTADO &&
  resultado.semaforo === ESPERADO_SEMAFORO;

// Segundo caso: mismos datos pero SIN el umbral por sector, para probar el
// umbral GENERAL de aprobación (configurable por plantilla) de forma
// aislada. Total sigue dando 70% - con puntajeMinimoAprobacion=0.75 (75%)
// tiene que desaprobar solo por eso, aunque no haya ningún umbral crítico
// específico configurado.
const resultado2 = calcularPuntaje({ sectores, areas, items, respuestas, umbrales: [], semaforoConfig, puntajeMinimoAprobacion: 0.75 });
console.log('\nCaso 2 (umbral general 75%, sin umbrales por sector/área):');
console.log('Puntaje total:', resultado2.puntajeTotal, '· Resultado:', resultado2.resultado, '(esperado DESAPROBADA)');
const ok2 = resultado2.resultado === 'DESAPROBADA' && resultado2.detalle.noAlcanzaMinimoGeneral === true;

if (ok && ok2) {
  console.log('\n✅ El motor de puntaje simplificado calcula correctamente (incluye umbral general).');
  process.exit(0);
} else {
  console.error('\n❌ El motor de puntaje NO coincide con lo esperado.');
  process.exit(1);
}
