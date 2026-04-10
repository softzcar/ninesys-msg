# Tests de integración — Fase 9.5

Suite end-to-end basada en `node --test` (built-in, sin Jest/Mocha).

## Qué prueban

1. **T1 — Ingest básico:** un mensaje entrante persiste fila en `wa_messages`.
2. **T2 — Auto-reply IA:** el stub de Gemini se invoca, el fakeSock envía, y la respuesta queda persistida con `via='ai'`.
3. **T3 — Guardrail `mode=human`:** el stub NO se invoca cuando la conversación está en modo humano.
4. **T4 — Handoff manual:** `sendText(..., { sentByUser })` marca la conversación como `mode=human`, `ai_enabled=0`, `assigned_to=<user>`.
5. **T5 — Release:** devolver la conversación a `hybrid` reactiva la IA.
6. **T6 — Throttle anti-loop:** 3 mensajes en <4s → 1 sola auto-respuesta.
7. **T7 — Breaker Gemini:** fallos consecutivos del stub NO rompen el ingest (los entrantes se persisten igual).

## Cómo corren

Los tests necesitan una MySQL real con el schema `wa_*` aplicado. Usan jids con prefijo `TEST-9.5-` para no chocar con datos reales; limpian antes y después.

### Opción A — directo con credenciales explícitas (recomendado en CI/local)

```bash
TEST_DB_HOST=... \
TEST_DB_USER=... \
TEST_DB_PASS=... \
TEST_DB_NAME=api_emp_163 \
npm test
```

### Opción B — reutilizar tenantResolver (en el VPS)

Requiere `API_URL` y `MSG_SERVICE_INTERNAL_TOKEN` en `.env` y conectividad al MySQL del tenant:

```bash
TEST_COMPANY_ID=163 npm test
```

## Dobles usados

- **`test/fixtures/fakeBaileys.js`** — fake socket con `sendMessage` que graba llamadas en `sock.sent` para aserciones. No habla con WhatsApp.
- **`test/fixtures/geminiStub.js`** — stub de `aiService.generateReply` con respuestas programables (`reply`, `fail`, `delayMs`) y contador de llamadas.

Los dobles se inyectan vía:
- `waManager._test.setSession(id, {...})` — registra una sesión fake como READY.
- `aiService._test.setGenerateReplyImpl(fn)` — swapea la impl de generateReply.

MySQL se usa **real** (no se mockea): la "integración" incluye validar el SQL concreto de `conversationStore` contra MySQL, porque usamos MySQL-ismos (`ON DUPLICATE KEY UPDATE`, columnas JSON) que SQLite no reproduce fielmente.
