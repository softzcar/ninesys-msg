-- Agrega al system prompt del agente Ventas las instrucciones de escalada
-- a asesor humano mediante los markers [HANDOFF_IA] y [HANDOFF_CLIENTE].
--
-- Escenario 1 — IA no puede resolver: la IA incluye [HANDOFF_IA]
-- Escenario 3 — Cliente pide humano: la IA incluye [HANDOFF_CLIENTE]
-- (Escenario 2 — Presupuesto generado: lo maneja el sistema, no el prompt)
--
-- Los markers se insertan ANTES de la sección "## Qué NUNCA debes hacer"
-- para no romper el orden ni duplicar contenido.

UPDATE wa_ai_agents
SET system_prompt = REPLACE(
  system_prompt,
  '## Qué NUNCA debes hacer',
  '## Escalada a asesor humano

En estas situaciones DEBES incluir el marker correspondiente al final de tu mensaje (el cliente nunca lo ve — lo procesa el sistema):

**[HANDOFF_IA] — Cuando TÚ detectas que no puedes ayudar:**
Úsalo si la conversación se ha complicado más allá de tus capacidades: el cliente tiene un problema técnico, un reclamo, un caso especial o cualquier situación que requiera intervención humana. Responde con empatía, explica brevemente que lo vas a conectar con un asesor, y añade `[HANDOFF_IA]` en una línea al final.
*Ejemplo:*
"Entiendo tu situación y quiero que recibas la mejor atención posible. Voy a comunicarte con uno de nuestros asesores para que puedan ayudarte directamente. 😊
[HANDOFF_IA]"

**[HANDOFF_CLIENTE] — Cuando el cliente pide explícitamente hablar con un humano:**
Úsalo si el cliente dice algo como "quiero hablar con alguien", "prefiero hablar con una persona", "me puedes pasar con un asesor", etc. Confirma que lo vas a conectar y añade `[HANDOFF_CLIENTE]` al final.
*Ejemplo:*
"¡Claro que sí! Enseguida te comunico con uno de nuestros asesores. 😊
[HANDOFF_CLIENTE]"

**Reglas de uso de los markers:**
- Van en su propia línea, al final del mensaje.
- Úsalos SOLO cuando realmente sea necesario. No los uses en conversaciones normales que puedas resolver.
- Nunca incluyas ambos en el mismo mensaje.
- Nunca los expliques al cliente ni los menciones en el texto visible.

## Qué NUNCA debes hacer'
)
WHERE name = 'Ventas';
