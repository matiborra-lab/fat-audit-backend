/**
 * STORAGE - evidencia (fotos/video) en un bucket S3-compatible (Cloudflare
 * R2 u otro). El frontend nunca sube el archivo a este servidor: pide una
 * URL firmada de subida (PUT) aca, sube el archivo directo al bucket desde
 * el celular, y despues guarda la URL publica final en audit_respuestas
 * via evidencias. Esto evita que fotos/videos pesados pasen por el backend.
 */

const { S3Client, PutObjectCommand, GetBucketCorsCommand, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
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
    // Desde el SDK 3.729 la URL firmada de subida incluye por default
    // x-amz-checksum-crc32 / x-amz-sdk-checksum-algorithm (el checksum de un
    // body vacío) - Cloudflare R2 y otros S3-compatibles lo rechazan cuando
    // el navegador sube el archivo real, y la subida directa falla con un
    // error de red opaco ("Load failed" en Safari, "Failed to fetch" en
    // Chrome). WHEN_REQUIRED deja la URL sin esos parámetros.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

// Los navegadores suben directo al bucket (PUT a la URL firmada), así que el
// bucket tiene que permitir CORS desde el frontend - un bucket nuevo no trae
// ninguna regla y la subida falla igual que con el checksum. Se configura
// solo si el bucket NO tiene ninguna regla (nunca pisa una ya cargada a
// mano); si algo falla (ej. credenciales sin permiso de administración del
// bucket) solo se avisa en el log.
async function asegurarCorsDelBucket() {
  const client = clienteS3();
  if (!client || !process.env.S3_BUCKET) return;
  const origenes = (process.env.FRONTEND_URL || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  if (!origenes.length) return;
  try {
    let existentes = [];
    try {
      const actual = await client.send(new GetBucketCorsCommand({ Bucket: process.env.S3_BUCKET }));
      existentes = actual.CORSRules || [];
    } catch (err) {
      if (err.name !== 'NoSuchCORSConfiguration') throw err;
    }
    if (existentes.length) {
      console.log('[storage] el bucket ya tiene reglas CORS, no se toca');
      return;
    }
    await client.send(new PutBucketCorsCommand({
      Bucket: process.env.S3_BUCKET,
      CORSConfiguration: {
        CORSRules: [{
          AllowedOrigins: origenes,
          AllowedMethods: ['GET', 'PUT', 'HEAD'],
          AllowedHeaders: ['*'],
          MaxAgeSeconds: 3600,
        }],
      },
    }));
    console.log('[storage] CORS del bucket configurado para: ' + origenes.join(', '));
  } catch (err) {
    console.error('[storage] no se pudo revisar/configurar el CORS del bucket (configurarlo a mano en el panel del proveedor):', err.message);
  }
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

module.exports = { urlDeSubida, asegurarCorsDelBucket };
