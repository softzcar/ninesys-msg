-- =====================================================
-- Migración 003 — Soft delete de conversaciones y mensajes
-- =====================================================
-- Aplicar dentro de la base de datos `api_emp_{id_empresa}` de cada tenant.
-- Idempotente (se puede correr varias veces sin romper).
--
-- Bloque sincronizado con:
--   ninesys-api/public/model/create_new_company_api_emp_N.sql
-- =====================================================

-- ---------- wa_conversations: soft delete ----------
ALTER TABLE `wa_conversations`
  ADD COLUMN IF NOT EXISTS `deleted_at` DATETIME NULL AFTER `updated_at`,
  ADD COLUMN IF NOT EXISTS `deleted_by` INT NULL AFTER `deleted_at`,
  ADD KEY IF NOT EXISTS `idx_deleted_at` (`deleted_at`);

-- ---------- wa_messages: soft delete (cascada lógica) ----------
ALTER TABLE `wa_messages`
  ADD COLUMN IF NOT EXISTS `deleted_at` DATETIME NULL AFTER `created_at`,
  ADD KEY IF NOT EXISTS `idx_deleted_at` (`deleted_at`);
