/**
 * ============================================================
 * PLANTILLAS DE AUDITORIA (constructor)
 * ============================================================
 * El editor de estructura (sectores/areas/items/reglas/umbrales) se guarda
 * TODO junto con PUT /api/plantillas/:id/estructura - se borra y se
 * reinserta dentro de una transaccion, en vez de exponer un CRUD granular
 * por sector/area/item. Es mas simple y alcanza para un constructor (no es
 * edicion colaborativa en tiempo real) - y solo se permite mientras la
 * plantilla esta en BORRADOR: una plantilla PUBLICADA es inmutable (ver
 * audit_runs.estructura_snapshot, que depende de que esto nunca cambie
 * bajo una auditoria ya iniciada).
 */

const db = require('../db');

function requireBuilder(req, res, next) {
  if (req.usuario.rol !== 'ADMIN' && req.usuario.rol !== 'AUDITOR') {
    return res.status(403).json({ error: 'Solo Administrador o Auditor pueden editar plantillas' });
  }
  next();
}

async function cargarEstructura(templateId) {
  const [sectores, areas, items, umbrales, sucursales] = await Promise.all([
    db.query('SELECT * FROM audit_sectores WHERE template_id = $1 ORDER BY orden', [templateId]),
    db.query('SELECT * FROM audit_areas WHERE template_id = $1 ORDER BY orden', [templateId]),
    db.query('SELECT * FROM audit_items WHERE sector_id IN (SELECT id FROM audit_sectores WHERE template_id = $1) ORDER BY orden', [templateId]),
    db.query('SELECT * FROM umbrales_criticos WHERE template_id = $1', [templateId]),
    db.query('SELECT sucursal_id FROM template_sucursales WHERE template_id = $1', [templateId]),
  ]);
  const itemIds = items.rows.map((i) => i.id);
  const reglas = itemIds.length
    ? await db.query('SELECT * FROM item_reglas WHERE item_id = ANY($1)', [itemIds])
    : { rows: [] };
  const reglasPorItem = new Map();
  for (const r of reglas.rows) {
    if (!reglasPorItem.has(r.item_id)) reglasPorItem.set(r.item_id, []);
    reglasPorItem.get(r.item_id).push(r);
  }
  return {
    sectores: sectores.rows,
    areas: areas.rows,
    items: items.rows.map((i) => ({ ...i, reglas: reglasPorItem.get(i.id) || [] })),
    umbrales: umbrales.rows,
    sucursal_ids: sucursales.rows.map((s) => s.sucursal_id),
  };
}

function registrarRutasPlantillas(app) {
  app.get('/api/plantillas', async (req, res) => {
    try {
      let sql = `SELECT t.*, (SELECT count(*)::int FROM audit_items WHERE sector_id IN (SELECT id FROM audit_sectores WHERE template_id = t.id)) AS cantidad_items
                  FROM audit_templates t WHERE 1=1`;
      const params = [];
      if (req.query.estado) {
        params.push(req.query.estado);
        sql += ` AND t.estado = $${params.length}`;
      }
      sql += ' ORDER BY t.nombre, t.version DESC';
      const { rows } = await db.query(sql, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/plantillas/:id', async (req, res) => {
    try {
      const { rows } = await db.query('SELECT * FROM audit_templates WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Plantilla no encontrada' });
      const estructura = await cargarEstructura(req.params.id);
      res.json({ ...rows[0], ...estructura });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/plantillas', requireBuilder, async (req, res) => {
    const { nombre, descripcion, tipo, weighting_mode, roles_permitidos } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Falta el campo: nombre' });
    try {
      const { rows } = await db.query(
        `INSERT INTO audit_templates (nombre, descripcion, tipo, weighting_mode, roles_permitidos, creado_por)
         VALUES ($1,$2,COALESCE($3,'INTERNA'),COALESCE($4,'CON_PESO'),COALESCE($5,ARRAY['ADMIN','AUDITOR']::TEXT[]),$6) RETURNING *`,
        [nombre, descripcion || null, tipo, weighting_mode, roles_permitidos, req.usuario.usuarioId]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/plantillas/:id', requireBuilder, async (req, res) => {
    const { nombre, descripcion, tipo, weighting_mode, roles_permitidos, aplica_todas_sucursales } = req.body;
    try {
      const { rows: actual } = await db.query('SELECT estado FROM audit_templates WHERE id = $1', [req.params.id]);
      if (!actual[0]) return res.status(404).json({ error: 'Plantilla no encontrada' });
      if (actual[0].estado !== 'BORRADOR') return res.status(400).json({ error: 'Solo se puede editar una plantilla en BORRADOR - crea una nueva versión' });
      const { rows } = await db.query(
        `UPDATE audit_templates SET nombre = COALESCE($1,nombre), descripcion = COALESCE($2,descripcion),
         tipo = COALESCE($3,tipo), weighting_mode = COALESCE($4,weighting_mode),
         roles_permitidos = COALESCE($5,roles_permitidos), aplica_todas_sucursales = COALESCE($6,aplica_todas_sucursales),
         actualizado_en = now() WHERE id = $7 RETURNING *`,
        [nombre ?? null, descripcion ?? null, tipo ?? null, weighting_mode ?? null, roles_permitidos ?? null, aplica_todas_sucursales ?? null, req.params.id]
      );
      res.json(rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Reemplaza sectores/areas/items/reglas/umbrales enteros. Body:
  // { sectores: [{nombre,orden,peso}], areas: [{nombre,orden,peso}],
  //   items: [{sector, area, texto, ...campos, reglas:[{condicion,acciones}]}] (sector/area = nombre, se resuelven a id),
  //   umbrales: [{tipo, sector|area (nombre), porcentaje_minimo}] }
  app.put('/api/plantillas/:id/estructura', requireBuilder, async (req, res) => {
    const { sectores = [], areas = [], items = [], umbrales = [] } = req.body;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: actual } = await client.query('SELECT estado FROM audit_templates WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!actual[0]) throw Object.assign(new Error('Plantilla no encontrada'), { status: 404 });
      if (actual[0].estado !== 'BORRADOR') throw Object.assign(new Error('Solo se puede editar una plantilla en BORRADOR - crea una nueva versión'), { status: 400 });

      await client.query('DELETE FROM audit_sectores WHERE template_id = $1', [req.params.id]);
      await client.query('DELETE FROM audit_areas WHERE template_id = $1', [req.params.id]);
      await client.query('DELETE FROM umbrales_criticos WHERE template_id = $1', [req.params.id]);

      const sectorIds = {};
      for (const [i, s] of sectores.entries()) {
        const { rows } = await client.query(
          'INSERT INTO audit_sectores (template_id, nombre, orden, peso) VALUES ($1,$2,$3,$4) RETURNING id',
          [req.params.id, s.nombre, s.orden ?? i, s.peso ?? null]
        );
        sectorIds[s.nombre] = rows[0].id;
      }
      const areaIds = {};
      for (const [i, a] of areas.entries()) {
        const { rows } = await client.query(
          'INSERT INTO audit_areas (template_id, nombre, orden, peso) VALUES ($1,$2,$3,$4) RETURNING id',
          [req.params.id, a.nombre, a.orden ?? i, a.peso ?? null]
        );
        areaIds[a.nombre] = rows[0].id;
      }
      for (const [i, it] of items.entries()) {
        if (!sectorIds[it.sector] || !areaIds[it.area]) {
          throw Object.assign(new Error(`Ítem "${it.texto}": el sector o área indicado no existe en esta plantilla`), { status: 400 });
        }
        const { rows: itemRows } = await client.query(
          `INSERT INTO audit_items (sector_id, area_id, texto, ayuda_texto, tipo_respuesta, opciones_json, peso, critico, informe_in_situ, evidencia_requerida, permite_no_aplica, orden)
           VALUES ($1,$2,$3,$4,COALESCE($5,'ESCALA_5'),$6,$7,COALESCE($8,false),COALESCE($9,false),COALESCE($10,'NINGUNA'),COALESCE($11,false),$12) RETURNING id`,
          [sectorIds[it.sector], areaIds[it.area], it.texto, it.ayuda_texto || null, it.tipo_respuesta,
            it.opciones_json ? JSON.stringify(it.opciones_json) : null, it.peso ?? null, it.critico, it.informe_in_situ,
            it.evidencia_requerida, it.permite_no_aplica, it.orden ?? i]
        );
        const itemId = itemRows[0].id;
        for (const regla of it.reglas || []) {
          await client.query(
            'INSERT INTO item_reglas (item_id, condicion_json, acciones_json) VALUES ($1,$2,$3)',
            [itemId, JSON.stringify(regla.condicion), JSON.stringify(regla.acciones)]
          );
        }
      }
      for (const u of umbrales) {
        if (u.tipo === 'SECTOR') {
          if (!sectorIds[u.sector]) throw Object.assign(new Error(`Umbral crítico: el sector "${u.sector}" no existe`), { status: 400 });
          await client.query('INSERT INTO umbrales_criticos (template_id, tipo, sector_id, porcentaje_minimo) VALUES ($1,\'SECTOR\',$2,$3)', [req.params.id, sectorIds[u.sector], u.porcentaje_minimo]);
        } else {
          if (!areaIds[u.area]) throw Object.assign(new Error(`Umbral crítico: el área "${u.area}" no existe`), { status: 400 });
          await client.query('INSERT INTO umbrales_criticos (template_id, tipo, area_id, porcentaje_minimo) VALUES ($1,\'AREA\',$2,$3)', [req.params.id, areaIds[u.area], u.porcentaje_minimo]);
        }
      }
      await client.query('UPDATE audit_templates SET actualizado_en = now() WHERE id = $1', [req.params.id]);
      await client.query('COMMIT');
      const estructura = await cargarEstructura(req.params.id);
      res.json(estructura);
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(err.status || 400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.patch('/api/plantillas/:id/sucursales', requireBuilder, async (req, res) => {
    const { aplica_todas_sucursales, sucursal_ids = [] } = req.body;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE audit_templates SET aplica_todas_sucursales = $1 WHERE id = $2', [!!aplica_todas_sucursales, req.params.id]);
      await client.query('DELETE FROM template_sucursales WHERE template_id = $1', [req.params.id]);
      if (!aplica_todas_sucursales) {
        for (const sucursalId of sucursal_ids) {
          await client.query('INSERT INTO template_sucursales (template_id, sucursal_id) VALUES ($1,$2)', [req.params.id, sucursalId]);
        }
      }
      await client.query('COMMIT');
      res.json({ aplica_todas_sucursales: !!aplica_todas_sucursales, sucursal_ids: aplica_todas_sucursales ? [] : sucursal_ids });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // Crea una nueva version BORRADOR a partir de una plantilla PUBLICADA, con
  // una copia profunda de su estructura actual para seguir editando sin
  // afectar la version publicada (ni las auditorias ya hechas con ella).
  app.post('/api/plantillas/:id/nueva-version', requireBuilder, async (req, res) => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: origenRows } = await client.query('SELECT * FROM audit_templates WHERE id = $1', [req.params.id]);
      const origen = origenRows[0];
      if (!origen) throw Object.assign(new Error('Plantilla no encontrada'), { status: 404 });
      const familiaId = origen.plantilla_base_id || origen.id;
      const { rows: maxVersionRows } = await client.query(
        `SELECT COALESCE(MAX(version),0) AS max FROM audit_templates WHERE id = $1 OR plantilla_base_id = $1`, [familiaId]
      );
      const nuevaVersion = maxVersionRows[0].max + 1;

      const { rows: nuevaRows } = await client.query(
        `INSERT INTO audit_templates (plantilla_base_id, nombre, descripcion, tipo, version, estado, weighting_mode, aplica_todas_sucursales, roles_permitidos, creado_por)
         VALUES ($1,$2,$3,$4,$5,'BORRADOR',$6,$7,$8,$9) RETURNING *`,
        [familiaId, origen.nombre, origen.descripcion, origen.tipo, nuevaVersion, origen.weighting_mode, origen.aplica_todas_sucursales, origen.roles_permitidos, req.usuario.usuarioId]
      );
      const nueva = nuevaRows[0];

      const estructura = await cargarEstructura(origen.id);
      const sectorIds = {};
      for (const s of estructura.sectores) {
        const { rows } = await client.query('INSERT INTO audit_sectores (template_id, nombre, orden, peso) VALUES ($1,$2,$3,$4) RETURNING id', [nueva.id, s.nombre, s.orden, s.peso]);
        sectorIds[s.id] = rows[0].id;
      }
      const areaIds = {};
      for (const a of estructura.areas) {
        const { rows } = await client.query('INSERT INTO audit_areas (template_id, nombre, orden, peso) VALUES ($1,$2,$3,$4) RETURNING id', [nueva.id, a.nombre, a.orden, a.peso]);
        areaIds[a.id] = rows[0].id;
      }
      for (const it of estructura.items) {
        const { rows: itemRows } = await client.query(
          `INSERT INTO audit_items (sector_id, area_id, texto, ayuda_texto, tipo_respuesta, opciones_json, peso, critico, informe_in_situ, evidencia_requerida, permite_no_aplica, orden)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [sectorIds[it.sector_id], areaIds[it.area_id], it.texto, it.ayuda_texto, it.tipo_respuesta, it.opciones_json, it.peso, it.critico, it.informe_in_situ, it.evidencia_requerida, it.permite_no_aplica, it.orden]
        );
        for (const regla of it.reglas) {
          await client.query('INSERT INTO item_reglas (item_id, condicion_json, acciones_json) VALUES ($1,$2,$3)', [itemRows[0].id, regla.condicion_json, regla.acciones_json]);
        }
      }
      for (const u of estructura.umbrales) {
        await client.query(
          'INSERT INTO umbrales_criticos (template_id, tipo, sector_id, area_id, porcentaje_minimo) VALUES ($1,$2,$3,$4,$5)',
          [nueva.id, u.tipo, u.sector_id ? sectorIds[u.sector_id] : null, u.area_id ? areaIds[u.area_id] : null, u.porcentaje_minimo]
        );
      }
      if (!origen.aplica_todas_sucursales) {
        for (const sucursalId of estructura.sucursal_ids) {
          await client.query('INSERT INTO template_sucursales (template_id, sucursal_id) VALUES ($1,$2)', [nueva.id, sucursalId]);
        }
      }
      await client.query('COMMIT');
      res.status(201).json(nueva);
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(err.status || 400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/plantillas/:id/publicar', requireBuilder, async (req, res) => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM audit_templates WHERE id = $1 FOR UPDATE', [req.params.id]);
      const plantilla = rows[0];
      if (!plantilla) throw Object.assign(new Error('Plantilla no encontrada'), { status: 404 });
      if (plantilla.estado !== 'BORRADOR') throw Object.assign(new Error('Solo se puede publicar una plantilla en BORRADOR'), { status: 400 });

      const { rows: itemsCount } = await client.query(
        'SELECT count(*)::int AS n FROM audit_items WHERE sector_id IN (SELECT id FROM audit_sectores WHERE template_id = $1)', [req.params.id]
      );
      if (itemsCount[0].n === 0) throw Object.assign(new Error('La plantilla no tiene ítems cargados'), { status: 400 });

      const familiaId = plantilla.plantilla_base_id || plantilla.id;
      await client.query(
        `UPDATE audit_templates SET estado = 'ARCHIVADA' WHERE (id = $1 OR plantilla_base_id = $1) AND estado = 'PUBLICADA' AND id <> $2`,
        [familiaId, plantilla.id]
      );
      const { rows: actualizada } = await client.query(
        `UPDATE audit_templates SET estado = 'PUBLICADA', actualizado_en = now() WHERE id = $1 RETURNING *`, [req.params.id]
      );
      await client.query('COMMIT');
      res.json(actualizada[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(err.status || 400).json({ error: err.message });
    } finally {
      client.release();
    }
  });
}

module.exports = registrarRutasPlantillas;
module.exports.cargarEstructura = cargarEstructura;
module.exports.requireBuilder = requireBuilder;
