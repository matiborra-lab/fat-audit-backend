/**
 * STORAGE - evidencia (fotos/video) en un bucket S3-compatible (Cloudflare
 * R2 u otro). El frontend nunca sube el archivo a este servidor: pide una
 * URL firmada de subida (PUT) aca, sube el archivo directo al bucket desde
 * el celular, y despues guarda la URL publica final en audit_respuestas
 * via evidencias. Esto evita que fotos/videos pesados pasen por el backend.
 */

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

function clienteS3() {
  if (!process.env.S3_ENDPOINT) return null;
  return new S3Client({
    region: 'auto',
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
}

const EXTENSIONES_VALIDAS = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
};

// Genera una URL firmada de subida (valida 5 minutos) + la URL publica final
// donde va a quedar el archivo una vez subido. `carpeta` agrupa por tipo de
// uso dentro del bucket (default 'auditorias', el original - los comunicados
// usan 'comunicados' para no mezclarse con evidencia de auditorías).
async function urlDeSubida({ contentType, runId, carpeta = 'auditorias' }) {
  const ext = EXTENSIONES_VALIDAS[contentType];
  if (!ext) throw new Error('Tipo de archivo no soportado: ' + contentType);
  const client = clienteS3();
  if (!client) throw new Error('El storage de evidencia no esta configurado (falta S3_ENDPOINT en el backend)');

  const key = `${carpeta}/${runId}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const bucket = process.env.S3_BUCKET;
  const comando = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(client, comando, { expiresIn: 300 });
  const publicUrl = (process.env.S3_PUBLIC_URL || '').replace(/\/$/, '') + '/' + key;
  return { uploadUrl, publicUrl, key };
}

module.exports = { urlDeSubida };
