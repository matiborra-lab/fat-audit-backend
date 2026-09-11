/**
 * ============================================================
 * MOTOR DE PUNTAJE
 * ============================================================
 * Funcion pura (sin DB, sin HTTP) que reproduce el calculo real del Excel
 * de FAT Burger (hoja "Cálculos"), generalizado para soportar pesos
 * opcionales en item/area/sector. Ver la seccion "Motor de puntaje" del
 * plan para el detalle de cada paso.
 *
 * Entra: la estructura de una auditoria (sectores/areas/items, tal como
 * queda guardada en audit_runs.estructura_snapshot) + las respuestas
 * cargadas + los umbrales criticos de la plantilla.
 * Sale: puntaje total (0..1), semaforo, resultado, y el detalle del rollup
 * por sector/area (para persistir en audit_runs.detalle_calculo y no
 * recalcular en cada lectura).
 */

// Normaliza el valor crudo de una respuesta a 0..1 segun el tipo de
// pregunta. Devuelve null si el tipo no aporta puntaje (NUMERO/TEXTO/FECHA
// sin regla) - esos items quedan afuera del calculo, igual que "No aplica".
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
      return null; // NUMERO | TEXTO | FECHA: sin puntaje salvo regla condicional aparte
  }
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

// Reparte peso 1 por igual entre los que no tienen peso propio dentro de un
// mismo grupo (regla 5.1: "sin pesos, reparto igualitario al 100%").
function pesoEfectivo(entidad, grupo) {
  if (entidad.peso != null) return Number(entidad.peso);
  const sinPeso = grupo.filter((e) => e.peso == null);
  return sinPeso.length > 0 ? 1 / sinPeso.length : 0;
}

function calcularPuntaje({ sectores, areas, items, respuestas, umbrales, semaforoConfig }) {
  const respuestaPorItem = new Map(respuestas.map((r) => [r.item_id, r]));

  // 1) Por item: valor normalizado + peso efectivo, agrupado por (sector,area).
  const bucket = new Map(); // key `${sectorId}:${areaId}` -> [{item, valor, peso}]
  const itemsConRespuesta = [];
  for (const item of items) {
    const resp = respuestaPorItem.get(item.id);
    if (!resp || resp.no_aplica) continue;
    const valor = normalizarValor(item, resp.valor_json);
    if (valor == null) continue;
    itemsConRespuesta.push({ item, valor });
  }
  for (const { item } of itemsConRespuesta) {
    const key = item.sector_id + ':' + item.area_id;
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(item);
  }
  const pesoItemCache = new Map(); // item.id -> peso efectivo
  for (const [, itemsDelBucket] of bucket) {
    for (const item of itemsDelBucket) {
      pesoItemCache.set(item.id, pesoEfectivo(item, itemsDelBucket));
    }
  }

  // 2) Puntaje por area DENTRO de cada sector (solo areas con items respondidos ahi).
  const scoreAreaEnSector = new Map(); // key `${sectorId}:${areaId}` -> 0..1
  for (const [key] of bucket) {
    const itemsBucket = itemsConRespuesta.filter(({ item }) => key === item.sector_id + ':' + item.area_id);
    let num = 0, den = 0;
    for (const { item, valor } of itemsBucket) {
      const p = pesoItemCache.get(item.id);
      num += p * valor;
      den += p;
    }
    if (den > 0) scoreAreaEnSector.set(key, num / den);
  }

  // 3) Puntaje por sector: cada area aplicable pondera por su peso global,
  // renormalizado solo entre las areas que tienen items respondidos en ese sector.
  const scorePorSector = new Map(); // sectorId -> 0..1
  const detalleSectores = [];
  for (const sector of sectores) {
    const areasDelSector = areas
      .map((area) => ({ area, key: sector.id + ':' + area.id }))
      .filter(({ key }) => scoreAreaEnSector.has(key));
    if (areasDelSector.length === 0) {
      detalleSectores.push({ sector_id: sector.id, nombre: sector.nombre, score: null, aplica: false });
      continue;
    }
    const sumaPesos = areasDelSector.reduce((acc, { area }) => acc + pesoEfectivo(area, areasDelSector.map((x) => x.area)), 0);
    let scoreSector = 0;
    const areasDetalle = [];
    for (const { area, key } of areasDelSector) {
      const pesoArea = pesoEfectivo(area, areasDelSector.map((x) => x.area));
      const pesoNormalizado = sumaPesos > 0 ? pesoArea / sumaPesos : 0;
      const scoreArea = scoreAreaEnSector.get(key);
      scoreSector += pesoNormalizado * scoreArea;
      areasDetalle.push({ area_id: area.id, nombre: area.nombre, score: scoreArea });
    }
    scorePorSector.set(sector.id, scoreSector);
    detalleSectores.push({ sector_id: sector.id, nombre: sector.nombre, score: scoreSector, aplica: true, areas: areasDetalle });
  }

  // 4) Puntaje total: suma de sectores aplicables ponderados por su peso
  // global, renormalizado entre los sectores que efectivamente aplicaron.
  const sectoresAplicables = sectores.filter((s) => scorePorSector.has(s.id));
  const sumaPesosSector = sectoresAplicables.reduce((acc, s) => acc + pesoEfectivo(s, sectoresAplicables), 0);
  let puntajeTotal = 0;
  for (const sector of sectoresAplicables) {
    const pesoNormalizado = sumaPesosSector > 0 ? pesoEfectivo(sector, sectoresAplicables) / sumaPesosSector : 0;
    puntajeTotal += pesoNormalizado * scorePorSector.get(sector.id);
  }

  // 5) Puntaje por area A TRAVES DE TODA LA AUDITORIA (para umbrales criticos
  // de area) - ratio simple de puntos obtenidos / maximo posible, sin pesar
  // por sector.
  const scoreAreaGlobal = new Map(); // areaId -> 0..1
  const detalleAreasGlobal = [];
  for (const area of areas) {
    const itemsDelArea = itemsConRespuesta.filter(({ item }) => item.area_id === area.id);
    if (itemsDelArea.length === 0) continue;
    let num = 0, den = 0;
    for (const { item, valor } of itemsDelArea) {
      const p = pesoItemCache.get(item.id);
      num += p * valor;
      den += p;
    }
    if (den > 0) {
      const score = num / den;
      scoreAreaGlobal.set(area.id, score);
      detalleAreasGlobal.push({ area_id: area.id, nombre: area.nombre, score });
    }
  }

  // 6) Umbrales criticos: si alguno no se alcanza, la auditoria queda
  // DESAPROBADA sin importar el puntaje total.
  const umbralesFallidos = [];
  for (const u of umbrales) {
    const score = u.tipo === 'SECTOR' ? scorePorSector.get(u.sector_id) : scoreAreaGlobal.get(u.area_id);
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
      areasGlobal: detalleAreasGlobal,
      umbralesFallidos,
    },
  };
}

module.exports = { calcularPuntaje, normalizarValor };
