# Arquitectura — Sistema Tampa Cleaning

**Última actualización:** 2 de octubre de 2026
**Propósito de este documento:** referencia técnica para entender cómo funciona el sistema, qué piezas lo componen y cómo se conectan.

---

## 1. Resumen en una frase

Los empleados de Tampa Cleaning interactúan por **WhatsApp** para registrar su ubicación (check-in), confirmar su programación diaria y reportar novedades. Un **servidor propio en Node.js** (hosteado en Render) procesa esos mensajes, valida la información contra **Google Sheets** (que funciona como base de datos central), y notifica a gerencia por WhatsApp cuando algo requiere atención. El cierre de cada servicio (checklist, insumos, comentario — o la evaluación por áreas, si el servicio es una inspección de calidad) se completa en una **página web propia**, generada por el mismo servidor — no se usa ninguna herramienta externa de formularios.

---

## 2. Historial de decisiones de arquitectura

1. **Versión inicial (abandonada):** Telegram + Google Apps Script. Se abandonó por fallas persistentes e imposibles de diagnosticar bien (errores 302 intermitentes, URLs de webhook que se corrompían, reintentos infinitos, logs insuficientes).
2. **Segunda versión:** WhatsApp (vía Twilio) + servidor propio en Render — resolvió la inestabilidad. Para el cierre de servicio se probó **AppSheet** (Google), pero se abandonó tras acumular demasiada fricción de configuración (vistas duplicadas, columnas que se ocultaban solas, nombres que dejaban de coincidir, interfaz con menús que el empleado no necesitaba).
3. **Versión actual:** el cierre de servicio se resuelve con una **página HTML generada por el propio servidor** — mismo patrón que todo lo demás, sin depender de configuración externa.

---

## 3. Componentes del sistema

| Componente | Rol | Dónde vive |
|---|---|---|
| **WhatsApp** | Interfaz que usan los empleados y gerencia | App de WhatsApp de cada persona |
| **Twilio** | Traduce entre WhatsApp y el servidor (recibe mensajes entrantes, envía salientes) | Cuenta en twilio.com — actualmente en modo **Sandbox** (pendiente migrar a número verificado) |
| **Servidor Node.js** | Toda la lógica de negocio y las páginas web del sistema | Hosteado en Render.com (`tampa-cleaning-servidor.onrender.com`), código en GitHub |
| **Google Sheets** | Base de datos central | `Tampa_Cleaning_BUILD` (Google Drive) |
| **Google Cloud (cuenta de servicio)** | Permite que el servidor lea/escriba en Sheets sin intervención humana | Proyecto `tampa-cleaning-509423` |

---

## 4. Estructura del código (repositorio en GitHub)

```
tampa-cleaning-servidor/
├── index.js       → Rutas HTTP: webhook de Twilio, programación diaria, formulario de cierre / inspección
├── logica.js       → Toda la lógica de negocio
├── sheets.js       → Módulo genérico de lectura/escritura a Google Sheets
├── package.json    → Dependencias: express, googleapis, twilio
├── CLAUDE.md       → Guía para Claude Code (resumen técnico del repositorio)
└── Arquitectura_Tampa_Cleaning.md → Este documento
```

---

## 5. Variables de entorno (en Render, nunca en el código)

| Variable | Para qué sirve |
|---|---|
| `GOOGLE_CLIENT_EMAIL` | Identifica la cuenta de servicio de Google |
| `GOOGLE_PRIVATE_KEY` | Clave privada de esa cuenta de servicio |
| `TWILIO_ACCOUNT_SID` | Identifica la cuenta de Twilio |
| `TWILIO_AUTH_TOKEN` | Autentica las llamadas a la API de Twilio |
| `CLAVE_ADMIN` | Protege la ruta `/enviar-programacion` |

**Pendiente de seguridad:** la clave privada de Google y el Auth Token de Twilio se compartieron en el chat de esta conversación en algún momento durante la configuración — conviene regenerar ambas credenciales cuando haya tiempo (Google Cloud Console y Twilio Console, respectivamente, tienen un botón para esto sin romper nada más).

---

## 6. Flujos implementados

### 6.1 Check-in con geofencing (entrada/salida automática)
El empleado comparte ubicación por WhatsApp. El servidor identifica al empleado por su número de teléfono (columna `ID_Telegram` en `EMPLEADOS`, heredada de la versión anterior), busca su servicio de hoy en `PROGRAMACION_DIARIA`, y decide solo si es "Entrada" o "Salida" según lo que ya esté registrado ese día. Calcula la distancia contra `SITIOS` (fórmula de Haversine) y guarda todo en `REGISTRO_TURNOS` y en la fila del día en `PROGRAMACION_DIARIA`.

**Detección de anomalías:** compara cada check-in contra el anterior del mismo empleado — coordenadas idénticas o velocidad implícita imposible (>150 km/h) disparan una alerta a gerencia, sin que el empleado se entere.

### 6.2 Programación diaria y confirmación
Se llena manualmente una fila en `PROGRAMACION_DIARIA` para el día siguiente. Visitando `https://tampa-cleaning-servidor.onrender.com/enviar-programacion?clave=...` se dispara el envío por WhatsApp a cada empleado con servicio pendiente. El empleado responde **"Ok"**, **"Confirmo"** o **"No puedo"** — el servidor encuentra sola la fila pendiente de ese empleado (sin necesitar que mencione el cliente).

### 6.3 Cierre de servicio (formulario propio, sin AppSheet)
Al marcar la salida, el servidor manda un link a `GET /cierre?id=...` — una página HTML que el propio servidor genera al vuelo. Si el servicio es de limpieza (cualquier `Tipo_Servicio` distinto de `Inspeccion`, o vacío), el formulario contiene:
- Muestra los datos de solo lectura del cliente (dirección, instrucciones).
- Checklist de tareas, tomado de `SITIOS.Checklist_Tareas`, con cada tarea ya marcada como completada (el empleado desmarca solo lo que no alcanzó a hacer).
- Lista de insumos comunes (`INSUMOS_COMUNES`, definida en el código) para marcar los que faltan, más un campo de texto libre para "otro insumo".
- Comentario libre.

Al enviarse (`POST /cierre`), el servidor calcula automáticamente qué tareas quedaron pendientes (las que no quedaron marcadas), guarda todo en `PROGRAMACION_DIARIA`, marca `Servicio_Finalizado = Sí`, y notifica a gerencia con el resumen completo.

**Protección contra reenvío:** si el link se abre después de que el cierre ya fue enviado, se muestra un aviso ("⚠️ Este servicio ya fue cerrado") en vez del formulario — y aunque alguien lograra enviarlo dos veces, el servidor verifica de nuevo antes de guardar y no sobrescribe la información.

*Nota: por ahora no se capturan fotos — se dejó fuera a propósito para simplificar, mientras se valida el resto del flujo. Se puede agregar más adelante conectando la API de Google Drive.*

### 6.4 Inspecciones de calidad
Una inspección se programa como **un servicio más** en `PROGRAMACION_DIARIA`: misma fila, mismo flujo de programación, confirmación y check-in, pero con `Tipo_Servicio = Inspeccion` y el supervisor en la columna `Empleado`. Al marcar la salida recibe el mismo link `/cierre?id=...`, pero el servidor detecta el tipo de servicio y muestra el **formulario de inspección** en lugar del de limpieza:
- Evaluación por área — cada área de `AREAS_INSPECCION` (definida en el código: Limpieza general, Uso de productos, Atención a instrucciones del cliente, Orden y organización, Seguridad y EPP) se califica como **Cumple** (marcado por defecto), **Cumple con observaciones** o **No cumple**.
- Hallazgos (texto libre).
- ¿Requiere acción correctiva? (Sí / No).

Al enviarse (`POST /cierre`), el servidor guarda en la fila de `PROGRAMACION_DIARIA`:
- `Resultado_Inspeccion` — resumen de todas las áreas (`Área: resultado; ...`)
- `Requiere_Accion_Correctiva` — Sí / No
- `Estado_Correccion` — `Pendiente` si requiere acción correctiva, vacío si no
- `Comentario_Empleado` — los hallazgos
- `Servicio_Finalizado = Sí`

Y notifica a gerencia: 🔴 **urgente** si alguna área quedó en "No cumple" o se marcó que requiere acción correctiva; ✅ **rutina** en cualquier otro caso. Tiene la misma protección contra reenvío que el cierre de limpieza.

### 6.5 Quejas y dudas
El empleado escribe un mensaje que contenga la palabra "queja" o "duda" en cualquier parte del texto (no hace falta que vaya al principio). El mensaje completo se guarda en la hoja `QUEJAS` (diferenciadas por columna `Tipo`), identificando automáticamente el servicio del día del empleado. Si viene con una foto adjunta en el mismo mensaje, el link queda guardado en `Foto_Soporte`.

### 6.6 Aviso en tiempo real
Solo **Will**, escribiendo `aviso [Cliente]: [mensaje]` desde su número personal, puede mandarle un aviso puntual al empleado que tenga ese cliente asignado hoy. El empleado responde **"Recibido"** para confirmar, lo que notifica de vuelta a gerencia.

### 6.7 Notificaciones a gerencia (`notificarGerencia`)
Función centralizada, con tres niveles de prioridad visual:
- 🔴 **urgente** — check-in fuera de rango, sin servicio asignado, "No puedo" a un servicio, posible ubicación falsa, queja, confirmación de aviso no recibida a tiempo, inspección con algún "No cumple" o que requiere acción correctiva
- 🟡 **atención** — problemas de configuración (ej. empleado sin número registrado), consultas/dudas
- ✅ **rutina** — confirmaciones de envío exitoso, cierre de servicio completado, inspección sin hallazgos graves

---

## 7. Estructura de las hojas de Google Sheets relevantes

| Hoja | Contiene |
|---|---|
| `EMPLEADOS` | Nombre, número de WhatsApp (columna `ID_Telegram`, heredada), rol, estatus |
| `CLIENTES` | Dirección, link de Maps, descripción del servicio, instrucciones por cliente |
| `SITIOS` | Coordenadas GPS y radio de tolerancia para geofencing, y `Checklist_Tareas` (lista separada por comas) para el formulario de cierre |
| `PROGRAMACION_DIARIA` | El corazón del sistema — un renglón por servicio, con columnas para programación, confirmación, check-in, y cierre. `Tipo_Servicio` distingue limpieza de `Inspeccion`; las inspecciones usan además `Resultado_Inspeccion`, `Requiere_Accion_Correctiva` y `Estado_Correccion` (todas opcionales — si la columna no existe, el servidor simplemente no la escribe) |
| `REGISTRO_TURNOS` | Bitácora de auditoría de cada check-in |
| `QUEJAS` | Quejas y dudas, diferenciadas por columna `Tipo` |

---

## 8. Costos mensuales estimados

| Servicio | Costo | Nota |
|---|---|---|
| Twilio (WhatsApp) | ~$1–5 USD | Depende de cuántos mensajes inicia el negocio (no el empleado) |
| Google Sheets API | $0 | Gratuito |
| Render (Starter recomendado) | $7 USD/mes | El plan gratis "duerme" tras 15 min sin uso — no recomendado para producción real |

---

## 9. Pendiente de construir

- **Fotos en el cierre de servicio** — requiere conectar la API de Google Drive.
- **`/aviso` desde un grupo** en vez de solo el chat personal de Will (decidido dejarlo así por ahora, simple).
- **Migrar de Sandbox de Twilio a WhatsApp Business verificado** — el Sandbox requiere reconectar cada cierto tiempo (las sesiones caducan) y tiene límites de mensajes de prueba; no apto para producción real.
- **Regenerar credenciales** compartidas durante la configuración (ver sección 5).
- **Tablero de control** (`RESUMEN_HOY`) — pestaña en el propio Sheets con fórmulas `QUERY`, aún no construida.
- **Seguimiento de acciones correctivas** — las inspecciones dejan `Estado_Correccion = Pendiente`, pero aún no hay flujo para marcarlas como resueltas ni recordatorios (por ahora se actualiza a mano en el Sheets).

---

## 10. Cómo hacer cambios de aquí en adelante

1. Editar el archivo correspondiente (`index.js`, `logica.js` o `sheets.js`) local o directo en GitHub.
2. Subir el cambio a la rama `main` del repositorio.
3. Render redespliega automáticamente al detectar el cambio.
4. Revisar la pestaña "Logs" del servicio en Render para confirmar que el despliegue fue exitoso.

**Importante:** siempre usar "Nueva versión" al reimplementar cambios que dependan de configuración externa — con Render esto es automático, no aplica el mismo cuidado que sí hacía falta con Apps Script.
