-- Migración: Fase A - Agentes IA múltiples
-- Fecha: 2026-04-10
-- Descripción: Crear tabla wa_ai_agents para soportar múltiples personalidades
--              de IA (ventas, cobranza, soporte, etc.) y vincular cada
--              conversación a un agente específico.

-- 1) Tabla de agentes IA
CREATE TABLE IF NOT EXISTS `wa_ai_agents` (
  `id`             INT NOT NULL AUTO_INCREMENT,
  `name`           VARCHAR(128) NOT NULL,
  `slug`           VARCHAR(64)  NOT NULL,
  `system_prompt`  TEXT NULL,
  `knowledge_base` JSON NULL,
  `model`          VARCHAR(64) NOT NULL DEFAULT 'gemini-2.5-flash',
  `temperature`    DECIMAL(3,2) NOT NULL DEFAULT 0.30,
  `max_tokens`     INT NOT NULL DEFAULT 1024,
  `enabled`        TINYINT(1) NOT NULL DEFAULT 1,
  `is_default`     TINYINT(1) NOT NULL DEFAULT 0,
  `created_at`     DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) Vincular conversaciones a un agente (nullable = usa el default)
ALTER TABLE `wa_conversations`
  ADD COLUMN `ai_agent_id` INT NULL AFTER `ai_enabled`,
  ADD KEY `idx_ai_agent` (`ai_agent_id`);

-- 3) Migrar el prompt actual de wa_ai_settings al agente "General" (default)
INSERT INTO `wa_ai_agents` (`name`, `slug`, `system_prompt`, `knowledge_base`,
  `model`, `temperature`, `max_tokens`, `enabled`, `is_default`)
SELECT
  'General'                  AS `name`,
  'general'                  AS `slug`,
  s.system_prompt,
  s.knowledge_base,
  s.model,
  s.temperature,
  s.max_tokens,
  1                          AS `enabled`,
  1                          AS `is_default`
FROM `wa_ai_settings` s
WHERE s.id = 1
ON DUPLICATE KEY UPDATE
  `system_prompt`  = VALUES(`system_prompt`),
  `knowledge_base` = VALUES(`knowledge_base`);
