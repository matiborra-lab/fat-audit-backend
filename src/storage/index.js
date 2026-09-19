/**
 * STORAGE - evidencia (fotos/video) en un bucket S3-compatible (Cloudflare
 * R2 u otro). El frontend nunca sube el archivo a este servidor: pide una
 * URL firmada de subida (PUT) aca, sube el archivo directo al bucket desde
 * el celular, y despues guarda la URL publica final en audit_respuestas
 * via evidencias. Esto evita que fotos/videos pesados pasen por el backend.
 */

const { S3Client, PutObjectCommand, DeleteObjectCommand, GetBucketCorsCommand, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
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

// Sube el archivo desde el propio servidor (el navegador se lo manda a la
// API, que ya tiene CORS resuelto) - alternativa a la URL firmada cuando el
// navegador no puede hablar directo con el bucket. Para archivos livianos
// (fotos): un video largo no entra en el límite de la ruta que la usa.
async function subirDesdeServidor({ buffer, contentType, carpeta, runId }) {
  const ext = EXTENSIONES_VALIDAS[contentType];
  if (!ext) throw new Error('Tipo de archivo no soportado: ' + contentType);
  const client = clienteS3();
  if (!client) throw new Error('El storage de evidencia no esta configurado (falta S3_ENDPOINT en el backend)');
  const key = `${carpeta}/${runId}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  await client.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: buffer, ContentType: contentType }));
  const publicUrl = (process.env.S3_PUBLIC_URL || '').replace(/\/$/, '') + '/' + key;
  return { publicUrl, key };
}

// Prueba cada eslabón por separado (credenciales/bucket, firma de la URL,
// CORS para el navegador, lectura pública) y devuelve un resultado por paso
// en vez de un error genérico - sin credenciales ni URLs firmadas en la
// respuesta. Deja un archivito de prueba y lo borra al final.
async function diagnosticar({ origen }) {
  const pasos = [];
  const paso = (nombre, ok, detalle) => pasos.push({ nombre, ok, detalle });
  const client = clienteS3();
  const bucket = process.env.S3_BUCKET;
  const publicBase = (process.env.S3_PUBLIC_URL || '').replace(/\/$/, '');

  const faltantes = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_PUBLIC_URL'].filter((k) => !process.env[k]);
  if (faltantes.length) {
    paso('Configuración', false, 'Faltan variables de entorno en el backend: ' + faltantes.join(', '));
    return pasos;
  }
  let hostEndpoint = process.env.S3_ENDPOINT;
  try { hostEndpoint = new URL(process.env.S3_ENDPOINT).host; } catch { paso('Configuración', false, 'S3_ENDPOINT no es una URL válida (tiene que empezar con https://)'); return pasos; }
  paso('Configuración', true, `Endpoint ${hostEndpoint} · bucket "${bucket}" · URL pública ${publicBase}`);

  const key = `diagnostico/${Date.now()}.png`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  let subido = false;
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: png, ContentType: 'image/png' }));
    subido = true;
    paso('Subir desde el servidor (credenciales y bucket)', true, 'El servidor pudo escribir en el bucket');
  } catch (err) {
    paso('Subir desde el servidor (credenciales y bucket)', false, `${err.name}: ${err.message} - revisá S3_ENDPOINT, S3_BUCKET y que las claves tengan permiso de escritura`);
  }

  if (subido) {
    try {
      const resp = await fetch(`${publicBase}/${key}`);
      paso('Lectura pública de las fotos', resp.ok, resp.ok
        ? 'La URL pública sirve los archivos'
        : `La URL pública devolvió ${resp.status} - las fotos se suben pero no se ven: activá el acceso público del bucket (dominio r2.dev o dominio propio) y revisá S3_PUBLIC_URL`);
    } catch (err) {
      paso('Lectura pública de las fotos', false, 'No se pudo conectar a S3_PUBLIC_URL: ' + err.message);
    }
  }

  try {
    const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: `diagnostico/firmada-${Date.now()}.png`, ContentType: 'image/png' }), { expiresIn: 120 });
    const pre = await fetch(url, { method: 'OPTIONS', headers: { Origin: origen, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' } });
    const permitido = pre.headers.get('access-control-allow-origin');
    const ok = pre.ok && (permitido === origen || permitido === '*');
    paso('Permiso del navegador (CORS) para ' + origen, ok, ok
      ? 'El bucket acepta subidas directas desde la app'
      : `El bucket no autoriza a ${origen} (respuesta ${pre.status}, access-control-allow-origin: ${permitido || 'ausente'}) - agregar una regla CORS en el bucket que permita PUT desde ese origen`);
  } catch (err) {
    paso('Permiso del navegador (CORS)', false, 'No se pudo probar: ' + err.message);
  }

  try {
    const cors = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
    paso('Reglas CORS del bucket', (cors.CORSRules || []).length > 0, JSON.stringify(cors.CORSRules || []));
  } catch (err) {
    paso('Reglas CORS del bucket', false, err.name === 'NoSuchCORSConfiguration' ? 'El bucket no tiene ninguna regla CORS' : `${err.name}: ${err.message}`);
  }

  if (subido) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {});
  return pasos;
}

module.exports = { urlDeSubida, subirDesdeServidor, diagnosticar, asegurarCorsDelBucket };
