/**
 * ============================================================
 * VERIFICACION DE FOTO POR IA
 * ============================================================
 * Un ítem de auditoría con evidencia FOTO puede además exigir que la foto
 * se analice con IA (audit_items.verificacion_ia + criterio_ia, ver
 * plantillas.js) - esto llama a un modelo de Claude con visión para que
 * decida si lo que se ve en la imagen cumple el criterio descripto por
 * quien armó la plantilla (ej. "la freidora debe estar limpia, sin restos
 * de aceite"). Se usa fetch directo a la API de mensajes (mismo patrón que
 * ya usa src/storage/index.js para probar el bucket) en vez de sumar el SDK
 * de Anthropic como dependencia nueva.
 */

const MODELO = 'claude-haiku-4-5-20251001'; // rápido y barato, alcanza para esta clasificación puntual

const MIME_A_MEDIA_TYPE = {
  'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/png': 'image/png', 'image/webp': 'image/webp',
};

class ErrorConfiguracionIA extends Error {}

function armarPrompt({ criterio, itemTexto }) {
  return `Sos un inspector de control de calidad de una cadena de comida rápida. Un auditor sacó esta foto para probar que se cumple la siguiente tarea:

"${criterio}"

(Ítem de la auditoría: "${itemTexto}")

Analizá la imagen en dos pasos:
1. Primero fijate si la foto realmente muestra lo que hace falta para juzgar esta tarea (el equipo, mueble o zona correspondiente - puede tener formatos distintos según la sucursal, pero tiene que ser reconocible como eso). Si la foto muestra otra cosa (una pared, el piso, una persona, otro sector, una foto borrosa o negra, etc.) o no se puede identificar el objeto/zona en cuestión, NO está cumplido - decilo explícitamente en la razón (ej. "La foto no muestra la freidora: se ve una pared").
2. Solo si la foto SÍ muestra lo correspondiente, evaluá con criterio estricto pero razonable si cumple lo pedido.

Respondé EXCLUSIVAMENTE con un JSON válido, sin texto antes ni después, con este formato exacto:
{"cumplido": true o false, "razon": "una frase corta (máx. 20 palabras): si la foto no corresponde, decilo; si corresponde, describí qué se ve y por qué cumple o no"}`;
}

// Devuelve { aprobado, razon }. Tira ErrorConfiguracionIA si falta la API
// key (el llamador decide qué hacer - ver runs.js, no bloquea la auditoría
// por un problema de configuración del servidor).
async function verificarFoto({ criterio, itemTexto, imageBuffer, contentType }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ErrorConfiguracionIA('La verificación por IA no está configurada en el servidor (falta ANTHROPIC_API_KEY)');
  const mediaType = MIME_A_MEDIA_TYPE[contentType];
  if (!mediaType) throw new Error('Tipo de imagen no soportado para verificación por IA: ' + contentType);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODELO,
      max_tokens: 300,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBuffer.toString('base64') } },
          { type: 'text', text: armarPrompt({ criterio, itemTexto }) },
        ],
      }],
    }),
  });
  if (!resp.ok) {
    const detalle = await resp.text().catch(() => '');
    throw new Error(`La IA no pudo analizar la foto (${resp.status}): ${detalle.slice(0, 200)}`);
  }
  const data = await resp.json();
  const texto = (data.content || []).map((b) => b.text || '').join('').trim();
  let parsed;
  try {
    // Por si el modelo agrega texto alrededor del JSON pese a lo pedido.
    const match = texto.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : texto);
  } catch {
    throw new Error('La IA devolvió una respuesta que no se pudo interpretar');
  }
  return { aprobado: parsed.cumplido === true, razon: String(parsed.razon || '').slice(0, 500) };
}

module.exports = { verificarFoto, ErrorConfiguracionIA };
