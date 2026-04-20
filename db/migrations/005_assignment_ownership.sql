-- =====================================================
-- Migración 005 — Ownership y asignación de vendedores (Fase D.1)
-- =====================================================
-- Aplicar dentro de la base de datos `api_emp_{id_empresa}` de cada tenant.
-- Idempotente (se puede correr varias veces sin romper).
--
-- Bloque sincronizado con:
--   ninesys-api/public/model/create_new_company_api_emp_N.sql
--
-- owner_id        → vendedor "dueño" de la conversación (ownership persistente).
--                   Se setea la primera vez que un humano toma el chat y no se
--                   pisa automáticamente en releases/devoluciones a IA. Permite
--                   aplicar sticky en el próximo escalado (Fase D.2).
-- last_inbound_at → marca el último mensaje entrante sin responder; se resetea
--                   cuando el vendedor asignado responde o la conv vuelve a IA.
--                   Pre-trabajo para el timeout de 20min (Fase D.3).
-- =====================================================

ALTER TABLE `wa_conversations`
  ADD COLUMN IF NOT EXISTS `owner_id`         INT       NULL AFTER `assigned_to`,
  ADD COLUMN IF NOT EXISTS `last_inbound_at`  DATETIME  NULL AFTER `owner_id`,
  ADD KEY IF NOT EXISTS `idx_owner` (`owner_id`);
