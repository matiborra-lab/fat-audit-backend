/**
 * ============================================================
 * SEED - datos iniciales para desarrollo
 * ============================================================
 * Crea (si todavia no existen): un admin de prueba, dos sucursales, el
 * semaforo estandar y la plantilla inicial de FAT Burger (100 items, tal
 * como esta en la seccion 18 de la especificacion), con sus umbrales
 * criticos observados en el Excel original. Se puede correr mas de una vez
 * sin duplicar nada (cada bloque chequea si ya existe antes de insertar).
 *
 *   npm run seed
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./index');
const { pool } = db;
const { SECTORES, AREAS, ITEMS, UMBRALES_CRITICOS, SEMAFORO } = require('./seed-data');

const ADMIN_EMAIL = 'admin@fataudit.com.ar';
const ADMIN_PASSWORD_DEV = 'FatAudit2026!'; // solo para desarrollo local - cambiar en produccion

async function seedAdmin(client) {
  const { rows } = await client.query('SELECT id FROM usuarios WHERE email = $1', [ADMIN_EMAIL]);
  if (rows[0]) return rows[0].id;
  const hash = await bcrypt.hash(ADMIN_PASSWORD_DEV, 10);
  const { rows: nuevo } = await client.query(
    `INSERT INTO usuarios (email, nombre, password_hash, rol, activo)
     VALUES ($1, 'Admin FAT Audit', $2, 'ADMIN', true) RETURNING id`,
    [ADMIN_EMAIL, hash]
  );
  console.log(`Admin de desarrollo creado: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD_DEV}`);
  return nuevo[0].id;
}

async function seedSucursales(client) {
  const nombres = ['FAT Burger Nueva Córdoba', 'FAT Burger Barrio Jardín'];
  const ids = [];
  for (const nombre of nombres) {
    const { rows } = await client.query('SELECT id FROM sucursales WHERE nombre = $1', [nombre]);
    if (rows[0]) { ids.push(rows[0].id); continue; }
    const { rows: nuevo } = await client.query(
      'INSERT INTO sucursales (nombre, activo) VALUES ($1, true) RETURNING id',
      [nombre]
    );
    ids.push(nuevo[0].id);
  }
  return ids;
}

async function seedSemaforo(client) {
  const { rows } = await client.query('SELECT count(*)::int AS n FROM semaforo_config');
  if (rows[0].n > 0) return;
  for (const s of SEMAFORO) {
    await client.query(
      'INSERT INTO semaforo_config (rango_min, rango_max, color, etiqueta, orden) VALUES ($1,$2,$3,$4,$5)',
      [s.rango_min, s.rango_max, s.color, s.etiqueta, s.orden]
    );
  }
}

async function seedPlantilla(client, adminId) {
  const nombre = 'Auditoría FAT Burger — Plantilla inicial';
  const { rows: existente } = await client.query(
    'SELECT id FROM audit_templates WHERE nombre = $1', [nombre]
  );
  if (existente[0]) { console.log('La plantilla inicial ya existe, no se recrea.'); return; }

  const { rows: tRows } = await client.query(
    `INSERT INTO audit_templates (nombre, descripcion, tipo, version, estado, weighting_mode, aplica_todas_sucursales, roles_permitidos, creado_por)
     VALUES ($1, $2, 'INTERNA', 1, 'PUBLICADA', 'CON_PESO', true, ARRAY['ADMIN','AUDITOR']::TEXT[], $3) RETURNING id`,
    [nombre, 'Plantilla migrada del Excel de auditorías de FAT Burger (100 ítems, 5 sectores, 6 áreas).', adminId]
  );
  const templateId = tRows[0].id;

  // Un solo INSERT multi-fila por nivel (ver db.bulkInsert) en vez de una
  // query por fila, así los 100 ítems tardan un viaje de ida y vuelta en
  // vez de ~100 secuenciales (relevante sobre todo contra una base remota
  // como Railway).
  const sectorRows = await db.bulkInsert(client, 'audit_sectores', ['template_id', 'nombre', 'orden'],
    SECTORES.map((s, i) => [templateId, s.nombre, i]));
  const sectorIds = {};
  SECTORES.forEach((s, i) => { sectorIds[s.nombre] = sectorRows[i].id; });

  const areaRows = await db.bulkInsert(client, 'audit_areas', ['template_id', 'nombre', 'orden', 'peso'],
    AREAS.map((a, i) => [templateId, a.nombre, i, a.peso]));
  const areaIds = {};
  AREAS.forEach((a, i) => { areaIds[a.nombre] = areaRows[i].id; });

  await db.bulkInsert(client, 'audit_items', ['sector_id', 'area_id', 'texto', 'tipo_respuesta', 'peso', 'critico', 'informe_in_situ', 'permite_no_aplica', 'orden'],
    ITEMS.map(([sectorNombre, areaNombre, texto, peso, critico, informeInSitu], orden) =>
      [sectorIds[sectorNombre], areaIds[areaNombre], texto, 'ESCALA_5', peso, critico, informeInSitu, true, orden]));

  for (const u of UMBRALES_CRITICOS) {
    if (u.tipo === 'SECTOR') {
      await client.query(
        `INSERT INTO umbrales_criticos (template_id, tipo, sector_id, porcentaje_minimo) VALUES ($1,'SECTOR',$2,$3)`,
        [templateId, sectorIds[u.sector], u.porcentaje_minimo]
      );
    } else {
      await client.query(
        `INSERT INTO umbrales_criticos (template_id, tipo, area_id, porcentaje_minimo) VALUES ($1,'AREA',$2,$3)`,
        [templateId, areaIds[u.area], u.porcentaje_minimo]
      );
    }
  }

  console.log(`Plantilla inicial creada (id=${templateId}) con ${ITEMS.length} ítems.`);
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const adminId = await seedAdmin(client);
    await seedSucursales(client);
    await seedSemaforo(client);
    await seedPlantilla(client, adminId);
    await client.query('COMMIT');
    console.log('Seed completado.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en el seed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
