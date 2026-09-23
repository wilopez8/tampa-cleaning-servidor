# Arquitectura — Sistema Tampa Cleaning

**Última actualización:** 22 de septiembre de 2026
**Propósito de este documento:** referencia técnica para entender cómo funciona el sistema, qué piezas lo componen y cómo se conectan — para consultar cuando haga falta recordar el funcionamiento o incorporar a alguien nuevo al proyecto.

---

## 1. Resumen en una frase

Los empleados de Tampa Cleaning interactúan por **WhatsApp** para registrar su ubicación (check-in), confirmar su programación diaria y reportar novedades. Un **servidor propio** (no Apps Script) procesa esos mensajes, valida la información contra **Google Sheets** (que funciona como base de datos central), y notifica a gerencia por WhatsApp cuando algo requiere atención.

---

## 2. Por qué esta arquitectura (contexto de decisión)

La primera versión de este sistema usaba **Telegram + Google Apps Script** como backend. Se abandonó después de encontrar fallas persistentes e imposibles de diagnosticar bien (errores 302 intermitentes, URLs de webhook que se corrompían, reintentos infinitos) — la conclusión fue que la pieza "Aplicación web" de Apps Script no es confiable como receptor de webhooks en tiempo real, y sus herramientas de diagnóstico (logs) son insuficientes.

Se migró a:
- **WhatsApp en vez de Telegram** — porque es la app que el personal ya usa a diario (mayor adopción real, cero fricción de instalar algo nuevo).
- **Un servidor propio en Render en vez de Apps Script** — porque ofrece logs reales y legibles, comportamiento predecible, y es la forma estándar de construir este tipo de integración en la industria.

---

## 3. Componentes del sistema

| Componente | Rol | Dónde vive |
|---|---|---|
| **WhatsApp** | Interfaz que usan los empleados y gerencia | App de WhatsApp de cada persona |
| **Twilio** | Traduce entre WhatsApp y el servidor (recibe mensajes entrantes, envía salientes) | Cuenta en twilio.com |
| **Servidor Node.js** | Toda la lógica de negocio: geofencing, validaciones, decisiones | Hosteado en Render.com, código en GitHub |
| **Google Sheets** | Base de datos central — toda la información del negocio | `Tampa_Cleaning_BUILD` (Google Drive) |
| **Google Cloud (cuenta de servicio)** | Permite que el servidor lea/escriba en Sheets sin intervención humana | Proyecto `tampa-cleaning-509423` |

---

## 4. Estructura del código (repositorio en GitHub)

```
tampa-cleaning-servidor/
├── index.js       → Define las rutas HTTP (webhook de Twilio, ruta de programación diaria)
├── logica.js       → Toda la lógica de negocio (check-in, geofencing, notificaciones, confirmaciones)
├── sheets.js       → Módulo genérico de lectura/escritura a Google Sheets
└── package.json    → Dependencias: express, googleapis, twilio
```

**Por qué está dividido así:** `sheets.js` no sabe nada del negocio de limpieza — solo sabe leer y escribir hojas. `logica.js` usa esas funciones genéricas para implementar las reglas específicas de Tampa Cleaning. `index.js` solo recibe peticiones HTTP y las dirige a la función correcta. Esto permite cambiar una pieza sin tocar las otras.

---

## 5. Variables de entorno (configuradas en Render, nunca en el código)

| Variable | Para qué sirve |
|---|---|
| `GOOGLE_CLIENT_EMAIL` | Identifica la cuenta de servicio de Google |
| `GOOGLE_PRIVATE_KEY` | Clave privada de esa cuenta de servicio |
| `TWILIO_ACCOUNT_SID` | Identifica la cuenta de Twilio |
| `TWILIO_AUTH_TOKEN` | Autentica las llamadas a la API de Twilio |
| `CLAVE_ADMIN` | Protege la ruta `/enviar-programacion` para que solo tú puedas dispararla |

**Por qué en variables de entorno y no en el código:** estas credenciales nunca deben quedar visibles en GitHub (público o privado) — si alguien accede al repositorio, no debe poder ver las claves reales.

---

## 6. Flujos implementados hasta ahora

### 6.1 Check-in con geofencing
1. Empleado comparte su ubicación por WhatsApp (ícono 📎 > Ubicación).
2. Twilio la reenvía al servidor (`POST /webhook`), con `Latitude`/`Longitude` en el cuerpo de la petición.
3. El servidor identifica al empleado por su número de teléfono (columna reutilizada `ID_Telegram` en `EMPLEADOS`).
4. Busca en `PROGRAMACION_DIARIA` si tiene un servicio asignado hoy (comparando fechas en zona horaria de Florida, no la del servidor).
5. Si lo encuentra, calcula la distancia (fórmula de Haversine) contra las coordenadas del cliente en `SITIOS`.
6. Guarda un registro de auditoría en `REGISTRO_TURNOS` y actualiza las columnas de entrada/salida en `PROGRAMACION_DIARIA`.
7. Si no hay servicio asignado o está fuera de rango, notifica a gerencia por WhatsApp.

### 6.2 Programación diaria y confirmación
1. Se agrega manualmente una fila en `PROGRAMACION_DIARIA` para el día siguiente (cliente, empleado, horario, observaciones — los datos del cliente como dirección e instrucciones se completan por fórmula desde `CLIENTES`).
2. Visitando la URL `https://tampa-cleaning-servidor.onrender.com/enviar-programacion?clave=...` se dispara el envío — el servidor manda por WhatsApp toda la información combinada a cada empleado con servicio pendiente de notificar.
3. El empleado responde con el texto exacto `"Confirmo [Cliente]"` o `"No puedo [Cliente]"`.
4. El servidor actualiza `Estado_Confirmacion` en `PROGRAMACION_DIARIA`; si es "No puedo", notifica a gerencia de inmediato.

### 6.3 Notificaciones a gerencia (`notificarGerencia`)
Función centralizada que manda WhatsApp a gerencia con un prefijo según urgencia:
- 🔴 urgente (check-in fuera de rango, sin servicio asignado, "No puedo" a un servicio)
- 🟡 atención (problemas de configuración, ej. empleado sin número registrado)
- ✅ rutina (confirmaciones de envío exitoso)

---

## 7. Estructura de las hojas de Google Sheets relevantes

| Hoja | Contiene |
|---|---|
| `EMPLEADOS` | Nombre, número de WhatsApp (columna `ID_Telegram`, heredada de la versión anterior), rol, estatus |
| `CLIENTES` | Dirección, link de Maps, descripción del servicio, instrucciones por cliente |
| `SITIOS` | Coordenadas GPS y radio de tolerancia por cliente, para el geofencing |
| `PROGRAMACION_DIARIA` | El corazón del sistema — un renglón por servicio programado, con columnas para programación, confirmación, check-in y (pendiente) cierre |
| `REGISTRO_TURNOS` | Bitácora de auditoría de cada check-in, nunca se edita manualmente |

---

## 8. Costos mensuales estimados

| Servicio | Costo | Nota |
|---|---|---|
| Twilio (WhatsApp) | ~$1–5 USD | Depende de cuántos mensajes inicia el negocio (no el empleado) |
| Google Sheets API | $0 | Gratuito, sin capa de pago |
| Render (Starter recomendado) | $7 USD/mes | El plan gratis "duerme" tras 15 min sin uso — no recomendado para producción real |

---

## 9. Pendiente de construir

- **Cierre de servicio** (checklist de tareas, insumos faltantes, comentario, fotos) — decidido hacerlo con **AppSheet** en vez de conversación por WhatsApp, para evitar la complejidad de manejar "memoria de conversación" en el servidor.
- **`/queja` y `/duda`** — reportes urgentes del empleado, unificados en una sola hoja `QUEJAS` diferenciada por columna `Tipo`.
- **`/aviso`** — solo Will, mensaje puntual a un empleado en medio de un servicio, con confirmación de "recibido".
- **Inspecciones de calidad** — se decidió modelarlas como un servicio más dentro de `PROGRAMACION_DIARIA` (con `Tipo_Servicio = Inspección`), reutilizando el mismo camino de programación y check-in que la limpieza normal.
- **Tablero de control** — una pestaña `RESUMEN_HOY` en el propio Sheets con fórmulas `QUERY`, en vez de una página web aparte.
- Migrar de Sandbox de Twilio a un número de **WhatsApp Business verificado** (requiere completar verificación con Meta).

---

## 10. Cómo hacer cambios de aquí en adelante

1. Editar el archivo correspondiente (`index.js`, `logica.js` o `sheets.js`) localmente o directo en GitHub.
2. Subir el cambio a la rama `main` del repositorio.
3. Render redespliega automáticamente al detectar el cambio (no hace falta ningún paso manual, a diferencia de Apps Script).
4. Revisar la pestaña "Logs" del servicio en Render para confirmar que el despliegue fue exitoso y no hay errores.
