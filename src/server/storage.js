/**
 * ============================================================
 * STORAGE - subida de respaldo y diagnóstico
 * ============================================================
 * La subida normal es directa navegador -> bucket con URL firmada (ver
 * src/storage). Si el navegador no puede hablar con el bucket (CORS mal
 * configurado, red del celular), el frontend cae a POST /api/storage/subir:
 * manda el archivo a esta API y el servidor lo sube.
 */

const express = require('express');
const { requireAdmin } = require('../auth/middleware');
const { subirDesdeServidor, diagnosticar } = require('../storage');

const CARPETAS = ['auditorias', 'tareas', 'comunicados'];
const LIMITE_MB = 30;

module.exports = function registrarRutasStorage(app) {
  // Body = el archivo crudo (Content-Type image/* o video/*).
  app.post('/api/storage/subir', express.raw({ type: ['image/*', 'video/*'], limit: `${LIMITE_MB}mb` }), async (req, res) => {
    const carpeta = req.query.carpeta;
    if (!CARPETAS.includes(carpeta)) return res.status(400).json({ error: 'Carpeta inválida' });
    // Mismo criterio que /api/comunicados/imagen/url-subida: solo Admin.
    if (carpeta === 'comunicados' && req.usuario.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo un administrador puede subir imágenes de comunicados' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Falta el archivo (o es de un tipo no soportado)' });
    try {
      const resultado = await subirDesdeServidor({
        buffer: req.body, contentType: req.headers['content-type'].split(';')[0], carpeta, runId: String(req.query.ref || 'general').replace(/[^\w-]/g, ''),
      });
      res.status(201).json(resultado);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/storage/diagnostico', requireAdmin, async (req, res) => {
    const origen = (req.headers.origin || (process.env.FRONTEND_URL || '').split(',')[0] || '').trim().replace(/\/$/, '');
    try {
      res.json({ origen, pasos: await diagnosticar({ origen }) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
