# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Node.js/Express server for Tampa Cleaning. Employees interact over **WhatsApp (via Twilio)** for GPS check-in, confirming the next day's schedule, reporting complaints/questions, and closing out assigned tasks ("pendientes"). **Google Sheets is the database.** Management (Will) is notified over WhatsApp. Admins schedule services and assign pendientes from a password-protected web agenda. All web pages (service close-out form, agenda, pendientes) are HTML rendered by this same server (no AppSheet or external form tools — that approach was abandoned on purpose, as was an earlier Telegram + Apps Script version).

Code, identifiers, sheet/column names, and all user-facing text are in **Spanish**; keep new code and messages in Spanish. `Arquitectura_Tampa_Cleaning.md` is the detailed architecture/decision doc (flows, sheet descriptions, pending work) — read it before larger changes and keep it in sync.

## Commands

- `npm install` / `npm start` (runs `node index.js`, port `PORT` or 3000).
- No tests, linter, or build step exist.
- Required env vars: `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY` (single-line with literal `\n`, restored in `sheets.js`), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `CLAVE_ADMIN` (legacy `/enviar-programacion`), `SESSION_SECRET` (≥32 chars, signs admin session cookies), `CLAVE_ADMIN_1`…`CLAVE_ADMIN_4` (per-admin login passwords; the index maps to a fixed admin name in `auth.js`). The Twilio client is constructed at module load in `logica.js`, so the server won't start without the Twilio vars.
- Running locally talks to the **real production spreadsheet and sends real WhatsApp messages** — there is no staging environment.
- Client-side JS for the agenda/pendientes pages lives inside server-side template strings, so a syntax error there only shows up in the browser. To check it without the network, stub `./sheets` and `./logica` via `Module._load`, call e.g. `edicion.editorHtml(fecha, {clientes:[],empleados:[]}, [])`, and run each `<script>` body through `new Function(...)`.

## Deployment

Hosted on Render (`tampa-cleaning-servidor.onrender.com`). **Pushing to `main` auto-deploys to production.** Check Render's Logs tab to confirm a deploy. New env vars must be created in Render before pushing code that uses them.

## Architecture

- `index.js` — Express routes. HTML is built inline with template strings.
  - `POST /webhook` (Twilio, form-encoded, replies with TwiML; `null` response = send empty `<Response>` i.e. stay silent).
  - `GET /enviar-programacion?clave=` (legacy: sends tomorrow's schedule).
  - `GET/POST /cierre?id=` (close-out form; renders the cleaning checklist or the quality-inspection form depending on `Tipo_Servicio === 'Inspeccion'`).
  - `GET/POST /login`, `GET /logout`; admin-only (`auth.requiereAdmin`): `GET /agenda`, `POST /agenda/guardar|enviar|cancelar`, `POST /actualizar-cache`, `GET /pendientes`, `POST /pendientes/guardar|cerrar|cancelar|recordar`.
  - `GET/POST /pendiente?id=` (employee's per-task page, unauthenticated like `/cierre`), `GET /test-sheets`.
- `logica.js` — WhatsApp business logic (check-in, schedule sending/confirmation, avisos, close-out, post-send change notices, `registrarCambio`), plus hardcoded constants: Twilio sandbox sender number, `BASE_URL`, Will's admin number (`CHAT_ADMIN_WHATSAPP`), `INSUMOS_COMUNES`, `AREAS_INSPECCION`. `enviarWhatsApp` returns the Twilio message SID.
- `auth.js` — admin login: HMAC-signed session cookie (12 h), constant-time password compare, in-memory lockout (5 failures/IP → 15 min).
- `agenda.js` — `/agenda` page: week strip, day view, filters, per-service "línea de vida", strip of pendientes due that day. Also exports date helpers (`hoyFlorida`, `fechaValida`, `normalizarFecha`) used by other modules.
- `edicion.js` — agenda editor: validation, create/edit/reassign/cancel, save & send, retroactive registration for past dates. `maestros()` returns active clients/employees.
- `pendientes.js` — pendientes: admin page, one WhatsApp per task (SID stored for reply matching), reminders, employee replies, employee page.
- `sheets.js` — Sheets API wrapper with hardcoded `SPREADSHEET_ID`: `leerHoja(nombre, { cache })`, `agregarFila(s)`, `actualizarCelda(s)`, `asegurarHoja` (creates a tab with headers if missing), `invalidarCache`, `edadCacheSegundos`. Re-authenticates on every call. Reads are live unless `{ cache: true }` (45 s, in-memory; used only by agenda views); any write invalidates that sheet's cache. Code paths that write must read live before validating.

### Webhook dispatch order (index.js)
Order matters, since a message can match several handlers: WhatsApp Reply to a pendiente message (`OriginalRepliedMessageSid` found in `PENDIENTES_MENSAJES`) → schedule confirmation (`ok`/`confirmo`/`no puedo`) → aviso acknowledgement (`recibido`) → `ok`/`listo` without Reply (closes a pendiente only if the employee has exactly one open+sent) → `aviso Cliente: msg` (only from Will's number) → text containing word `queja` → `duda` → location share (Latitude/Longitude → check-in) → `hola`/`/start` help. Anything else gets no reply.

### Sheets conventions
- Row 0 is headers; code builds a `col` map (`header name → index`) and accesses cells by column name. Writes use 1-indexed row/column (`i + 1`, `col[x] + 1`).
- Many columns are optional — writes are guarded with `if (col['X'] !== undefined)`. Preserve this pattern when adding columns. Exception: the agenda refuses to save if its required `PROGRAMACION_DIARIA` columns are missing (and retroactive saves require `Registro_Retroactivo`, `Motivo_Retroactivo`, `Origen_Registro`, `Hora_Entrada_Real`, `Hora_Salida_Real`, `Servicio_Finalizado`).
- New rows from the agenda and pendientes are built by header name, so column order there doesn't matter.
- **Positional exceptions** (break if sheet columns are reordered): `agregarFila` calls for `REGISTRO_TURNOS`, `QUEJAS`, `CAMBIOS_PROGRAMACION`, `PENDIENTES_MENSAJES` and `PENDIENTES_HISTORIAL` pass values in fixed column order; reply matching reads `PENDIENTES_MENSAJES` column A = SID, B = ID_Pendiente; `buscarTelefonoPorNombre` assumes `EMPLEADOS` column A = phone, B = name.
- `CAMBIOS_PROGRAMACION`, `PENDIENTES`, `PENDIENTES_MENSAJES`, `PENDIENTES_HISTORIAL` are auto-created via `asegurarHoja` on first use.
- Employee WhatsApp numbers live in the `EMPLEADOS.ID_Telegram` column (legacy name, kept intentionally). Phones are compared via `soloDigitos`.
- `PROGRAMACION_DIARIA` is the core table (one row per service, ID `PRG-AAAAMMDD-NN`): scheduling, confirmation, check-in entry/exit, and close-out columns all live on the same row, identified by `ID_Programacion`. Rows are never deleted — cancellation sets `Cancelado = Sí` + `Motivo_Cancelacion`, and cancelled rows are skipped everywhere.
- `PENDIENTES` holds one row per task (ID `PND-AAAAMMDD-NN`, by creation date), optionally linked to a service via `ID_Programacion`.

### Dates and time
"Today"/"tomorrow" are computed in `America/New_York`, not server time (Render runs UTC). `normalizarFecha` accepts both `YYYY-MM-DD` and `M/D/YYYY` from the sheet. Use the same timezone handling for any new date logic. Check-in times are stored as `M/D/YYYY, h:mm:ss AM/PM`; retroactive entries write the same format (`textoHoraReal` in `edicion.js`).

### Behaviors to preserve
- Check-in auto-decides Entrada vs Salida from what's already recorded today; on Salida it sends the `/cierre` link.
- Anomaly detection (identical coordinates or >150 km/h implied speed vs. the employee's previous check-in) alerts management silently.
- Close-out is idempotent: both GET and POST check `Servicio_Finalizado === 'Sí'`; the POST path throws an error with `yaFinalizado = true` that `index.js` turns into a warning page. Pendientes likewise refuse to change once not `Abierto`.
- All management alerts go through `notificarGerencia(mensaje, nivel)` with levels `urgente` 🔴 / `atencion` 🟡 / `rutina` ✅.
- Editing a service that was already sent (employee/client/time/type) resets confirmation to `Pendiente`, notifies the affected employees, and logs to `CAMBIOS_PROGRAMACION`; if a notice fails, the change still stays saved and management is alerted.
- Past dates in the agenda are **retroactive**: a reason is required, rows are flagged `Registro_Retroactivo = Sí`, new rows get `Estado_Envio = No aplica` (skipped by sending), and no WhatsApp is ever sent.
- Writes in `edicion.js` and `pendientes.js` go through an in-memory serial queue (`enSerie`) so concurrent admins don't generate duplicate IDs. This and the login lockout assume a single server instance.
