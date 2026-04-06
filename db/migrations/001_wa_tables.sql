-- =====================================================
-- Migración 001 — Tablas WhatsApp (servicio msg_ninesys)
-- =====================================================
-- Aplicar dentro de la base de datos `api_emp_{id_empresa}` de cada tenant.
-- Idempotente (CREATE TABLE IF NOT EXISTS).
--
-- Bloque sincronizado con:
--   ninesys-api/public/model/create_new_company_api_emp_N.sql
-- (regla obligatoria de GEMINI.md: cualquier cambio de schema debe replicarse
-- en la plantilla de creación de empresa nueva).
-- =====================================================

-- ---------- 1. Credenciales Baileys (reemplaza .wwebjs_auth/) ----------
CREATE TABLE IF NOT EXISTS `wa_session_auth` (
  `key_name`   VARCHAR(255) NOT NULL,
  `key_value`  LONGBLOB NOT NULL,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`key_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 2. Estado de la sesión WhatsApp (una sola fila) ----------
CREATE TABLE IF NOT EXISTS `wa_session_state` (
  `id`           TINYINT NOT NULL DEFAULT 1,
  `phone_number` VARCHAR(32)  NULL,
  `pushname`     VARCHAR(128) NULL,
  `status`       ENUM('NOT_REGISTERED','INITIALIZING','REQUIRES_QR','AUTHENTICATED',
                      'READY','PAUSED','ERROR','DISCONNECTED')
                 NOT NULL DEFAULT 'NOT_REGISTERED',
  `last_error`   TEXT NULL,
  `qr_attempts`  INT NOT NULL DEFAULT 0,
  `paused_until` BIGINT NULL,
  `last_seen_at` DATETIME NULL,
  `updated_at`   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `wa_session_state_singleton` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 3. Conversaciones ----------
CREATE TABLE IF NOT EXISTS `wa_conversations` (
  `id`           BIGINT NOT NULL AUTO_INCREMENT,
  `jid`          VARCHAR(64)  NOT NULL,
  `name`         VARCHAR(255) NULL,
  `is_group`     TINYINT(1) NOT NULL DEFAULT 0,
  `mode`         ENUM('bot','human','hybrid') NOT NULL DEFAULT 'hybrid',
  `ai_enabled`   TINYINT(1) NOT NULL DEFAULT 1,
  `assigned_to`  INT NULL,
  `unread_count` INT NOT NULL DEFAULT 0,
  `last_message` TEXT NULL,
  `last_ts`      BIGINT NULL,
  `tags`         JSON NULL,
  `created_at`   DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_jid` (`jid`),
  KEY `idx_last_ts` (`last_ts` DESC),
  KEY `idx_assigned` (`assigned_to`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 4. Mensajes ----------
CREATE TABLE IF NOT EXISTS `wa_messages` (
  `id`            BIGINT NOT NULL AUTO_INCREMENT,
  `jid`           VARCHAR(64) NOT NULL,
  `wa_message_id` VARCHAR(128) NULL,
  `from_me`       TINYINT(1) NOT NULL,
  `sender`        VARCHAR(64) NULL,
  `type`          ENUM('text','image','audio','video','document','sticker','location','contact','system')
                  NOT NULL DEFAULT 'text',
  `body`          MEDIUMTEXT NULL,
  `media_url`     VARCHAR(512) NULL,
  `media_mime`    VARCHAR(128) NULL,
  `via`           ENUM('human','api','ai','template') NOT NULL DEFAULT 'api',
  `sent_by_user`  INT NULL,
  `status`        ENUM('pending','sent','delivered','read','failed') NOT NULL DEFAULT 'pending',
  `ts`            BIGINT NOT NULL,
  `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_msg` (`wa_message_id`),
  KEY `idx_conv` (`jid`, `ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 5. Plantillas editables ----------
CREATE TABLE IF NOT EXISTS `wa_templates` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(128) NOT NULL,
  `body`       TEXT NOT NULL,
  `variables`  JSON NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 6. Configuración IA por empresa ----------
CREATE TABLE IF NOT EXISTS `wa_ai_settings` (
  `id`             TINYINT NOT NULL DEFAULT 1,
  `provider`       ENUM('anthropic','gemini') NOT NULL DEFAULT 'anthropic',
  `enabled`        TINYINT(1) NOT NULL DEFAULT 0,
  `model`          VARCHAR(64) NOT NULL DEFAULT 'claude-sonnet-4-6',
  `system_prompt`  TEXT NULL,
  `temperature`    DECIMAL(3,2) NOT NULL DEFAULT 0.30,
  `max_tokens`     INT NOT NULL DEFAULT 1024,
  `handoff_rules`  JSON NULL,
  `knowledge_base` JSON NULL,
  `updated_at`     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `wa_ai_settings_singleton` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 7. Log de envíos (auditoría y métricas) ----------
CREATE TABLE IF NOT EXISTS `wa_send_log` (
  `id`           BIGINT NOT NULL AUTO_INCREMENT,
  `endpoint`     VARCHAR(64) NOT NULL,
  `phone`        VARCHAR(32) NOT NULL,
  `template`     VARCHAR(128) NULL,
  `status`       ENUM('ok','error') NOT NULL,
  `error`        TEXT NULL,
  `requested_by` VARCHAR(128) NULL,
  `created_at`   DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- Seed de wa_session_state y wa_ai_settings (singletons) ----------
INSERT IGNORE INTO `wa_session_state` (`id`, `status`) VALUES (1, 'NOT_REGISTERED');
INSERT IGNORE INTO `wa_ai_settings` (`id`) VALUES (1);
