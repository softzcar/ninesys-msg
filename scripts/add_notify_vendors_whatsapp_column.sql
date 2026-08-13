-- Agrega la columna notify_vendors_whatsapp a wa_ai_settings.
--
-- notify_vendors_whatsapp = 1 (default): comportamiento actual.
--   handoffToHuman() notifica al vendedor asignado por WhatsApp directo
--   (notifyVendorByWhatsApp) y por el relay de "Mensaje Interno" de
--   ninesys-api (internalMessenger.notifyVendorOfAssignment).
--
-- notify_vendors_whatsapp = 0:
--   Ambos avisos automáticos por WhatsApp quedan silenciados. El resto del
--   handoff (asignación del chat, cambio de modo de la conversación) sigue
--   funcionando igual -- solo se omiten los 2 mensajes de WhatsApp al
--   vendedor. Pensado para prevenir bloqueos de cuenta por ráfagas de
--   mensajes instantáneos (ver logs_gemini de implementación del delay
--   humano, 2026-08-12).

ALTER TABLE wa_ai_settings
  ADD COLUMN IF NOT EXISTS notify_vendors_whatsapp TINYINT(1) NOT NULL DEFAULT 1
  COMMENT '1=envia avisos automaticos de asignacion por WhatsApp al vendedor; 0=silencia esos avisos automaticos';

-- Para desactivar los avisos automáticos por WhatsApp a vendedores:
--   UPDATE wa_ai_settings SET notify_vendors_whatsapp = 0 WHERE id = 1;
-- Para reactivarlos:
--   UPDATE wa_ai_settings SET notify_vendors_whatsapp = 1 WHERE id = 1;
