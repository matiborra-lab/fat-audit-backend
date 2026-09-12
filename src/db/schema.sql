-- ============================================================
-- ESQUEMA DE BASE DE DATOS - FAT AUDIT
-- Postgres. Auditorías multi-sucursal de FAT Burger.
-- ============================================================

CREATE TABLE sucursales (
  id                    SERIAL PRIMARY KEY,
  nombre                TEXT NOT NULL,
  codigo                TEXT UNIQUE,
  direccion             TEXT,
  activo                BOOLEAN NOT NULL DEFAULT true,
  latitud               NUMERIC(9,6),   -- opcionales - sin coordenadas simplemente no se muestra clima (ver src/clima)
  longitud              NUMERIC(9,6),
  creado_en             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Disponibilidad de cada turno (DIURNO/NOCTURNO) por dia de la semana,
-- configurable por sucursal desde la ficha de Sucursales - unica fuente de
-- verdad de horarios (Gestionar turnos solo LEE esto, no lo edita). Si un
-- dia+turno no esta habilitado, no se puede asignar gente ahi. hora_hasta <
-- hora_desde se interpreta como que el turno cruza la medianoche.
CREATE TABLE sucursal_horarios_turno (
  id            SERIAL PRIMARY KEY,
  sucursal_id   INTEGER NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  dia_semana    INTEGER NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),  -- 0=domingo..6=sabado, Date#getDay
  turno_tipo    TEXT NOT NULL CHECK (turno_tipo IN ('DIURNO', 'NOCTURNO')),
  habilitado    BOOLEAN NOT NULL DEFAULT true,
  hora_desde    TIME NOT NULL,
  hora_hasta    TIME NOT NULL,
  UNIQUE (sucursal_id, dia_semana, turno_tipo)
);

-- Un GERENTE pertenece a una unica sucursal (sucursal_id fijo) - ADMIN y
-- AUDITOR tienen alcance global y sucursal_id queda NULL. A diferencia de un
-- modelo usuario<->sucursal N a N, esto alcanza porque la spec pide
-- explicitamente "el gerente pertenece a una unica sucursal".
CREATE TABLE usuarios (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  usuario       TEXT UNIQUE,            -- nombre de usuario opcional - permite loguearse con email O con usuario
  nombre        TEXT,
  password_hash TEXT,                    -- NULL hasta que acepta la invitacion y pone su clave
  rol           TEXT NOT NULL DEFAULT 'AUDITOR' CHECK (rol IN ('ADMIN', 'AUDITOR', 'GERENTE', 'COLABORADOR')),
  sucursal_id   INTEGER REFERENCES sucursales(id) ON DELETE SET NULL,
                                          -- obligatorio (a nivel app) cuando rol = 'GERENTE' o 'COLABORADOR'
  puesto        TEXT CHECK (puesto IN ('COCINA', 'CAJA', 'REFUERZO_COCINA')),
                                          -- obligatorio (a nivel app) solo cuando rol = 'COLABORADOR'
  fecha_nacimiento DATE,                 -- opcional, solo Gerente/Colaborador - agrega su cumpleaños como
                                          -- fecha especial recurrente en el calendario de su sucursal
  activo            BOOLEAN NOT NULL DEFAULT true,
  eliminado_en      TIMESTAMPTZ,             -- soft-delete, igual criterio que COTEJA: nunca se borra la fila
  ultimo_login      TIMESTAMPTZ,
  ultima_actividad_en TIMESTAMPTZ,           -- cualquier request autenticado (no solo login) - ver requireAuth,
                                              -- se actualiza con throttle para no escribir en cada pedido
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_usuarios_sucursal ON usuarios (sucursal_id);

-- Tokens de un solo uso para "aceptar invitacion" y "olvide mi contraseña".
CREATE TABLE tokens_usuario (
  id          SERIAL PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  tipo        TEXT NOT NULL CHECK (tipo IN ('INVITACION', 'RESET')),
  expira_en   TIMESTAMPTZ NOT NULL,
  usado_en    TIMESTAMPTZ,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- PLANTILLAS DE AUDITORIA
-- ============================================================

-- Publicar una plantilla que ya estaba PUBLICADA crea una fila nueva con
-- version+1 y plantilla_base_id apuntando a la primera version de la
-- familia (para poder listar "todas las versiones de esta plantilla"). Las
-- auditorias ya hechas nunca dependen de esta tabla en tiempo de lectura -
-- guardan su propia foto (audit_runs.estructura_snapshot).
CREATE TABLE audit_templates (
  id                      SERIAL PRIMARY KEY,
  plantilla_base_id       INTEGER REFERENCES audit_templates(id) ON DELETE SET NULL,
  nombre                  TEXT NOT NULL,
  descripcion             TEXT,
  tipo                    TEXT NOT NULL DEFAULT 'INTERNA' CHECK (tipo IN ('MARCA', 'INTERNA', 'SEGUIMIENTO')),
  version                 INTEGER NOT NULL DEFAULT 1,
  estado                  TEXT NOT NULL DEFAULT 'BORRADOR' CHECK (estado IN ('BORRADOR', 'PUBLICADA', 'ARCHIVADA')),
  weighting_mode          TEXT NOT NULL DEFAULT 'CON_PESO' CHECK (weighting_mode IN ('SIN_PESO', 'CON_PESO')),
  aplica_todas_sucursales BOOLEAN NOT NULL DEFAULT true,
  roles_permitidos        TEXT[] NOT NULL DEFAULT ARRAY['ADMIN', 'AUDITOR']::TEXT[],
                                          -- quien puede EJECUTAR esta plantilla ('GERENTE' se suma explicitamente
                                          -- si la plantilla lo habilita para auditorias internas del propio local)
  puntaje_minimo_aprobacion NUMERIC(5,4),  -- umbral GENERAL (0..1): si el puntaje total no lo alcanza, la
                                          -- auditoria queda DESAPROBADA - independiente de los umbrales_criticos
                                          -- por sector/area. NULL = sin minimo general (solo deciden los
                                          -- umbrales_criticos, si hay alguno configurado)
  creado_por              INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en               TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Solo se usa cuando aplica_todas_sucursales = false.
CREATE TABLE template_sucursales (
  id           SERIAL PRIMARY KEY,
  template_id  INTEGER NOT NULL REFERENCES audit_templates(id) ON DELETE CASCADE,
  sucursal_id  INTEGER NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  UNIQUE (template_id, sucursal_id)
);

-- Agrupador de recorrido fisico (Cocina, Deposito, etc.) - es el "sector"
-- del Excel original y tambien la seccion que el auditor completa paso a
-- paso en el celular (ver ejecucion movil). Puramente de navegacion/
-- agrupamiento - NO pondera en el calculo del puntaje (eso lo hace el area,
-- ver audit_areas.peso). Igual sirve para umbrales criticos por sector
-- (ver umbrales_criticos), que se calculan como ratio directo, sin peso.
CREATE TABLE audit_sectores (
  id           SERIAL PRIMARY KEY,
  template_id  INTEGER NOT NULL REFERENCES audit_templates(id) ON DELETE CASCADE,
  nombre       TEXT NOT NULL,
  orden        INTEGER NOT NULL DEFAULT 0
);

-- Dimension transversal (Bromatologia, Marca, etc.) - se audita dentro de
-- varios sectores a la vez; cada item pertenece a un sector Y a un area.
-- Unica unidad de peso a nivel plantilla: si ninguna area tiene peso,
-- reparto igualitario; si alguna lo tiene, TODAS deben tenerlo y sumar
-- exactamente 100% (ver validarPesos en server/plantillas.js).
CREATE TABLE audit_areas (
  id           SERIAL PRIMARY KEY,
  template_id  INTEGER NOT NULL REFERENCES audit_templates(id) ON DELETE CASCADE,
  nombre       TEXT NOT NULL,
  orden        INTEGER NOT NULL DEFAULT 0,
  peso         NUMERIC(6,4)
);

CREATE TABLE audit_items (
  id                   SERIAL PRIMARY KEY,
  sector_id            INTEGER NOT NULL REFERENCES audit_sectores(id) ON DELETE CASCADE,
  area_id              INTEGER NOT NULL REFERENCES audit_areas(id) ON DELETE CASCADE,
  texto                TEXT NOT NULL,
  ayuda_texto          TEXT,                    -- aclaracion/instructivo para el auditor (columna "Comentarios" del Excel)
  tipo_respuesta       TEXT NOT NULL DEFAULT 'ESCALA_5'
    CHECK (tipo_respuesta IN ('SI_NO', 'CHECKBOX', 'ESCALA_5', 'ESCALA_10', 'OPCION_MULTIPLE', 'NUMERO', 'TEXTO', 'FECHA')),
  opciones_json        JSONB,                   -- solo OPCION_MULTIPLE: [{etiqueta, valor}], valor en 0..1
  peso                 NUMERIC(6,4),             -- solo tiene sentido si tipo_respuesta puntua (no TEXTO/FECHA/NUMERO).
                                                  -- NULL en TODOS los items puntuables de su area = reparto igual;
                                                  -- si alguno lo tiene, TODOS deben tenerlo y sumar 100% dentro del area
  critico              BOOLEAN NOT NULL DEFAULT false,   -- marcador informativo (comprobante + resumen de criticos)
  informe_in_situ      BOOLEAN NOT NULL DEFAULT false,   -- debe figurar en el comprobante de visita
  evidencia_requerida  TEXT NOT NULL DEFAULT 'NINGUNA' CHECK (evidencia_requerida IN ('NINGUNA', 'FOTO', 'VIDEO', 'FOTO_O_VIDEO')),
  permite_no_aplica    BOOLEAN NOT NULL DEFAULT false,
  orden                INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_audit_items_sector ON audit_items (sector_id);
CREATE INDEX idx_audit_items_area ON audit_items (area_id);

-- Regla condicional: IF respuesta [operador] valor THEN exigir acciones.
CREATE TABLE item_reglas (
  id             SERIAL PRIMARY KEY,
  item_id        INTEGER NOT NULL REFERENCES audit_items(id) ON DELETE CASCADE,
  condicion_json JSONB NOT NULL,   -- {operador: '=','<','<=','>','>=','entre','contiene', valor}
  acciones_json  JSONB NOT NULL    -- {comentario_obligatorio, foto_obligatoria, video_obligatoria, accion_sugerida}
);

-- Umbral minimo por sector o por area (a traves de TODA la auditoria, no solo
-- un sector) que, si no se alcanza, desaprueba la auditoria sin importar el
-- puntaje total - configurable por plantilla (ver src/scoring).
CREATE TABLE umbrales_criticos (
  id                 SERIAL PRIMARY KEY,
  template_id        INTEGER NOT NULL REFERENCES audit_templates(id) ON DELETE CASCADE,
  tipo               TEXT NOT NULL CHECK (tipo IN ('SECTOR', 'AREA')),
  sector_id          INTEGER REFERENCES audit_sectores(id) ON DELETE CASCADE,
  area_id            INTEGER REFERENCES audit_areas(id) ON DELETE CASCADE,
  porcentaje_minimo  NUMERIC(5,4) NOT NULL,  -- 0..1
  CHECK (
    (tipo = 'SECTOR' AND sector_id IS NOT NULL AND area_id IS NULL) OR
    (tipo = 'AREA' AND area_id IS NOT NULL AND sector_id IS NULL)
  )
);

-- ============================================================
-- EJECUCION DE AUDITORIAS
-- ============================================================

CREATE TABLE audit_runs (
  id                    SERIAL PRIMARY KEY,
  template_id           INTEGER NOT NULL REFERENCES audit_templates(id) ON DELETE RESTRICT,
  estructura_snapshot   JSONB NOT NULL,   -- copia completa de sectores/areas/items/reglas/umbrales al iniciar -
                                           -- una auditoria ya hecha nunca cambia aunque se edite la plantilla despues
  sucursal_id           INTEGER NOT NULL REFERENCES sucursales(id) ON DELETE RESTRICT,
  tipo                  TEXT NOT NULL CHECK (tipo IN ('MARCA', 'INTERNA', 'SEGUIMIENTO')),
  auditor_user_id       INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  responsable_nombre    TEXT,             -- responsable/gerente/turno auditado (texto libre)
  estado                TEXT NOT NULL DEFAULT 'EN_PROGRESO' CHECK (estado IN ('EN_PROGRESO', 'COMPLETADA', 'CANCELADA')),
  iniciada_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completada_en         TIMESTAMPTZ,
  puntaje_total         NUMERIC(6,4),     -- 0..1, se completa al finalizar
  semaforo              TEXT,             -- 'ROJO'|'NARANJA'|'AMARILLO'|'VERDE'|'DORADO'
  resultado             TEXT CHECK (resultado IN ('APROBADA', 'DESAPROBADA')),
  detalle_calculo       JSONB,            -- rollup por sector/area ya resuelto (ver src/scoring) - evita recalcular
                                           -- en cada lectura del historial/dashboard
  firma_nombre          TEXT,             -- confirmacion del auditor al cerrar (nombre tipeado)
  firma_responsable      TEXT,            -- confirmacion opcional del responsable del turno
  origen_run_id         INTEGER REFERENCES audit_runs(id) ON DELETE SET NULL,  -- seguimientos: de que auditoria salio
  creado_en             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_runs_sucursal ON audit_runs (sucursal_id, creado_en);
CREATE INDEX idx_audit_runs_estado ON audit_runs (estado);
CREATE INDEX idx_audit_runs_origen ON audit_runs (origen_run_id);

CREATE TABLE audit_respuestas (
  id             SERIAL PRIMARY KEY,
  run_id         INTEGER NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
  item_id        INTEGER NOT NULL,   -- id del item DENTRO del snapshot (no FK - el item vivo pudo cambiar/borrarse)
  valor_json     JSONB,              -- respuesta cruda: numero, boolean, string u opcion elegida
  comentario     TEXT,
  no_aplica      BOOLEAN NOT NULL DEFAULT false,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, item_id)
);

CREATE TABLE evidencias (
  id             SERIAL PRIMARY KEY,
  respuesta_id   INTEGER NOT NULL REFERENCES audit_respuestas(id) ON DELETE CASCADE,
  tipo           TEXT NOT NULL CHECK (tipo IN ('FOTO', 'VIDEO')),
  url            TEXT NOT NULL,
  thumbnail_url  TEXT,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_evidencias_respuesta ON evidencias (respuesta_id);

-- Semaforo editable (hoy seedeado con los 5 tramos de la spec) - preparado
-- para que una futura pantalla de Configuracion lo edite sin tocar el schema.
CREATE TABLE semaforo_config (
  id          SERIAL PRIMARY KEY,
  rango_min   INTEGER NOT NULL,
  rango_max   INTEGER NOT NULL,
  color       TEXT NOT NULL,
  etiqueta    TEXT NOT NULL,
  orden       INTEGER NOT NULL
);

-- ============================================================
-- CALENDARIO
-- ============================================================

-- Un evento = UNA ocurrencia concreta (fecha/hora puntual), incluida cada
-- ocurrencia de una serie recurrente - la recurrencia se resuelve al crear
-- el evento (se generan N filas, una por ocurrencia, con el mismo
-- serie_id), no como una regla que se expande en cada lectura. Simplifica
-- mucho la consulta del mes a cambio de no soportar series "infinitas" (se
-- pide una fecha limite al crear una serie).
CREATE TABLE schedule_events (
  id                    SERIAL PRIMARY KEY,
  sucursal_id           INTEGER NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  tipo                  TEXT NOT NULL CHECK (tipo IN ('AUDITORIA', 'SEGUIMIENTO', 'TAREA', 'TURNO', 'EVENTO_ESPECIAL')),
  template_id           INTEGER REFERENCES audit_templates(id) ON DELETE SET NULL, -- solo AUDITORIA/SEGUIMIENTO: que plantilla precargar
  titulo                TEXT NOT NULL,
  descripcion           TEXT,
  responsable_user_id   INTEGER REFERENCES usuarios(id) ON DELETE SET NULL, -- AUDITORIA/SEGUIMIENTO/TAREA: quien la hace: TURNO: el colaborador asignado
  puesto                TEXT CHECK (puesto IN ('COCINA', 'CAJA', 'REFUERZO_COCINA')), -- solo TURNO - puede diferir
                                              -- del puesto de base del colaborador (usuarios.puesto): es el puesto
                                              -- para ESE turno puntual, no cambia su perfil
  turno_tipo            TEXT CHECK (turno_tipo IN ('DIURNO', 'NOCTURNO')), -- solo TURNO
  fecha_hora            TIMESTAMPTZ NOT NULL,
  duracion_minutos      INTEGER,             -- TURNO: junto a fecha_hora define el "hasta" (fecha_hora + duracion)
  serie_id              INTEGER,             -- agrupa las ocurrencias de una misma recurrencia (id de la 1ra fila de la serie)
  run_id                INTEGER REFERENCES audit_runs(id) ON DELETE SET NULL, -- solo AUDITORIA/SEGUIMIENTO, una vez iniciada desde el calendario
  estado                TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'COMPLETADA', 'OMITIDA')),
                                              -- "VENCIDA" NO se guarda - se calcula al leer (pendiente + fecha pasada)
  completado_en         TIMESTAMPTZ,
  completado_por        INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  completado_comentario TEXT,
  evidencia_url         TEXT,                -- solo TAREA: una evidencia por cumplimiento (no varias)
  evidencia_tipo        TEXT CHECK (evidencia_tipo IN ('FOTO', 'VIDEO')),
  solicitud_revision_motivo  TEXT,            -- solo TURNO: "no puedo asistir" del colaborador asignado
  solicitud_revision_en      TIMESTAMPTZ,
  solicitud_revision_estado  TEXT CHECK (solicitud_revision_estado IN ('PENDIENTE', 'RESUELTA')),
  origen_run_id         INTEGER REFERENCES audit_runs(id) ON DELETE SET NULL, -- solo SEGUIMIENTO generado desde los
                                              -- hallazgos de una auditoria de marca ya completada (ver runs.js)
  items_seleccionados   INTEGER[],           -- idem: ids de item DENTRO del snapshot de origen_run_id a incluir
  recordatorio_enviado_en TIMESTAMPTZ,        -- recordatorio del dia de realizacion (ver src/recordatorios) -
                                              -- evita mandarlo mas de una vez por evento
  asignacion_confirmada BOOLEAN NOT NULL DEFAULT true, -- solo TURNO: false = recien creado/modificado, se ve
                                              -- gris con reloj y NO se notifica hasta que el gerente confirme
                                              -- con "Asignar turnos" (default true para no afectar otros tipos)
  notificado_en         TIMESTAMPTZ,         -- solo TURNO: cuando se le aviso al responsable por ultima vez -
                                              -- permite reintentar si la notificacion fallo (ver calendario.js)
  icono                 TEXT,                -- solo EVENTO_ESPECIAL: emoji elegido del banco (default 🎉) - el resto
                                              -- de los tipos usan un ícono fijo por tipo, ver TIPO_ICONO en el frontend
  creado_por            INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_schedule_events_sucursal_fecha ON schedule_events (sucursal_id, fecha_hora);
CREATE INDEX idx_schedule_events_serie ON schedule_events (serie_id);
CREATE INDEX idx_schedule_events_responsable ON schedule_events (responsable_user_id);

-- Catalogo de tareas rutinarias (tipo -> tareas), administrable por Admin en
-- Configuracion - una TAREA del calendario puede salir de este catalogo
-- (tarea_catalogo_id) o ser libre ("Otro", con titulo/descripcion propios).
CREATE TABLE tipos_tarea (
  id       SERIAL PRIMARY KEY,
  nombre   TEXT NOT NULL,
  orden    INTEGER NOT NULL DEFAULT 0,
  activo   BOOLEAN NOT NULL DEFAULT true,
  icono    TEXT,                          -- emoji del banco (ver BANCO_EMOJIS) - fallback 📝 en la app si no se eligió
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE tareas_catalogo (
  id                       SERIAL PRIMARY KEY,
  tipo_tarea_id            INTEGER NOT NULL REFERENCES tipos_tarea(id) ON DELETE CASCADE,
  nombre                   TEXT NOT NULL,
  orden                    INTEGER NOT NULL DEFAULT 0,
  activo                   BOOLEAN NOT NULL DEFAULT true,
  aplica_todas_sucursales  BOOLEAN NOT NULL DEFAULT true,
  foto_requerida           BOOLEAN NOT NULL DEFAULT false, -- exige evidencia fotografica (solo camara) al completarla
  creado_en                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tareas_catalogo_tipo ON tareas_catalogo (tipo_tarea_id);
-- Solo se usa cuando aplica_todas_sucursales = false (mismo patron que template_sucursales).
CREATE TABLE tarea_sucursales (
  tarea_id     INTEGER NOT NULL REFERENCES tareas_catalogo(id) ON DELETE CASCADE,
  sucursal_id  INTEGER NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  PRIMARY KEY (tarea_id, sucursal_id)
);

ALTER TABLE schedule_events
  ADD COLUMN tarea_catalogo_id     INTEGER REFERENCES tareas_catalogo(id) ON DELETE SET NULL,
  ADD COLUMN evidencia_obligatoria BOOLEAN NOT NULL DEFAULT false, -- copiado de tareas_catalogo.foto_requerida (o tildado a mano si es "Otro")
  ADD COLUMN hora_definida         BOOLEAN NOT NULL DEFAULT true;  -- false = tarea "solo ese dia", sin horario puntual (ver panel Tareas)

-- Notificaciones in-app - base de datos compartida con Web Push (etapa
-- posterior): cada trigger (turnos publicados, solicitud de revision,
-- asignacion) inserta aca: mas adelante, el mismo insert tambien dispara el
-- push. Por ahora solo se muestran in-app (campana en el Layout).
CREATE TABLE notificaciones (
  id            SERIAL PRIMARY KEY,
  usuario_id    INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo          TEXT NOT NULL,
  titulo        TEXT NOT NULL,
  cuerpo        TEXT,
  payload_json  JSONB,
  leida_en      TIMESTAMPTZ,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notificaciones_usuario ON notificaciones (usuario_id, creado_en DESC);

-- Suscripciones Web Push (una fila por navegador/dispositivo en el que el
-- usuario aceptó notificaciones) - crearNotificacion/crearNotificaciones
-- (ver src/server/notificaciones.js) le pega un push a cada una además de
-- guardar la notificación in-app. endpoint es único por navegador/dispositivo
-- (lo da el browser), por eso alcanza como UNIQUE en vez de (usuario_id, endpoint).
CREATE TABLE push_subscriptions (
  id          SERIAL PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_push_subscriptions_usuario ON push_subscriptions (usuario_id);

-- ============================================================
-- FERIADOS (ArgentinaDatos)
-- ============================================================

-- Cache local del endpoint publico de ArgentinaDatos - nacionales
-- (inamovible), trasladables y puentes turisticos. Se reemplaza entero por
-- anio en cada actualizacion (ver src/feriados) en vez de upsert fila por
-- fila; si la API no responde, se conserva lo que ya habia (el reemplazo
-- solo ocurre despues de un fetch exitoso).
CREATE TABLE feriados (
  id             SERIAL PRIMARY KEY,
  fecha          DATE NOT NULL,
  nombre         TEXT NOT NULL,
  tipo           TEXT NOT NULL CHECK (tipo IN ('inamovible', 'trasladable', 'puente')),
  anio           INTEGER NOT NULL,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_feriados_fecha ON feriados (fecha);

-- ============================================================
-- REPORTES PROGRAMADOS
-- ============================================================

-- Envío periódico (semanal o mensual) de un resumen de auditorías por mail -
-- lo evalúa un chequeo en memoria cada N minutos (ver src/reportes), no un
-- cron de sistema operativo, para no depender de infraestructura extra.
-- dia_mes se limita a 1-28 para que dispare todos los meses por igual (evita
-- el caso "día 31" en meses más cortos).
CREATE TABLE reportes_programados (
  id              SERIAL PRIMARY KEY,
  nombre          TEXT NOT NULL,
  sucursal_id     INTEGER REFERENCES sucursales(id) ON DELETE CASCADE,  -- NULL = todas las sucursales (solo Admin/Auditor)
  frecuencia      TEXT NOT NULL CHECK (frecuencia IN ('SEMANAL', 'MENSUAL')),
  dia_semana      INTEGER CHECK (dia_semana BETWEEN 0 AND 6),  -- solo SEMANAL (0=domingo..6=sábado, Date#getDay)
  dia_mes         INTEGER CHECK (dia_mes BETWEEN 1 AND 28),    -- solo MENSUAL
  hora            TIME NOT NULL DEFAULT '08:00',
  destinatarios   TEXT[] NOT NULL,
  activo          BOOLEAN NOT NULL DEFAULT true,
  ultimo_envio_en TIMESTAMPTZ,  -- evita reenviar dos veces el mismo período
  creado_por      INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (frecuencia = 'SEMANAL' AND dia_semana IS NOT NULL AND dia_mes IS NULL) OR
    (frecuencia = 'MENSUAL' AND dia_mes IS NOT NULL AND dia_semana IS NULL)
  )
);

-- ============================================================
-- PREFERENCIAS DE NOTIFICACION
-- ============================================================

-- Una fila por usuario+tipo de preferencia (no confundir con
-- notificaciones.tipo, que es el tipo de la notificacion ya disparada) - si
-- no hay fila para un usuario+tipo, se asume habilitado=true (default
-- implicito, ver notificacion-preferencias.js). anticipacion_horas solo
-- aplica a los tipos RECORDATORIO_* (cuanto antes de la hora del evento se
-- avisa) - el resto (ASIGNACION_*, TURNOS_ASIGNADOS, CUMPLEANOS) son on/off
-- puros, sin horario configurable.
CREATE TABLE notificacion_preferencias (
  id                  SERIAL PRIMARY KEY,
  usuario_id          INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo                TEXT NOT NULL CHECK (tipo IN (
                        'ASIGNACION_TAREA', 'RECORDATORIO_TAREA',
                        'ASIGNACION_AUDITORIA', 'RECORDATORIO_AUDITORIA',
                        'ASIGNACION_EVENTO_ESPECIAL', 'RECORDATORIO_EVENTO_ESPECIAL',
                        'TURNOS_ASIGNADOS', 'CUMPLEANOS', 'CLIMA'
                      )),
  habilitado          BOOLEAN NOT NULL DEFAULT true,
  anticipacion_horas  INTEGER,
  UNIQUE (usuario_id, tipo)
);

-- Reglas de clima del usuario (botón "+ Agregar regla") - varias por
-- usuario, cada una condicional (tipo de clima O temperatura) con su propia
-- anticipación en días. Se evalúan contra el pronóstico de Open-Meteo de la
-- sucursal del usuario (ver src/clima).
CREATE TABLE notificacion_reglas_clima (
  id                 SERIAL PRIMARY KEY,
  usuario_id         INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  campo              TEXT NOT NULL CHECK (campo IN ('weather_code', 'temperatura')),
  operador           TEXT NOT NULL CHECK (operador IN ('eq', 'gte', 'lte')),
  valor              NUMERIC NOT NULL,
  anticipacion_dias  INTEGER NOT NULL DEFAULT 0 CHECK (anticipacion_dias BETWEEN 0 AND 10),
  orden              INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_notificacion_reglas_clima_usuario ON notificacion_reglas_clima (usuario_id);

-- Dedup de recordatorios (para no avisar mas de una vez por evento/dia/regla
-- en cada corrida del scheduler, ver src/recordatorios). schedule_event_id
-- se usa para recordatorios de un evento puntual (Tarea/Auditoria/Evento
-- especial); clave se usa para los que no son de un evento concreto
-- (Cumpleaños, Clima - ej. 'CUMPLEANOS-<usuario_cumpleañero>-<año>' o
-- 'CLIMA-<regla_id>-<fecha_pronostico>'). Las dos UNIQUE conviven porque
-- NULL nunca es igual a NULL en una constraint - una fila de evento (con
-- clave NULL) nunca choca con una fila de clave (con schedule_event_id NULL).
CREATE TABLE recordatorios_enviados (
  id                 SERIAL PRIMARY KEY,
  schedule_event_id  INTEGER REFERENCES schedule_events(id) ON DELETE CASCADE,
  usuario_id         INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo               TEXT NOT NULL,
  clave              TEXT,
  enviado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (schedule_event_id, usuario_id, tipo),
  UNIQUE (usuario_id, tipo, clave)
);
CREATE INDEX idx_reportes_programados_activo ON reportes_programados (activo);
