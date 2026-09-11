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
  -- Horario de cada turno, configurable por sucursal - la grilla de
  -- "Gestionar turnos" completa fecha_hora/duracion_minutos automaticamente
  -- a partir de esto cuando se elige DIURNO o NOCTURNO (ver turno_tipo en
  -- schedule_events); nocturno_hasta < nocturno_desde se interpreta como
  -- que cruza la medianoche.
  turno_diurno_desde    TIME NOT NULL DEFAULT '08:00',
  turno_diurno_hasta    TIME NOT NULL DEFAULT '16:00',
  turno_nocturno_desde  TIME NOT NULL DEFAULT '16:00',
  turno_nocturno_hasta  TIME NOT NULL DEFAULT '00:00',
  creado_en             TIMESTAMPTZ NOT NULL DEFAULT now()
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
  activo        BOOLEAN NOT NULL DEFAULT true,
  eliminado_en  TIMESTAMPTZ,             -- soft-delete, igual criterio que COTEJA: nunca se borra la fila
  ultimo_login  TIMESTAMPTZ,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
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
  tipo                  TEXT NOT NULL CHECK (tipo IN ('AUDITORIA', 'SEGUIMIENTO', 'TAREA', 'TURNO')),
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
  creado_por            INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_schedule_events_sucursal_fecha ON schedule_events (sucursal_id, fecha_hora);
CREATE INDEX idx_schedule_events_serie ON schedule_events (serie_id);
CREATE INDEX idx_schedule_events_responsable ON schedule_events (responsable_user_id);

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
