-- Agrega la columna always_ai a wa_ai_settings.
--
-- always_ai = 0 (default): comportamiento actual.
--   handoffToHuman() pone la conversación en mode='human' y silencia la IA.
--   El vendedor recibe la notificación.
--
-- always_ai = 1: modo "IA siempre activa".
--   handoffToHuman() solo notifica al vendedor, pero NO cambia el mode de la
--   conversación ni desactiva ai_enabled. La IA sigue respondiendo.
--   Útil para flujos donde el vendedor es un observador, no quien atiende.

ALTER TABLE wa_ai_settings
  ADD COLUMN IF NOT EXISTS always_ai TINYINT(1) NOT NULL DEFAULT 0
  COMMENT '0=handoff normal; 1=IA siempre activa (solo notifica, no pasa a modo humano)';

-- Para activar el modo siempre-IA en el tenant:
--   UPDATE wa_ai_settings SET always_ai = 1 WHERE id = 1;
-- Para volver al comportamiento normal:
--   UPDATE wa_ai_settings SET always_ai = 0 WHERE id = 1;
