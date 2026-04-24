-- =====================================================
-- Migración 009 — Transcripción de notas de voz y acumulado de consumo IA
-- =====================================================
-- Aplicar dentro de la base de datos `api_emp_{id_empresa}` de cada tenant.
-- Idempotente (se puede correr varias veces sin romper).
--
-- Bloque sincronizado con:
--   ninesys-api/public/model/create_new_company_api_emp_N.sql
-- (regla obligatoria: cualquier cambio de schema debe replicarse en la
-- plantilla de creación de empresa nueva).
--
-- Objetivo:
--   1. Guardar en `wa_messages` la transcripción de cada nota de voz
--      que procese Whisper (columnas transcript/_lang/_cost_usd/_error).
--   2. Acumular el gasto mensual por proveedor (Whisper, Gemini) en
--      `wa_usage_monthly` para el panel de configuración.
--   3. Exponer `wa_tenant_config` con los flags STT: enable, tope mensual
--      en USD y umbral de audio largo (pasar a humano sin transcribir).
--
-- Decisión sobre la unidad de consumo acumulado:
--   El plan original (logs_gemini/2026-04-20_00-00-01_plan-mensajes_voz_ia_whisper.log)
--   proponía `usd_cents BIGINT`. Desviamos intencionalmente a `usd_micros`
--   (1 micro = 1e-6 USD). Motivo: una nota de voz de 30s en Whisper cuesta
--   ~$0.003 (0.3 cents); redondear a cents enteros pierde el gasto real
--   de cada llamada y deja el acumulador clavado en 0. Con micros:
--     - seguimos con BIGINT (exacto, aditivo, sin errores de float),
--     - la mínima unidad representable es $0.000001 (suficiente para
--       cualquier precio razonable de STT/LLM),
--     - al leer dividimos por 1e6 para mostrar USD.
-- =====================================================

-- ---------- 1. Columnas de transcripción en wa_messages ----------
-- Se mantiene DECIMAL(10,6) en transcript_cost_usd a nivel mensaje porque
-- no se agrega (solo se consulta para auditoría); el acumulado vive en
-- wa_usage_monthly con la precisión en micros explicada arriba.
ALTER TABLE `wa_messages`
  ADD COLUMN IF NOT EXISTS `transcript`           TEXT           NULL AFTER `body`,
  ADD COLUMN IF NOT EXISTS `transcript_lang`      VARCHAR(8)     NULL AFTER `transcript`,
  ADD COLUMN IF NOT EXISTS `transcript_cost_usd`  DECIMAL(10,6)  NULL AFTER `transcript_lang`,
  ADD COLUMN IF NOT EXISTS `transcript_error`     VARCHAR(255)   NULL AFTER `transcript_cost_usd`;

-- ---------- 2. Acumulado mensual de consumo por proveedor ----------
-- PK (year_month, provider) — una fila por mes/proveedor. Upsert con
-- `ON DUPLICATE KEY UPDATE usd_micros = usd_micros + VALUES(usd_micros)`.
-- Nota: `year_month` se entrecomilla con backticks en las queries porque
-- YEAR_MONTH es una unidad de intervalo reservada en MariaDB. El nombre de
-- columna es válido pero el driver necesita backticks para no confundirlo.
CREATE TABLE IF NOT EXISTS `wa_usage_monthly` (
  `year_month`  CHAR(7)     NOT NULL,            -- '2026-04'
  `provider`    VARCHAR(16) NOT NULL,            -- 'whisper' | 'gemini'
  `usd_micros`  BIGINT      NOT NULL DEFAULT 0,  -- micro-USD (1e-6 USD)
  `call_count`  INT         NOT NULL DEFAULT 0,
  `updated_at`  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
                                     ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`year_month`, `provider`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 3. Configuración STT por tenant (singleton id=1) ----------
-- stt_enabled              → toggle maestro. Si 0, los audios nunca se
--                            mandan a Whisper (tampoco se hace handoff
--                            por audio largo basado en esta lógica; la
--                            red de seguridad de waManager sigue activa
--                            para audios >120s).
-- stt_monthly_usd_limit    → tope duro por mes. Al alcanzarse, los audios
--                            no se transcriben y se escala a humano con
--                            aviso.
-- stt_long_audio_seconds   → audios ≥ este umbral se pasan a humano sin
--                            gastar Whisper. Default 120s (= 2 min).
-- stt_language             → hint de idioma para Whisper (más precisión).
--                            'es' por default; vacío = autodetección.
CREATE TABLE IF NOT EXISTS `wa_tenant_config` (
  `id`                      TINYINT        NOT NULL DEFAULT 1,
  `stt_enabled`             TINYINT(1)     NOT NULL DEFAULT 1,
  `stt_monthly_usd_limit`   DECIMAL(10,2)  NOT NULL DEFAULT 3.00,
  `stt_long_audio_seconds`  INT            NOT NULL DEFAULT 120,
  `stt_language`            VARCHAR(8)     NOT NULL DEFAULT 'es',
  `updated_at`              TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                                   ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `wa_tenant_config_singleton` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed del singleton.
INSERT IGNORE INTO `wa_tenant_config` (`id`) VALUES (1);
