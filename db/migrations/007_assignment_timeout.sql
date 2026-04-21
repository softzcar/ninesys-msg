-- =====================================================
-- Migración 007 — Timeout de asignación en horario laboral (Fase D.3)
-- =====================================================
-- Aplicar dentro de la base de datos `api_emp_{id_empresa}` de cada tenant.
-- Idempotente (se puede correr varias veces sin romper).
--
-- Bloque sincronizado con:
--   ninesys-api/public/model/create_new_company_api_emp_N.sql
--
-- assigned_at          → instante en que la conversación se asignó al vendedor
--                        actual (assigned_to). Se actualiza cada vez que cambia
--                        el assigned_to de NULL/otro → vendedor_X. Sirve como
--                        fallback del reloj de timeout cuando el vendedor aún
--                        no ha enviado ningún mensaje.
-- last_vendor_reply_at → instante de la última respuesta saliente de un humano
--                        (mensajes con sent_by_user IS NOT NULL). Es el reloj
--                        principal para calcular minutos hábiles transcurridos
--                        sin respuesta. Si NULL, se usa assigned_at.
--
-- Cuando el loop de assignmentTimeout detecta que han pasado 20 min hábiles
-- sin respuesta, libera la conversación (assigned_to = NULL) y dispara un
-- handoff automático excluyendo al vendedor actual.
-- =====================================================

ALTER TABLE `wa_conversations`
  ADD COLUMN IF NOT EXISTS `assigned_at`          DATETIME NULL AFTER `last_inbound_at`,
  ADD COLUMN IF NOT EXISTS `last_vendor_reply_at` DATETIME NULL AFTER `assigned_at`,
  ADD KEY IF NOT EXISTS `idx_assigned_at` (`assigned_at`),
  ADD KEY IF NOT EXISTS `idx_last_vendor_reply_at` (`last_vendor_reply_at`);
