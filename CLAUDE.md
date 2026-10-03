# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Node.js/Express server for Tampa Cleaning. Employees interact over **WhatsApp (via Twilio)** for GPS check-in, confirming the next day's schedule, and reporting complaints/questions. **Google Sheets is the database.** Management (Will) is notified over WhatsApp. Service close-out is an HTML form rendered by this same server (no AppSheet or external form tools — that approach was abandoned on purpose, as was an earlier Telegram + Apps Script version).

Code, identifiers, sheet/column names, and all user-facing text are in **Spanish**; keep new code and messages in Spanish. `Arquitectura_Tampa_Cleaning.md` is the detailed architecture/decision doc (flows, sheet descriptions, pending work) — read it before larger changes and keep it in sync.

## Commands

- `npm install` / `npm start` (runs `node index.js`, port `PORT` or 3000).
- No tests, linter, or build step exist.
- Required env vars: `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY` (single-line with literal `\n`, restored in `sheets.js`), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `CLAVE_ADMIN`. The Twilio client is constructed at module load in `logica.js`, so the server won't start without the Twilio vars.
- Running locally talks to the **real production spreadsheet and sends real WhatsApp messages** — there is no staging environment.

## Deployment

Hosted on Render (`tampa-cleaning-servidor.onrender.com`). **Pushing to `main` auto-deploys to production.** Check Render's Logs tab to confirm a deploy.

## Architecture

Three files:
- `index.js` — Express routes. `POST /webhook` (Twilio, form-encoded, replies with TwiML; `null` response = send empty `<Response>` i.e. stay silent), `GET /enviar-programacion?clave=` (sends tomorrow's schedule), `GET/POST /cierre?id=` (close-out form; renders either the cleaning checklist form or the quality-inspection form depending on `Tipo_Servicio === 'Inspeccion'`), `GET /test-sheets`. HTML is built inline with template strings.
- `logica.js` — all business logic, plus hardcoded constants: Twilio sandbox sender number, `BASE_URL`, Will's admin number (`CHAT_ADMIN_WHATSAPP`), `INSUMOS_COMUNES`, `AREAS_INSPECCION`.
- `sheets.js` — thin Sheets API wrapper (`leerHoja`, `agregarFila`, `actualizarCelda`), hardcoded `SPREADSHEET_ID`. Re-authenticates and reads the whole sheet on every call; no caching.

### Webhook dispatch order (index.js)
Order matters, since a message can match several handlers: confirmation reply (`ok`/`confirmo`/`no puedo`) → aviso acknowledgement (`recibido`) → `aviso Cliente: msg` (only from Will's number) → text containing word `queja` → `duda` → location share (Latitude/Longitude → check-in) → `hola`/`/start` help. Anything else gets no reply.

### Sheets conventions
- Row 0 is headers; code builds a `col` map (`header name → index`) and accesses cells by column name. Writes use 1-indexed row/column (`i + 1`, `col[x] + 1`).
- Many columns are optional — writes are guarded with `if (col['X'] !== undefined)`. Preserve this pattern when adding columns.
- **Positional exceptions** (break if sheet columns are reordered): `agregarFila` calls for `REGISTRO_TURNOS` and `QUEJAS` pass values in fixed column order; `buscarTelefonoPorNombre` assumes `EMPLEADOS` column A = phone, B = name.
- Employee WhatsApp numbers live in the `EMPLEADOS.ID_Telegram` column (legacy name, kept intentionally). Phones are compared via `soloDigitos`.
- `PROGRAMACION_DIARIA` is the core table (one row per service): scheduling, confirmation, check-in entry/exit, and close-out columns all live on the same row, identified by `ID_Programacion`.

### Dates and time
"Today"/"tomorrow" are computed in `America/New_York`, not server time (Render runs UTC). `normalizarFecha` accepts both `YYYY-MM-DD` and `M/D/YYYY` from the sheet. Use the same timezone handling for any new date logic.

### Behaviors to preserve
- Check-in auto-decides Entrada vs Salida from what's already recorded today; on Salida it sends the `/cierre` link.
- Anomaly detection (identical coordinates or >150 km/h implied speed vs. the employee's previous check-in) alerts management silently.
- Close-out is idempotent: both GET and POST check `Servicio_Finalizado === 'Sí'`; the POST path throws an error with `yaFinalizado = true` that `index.js` turns into a warning page.
- All management alerts go through `notificarGerencia(mensaje, nivel)` with levels `urgente` 🔴 / `atencion` 🟡 / `rutina` ✅.
