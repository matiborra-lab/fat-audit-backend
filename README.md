# FAT Audit — Backend

API de FAT Audit: auditorías multi-sucursal de FAT Burger. Node/Express +
Postgres (SQL crudo), JWT+bcrypt, mismo patrón que `coteja-backend`.

## Arrancar en local

1. `npm install`
2. Copiar `.env.example` a `.env` y completar `DATABASE_URL` (una base
   Postgres — gratis en [neon.tech](https://neon.tech) o
   [railway.app](https://railway.app)) y `JWT_SECRET` (generar con
   `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`).
3. `npm run migrate` — crea las tablas.
4. `npm run seed` — crea un admin de desarrollo
   (`admin@fataudit.com.ar` / `FatAudit2026!`), dos sucursales de ejemplo y
   la plantilla inicial de FAT Burger (100 ítems).
5. `npm run dev` — levanta el servidor en `http://localhost:3000`.

## Validar el motor de puntaje

`node src/scoring/validar.js` — corre el motor contra los números reales de
la auditoría de ejemplo del Excel y confirma que da el mismo resultado
(puntaje total y aprobado/desaprobado). No necesita base de datos.

## Estructura

- `src/server/` — rutas HTTP (`index.js` auth/sucursales/usuarios,
  `plantillas.js` constructor, `runs.js` ejecución, `historial.js`
  historial/dashboard).
- `src/db/` — conexión, `schema.sql`, `migrate.js`, `seed.js`.
- `src/auth/` — passwords, sesión (JWT), middleware de auth/alcance, tokens
  de invitación/reset.
- `src/scoring/` — motor de cálculo de puntaje (función pura).
- `src/mailer/` — envío de mails transaccionales (Resend).
- `src/storage/` — URLs firmadas de subida de evidencia (S3-compatible).
