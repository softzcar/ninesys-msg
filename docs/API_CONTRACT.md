# Contrato de `msg_ninesys` — Prueba de regresión

> Este documento congela la superficie HTTP + WebSocket que consume `app_multi`
> (Nuxt) desde `ws.nineteengreen.com` (dev) / `ws.nineteencustom.com` (prod).
>
> **Durante la migración a Baileys, nada de lo listado aquí puede cambiar de
> nombre, forma o payload.** Toda funcionalidad nueva (conversaciones, IA,
> etc.) se añade como rutas/eventos **adicionales**.
>
> Fecha de congelación: 2026-04-06

---

## Autenticación

Todas las rutas marcadas con 🔒 requieren header `Authorization: Bearer <JWT>`.
El JWT se obtiene vía `POST /login`. El frontend lo gestiona en
`app_multi/plugins/whatsapp.js` (`$wsApi`).

### `POST /login`
**Body:**
```json
{ "username": "admin", "password": "Ninesys@2024" }
```
**Response 200:**
```json
{ "token": "<jwt>", "refreshToken": "<jwt>" }
```

### `POST /refresh`
**Body:** `{ "refreshToken": "<jwt>" }`
**Response 200:** `{ "token": "<jwt>" }`

---

## Endpoints REST (usados por `app_multi`)

### 🔒 `GET /session-info/:companyId`
Devuelve estado de la sesión WhatsApp de la empresa. Inicializa el cliente si
no existe. Usado por `configuracionWizard.vue`.

**Response 200 — cliente listo:**
```json
{
  "qr": null,
  "ws_ready": true,
  "message": "Cliente de WhatsApp listo para la compañía ID 163.",
  "info": {
    "id": "521...@c.us",
    "number": "521...",
    "platform": "android",
    "pushname": "..."
  }
}
```

**Response 200 — requiere QR:**
```json
{
  "qr": "data:image/png;base64,...",
  "ws_ready": false,
  "message": "Escanee el código QR para la compañía ID 163."
}
```

**Response 200 — pausado:**
```json
{
  "status": "PAUSED",
  "ws_ready": false,
  "qr": null,
  "pausedUntil": 1234567890000,
  "message": "Sesión pausada temporalmente. Espere N minuto(s)."
}
```

### 🔒 `GET /qr/64/:companyId`
Devuelve el base64 del QR en JSON.

**Response 200:** `{ "qr": "data:image/png;base64,..." }`
**Response 404:** `{ "message": "Cliente conectado. QR no disponible." }`

### 🔒 `GET /qr/:companyId`
Devuelve una página HTML con `<img src="data:image/png;base64,...">`.
(Uso interno desde navegador / debug.)

### `GET /ws-info/:companyId`
Sin autenticación. Usado por `checkConnection.vue` para el icono de estado.

**Response 200:**
```json
{
  "status": "READY" | "REQUIRES_QR" | "PAUSED" | "ERROR" | "INITIALIZING" | "NOT_REGISTERED",
  "ws_ready": true | false,
  "qr": null | "data:image/png;base64,...",
  "message": "..."
}
```

### 🔒 `GET /connected-clients`
Lista todas las sesiones registradas. Usado por `manager.html` (ops interno).

**Response 200:** `[ { company_id, whatsapp_ready, status_detail, error_message, phoneNumber, pushname }, ... ]`

### 🔒 `GET /chats/:companyId`
Lista los chats ordenados por último mensaje.

**Response 200:** `[ { id, name, isGroup, unreadCount, lastMessage, timestamp }, ... ]`

> **Nota migración:** Baileys no expone `getChats()`. Durante la migración este
> endpoint devolverá datos provenientes de `wa_conversations` (vacío hasta que
> se persistan). Confirmar si `app_multi` lo consume activamente o solo
> `manager.html`.

### 🔒 `POST /restart/:companyId`
Reinicia el cliente de una empresa. **Response 200:** `{ "message": "..." }`

### 🔒 `DELETE /disconnect/:companyId`
Cierra sesión y borra credenciales. **Response 200:** `{ "message": "..." }`

### 🔒 `DELETE /client/:companyId`
Elimina cliente y entrada en memoria. **Response 200:** `{ "message": "..." }`

### `POST /send-message-basic/:companyId`
**Body:** `{ "phone": "521...", "name": "...", "message": "..." }`
Antepone `"Hola <name>, "` al mensaje.

### `POST /send-message-custom/:companyId`
**Body:** `{ "phone": "521...", "name": "...", "message": "..." }`
Envía el mensaje tal cual. Usado por `WsSendMsgCustomInterno.vue`.

### `POST /send-message/:companyId`
**Body:** `{ "phone_client": "...", "template": "<nombre>", ...vars }`
Usa una plantilla de `/templates/`. Invocado por `mixins.js` →
`$config.API/send-message`.

### `POST /send-direct-message/:companyId`
**Body:** `{ "phone": "521...", "message": "..." }`
**Response 200:** `{ "success": true, "message": "..." }`
Modo fire-and-forget (no await).

### 🔒 `GET /server-status`
Métricas de PM2 (`manager.html`).

### 🔒 `POST /restart-server`
Reinicia el proceso PM2 (`manager.html`).

---

## Eventos WebSocket (Socket.IO)

**CORS allowlist** actual (`websocket.js`):
- `https://app.nineteencustom.com`
- `http://app.nineteencustom.com`
- `https://app.nineteengreen.com`
- `http://app.nineteengreen.com`
- `http://localhost:3000`
- `http://localhost:3001`

**Transports:** `['websocket', 'polling']` — `allowEIO3: true`.

### Desde cliente → servidor
- `subscribe(companyId)` — se une a la sala `company-<id>`. Si la empresa no
  tiene cliente en memoria con estado `NOT_REGISTERED`/`INITIALIZING`, se
  auto-inicializa.
- `restart-client(companyId)`
- `disconnect-client(companyId)` — tras desconectar, reinicializa para generar
  un nuevo QR.

### Desde servidor → cliente (emitidos en sala `company-<id>`)
- `qr` — `{ qr: "data:image/png;base64,..." }`
- `ready` — `{ ws_ready: true }`
- `status` — `{ status: "AUTHENTICATED" | "PAUSED" | ..., message, pausedUntil? }`
- `disconnected` — `{ reason: "LOGOUT" | "NAVIGATION" | ... }`
- `error` — `{ message: "..." }`

---

## Resolución de credenciales (nuevo, Fase 1)

`msg_ninesys` ya no guarda sesiones en `.wwebjs_auth/` sino en la tabla
`wa_session_auth` de `api_emp_{id_empresa}`. Para conectarse, resuelve las
credenciales llamando a `ninesys-api`:

### `GET /internal/db-credentials/{id_empresa}` (en `ninesys-api`)
**Headers:** `X-Internal-Token: <INTERNAL_SHARED_TOKEN>`
**Response 200:**
```json
{
  "db_host": "...",
  "db_user": "...",
  "db_password": "...",
  "db_name": "api_emp_163"
}
```
**Response 401:** token inválido.
**Response 404:** empresa no existe o inactiva.

> Este endpoint NO es consumido por `app_multi`. Es estrictamente servidor ↔
> servidor. Ver `ninesys-api/app/routes/msg_service.php`.
