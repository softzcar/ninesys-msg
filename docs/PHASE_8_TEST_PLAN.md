# Plan de pruebas — Fase 8 (IA / handoff)

Pruebas manuales end-to-end para validar el cableado de Gemini, los toggles
global / por conversación, los modos `bot|human|hybrid` y el handoff manual.

---

## Pre-requisitos

1. `.env` con:
   ```
   GEMINI_API_KEY=<tu_key>
   AI_DEFAULT_PROVIDER=gemini
   AI_DEFAULT_MODEL=gemini-2.5-flash
   ```
2. Tenant `api_emp_<ID>` con la migración 001 aplicada **incluyendo la columna
   nueva `respond_in_groups`**. Si el tenant ya existía antes de Fase 8:
   ```sql
   ALTER TABLE wa_ai_settings
     ADD COLUMN respond_in_groups TINYINT(1) NOT NULL DEFAULT 0,
     MODIFY provider ENUM('anthropic','gemini') NOT NULL DEFAULT 'gemini',
     MODIFY model VARCHAR(64) NOT NULL DEFAULT 'gemini-2.5-flash';
   UPDATE wa_ai_settings SET provider='gemini', model='gemini-2.5-flash' WHERE id=1;
   ```
3. Sesión Baileys del tenant en estado `READY` (escanear QR si hace falta).
4. Un teléfono real para escribirle al número del tenant.
5. Variables de entorno para los curls:
   ```bash
   COMPANY=<id>
   TOKEN=<jwt válido>
   JID="521XXXXXXXXXX@s.whatsapp.net"
   BASE=http://localhost:3000
   AUTH="Authorization: Bearer $TOKEN"
   ```

---

## Setup inicial — activar IA

```bash
# Activar IA global del tenant
curl -X POST "$BASE/ai/toggle/$COMPANY" -H "$AUTH" -H "Content-Type: application/json"  -d '{"enabled": true}'

# Configurar prompt mínimo para que Gemini sepa qué tono usar
curl -X PUT "$BASE/ai/settings/$COMPANY" -H "$AUTH" -H "Content-Type: application/json"   -d '{
    "system_prompt": "Eres asistente de atención al cliente de Ninesys. Responde en español, breve, amable. Si te piden hablar con un humano, indícalo claramente.",
    "temperature": 0.3,
    "max_tokens": 300
  }'

# Verificar
curl "$BASE/ai/settings/$COMPANY" -H "$AUTH"
```

**Esperado:** `enabled: true`, prompt actualizado, `provider: 'gemini'`,
`model: 'gemini-2.5-flash'`.

---

## Matriz de pruebas

| #  | Estado de partida | Acción | Resultado esperado |
|----|-------------------|--------|--------------------|
| **T1** | Global ON, conv nueva (default `mode=hybrid`, `ai_enabled=1`) | Mandar "Hola" desde tu WhatsApp al número del tenant | IA responde en 1–3 s. En `wa_messages` el mensaje saliente tiene `via='ai'`. En `wa_send_log` aparece fila `endpoint='ai_auto'`, `status='ok'`. |
| **T2** | Misma conv | Mandar 2 mensajes seguidos rapidísimo (<4 s) | Sólo se responde una vez (throttle anti-loop). |
| **T3** | Misma conv, IA respondiendo | Apagar global: `POST /ai/toggle/$COMPANY {enabled:false}`. Mandar otro mensaje. | **No** hay respuesta IA. Nada nuevo en `wa_send_log`. |
| **T4** | Reactivar global. Apagar IA sólo en esta conv: `POST /conversations/$COMPANY/$JID/ai/toggle {enabled:false}`. Mandar mensaje. | **No** responde. Otras conversaciones sí siguen respondiendo. |
| **T5** | Volver a activar conv: `POST /conversations/$COMPANY/$JID/ai/toggle {enabled:true}`. Cambiar a modo humano: `POST /conversations/$COMPANY/$JID/mode {mode:"human"}`. Mandar mensaje. | **No** responde (modo human gana aunque `ai_enabled=1`). |
| **T6 — Handoff manual** | Volver a `hybrid`: `POST /conversations/$COMPANY/$JID/release`. Confirmar que IA vuelve a responder. Luego simular envío de empleado desde un node REPL: <br>`require('./src/services/waManager').sendText($COMPANY, $JID, 'Hola, te atiende Ozcar', {via:'human', sentByUser: 1})` | (a) El mensaje llega al cliente. (b) `wa_messages` queda con `via='human'`, `sent_by_user=1`. (c) `wa_conversations` ahora tiene `mode='human'`, `ai_enabled=0`, `assigned_to=1`. (d) Mandar otro mensaje desde el cliente → IA **no** responde. (e) Socket.IO emite `conversation:handoff`. |
| **T7 — Release** | `POST /conversations/$COMPANY/$JID/release`. Cliente manda mensaje. | IA vuelve a responder. `wa_conversations` queda en `hybrid`, `ai_enabled=1`, `assigned_to=null`. |
| **T8 — Asignar sin enviar** | `POST /conversations/$COMPANY/$JID/assign {userId: 2}`. Cliente manda mensaje. | IA **no** responde (asignar implica `mode=human` + `ai_enabled=0`). `assigned_to=2`. |
| **T9 — Grupo** | Agregar el número del tenant a un grupo de WhatsApp y escribir algo. | IA **no** responde (hardcoded skip de grupos). Nada en `wa_send_log` para ese jid `@g.us`. |
| **T10 — Validaciones REST** | `POST /ai/toggle/$COMPANY` con body vacío | `400 Body requiere { enabled: boolean }` |
|        | `POST /conversations/$COMPANY/$JID/mode {mode:"foo"}` | `400` con lista de modos válidos |
|        | `POST /conversations/$COMPANY/unknown@s.whatsapp.net/ai/toggle {enabled:true}` | `404 Conversación no encontrada` |

---

## Verificaciones SQL útiles

```sql
-- Estado actual de la conversación de prueba
SELECT jid, mode, ai_enabled, assigned_to, unread_count, last_message
FROM wa_conversations WHERE jid = '521XXXXXXXXXX@s.whatsapp.net';

-- Últimos mensajes con su origen
SELECT ts, from_me, via, sent_by_user, LEFT(body,80) AS body, status
FROM wa_messages WHERE jid = '521XXXXXXXXXX@s.whatsapp.net'
ORDER BY ts DESC LIMIT 10;

-- Auditoría de auto-respuestas IA
SELECT created_at, phone, status, error, requested_by
FROM wa_send_log WHERE endpoint='ai_auto'
ORDER BY id DESC LIMIT 20;

-- Settings actuales
SELECT enabled, provider, model, LEFT(system_prompt,80) AS prompt, temperature, max_tokens
FROM wa_ai_settings WHERE id=1;
```

---

## Criterios de aceptación de la Fase 8

- [ ] T1, T6, T7 funcionan end-to-end (caso feliz + handoff bidireccional).
- [ ] T3 y T4 demuestran que **ambos toggles independientes funcionan**.
- [ ] T5 demuestra que `mode='human'` gana incluso con `ai_enabled=1`.
- [ ] T9 confirma que grupos no disparan IA.
- [ ] Cada respuesta IA aparece en `wa_send_log`.

---

## Cosas a vigilar durante las pruebas

1. **Latencia:** debería estar entre 1–3 s. Si ves >5 s consistentemente,
   bajar `max_tokens` o revisar región del API key.
2. **Calidad/tono:** si las respuestas son demasiado largas o robóticas,
   ajustar `system_prompt` y/o `temperature` vía `PUT /ai/settings`.
3. **Loops:** si por algún bug llegaras a ver al bot respondiéndose a sí
   mismo, el throttle de 4 s lo cortaría — pero igual investigar el filtro
   `from_me` en `maybeAutoReply`.
4. **Logs del proceso:** mirar `console.error` con prefijo
   `[waManager:<id>] maybeAutoReply falló:` o `[aiService] Gemini falló` —
   son los puntos donde la IA queda muda silenciosamente.

---

## Endpoints de referencia (Fase 8)

| Método | Ruta | Body |
|---|---|---|
| `GET`  | `/ai/settings/:companyId` | — |
| `PUT`  | `/ai/settings/:companyId` | `{ provider?, model?, system_prompt?, temperature?, max_tokens?, knowledge_base?, ... }` |
| `POST` | `/ai/toggle/:companyId` | `{ enabled: boolean }` |
| `POST` | `/conversations/:companyId/:jid/ai/toggle` | `{ enabled: boolean }` |
| `POST` | `/conversations/:companyId/:jid/mode` | `{ mode: 'bot'\|'human'\|'hybrid' }` |
| `POST` | `/conversations/:companyId/:jid/assign` | `{ userId: number }` |
| `POST` | `/conversations/:companyId/:jid/release` | — |

Todos requieren `Authorization: Bearer <jwt>`.
