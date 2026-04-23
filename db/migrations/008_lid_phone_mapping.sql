-- 008_lid_phone_mapping.sql
-- Mapeo LID ↔ JID-fono para contactos de WhatsApp (Fase D — auto-asignación).
--
-- Contexto: WhatsApp introdujo "LID" (Linked Identifier) como forma anónima
-- de direccionamiento; mensajes entrantes pueden llegar con remoteJid en
-- formato `<numero>@lid` en vez del típico `<telefono>@s.whatsapp.net`. El
-- LID no contiene el teléfono real, por lo que no podemos buscar al cliente
-- en `customers.phone` si solo tenemos el LID.
--
-- Baileys expone el mapeo por dos vías:
--   1. Evento `chats.phoneNumberShare` — cuando el peer comparte su número.
--   2. `contacts.upsert`/`contacts.update` / `messaging-history.set` — los
--      Contact sincronizados traen `id` y `lid` cuando ambos existen.
-- Cada vez que vemos el par lo persistimos aquí para resolverlo en
-- conversaciones futuras.

CREATE TABLE IF NOT EXISTS wa_lid_phone_map (
  lid_jid       VARCHAR(100) NOT NULL,
  phone_jid     VARCHAR(100) NOT NULL,
  pushname      VARCHAR(255) DEFAULT NULL,
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (lid_jid),
  KEY idx_phone_jid (phone_jid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Nota: Esta tabla vive en la base de datos de cada tenant (api_emp_{id}).
-- No hay FK a `customers` porque el phone_jid todavía no está resuelto a un
-- `_id` — la resolución final la hace customerLookup contra `customers.phone`.
