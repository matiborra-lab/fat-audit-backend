/**
 * ============================================================
 * PDF DE INFORME DE AUDITORÍA
 * ============================================================
 * Genera el PDF con pdfkit (JS puro, sin navegador headless - evita el
 * peso/tiempo de build que traería Puppeteer/Playwright en Railway). Arma
 * el documento imperativamente (texto, rectángulos, imágenes) en vez de
 * HTML->PDF.
 *
 * Las miniaturas de evidencia se descargan desde su URL pública (S3/R2) al
 * vuelo y se embeben como imagen JPEG; los videos se listan como link (no
 * se embeben, igual que pide la spec: "miniatura y enlace seguro, no
 * embebidos" - acá directamente el link, sin miniatura de video en el PDF).
 */

const PDFDocument = require('pdfkit');

const COLOR_BORDO = '#86152D';
const COLOR_AMARILLO = '#F7BE32';
const COLOR_TEXTO = '#1F2937';
const COLOR_GRIS = '#6B7280';
const SEMAFORO_COLORES = {
  ROJO: '#DC2626', NARANJA: '#EA580C', AMARILLO: '#CA8A04', VERDE: '#16A34A', DORADO: '#B8860B',
};

function valorLegible(item, valor) {
  if (valor == null) return '—';
  if (item.tipo_respuesta === 'ESCALA_5') return `${valor} / 5`;
  if (item.tipo_respuesta === 'ESCALA_10') return `${valor} / 10`;
  if (item.tipo_respuesta === 'SI_NO') return valor === 'SI' || valor === true ? 'Sí' : 'No';
  if (item.tipo_respuesta === 'CHECKBOX') return valor ? 'Verificado' : 'Pendiente';
  return String(valor);
}

async function descargarImagen(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

// run: fila de audit_runs + sucursal_nombre, auditor_nombre (joins hechos
// por el caller) + respuestas + evidencias (igual forma que GET /api/runs/:id).
// Devuelve un Buffer con el PDF entero (mas simple para los dos usos que
// tiene: mandarlo como respuesta HTTP y adjuntarlo a un mail).
async function generarPdfAuditoria(run) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const finalizado = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const estructura = run.estructura_snapshot;
  const respuestaPorItem = new Map(run.respuestas.map((r) => [r.item_id, r]));
  const evidenciasPorRespuesta = new Map();
  for (const e of run.evidencias) {
    if (!evidenciasPorRespuesta.has(e.respuesta_id)) evidenciasPorRespuesta.set(e.respuesta_id, []);
    evidenciasPorRespuesta.get(e.respuesta_id).push(e);
  }

  // --- Encabezado ---
  doc.rect(0, 0, doc.page.width, 90).fill(COLOR_BORDO);
  doc.fillColor('#FFFFFF').fontSize(20).font('Helvetica-Bold').text('FAT AUDIT', 40, 25);
  doc.fontSize(11).font('Helvetica').text('Informe de auditoría', 40, 50);
  doc.fillColor(COLOR_TEXTO);

  doc.moveDown(3);
  const y0 = 110;
  doc.fontSize(10).font('Helvetica-Bold').text('Sucursal:', 40, y0, { continued: true }).font('Helvetica').text(' ' + (run.sucursal_nombre || '—'));
  doc.font('Helvetica-Bold').text('Fecha:', 40, y0 + 16, { continued: true }).font('Helvetica').text(' ' + new Date(run.completada_en || run.creado_en).toLocaleString('es-AR'));
  doc.font('Helvetica-Bold').text('Auditor:', 40, y0 + 32, { continued: true }).font('Helvetica').text(' ' + (run.auditor_nombre || '—'));
  doc.font('Helvetica-Bold').text('Tipo:', 300, y0, { continued: true }).font('Helvetica').text(' ' + run.tipo);
  doc.font('Helvetica-Bold').text('Responsable:', 300, y0 + 16, { continued: true }).font('Helvetica').text(' ' + (run.responsable_nombre || '—'));

  // --- Puntaje / semáforo / resultado ---
  const yBox = y0 + 60;
  doc.roundedRect(40, yBox, doc.page.width - 80, 60, 6).fillAndStroke('#F7F7F6', '#E5E7EB');
  doc.fillColor(COLOR_TEXTO).fontSize(24).font('Helvetica-Bold').text(`${Math.round((run.puntaje_total || 0) * 100)}%`, 55, yBox + 14);
  const colorSemaforo = SEMAFORO_COLORES[run.semaforo] || COLOR_GRIS;
  doc.roundedRect(180, yBox + 18, 90, 22, 11).fill(colorSemaforo);
  doc.fillColor('#FFFFFF').fontSize(10).font('Helvetica-Bold').text(run.semaforo || '—', 180, yBox + 24, { width: 90, align: 'center' });
  const colorResultado = run.resultado === 'APROBADA' ? '#16A34A' : COLOR_BORDO;
  doc.roundedRect(290, yBox + 18, 110, 22, 11).fill(colorResultado);
  doc.fillColor('#FFFFFF').fontSize(10).font('Helvetica-Bold').text(run.resultado || '—', 290, yBox + 24, { width: 110, align: 'center' });
  doc.fillColor(COLOR_TEXTO);

  let y = yBox + 80;
  const umbralesFallidos = run.detalle_calculo?.umbralesFallidos || [];
  if (umbralesFallidos.length > 0) {
    doc.fontSize(10).font('Helvetica-Bold').fillColor(COLOR_BORDO).text('Umbrales críticos no alcanzados:', 40, y);
    y += 14;
    for (const u of umbralesFallidos) {
      doc.font('Helvetica').fontSize(9).text(`• ${u.tipo === 'SECTOR' ? 'Sector' : 'Área'}: ${Math.round(u.score * 100)}% (mínimo ${Math.round(u.porcentaje_minimo * 100)}%)`, 50, y);
      y += 12;
    }
    doc.fillColor(COLOR_TEXTO);
    y += 6;
  }

  // --- Detalle por sector ---
  for (const sector of estructura.sectores) {
    const itemsDelSector = estructura.items.filter((it) => it.sector_id === sector.id);
    if (itemsDelSector.length === 0) continue;

    if (y > doc.page.height - 100) { doc.addPage(); y = 40; }
    doc.fontSize(12).font('Helvetica-Bold').fillColor(COLOR_BORDO).text(sector.nombre, 40, y);
    y += 18;
    doc.fillColor(COLOR_TEXTO);

    for (const item of itemsDelSector) {
      if (y > doc.page.height - 80) { doc.addPage(); y = 40; }
      const resp = respuestaPorItem.get(item.id);
      const valor = resp?.no_aplica ? 'No aplica' : valorLegible(item, resp?.valor_json);
      const critico = item.critico ? '  [crítico]' : '';

      doc.fontSize(9).font('Helvetica').text(item.texto + critico, 40, y, { width: 380 });
      doc.font('Helvetica-Bold').text(valor, 430, y, { width: 100, align: 'right' });
      y += 13;
      if (resp?.comentario) {
        doc.fontSize(8).font('Helvetica-Oblique').fillColor(COLOR_GRIS).text(`"${resp.comentario}"`, 48, y, { width: 480 });
        doc.fillColor(COLOR_TEXTO);
        y += 12;
      }

      const evidencias = resp ? evidenciasPorRespuesta.get(resp.id) || [] : [];
      const fotos = evidencias.filter((e) => e.tipo === 'FOTO');
      const videos = evidencias.filter((e) => e.tipo === 'VIDEO');
      if (fotos.length > 0) {
        let x = 48;
        for (const foto of fotos.slice(0, 4)) {
          const buffer = await descargarImagen(foto.thumbnail_url || foto.url);
          if (buffer) {
            try {
              doc.image(buffer, x, y, { width: 40, height: 40, fit: [40, 40] });
            } catch {
              // imagen invalida/corrupta - se omite sin romper el PDF
            }
          }
          x += 46;
        }
        y += 46;
      }
      if (videos.length > 0) {
        doc.fontSize(7).fillColor(COLOR_GRIS).text(`Video: ${videos[0].url}`, 48, y, { width: 480 });
        doc.fillColor(COLOR_TEXTO);
        y += 11;
      }
      y += 4;
    }
    y += 8;
  }

  if (run.firma_nombre) {
    if (y > doc.page.height - 60) { doc.addPage(); y = 40; }
    y += 10;
    doc.fontSize(9).font('Helvetica').fillColor(COLOR_GRIS).text(`Firmado por ${run.firma_nombre}${run.firma_responsable ? ` · Responsable: ${run.firma_responsable}` : ''}`, 40, y);
  }

  // Pie de página con numeración. Escribir tan cerca del borde (a proposito,
  // fuera del margen inferior por defecto de 40pt) hace que pdfkit agregue
  // sola una pagina en blanco extra pensando que el texto no entra - se
  // desactiva el margen inferior momentaneamente para esta sola escritura.
  const paginas = doc.bufferedPageRange();
  for (let i = 0; i < paginas.count; i++) {
    doc.switchToPage(i);
    const margenOriginal = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.fontSize(8).fillColor(COLOR_GRIS).text(`FAT Audit · página ${i + 1} de ${paginas.count}`, 40, doc.page.height - 30, { width: doc.page.width - 80, align: 'center' });
    doc.page.margins.bottom = margenOriginal;
  }

  doc.end();
  return finalizado;
}

module.exports = { generarPdfAuditoria };
