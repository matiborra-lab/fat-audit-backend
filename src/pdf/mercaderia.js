/**
 * ============================================================
 * PDF DE REPORTES DE MERCADERIA FAT
 * ============================================================
 * Dos reportes (ver src/server/mercaderia.js): saldos pendientes (situación
 * de hoy) y todos los documentos emitidos en un período - ambos agrupados
 * por sucursal, con subtotal por sucursal y total general. Misma estética
 * (pdfkit, paleta de la marca) que el informe de auditoría (src/pdf).
 */

const PDFDocument = require('pdfkit');

const COLOR_BORDO = '#86152D';
const COLOR_TEXTO = '#1F2937';
const COLOR_GRIS = '#6B7280';
const ZONA = 'America/Argentina/Buenos_Aires';
const MARGEN = 40;
const ALTO_MAX = 780; // debajo de esto se corta a página nueva

const pesos = (n) => '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const numero = (id) => '#' + String(id).padStart(5, '0');
const fecha = (d) => new Date(d).toLocaleDateString('es-AR', { timeZone: ZONA });
const fechaISO = (s) => s.split('-').reverse().join('/');
const ETIQUETA_ESTADO = { PENDIENTE_CONFIRMAR: 'Pendiente de confirmar', CONFIRMADO: 'Confirmado', LISTO_RETIRAR: 'Listo para retirar', RETIRADO: 'Retirado', CANCELADO: 'Cancelado' };

function demora(p) {
  if (p.dias_demora == null) return 'aún no retirado';
  return `${p.dias_demora} día${p.dias_demora === 1 ? '' : 's'}`;
}

function agruparPorSucursal(pedidos) {
  const grupos = new Map();
  for (const p of pedidos) {
    if (!grupos.has(p.sucursal_id)) grupos.set(p.sucursal_id, { nombre: p.sucursal_nombre, pedidos: [] });
    grupos.get(p.sucursal_id).pedidos.push(p);
  }
  return [...grupos.values()];
}

function nuevoDocumento(titulo, subtitulo) {
  const doc = new PDFDocument({ size: 'A4', margin: MARGEN, bufferPages: true });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const terminado = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.fillColor(COLOR_BORDO).font('Helvetica-Bold').fontSize(18).text('FAT BURGER · Mercadería', MARGEN, MARGEN);
  doc.fillColor(COLOR_TEXTO).fontSize(13).text(titulo);
  doc.fillColor(COLOR_GRIS).font('Helvetica').fontSize(9).text(subtitulo);
  doc.text('Generado el ' + new Date().toLocaleString('es-AR', { timeZone: ZONA, hour12: false }));
  doc.moveDown(1);
  return { doc, terminado };
}

// Asegura espacio para un bloque de `alto` puntos; si no entra, página nueva.
function espacio(doc, alto) {
  if (doc.y + alto > ALTO_MAX) doc.addPage();
}

function pie(doc) {
  const rango = doc.bufferedPageRange();
  for (let i = 0; i < rango.count; i++) {
    doc.switchToPage(rango.start + i);
    const margenInferior = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // sin esto, escribir en el pie dispara una página nueva
    doc.fillColor(COLOR_GRIS).font('Helvetica').fontSize(8).text(`Página ${i + 1} de ${rango.count}`, MARGEN, 812, { width: 515, align: 'right', lineBreak: false });
    doc.page.margins.bottom = margenInferior;
  }
}

function titulosSucursal(doc, nombre) {
  espacio(doc, 60);
  doc.moveDown(0.5);
  doc.fillColor(COLOR_BORDO).font('Helvetica-Bold').fontSize(12).text(nombre.toUpperCase(), MARGEN);
  doc.moveTo(MARGEN, doc.y + 2).lineTo(555, doc.y + 2).strokeColor(COLOR_BORDO).lineWidth(0.8).stroke();
  doc.moveDown(0.6);
}

async function generarPdfSaldos({ pedidos, todasLasSucursales }) {
  const { doc, terminado } = nuevoDocumento('Saldos pendientes', todasLasSucursales ? 'Todas las sucursales · situación actual' : 'Situación actual');
  if (!pedidos.length) {
    doc.fillColor(COLOR_TEXTO).font('Helvetica').fontSize(11).text('No hay saldos pendientes.');
  }
  let totalGeneral = 0;
  for (const grupo of agruparPorSucursal(pedidos)) {
    titulosSucursal(doc, grupo.nombre);
    let subtotal = 0;
    for (const p of grupo.pedidos) {
      espacio(doc, 62);
      doc.fillColor(COLOR_TEXTO).font('Helvetica-Bold').fontSize(10).text(`Pedido ${numero(p.id)}`, MARGEN);
      doc.font('Helvetica').fontSize(9.5);
      doc.text(`Fecha: ${fecha(p.creado_en)}`);
      doc.text(`Total: ${pesos(p.total)}`);
      doc.text(`Saldo pendiente: ${pesos(p.saldo)}`);
      doc.text(`Demora: ${demora(p)}`);
      doc.moveDown(0.5);
      subtotal += Math.round(p.saldo * 100);
    }
    totalGeneral += subtotal;
    espacio(doc, 24);
    doc.fillColor(COLOR_BORDO).font('Helvetica-Bold').fontSize(11).text(`TOTAL ${grupo.nombre.toUpperCase()}: ${pesos(subtotal / 100)}`, MARGEN);
    doc.moveDown(0.8);
  }
  if (pedidos.length) {
    espacio(doc, 30);
    doc.moveDown(0.4);
    doc.fillColor(COLOR_BORDO).font('Helvetica-Bold').fontSize(13).text(`TOTAL GENERAL PENDIENTE: ${pesos(totalGeneral / 100)}`, MARGEN);
  }
  pie(doc);
  doc.end();
  return terminado;
}

// Columnas de la tabla de documentos: [x, ancho, alineación]
const COL = { num: [40, 48], fecha: [90, 60], resp: [152, 118], estado: [272, 92], total: [366, 60], abonado: [430, 60], saldo: [494, 61] };

function filaDocumento(doc, y, valores, opciones = {}) {
  const { negrita = false, color = COLOR_TEXTO } = opciones;
  doc.fillColor(color).font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
  for (const [clave, texto] of Object.entries(valores)) {
    const [x, ancho] = COL[clave];
    const derecha = ['total', 'abonado', 'saldo'].includes(clave);
    doc.text(String(texto), x, y, { width: ancho - 4, align: derecha ? 'right' : 'left', lineBreak: false, ellipsis: true });
  }
}

async function generarPdfDocumentos({ pedidos, desde, hasta, todasLasSucursales }) {
  const { doc, terminado } = nuevoDocumento(
    'Documentos emitidos',
    `${todasLasSucursales ? 'Todas las sucursales' : 'Sucursal seleccionada'} · del ${fechaISO(desde)} al ${fechaISO(hasta)}`
  );
  if (!pedidos.length) {
    doc.fillColor(COLOR_TEXTO).font('Helvetica').fontSize(11).text('No hay pedidos en ese período.');
  }
  const acumulado = { total: 0, abonado: 0, saldo: 0 };
  for (const grupo of agruparPorSucursal(pedidos)) {
    titulosSucursal(doc, grupo.nombre);
    const encabezado = () => {
      filaDocumento(doc, doc.y, { num: 'Pedido', fecha: 'Fecha', resp: 'Responsable', estado: 'Estado', total: 'Total', abonado: 'Abonado', saldo: 'Saldo' }, { negrita: true, color: COLOR_GRIS });
      doc.y += 13;
    };
    encabezado();
    const sub = { total: 0, abonado: 0, saldo: 0 };
    for (const p of grupo.pedidos) {
      if (doc.y + 14 > ALTO_MAX) { doc.addPage(); encabezado(); }
      filaDocumento(doc, doc.y, {
        num: numero(p.id), fecha: fecha(p.creado_en), resp: p.responsable_nombre, estado: ETIQUETA_ESTADO[p.estado],
        total: pesos(p.total), abonado: pesos(p.abonado), saldo: pesos(p.saldo),
      });
      doc.y += 13;
      // Un pedido cancelado se lista pero no suma en los totales.
      if (p.estado !== 'CANCELADO') { sub.total += Math.round(p.total * 100); sub.abonado += Math.round(p.abonado * 100); sub.saldo += Math.round(p.saldo * 100); }
    }
    for (const k of Object.keys(sub)) acumulado[k] += sub[k];
    espacio(doc, 26);
    doc.moveDown(0.3);
    filaDocumento(doc, doc.y, { resp: `TOTAL ${grupo.nombre.toUpperCase()}`, total: pesos(sub.total / 100), abonado: pesos(sub.abonado / 100), saldo: pesos(sub.saldo / 100) }, { negrita: true, color: COLOR_BORDO });
    doc.y += 18;
  }
  if (pedidos.length) {
    espacio(doc, 30);
    doc.moveDown(0.4);
    filaDocumento(doc, doc.y, { resp: 'TOTAL GENERAL', total: pesos(acumulado.total / 100), abonado: pesos(acumulado.abonado / 100), saldo: pesos(acumulado.saldo / 100) }, { negrita: true, color: COLOR_BORDO });
  }
  pie(doc);
  doc.end();
  return terminado;
}

module.exports = { generarPdfSaldos, generarPdfDocumentos };
