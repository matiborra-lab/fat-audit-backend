/**
 * ============================================================
 * MOTOR DE PUNTAJE
 * ============================================================
 * Funcion pura (sin DB, sin HTTP). Modelo simplificado: el AREA es la unica
 * unidad de peso a nivel plantilla - el SECTOR es puramente un agrupador de
 * recorrido/navegacion (no pondera el total), aunque sigue teniendo su
 * propio puntaje "crudo" para los umbrales criticos por sector.
 *
 * Entra: la estructura de una auditoria (sectores/areas/items, tal como
 * queda guardada en audit_runs.estructura_snapshot) + las respuestas
 * cargadas + los umbrales criticos de la plantilla.
 * Sale: puntaje total (0..1), semaforo, resultado, y el detalle del rollup
 * por sector/area (para persistir en audit_runs.detalle_calculo y no
 * recalcular en cada lectura).
 */

// Normaliza el valor crudo de una respuesta a 0..1 segun el tipo de
// pregunta. Devuelve null si el tipo no aporta puntaje (TEXTO/FECHA/NUMERO,
// que nunca puntuan por diseño) - esos items quedan afuera del calculo,
// igual que "No aplica".
function normalizarValor(item, valorJson) {
  if (valorJson == null) return null;
  switch (item.tipo_respuesta) {
    case 'ESCALA_5': {
      const n = Number(valorJson);
      if (isNaN(n)) return null;
      return clamp01((n - 1) / 4);
    }
    case 'ESCALA_10': {
      const n = Number(valorJson);
      if (isNaN(n)) return null;
      return clamp01((n - 1) / 9);
    }
    case 'SI_NO':
      return valorJson === 'SI' || valorJson === true ? 1 : 0;
    case 'CHECKBOX':
      return valorJson === true ? 1 : 0;
    case 'OPCION_MULTIPLE': {
      const opciones = item.opciones_json || [];
      const elegida = opciones.find((o) => o.etiqueta === valorJson || o.valor === valorJson);
      return elegida ? clamp01(Number(elegida.valor)) : null;
    }
    default:
      return null; // NUMERO | TEXTO | FECHA: nunca puntuan
  }
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

// Reparte peso 1 por igual entre los que no tienen peso propio dentro de un
// mismo grupo (regla: "sin pesos en ningun item del grupo, reparto
// igualitario"). Si ALGUNO del grupo tiene peso, ya se valido al guardar la
// plantilla que TODOS lo tengan y sumen 100% - por eso acá alcanza con leer
// item.peso directo en ese caso.
function pesoEfectivo(item, grupo) {
  if (item.peso != null) return Number(item.peso);
  const sinPeso = grupo.filter((e) => e.peso == null);
  return sinPeso.length > 0 ? 1 / sinPeso.length : 0;
}

function calcularPuntaje({ sectores, areas, items, respuestas, umbrales, semaforoConfig }) {
  const respuestaPorItem = new Map(respuestas.map((r) => [r.item_id, r]));

  // 1) Por item: valor normalizado (excluye no_aplica, sin respuesta, o
  // tipos que nunca puntuan).
  const itemsConRespuesta = [];
  for (const item of items) {
    const resp = respuestaPorItem.get(item.id);
    if (!resp || resp.no_aplica) continue;
    const valor = normalizarValor(item, resp.valor_json);
    if (valor == null) continue;
    itemsConRespuesta.push({ item, valor });
  }

  // 2) Peso efectivo de cada item, calculado UNA vez dentro del grupo de su
  // propia area (across todos los sectores) - se reusa tanto para el
  // puntaje de area (que pondera el total) como para el puntaje crudo de
  // sector (que solo se usa para umbrales criticos, ver mas abajo).
  const itemsPorArea = new Map(); // areaId -> [{item, valor}]
  for (const entry of itemsConRespuesta) {
    const areaId = entry.item.area_id;
    if (!itemsPorArea.has(areaId)) itemsPorArea.set(areaId, []);
    itemsPorArea.get(areaId).push(entry);
  }
  const pesoItemCache = new Map(); // item.id -> peso efectivo
  for (const [, entradas] of itemsPorArea) {
    const grupo = entradas.map((e) => e.item);
    for (const { item } of entradas) pesoItemCache.set(item.id, pesoEfectivo(item, grupo));
  }

  // 3) Puntaje por area (global, a traves de todos los sectores) - esta es
  // la UNICA cascada que pondera el total.
  const scorePorArea = new Map(); // areaId -> 0..1
  const detalleAreas = [];
  for (const area of areas) {
    const entradas = itemsPorArea.get(area.id) || [];
    if (entradas.length === 0) continue;
    let num = 0, den = 0;
    for (const { item, valor } of entradas) {
      const p = pesoItemCache.get(item.id);
      num += p * valor;
      den += p;
    }
    if (den > 0) {
      const score = num / den;
      scorePorArea.set(area.id, score);
      detalleAreas.push({ area_id: area.id, nombre: area.nombre, score });
    }
  }

  // 4) Puntaje total: suma de areas aplicables ponderadas por su peso
  // global, renormalizado entre las areas que efectivamente aplicaron (si
  // una plantilla tiene una area sin ningun item respondido, no corresponde
  // que su peso "se pierda" del 100%).
  const areasAplicables = areas.filter((a) => scorePorArea.has(a.id));
  const sumaPesosArea = areasAplicables.reduce((acc, a) => acc + pesoEfectivo(a, areasAplicables), 0);
  let puntajeTotal = 0;
  for (const area of areasAplicables) {
    const pesoNormalizado = sumaPesosArea > 0 ? pesoEfectivo(area, areasAplicables) / sumaPesosArea : 0;
    puntajeTotal += pesoNormalizado * scorePorArea.get(area.id);
  }

  // 5) Puntaje "crudo" por sector - SOLO para umbrales criticos y para
  // mostrar el progreso agrupado por sector en el detalle. No pondera el
  // total (el sector no tiene peso propio). Reusa el peso efectivo de cada
  // item (el que ya tiene por su area), asi un item marcado 0% dentro de su
  // area tampoco pesa en el sector.
  const scorePorSector = new Map(); // sectorId -> 0..1
  const detalleSectores = [];
  for (const sector of sectores) {
    const entradas = itemsConRespuesta.filter(({ item }) => item.sector_id === sector.id);
    if (entradas.length === 0) {
      detalleSectores.push({ sector_id: sector.id, nombre: sector.nombre, score: null, aplica: false });
      continue;
    }
    let num = 0, den = 0;
    for (const { item, valor } of entradas) {
      const p = pesoItemCache.get(item.id);
      num += p * valor;
      den += p;
    }
    const score = den > 0 ? num / den : null;
    if (score != null) scorePorSector.set(sector.id, score);
    detalleSectores.push({ sector_id: sector.id, nombre: sector.nombre, score, aplica: score != null });
  }

  // 6) Umbrales criticos: si alguno no se alcanza, la auditoria queda
  // DESAPROBADA sin importar el puntaje total.
  const umbralesFallidos = [];
  for (const u of umbrales) {
    const score = u.tipo === 'SECTOR' ? scorePorSector.get(u.sector_id) : scorePorArea.get(u.area_id);
    if (score != null && score < Number(u.porcentaje_minimo)) {
      umbralesFallidos.push({ ...u, score });
    }
  }
  const resultado = umbralesFallidos.length > 0 ? 'DESAPROBADA' : 'APROBADA';

  // 7) Semaforo.
  const puntajePct = Math.round(puntajeTotal * 100);
  const tramo = semaforoConfig.find((s) => puntajePct >= s.rango_min && puntajePct <= s.rango_max);
  const semaforo = tramo ? tramo.etiqueta.toUpperCase() : null;

  return {
    puntajeTotal,
    semaforo,
    resultado,
    detalle: {
      sectores: detalleSectores,
      areas: detalleAreas,
      umbralesFallidos,
    },
  };
}

module.exports = { calcularPuntaje, normalizarValor };
