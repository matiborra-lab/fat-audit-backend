/**
 * ============================================================
 * HISTORIAL Y DASHBOARD
 * ============================================================
 */

const db = require('../db');
const { scopeSucursal } = require('../auth/middleware');

module.exports = function registrarRutasHistorial(app) {
  app.get('/api/historial', async (req, res) => {
    const { sucursal_id, tipo, template_id, estado, desde, hasta, puntaje_min, puntaje_max } = req.query;
    let sql = `SELECT r.id, r.template_id, t.nombre AS plantilla_nombre, r.sucursal_id, s.nombre AS sucursal_nombre,
                      r.tipo, r.estado, r.creado_en, r.iniciada_en, r.completada_en, r.puntaje_total, r.semaforo, r.resultado,
                      u.nombre AS auditor_nombre, r.responsable_nombre, r.origen_run_id
               FROM audit_runs r
               JOIN audit_templates t ON t.id = r.template_id
               JOIN sucursales s ON s.id = r.sucursal_id
               JOIN usuarios u ON u.id = r.auditor_user_id
               WHERE 1=1`;
    let params = [];
    if (req.usuario.rol === 'GERENTE') {
      const scoped = scopeSucursal(req.usuario, 'r.sucursal_id', params);
      sql += scoped.sql; params = scoped.params;
    } else if (sucursal_id) {
      params.push(sucursal_id); sql += ` AND r.sucursal_id = $${params.length}`;
    }
    if (tipo) { params.push(tipo); sql += ` AND r.tipo = $${params.length}`; }
    if (template_id) { params.push(template_id); sql += ` AND r.template_id = $${params.length}`; }
    if (estado) { params.push(estado); sql += ` AND r.estado = $${params.length}`; }
    if (desde) { params.push(desde); sql += ` AND r.creado_en >= $${params.length}`; }
    // Mismo criterio que GET /api/calendario: `hasta` es una fecha sin hora,
    // <= la trunca a medianoche y descarta lo creado más tarde ese día.
    if (hasta) { params.push(hasta); sql += ` AND r.creado_en < ($${params.length}::date + 1)`; }
    if (puntaje_min) { params.push(Number(puntaje_min) / 100); sql += ` AND r.puntaje_total >= $${params.length}`; }
    if (puntaje_max) { params.push(Number(puntaje_max) / 100); sql += ` AND r.puntaje_total <= $${params.length}`; }
    sql += ' ORDER BY r.creado_en DESC LIMIT 200';
    try {
      const { rows } = await db.query(sql, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/dashboard', async (req, res) => {
    try {
      let sucursalesSql = 'SELECT id, nombre FROM sucursales WHERE activo = true';
      let params = [];
      // Gerente y Colaborador son roles de UNA sola sucursal - se fuerza la
      // suya sin confiar en ningun sucursal_id que manden (mismo criterio
      // que scopeSucursal, pero escrito acá porque ese helper solo cubre
      // Gerente y no queremos tocar sus otros usos). Admin/Auditor pueden
      // filtrar opcionalmente o ver todas.
      if (req.usuario.rol === 'GERENTE' || req.usuario.rol === 'COLABORADOR') {
        params.push(req.usuario.sucursal_id); sucursalesSql += ` AND id = $${params.length}`;
      } else if (req.query.sucursal_id) {
        params.push(req.query.sucursal_id); sucursalesSql += ` AND id = $${params.length}`;
      }
      const { rows: sucursales } = await db.query(sucursalesSql, params);
      const sucursalIds = sucursales.map((s) => s.id);
      if (sucursalIds.length === 0) return res.json({ ranking: [], sucursales: [] });

      // Ultima auditoria de MARCA completada por sucursal + la anterior (para
      // tendencia), con una sola query (rn=1 -> ultima, rn=2 -> anterior).
      // Solo MARCA: una auditoria interna (autoevaluacion del Gerente) no
      // tiene que poder mejorar/empeorar el puntaje "oficial" que se muestra acá.
      const { rows: conRn } = await db.query(
        `SELECT * FROM (
           SELECT id, sucursal_id, tipo, puntaje_total, semaforo, resultado, completada_en, detalle_calculo,
                  ROW_NUMBER() OVER (PARTITION BY sucursal_id ORDER BY completada_en DESC) AS rn
           FROM audit_runs WHERE sucursal_id = ANY($1) AND estado = 'COMPLETADA' AND tipo = 'MARCA'
         ) x WHERE rn <= 2`,
        [sucursalIds]
      );
      // OJO: pg devuelve ROW_NUMBER() (bigint) como STRING, no number - "1"
      // === 1 da false siempre. Hay que convertir antes de comparar.
      const ultimas = conRn.filter((r) => Number(r.rn) === 1);
      const anteriorPorSucursal = new Map(conRn.filter((r) => Number(r.rn) === 2).map((a) => [a.sucursal_id, Number(a.puntaje_total)]));

      // El ranking numerado (1, 2, 3...) lo arma el frontend según el orden
      // de este array - se ordena acá por el mismo puntaje que se usa para
      // ordenar, mostrando null (sin auditorías) al final.
      const ranking = sucursales.map((s) => {
        const ultima = ultimas.find((u) => u.sucursal_id === s.id);
        const anterior = anteriorPorSucursal.get(s.id);
        return {
          sucursal_id: s.id,
          sucursal_nombre: s.nombre,
          tipo: ultima?.tipo || null,
          puntaje_total: ultima ? Number(ultima.puntaje_total) : null,
          semaforo: ultima?.semaforo || null,
          resultado: ultima?.resultado || null,
          completada_en: ultima?.completada_en || null,
          tendencia: ultima && anterior != null ? Number(ultima.puntaje_total) - anterior : null,
          umbrales_fallidos: ultima?.detalle_calculo?.umbralesFallidos?.length || 0,
        };
      }).sort((a, b) => (b.puntaje_total ?? -1) - (a.puntaje_total ?? -1));

      // Últimas 10 auditorías de MARCA completadas en el alcance actual -
      // alimenta el gráfico de "resultado general" y el promedio por área
      // (ver Dashboard.jsx) - mismo criterio que arriba, sin auditorías internas.
      const { rows: ultimasAuditorias } = await db.query(
        `SELECT r.id, r.sucursal_id, s.nombre AS sucursal_nombre, r.tipo, r.completada_en,
                r.puntaje_total, r.semaforo, r.resultado, r.detalle_calculo
         FROM audit_runs r JOIN sucursales s ON s.id = r.sucursal_id
         WHERE r.sucursal_id = ANY($1) AND r.estado = 'COMPLETADA' AND r.tipo = 'MARCA'
         ORDER BY r.completada_en DESC LIMIT 10`,
        [sucursalIds]
      );

      // Promedio por área de esas mismas últimas auditorías (desempeño
      // transversal, ver Dashboard.jsx > gráfico por área).
      const areasAcumuladas = new Map(); // nombre -> {suma, n}
      for (const r of ultimasAuditorias) {
        for (const a of r.detalle_calculo?.areas || []) {
          if (!areasAcumuladas.has(a.nombre)) areasAcumuladas.set(a.nombre, { suma: 0, n: 0 });
          const acc = areasAcumuladas.get(a.nombre);
          acc.suma += a.score; acc.n += 1;
        }
      }
      const promedioPorArea = [...areasAcumuladas.entries()].map(([nombre, { suma, n }]) => ({ nombre, promedio: suma / n }));

      res.json({
        sucursales, ranking, promedioPorArea,
        ultimasAuditorias: ultimasAuditorias.map((r) => ({
          id: r.id, sucursal_id: r.sucursal_id, sucursal_nombre: r.sucursal_nombre, tipo: r.tipo,
          completada_en: r.completada_en, puntaje_total: Number(r.puntaje_total), semaforo: r.semaforo, resultado: r.resultado,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
