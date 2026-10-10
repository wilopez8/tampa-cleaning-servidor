# Arquitectura — Sistema Tampa Cleaning

**Última actualización:** 9 de octubre de 2026
**Propósito de este documento:** referencia técnica para entender cómo funciona el sistema, qué piezas lo componen y cómo se conectan.

---

## 1. Resumen en una frase

Los empleados de Tampa Cleaning interactúan por **WhatsApp** para registrar su ubicación (check-in), confirmar su programación y reportar novedades. Un **servidor propio en Node.js** (hosteado en Render) procesa esos mensajes, valida la información contra **Google Sheets** (que funciona como base de datos central), y notifica a gerencia por WhatsApp cuando algo requiere atención. El cierre de cada servicio (checklist, insumos, comentario — o la evaluación por áreas, si el servicio es una inspección de calidad) se completa en una **página web propia**, generada por el mismo servidor — no se usa ninguna herramienta externa de formularios. Los administradores programan, editan, reasignan y cancelan servicios desde una **agenda web** protegida con clave (`/agenda`), también generada por el servidor. Desde esa misma sesión asignan **pendientes** (tareas sueltas como acciones correctivas o diligencias) que el empleado recibe por WhatsApp y cierra respondiendo "Ok".

---

## 2. Historial de decisiones de arquitectura

1. **Versión inicial (abandonada):** Telegram + Google Apps Script. Se abandonó por fallas persistentes e imposibles de diagnosticar bien (errores 302 intermitentes, URLs de webhook que se corrompían, reintentos infinitos, logs insuficientes).
2. **Segunda versión:** WhatsApp (vía Twilio) + servidor propio en Render — resolvió la inestabilidad. Para el cierre de servicio se probó **AppSheet** (Google), pero se abandonó tras acumular demasiada fricción de configuración (vistas duplicadas, columnas que se ocultaban solas, nombres que dejaban de coincidir, interfaz con menús que el empleado no necesitaba).
3. **Cierre de servicio propio:** el cierre se resuelve con una **página HTML generada por el propio servidor** — mismo patrón que todo lo demás, sin depender de configuración externa.
4. **Versión actual — agenda de administración:** la programación ya no se llena a mano en el Sheets. Se agregó un panel web (`/agenda`) con inicio de sesión por administrador, validaciones antes de guardar, envío por WhatsApp desde el mismo panel y registro de todo cambio hecho después de enviar. Mismo principio: HTML generado por el servidor, sin frameworks ni herramientas externas.
5. **Pendientes y registro retroactivo:** se agregó un módulo de **pendientes** (tareas fuera de la programación diaria, con seguimiento por WhatsApp) para cubrir, entre otras cosas, el seguimiento de acciones correctivas de las inspecciones. Las fechas pasadas de la agenda dejaron de ser de solo lectura: ahora admiten **registro retroactivo** (con motivo obligatorio, marcado y sin enviar WhatsApp).

---

## 3. Componentes del sistema

| Componente | Rol | Dónde vive |
|---|---|---|
| **WhatsApp** | Interfaz que usan los empleados y gerencia | App de WhatsApp de cada persona |
| **Twilio** | Traduce entre WhatsApp y el servidor (recibe mensajes entrantes, envía salientes) | Cuenta en twilio.com — actualmente en modo **Sandbox** (pendiente migrar a número verificado) |
| **Servidor Node.js** | Toda la lógica de negocio y las páginas web del sistema (formulario de cierre, login, agenda, pendientes) | Hosteado en Render.com (`tampa-cleaning-servidor.onrender.com`), código en GitHub |
| **Google Sheets** | Base de datos central | `Tampa_Cleaning_BUILD` (Google Drive) |
| **Google Cloud (cuenta de servicio)** | Permite que el servidor lea/escriba en Sheets sin intervención humana | Proyecto `tampa-cleaning-509423` |

---

## 4. Estructura del código (repositorio en GitHub)

```
tampa-cleaning-servidor/
├── index.js       → Rutas HTTP: webhook de Twilio, programación, formulario de cierre / inspección, login, agenda, pendientes
├── logica.js      → Lógica de negocio de WhatsApp: check-in, envío de programación, confirmaciones, avisos de cambio, cierre
├── auth.js        → Inicio de sesión de administradores (claves, cookie firmada, bloqueo por intentos fallidos)
├── agenda.js      → Página /agenda: vista semanal/diaria, filtros, "línea de vida" de cada servicio, franja de pendientes del día
├── edicion.js     → Editor de la agenda: validaciones, crear/editar/reasignar, cancelar, guardar y enviar, registro retroactivo
├── pendientes.js  → Pendientes: página /pendientes, envío y recordatorios por WhatsApp, respuestas "Ok"/"Pendiente", página del empleado
├── sheets.js      → Módulo genérico de lectura/escritura a Google Sheets (con caché corta opcional)
├── package.json   → Dependencias: express, googleapis, twilio (el login usa `crypto`, incluido en Node)
├── CLAUDE.md      → Guía para Claude Code (resumen técnico del repositorio)
└── Arquitectura_Tampa_Cleaning.md → Este documento
```

### 4.1 Rutas HTTP

| Ruta | Protección | Para qué |
|---|---|---|
| `POST /webhook` | — (Twilio) | Mensajes entrantes de WhatsApp |
| `GET /enviar-programacion?clave=` | `CLAVE_ADMIN` | Enlace antiguo: envía los Borrador de **mañana** (se mantiene por compatibilidad) |
| `GET/POST /cierre?id=` | — (link único por servicio) | Formulario de cierre / inspección |
| `GET/POST /login`, `GET /logout` | — | Inicio y cierre de sesión de administradores |
| `GET /agenda?fecha=&cliente=&empleado=&estado=&tipo=` | Sesión | Agenda (HTML) |
| `POST /agenda/guardar` | Sesión | Valida (`soloValidar`) o guarda filas del editor (JSON). En fechas pasadas exige `motivo` |
| `POST /agenda/enviar` | Sesión | Guarda la grilla y envía por WhatsApp todos los Borrador de la fecha |
| `POST /agenda/cancelar` | Sesión | Cancela un servicio con motivo |
| `POST /actualizar-cache` | Sesión | Botón "Actualizar" de la agenda: descarta la caché de lectura |
| `GET /pendientes?responsable=&estado=&tipo=&vencidos=1` | Sesión | Lista de pendientes + grilla para crear nuevos (por defecto muestra solo los `Abierto`) |
| `POST /pendientes/guardar` | Sesión | Crea pendientes en Borrador; con `enviar` además los envía, con `soloEnviar` solo envía los Borrador existentes |
| `POST /pendientes/cerrar` | Sesión | Marca un pendiente como Resuelto (nota opcional) |
| `POST /pendientes/cancelar` | Sesión | Cancela un pendiente con motivo |
| `POST /pendientes/recordar` | Sesión | Reenvía recordatorio de un pendiente (`id`) o de todos los abiertos de un empleado (`responsable`) |
| `GET/POST /pendiente?id=` | — (link único por pendiente) | Página del empleado para marcar el pendiente como resuelto o "sigue pendiente" |
| `GET /test-sheets` | — | Prueba de conexión con Sheets |

### 4.2 Caché de lectura (`sheets.js`)

`leerHoja(nombre)` sigue leyendo en vivo por defecto. Con `leerHoja(nombre, { cache: true })` devuelve datos de hasta **45 segundos** — lo usa solo la vista de la agenda para no releer el Sheets en cada clic. Toda escritura (`agregarFila`, `agregarFilas`, `actualizarCelda`, `actualizarCeldas`) invalida la caché de esa hoja. Las operaciones que **escriben** (guardar, cancelar, enviar) siempre releen en vivo antes de validar. La caché vive en memoria del proceso: se pierde al redesplegar, sin consecuencias.

Funciones nuevas en `sheets.js`: `actualizarCeldas` (varias celdas en una sola llamada), `agregarFilas` (varias filas a la vez), `asegurarHoja` (crea una pestaña con encabezados si no existe), `invalidarCache`, `edadCacheSegundos`.

---

## 5. Variables de entorno (en Render, nunca en el código)

| Variable | Para qué sirve |
|---|---|
| `GOOGLE_CLIENT_EMAIL` | Identifica la cuenta de servicio de Google |
| `GOOGLE_PRIVATE_KEY` | Clave privada de esa cuenta de servicio |
| `TWILIO_ACCOUNT_SID` | Identifica la cuenta de Twilio |
| `TWILIO_AUTH_TOKEN` | Autentica las llamadas a la API de Twilio |
| `CLAVE_ADMIN` | Protege la ruta antigua `/enviar-programacion` |
| `CLAVE_ADMIN_1` … `CLAVE_ADMIN_4` | Clave personal de cada administrador para entrar a la agenda (1 = Wilmar Lopez, 2 = Carolina Gallego, 3 = Andres Madrid, 4 = Claudia Lopez). El orden es fijo y las cuatro deben ser distintas. Si una no está definida, ese administrador simplemente no puede entrar |
| `SESSION_SECRET` | Firma las cookies de sesión. **Obligatoria, mínimo 32 caracteres** — sin ella el login falla. Cambiarla cierra la sesión de todos |

**Pendiente de seguridad:** la clave privada de Google y el Auth Token de Twilio se compartieron en el chat de esta conversación en algún momento durante la configuración — conviene regenerar ambas credenciales cuando haya tiempo (Google Cloud Console y Twilio Console, respectivamente, tienen un botón para esto sin romper nada más).

---

## 6. Flujos implementados

### 6.1 Check-in con geofencing (entrada/salida automática)
El empleado comparte ubicación por WhatsApp. El servidor identifica al empleado por su número de teléfono (columna `ID_Telegram` en `EMPLEADOS`, heredada de la versión anterior), busca su servicio de hoy en `PROGRAMACION_DIARIA` (ignorando los servicios con `Cancelado = Sí`), y decide solo si es "Entrada" o "Salida" según lo que ya esté registrado ese día. Calcula la distancia contra `SITIOS` (fórmula de Haversine) y guarda todo en `REGISTRO_TURNOS` y en la fila del día en `PROGRAMACION_DIARIA`.

**Detección de anomalías:** compara cada check-in contra el anterior del mismo empleado — coordenadas idénticas o velocidad implícita imposible (>150 km/h) disparan una alerta a gerencia, sin que el empleado se entere.

### 6.2 Programación y confirmación
La programación se crea desde la **agenda** (ver 6.8): los servicios nuevos quedan en `Estado_Envio = Borrador` y se envían con el botón **"Guardar y enviar al equipo"**. Se puede programar y enviar cualquier fecha de hoy en adelante, no solo mañana.

El envío (`enviarProgramacionFecha`) lee el Sheets en vivo, toma todos los servicios de esa fecha que no estén enviados ni cancelados (ni marcados `Estado_Envio = No aplica`, que es como quedan los registros retroactivos), y manda a cada empleado su mensaje. El título se adapta a la fecha ("para HOY", "para mañana" o "para el DD/MM/AAAA"). Si la fila de `PROGRAMACION_DIARIA` no trae dirección, link de Maps, descripción o instrucciones, se toman **en vivo de `CLIENTES`**. Los empleados sin número quedan listados y los envíos fallidos **siguen en Borrador** para reintentar; ambos casos se avisan a gerencia (🟡) y se muestran en pantalla al administrador.

El enlace antiguo `https://tampa-cleaning-servidor.onrender.com/enviar-programacion?clave=...` sigue funcionando: hace lo mismo para la fecha de mañana.

El empleado responde **"Ok"**, **"Confirmo"** o **"No puedo"** — el servidor encuentra sola la fila pendiente de ese empleado (sin necesitar que mencione el cliente). Solo se consideran filas **ya enviadas**, **no canceladas** y con fecha **de hoy en adelante**, para que una respuesta no confirme por error un borrador o un servicio viejo.

### 6.3 Cierre de servicio (formulario propio, sin AppSheet)
Al marcar la salida, el servidor manda un link a `GET /cierre?id=...` — una página HTML que el propio servidor genera al vuelo. Si el servicio es de limpieza (cualquier `Tipo_Servicio` distinto de `Inspeccion`, o vacío), el formulario contiene:
- Muestra los datos de solo lectura del cliente (dirección, instrucciones — si la fila no los trae, se toman en vivo de `CLIENTES`).
- Checklist de tareas, tomado de `SITIOS.Checklist_Tareas`, con cada tarea ya marcada como completada (el empleado desmarca solo lo que no alcanzó a hacer).
- Lista de insumos comunes (`INSUMOS_COMUNES`, definida en el código) para marcar los que faltan, más un campo de texto libre para "otro insumo".
- Comentario libre.

Al enviarse (`POST /cierre`), el servidor calcula automáticamente qué tareas quedaron pendientes (las que no quedaron marcadas), guarda todo en `PROGRAMACION_DIARIA`, marca `Servicio_Finalizado = Sí`, y notifica a gerencia con el resumen completo.

**Protección contra reenvío:** si el link se abre después de que el cierre ya fue enviado, se muestra un aviso ("⚠️ Este servicio ya fue cerrado") en vez del formulario — y aunque alguien lograra enviarlo dos veces, el servidor verifica de nuevo antes de guardar y no sobrescribe la información.

*Nota: por ahora no se capturan fotos — se dejó fuera a propósito para simplificar, mientras se valida el resto del flujo. Se puede agregar más adelante conectando la API de Google Drive.*

### 6.4 Inspecciones de calidad
Una inspección se programa como **un servicio más** en `PROGRAMACION_DIARIA` (desde la agenda, con Tipo = `Inspeccion`): misma fila, mismo flujo de programación, confirmación y check-in, pero con el supervisor en la columna `Empleado`. Al marcar la salida recibe el mismo link `/cierre?id=...`, pero el servidor detecta el tipo de servicio y muestra el **formulario de inspección** en lugar del de limpieza:
- Evaluación por área — cada área de `AREAS_INSPECCION` (definida en el código: Limpieza general, Uso de productos, Atención a instrucciones del cliente, Orden y organización, Seguridad y EPP) se califica como **Cumple** (marcado por defecto), **Cumple con observaciones** o **No cumple**.
- Hallazgos (texto libre).
- ¿Requiere acción correctiva? (Sí / No).

Al enviarse (`POST /cierre`), el servidor guarda en la fila de `PROGRAMACION_DIARIA`:
- `Resultado_Inspeccion` — resumen de todas las áreas (`Área: resultado; ...`)
- `Requiere_Accion_Correctiva` — Sí / No
- `Estado_Correccion` — `Pendiente` si requiere acción correctiva, vacío si no
- `Comentario_Empleado` — los hallazgos
- `Servicio_Finalizado = Sí`

Y notifica a gerencia: 🔴 **urgente** si alguna área quedó en "No cumple" o se marcó que requiere acción correctiva; ✅ **rutina** en cualquier otro caso. Si requiere acción correctiva, el mensaje incluye el enlace a `/pendientes` y el ID del servicio, para que el administrador cree un pendiente vinculado (ver 6.9). Tiene la misma protección contra reenvío que el cierre de limpieza.

### 6.5 Quejas y dudas
El empleado escribe un mensaje que contenga la palabra "queja" o "duda" en cualquier parte del texto (no hace falta que vaya al principio). El mensaje completo se guarda en la hoja `QUEJAS` (diferenciadas por columna `Tipo`), identificando automáticamente el servicio del día del empleado. Si viene con una foto adjunta en el mismo mensaje, el link queda guardado en `Foto_Soporte`. Las quejas asociadas a un servicio se ven en su detalle dentro de la agenda.

### 6.6 Aviso en tiempo real
Solo **Will**, escribiendo `aviso [Cliente]: [mensaje]` desde su número personal, puede mandarle un aviso puntual al empleado que tenga ese cliente asignado hoy. El empleado responde **"Recibido"** para confirmar, lo que notifica de vuelta a gerencia.

### 6.7 Notificaciones a gerencia (`notificarGerencia`)
Función centralizada, con tres niveles de prioridad visual:
- 🔴 **urgente** — check-in fuera de rango, sin servicio asignado, "No puedo" a un servicio, posible ubicación falsa, queja, confirmación de aviso no recibida a tiempo, inspección con algún "No cumple" o que requiere acción correctiva, **no se pudo avisar a un empleado de un cambio o cancelación** de un servicio ya enviado
- 🟡 **atención** — problemas de configuración (ej. empleado sin número registrado al enviar la programación o un pendiente), envíos de programación o de pendientes fallidos (siguen en Borrador), consultas/dudas
- ✅ **rutina** — programación enviada (indica qué administrador la envió), cierre de servicio completado, inspección sin hallazgos graves, pendientes/recordatorios enviados, pendiente resuelto o que "sigue abierto" (con la nota del empleado)

### 6.8 Agenda de administración (`/agenda`)

**Acceso (`auth.js`).** Cada administrador entra en `/login` con su clave personal (`CLAVE_ADMIN_1..4`); la clave identifica quién es, y ese nombre queda registrado en todo lo que haga (`Creado_Por`, `Modificado_Por`, `CAMBIOS_PROGRAMACION`). La sesión es una cookie firmada con HMAC (`SESSION_SECRET`), `HttpOnly` + `Secure`, válida **12 horas**. Tras **5 claves incorrectas** desde la misma IP, el login se bloquea **15 minutos** (este contador vive en memoria: se reinicia con cada despliegue). Las comparaciones de clave son de tiempo constante. Si la sesión vence, las páginas redirigen al login y luego regresan a donde estaba el administrador.

**Vista (`agenda.js`).**
- Tira semanal (lunes a domingo) con número de servicios por día y un punto de color: 🟢 todo finalizado, 🟡 pendiente, 🔴 alerta (algún "No puede", acción correctiva pendiente, o un día pasado con servicios sin finalizar), gris sin servicios.
- Navegación por día (←, Hoy, →, selector de fecha) y filtros por cliente, empleado, estado y tipo. Enlace a **Pendientes** en la cabecera.
- Cada servicio muestra un **estado calculado** a partir de sus columnas: Borrador → Enviado → Confirmado / No puede → En curso → Salida (falta cierre) → Finalizado, o Cancelado. Marcas adicionales: **Retroactivo** (con el motivo al pasar el mouse), ✍️ si las horas reales se escribieron a mano (`Origen_Registro = Manual`), 👥N si varios empleados atienden el mismo cliente y tipo ese día (equipo).
- ⚠️ **Acción pendiente:** si el servicio tiene pendientes vinculados (`PENDIENTES.ID_Programacion`), se marca mientras alguno siga `Abierto`. Si no tiene ninguno, se usa el criterio antiguo (`Requiere_Accion_Correctiva = Sí` y `Estado_Correccion = Pendiente`).
- **Franja de pendientes:** debajo del editor se listan los pendientes abiertos cuya fecha límite es la del día mostrado; si el día mostrado es hoy, también los **vencidos**.
- **"Detalle" (línea de vida):** todo lo que se sabe del servicio en un solo lugar — programación (con quién lo creó/modificó, cancelación, retroactivo y origen del registro), envío y confirmación, entrada, salida, cierre, inspección, avisos, cambios posteriores al envío (de `CAMBIOS_PROGRAMACION`), pendientes vinculados y quejas/dudas asociadas.
- Usa la caché de 45 s; la pantalla indica la antigüedad de los datos y el botón **"Actualizar"** fuerza una lectura nueva.

**Edición (`edicion.js`).** Para hoy y fechas futuras aparece una grilla "Programar servicios" (para fechas pasadas, ver *Registro retroactivo* más abajo):
- Cada fila: Tipo (Limpieza / Inspeccion), Cliente, Empleado, Hora inicio – Hora fin, Observaciones del día. Al seleccionar un cliente se muestra su dirección, instrucciones, checklist y si tiene coordenadas.
- Solo se ofrecen **clientes activos** (`Cliente Vigente` en `CLIENTES` **y** `Activo` en `SITIOS`) y **empleados activos** (`Estatus = Activo` en `EMPLEADOS`).
- **Validación en vivo** (mientras se escribe) y otra vez al guardar: cliente activo y con coordenadas, empleado activo y con WhatsApp, horas válidas y fin posterior al inicio, el mismo **empleado** no puede estar dos veces en el mismo cliente con el mismo tipo el mismo día, y un empleado no puede tener **horarios cruzados**. Varios empleados distintos **sí** pueden ir al mismo cliente el mismo día (servicio en equipo: una fila por empleado). Si una fila falla, no se guarda nada del lote.
- Los servicios nuevos reciben un ID `PRG-AAAAMMDD-NN` (consecutivo por fecha) y quedan en **Borrador** con `Estado_Confirmacion = Pendiente`. `Horario` se llena solo a partir de las horas (ej. `8:00-12:00`).
- **Editar / Reasignar / Cancelar** desde la tabla. "Reasignar" abre la fila con solo el empleado editable. Un servicio **ya iniciado** (con hora de entrada) no se puede cancelar ni cambiar — solo sus observaciones.
- **Cancelar** pide un motivo obligatorio. La fila **nunca se borra**: queda `Cancelado = Sí` + `Motivo_Cancelacion`. Los servicios cancelados se ignoran en check-in, confirmación y envío.
- Las escrituras se hacen **una tras otra** (cola en memoria), para que dos administradores guardando a la vez no generen el mismo ID. Máximo 60 filas por operación.

**Cambios después de enviar.** Si un servicio ya enviado cambia de empleado, cliente, horario o tipo, el servidor:
1. Vuelve a dejar `Estado_Confirmacion = Pendiente` (borra la confirmación anterior y el motivo de "No puedo").
2. Avisa por WhatsApp: si cambió el empleado, el anterior recibe "ya no estás asignado/a" y el nuevo recibe la programación completa como "Nueva asignación"; si cambió cliente/horario/tipo, el empleado recibe el antes → después (con la nueva dirección si cambió el cliente) y se le pide confirmar de nuevo. Si se cancela, recibe "❌ Servicio cancelado".
3. Registra cada aviso en la hoja `CAMBIOS_PROGRAMACION`, con `Aviso_Enviado = Sí / Error`. Si un aviso falla, los cambios **igual quedan guardados**, se alerta a gerencia 🔴 y el administrador ve en pantalla a quién debe avisar directamente.

Cambiar solo las observaciones de un servicio enviado, o cancelar un borrador, **no** avisa al empleado, pero sí queda registrado en `CAMBIOS_PROGRAMACION`.

**Registro retroactivo (fechas pasadas).** Sirve para dejar constancia de servicios que no se registraron a tiempo (el empleado no hizo check-in, se olvidó programar, etc.). En una fecha pasada la grilla se llama "Registrar / corregir servicios" y cambia así:
- Aparece un campo **Motivo (obligatorio)**, de mínimo 3 caracteres; sin él no se guarda nada.
- Tres columnas extra: **Entrada real**, **Salida real** (hora) y **Finalizado** (casilla). Se valida que la salida sea posterior a la entrada.
- **Nunca se envía WhatsApp**: no hay botón "Guardar y enviar", y los cambios o cancelaciones no avisan al empleado.
- Se pueden editar servicios **ya iniciados** (incluidas sus horas reales) y cancelarlos.
- Si el cliente o el empleado de un servicio existente ya no está activo, se acepta siempre que no se haya cambiado.
- Los servicios nuevos quedan con `Estado_Envio = No aplica`, `Estado_Confirmacion = No aplica` y `Origen_Registro = Manual`. Toda fila creada o editada queda con `Registro_Retroactivo = Sí` y el `Motivo_Retroactivo`; si se tocaron las horas reales, `Origen_Registro = Manual`.
- Las horas reales se escriben en el **mismo formato que usa el check-in** (`10/9/2026, 5:11:00 PM`), para que el resto del sistema las lea igual.
- Cada cambio queda en `CAMBIOS_PROGRAMACION` como `Retroactivo (nuevo)`, `Retroactivo (edición)` (con el antes → después de cada campo) o `Cancelación retroactiva`, con `Aviso_Enviado = No (fecha pasada)`.
- Requiere en `PROGRAMACION_DIARIA` las columnas `Registro_Retroactivo`, `Motivo_Retroactivo`, `Origen_Registro`, `Hora_Entrada_Real`, `Hora_Salida_Real` y `Servicio_Finalizado`; si falta alguna, el guardado se rechaza indicando cuál.

### 6.9 Pendientes (`/pendientes`, `pendientes.js`)

Un **pendiente** es una tarea asignada a un empleado que no es un servicio de la programación diaria: una acción correctiva tras una inspección, una diligencia, una revisión de servicio u otra cosa. Vive en su propia hoja (`PENDIENTES`), no en `PROGRAMACION_DIARIA`.

**Creación (administrador).** En `/pendientes` hay una grilla "Nuevos pendientes" con: Tipo (`Acción correctiva`, `Diligencia`, `Revisión de servicio`, `Otro`), Título, Cliente (opcional), **ID de servicio** (opcional — vincula el pendiente a un `ID_Programacion`, que se valida que exista), Responsable, Fecha límite, Horario (opcional, exige fecha), Prioridad (`Baja`, `Normal`, `Alta`) y Observaciones. Se valida igual que la agenda: responsable activo y con WhatsApp, cliente activo, horas coherentes; si una fila falla no se guarda el lote. Los pendientes reciben un ID `PND-AAAAMMDD-NN` (consecutivo por **día de creación**) y quedan `Estado = Abierto`, `Estado_Envio = Borrador`.

**Envío.** "Guardar y enviar al equipo" manda **un WhatsApp independiente por cada pendiente** en Borrador, con el título, ID, tipo, cliente, fecha/horario, prioridad alta (❗) si aplica, observaciones, instrucciones de respuesta y un enlace `/pendiente?id=...`. El **SID** de cada mensaje de Twilio se guarda en `PENDIENTES_MENSAJES`, para reconocer luego a qué pendiente responde el empleado. Si el responsable no tiene número o el envío falla, el pendiente sigue en Borrador y se avisa a gerencia 🟡.

**Respuesta del empleado** — tres caminos:
1. **Reply (Responder) por WhatsApp** al mensaje del pendiente: Twilio envía `OriginalRepliedMessageSid`, el servidor lo busca en `PENDIENTES_MENSAJES` y verifica que quien responde sea el responsable. "**Ok**" o "**Listo**" (más un comentario opcional) lo marca **Resuelto**; "**Pendiente**" (más comentario) lo deja abierto y agrega el comentario a `Notas_Seguimiento`. Cualquier otro texto recibe las instrucciones.
2. **"Ok" sin Reply:** solo se acepta si el empleado tiene **un único** pendiente abierto y enviado; si tiene varios, se le pide responder con Reply al mensaje correcto.
3. **Enlace `/pendiente?id=`:** página con botones "✅ Marcar como resuelto" y "Sigue pendiente" + comentario. Si el pendiente ya no está abierto, muestra un aviso en vez del formulario.

Cada resolución o "sigue abierto" avisa a gerencia (✅ rutina) con la nota.

**Orden en el webhook.** La respuesta por Reply a un pendiente se evalúa **primero**, antes que la confirmación de programación. El "Ok" sin Reply se evalúa **después** de la confirmación de programación y del "Recibido" de avisos — así un "Ok" sigue confirmando la programación del día siguiente si hay una pendiente de confirmar. Orden completo: Reply a pendiente → confirmación de programación → "Recibido" → "Ok" sin Reply a pendiente → `aviso` → queja → duda → ubicación → ayuda.

**Seguimiento (administrador).** La lista se filtra por responsable, estado (por defecto solo `Abierto`), tipo y "solo vencidos" (abiertos con fecha límite anterior a hoy), y ordena los vencidos primero. Acciones por fila: **Resolver** (nota opcional), **Recordar** (reenvía el mensaje como "Recordatorio", solo si ya fue enviado), **Cancelar** (motivo obligatorio). Con un responsable filtrado aparece "Recordar los abiertos de …". Los recordatorios son **manuales** — no hay envío automático. Cada evento (creado, enviado, recordatorio, resuelto, sigue abierto, cancelado) queda en `PENDIENTES_HISTORIAL`.

Las escrituras de pendientes usan su propia cola en memoria (mismo patrón que la agenda). Las tres hojas de pendientes **se crean solas** con sus encabezados la primera vez que se usan.

---

## 7. Estructura de las hojas de Google Sheets relevantes

| Hoja | Contiene |
|---|---|
| `EMPLEADOS` | Nombre, número de WhatsApp (columna `ID_Telegram`, heredada), `Rol`, `Estatus` (solo los `Activo` aparecen en la agenda) |
| `CLIENTES` | Nombre (columna `clientes`), `Direccion`, `Google Maps`, `Descripcion_Servicio`, `Instrucciones`, `Cliente Vigente/Vencido`. Es la fuente **en vivo** de dirección/instrucciones cuando la fila de programación no las trae |
| `SITIOS` | `Nombre_Cliente`, coordenadas GPS (`Latitud`, `Longitud`) y radio de tolerancia para geofencing, `Checklist_Tareas` (lista separada por comas) para el formulario de cierre, `Estatus` |
| `PROGRAMACION_DIARIA` | El corazón del sistema — un renglón por servicio, con columnas para programación, confirmación, check-in, y cierre. `Tipo_Servicio` distingue limpieza de `Inspeccion`; las inspecciones usan además `Resultado_Inspeccion`, `Requiere_Accion_Correctiva` y `Estado_Correccion` (todas opcionales — si la columna no existe, el servidor simplemente no la escribe). Ver columnas de la agenda abajo |
| `REGISTRO_TURNOS` | Bitácora de auditoría de cada check-in |
| `QUEJAS` | Quejas y dudas, diferenciadas por columna `Tipo`, asociadas al servicio por `ID_Programacion` |
| `CAMBIOS_PROGRAMACION` | Bitácora de cambios hechos desde la agenda (incluidos los retroactivos): `Fecha_Hora`, `ID_Programacion`, `Fecha_Servicio`, `Tipo_Cambio`, `Detalle`, `Realizado_Por`, `Empleado_Notificado`, `Aviso_Enviado`. **El servidor la crea sola** (con encabezados) la primera vez que registra un cambio |
| `PENDIENTES` | **Nueva.** Un renglón por pendiente: `ID_Pendiente`, `Tipo`, `Titulo`, `Observaciones`, `Cliente`, `ID_Programacion` (servicio vinculado, opcional), `Responsable`, `Fecha_Limite`, `Hora_Inicio`, `Hora_Fin`, `Prioridad`, `Estado` (`Abierto` / `Resuelto` / `Cancelado`), `Estado_Envio` (`Borrador` / `Enviado`), `Creado_Por`, `Fecha_Creacion`, `Notas_Seguimiento`, `Fecha_Cierre`, `Cerrado_Por` (quién y por qué vía: WhatsApp, Enlace o Agenda web), `Nota_Cierre`, `Ultimo_Recordatorio`. Se escribe por nombre de columna. **Se crea sola** |
| `PENDIENTES_MENSAJES` | **Nueva.** Relaciona cada WhatsApp enviado con su pendiente: `SID`, `ID_Pendiente`, `Fecha_Hora`, `Tipo_Envio`. Es lo que permite reconocer una respuesta por Reply. **Se crea sola** |
| `PENDIENTES_HISTORIAL` | **Nueva.** Bitácora de eventos de cada pendiente: `Fecha_Hora`, `ID_Pendiente`, `Evento`, `Detalle`, `Realizado_Por`. **Se crea sola** |

**Columnas de `PROGRAMACION_DIARIA` que exige la agenda.** A diferencia del resto del sistema (donde las columnas son opcionales), la agenda **se niega a guardar** si falta alguna de estas: `ID_Programacion`, `Fecha_Servicio`, `Tipo_Servicio`, `Cliente`, `Empleado`, `Horario`, `Hora_Inicio`, `Hora_Fin`, `Observaciones_Puntuales`, `Estado_Envio`, `Estado_Confirmacion`, `Creado_Por`, `Fecha_Creacion`, `Modificado_Por`, `Fecha_Modificacion`, `Cancelado`, `Motivo_Cancelacion`. Las filas nuevas se escriben por **nombre de columna** (no por posición), así que el orden de las columnas puede cambiar sin romper nada.

**Columnas adicionales para el registro retroactivo:** `Registro_Retroactivo` (Sí / vacío), `Motivo_Retroactivo`, `Origen_Registro` (`Manual` cuando las horas reales las escribió un administrador). Solo se exigen al guardar en una fecha pasada. `PENDIENTES_MENSAJES` usa posiciones fijas (columna A = SID, B = ID_Pendiente) y `PENDIENTES_HISTORIAL` se escribe en orden fijo: no reordenar sus columnas.

---

## 8. Costos mensuales estimados

| Servicio | Costo | Nota |
|---|---|---|
| Twilio (WhatsApp) | ~$1–5 USD | Depende de cuántos mensajes inicia el negocio (no el empleado). Los avisos de cambio/cancelación, los pendientes y sus recordatorios suman mensajes salientes |
| Google Sheets API | $0 | Gratuito |
| Render (Starter recomendado) | $7 USD/mes | El plan gratis "duerme" tras 15 min sin uso — no recomendado para producción real |

---

## 9. Pendiente de construir

- **Fotos en el cierre de servicio** — requiere conectar la API de Google Drive.
- **`/aviso` desde un grupo** en vez de solo el chat personal de Will (decidido dejarlo así por ahora, simple).
- **Migrar de Sandbox de Twilio a WhatsApp Business verificado** — el Sandbox requiere reconectar cada cierto tiempo (las sesiones caducan) y tiene límites de mensajes de prueba; no apto para producción real.
- **Regenerar credenciales** compartidas durante la configuración (ver sección 5).
- **Tablero de control** (`RESUMEN_HOY`) — pestaña en el propio Sheets con fórmulas `QUERY`, aún no construida (la agenda cubre buena parte de esa necesidad).
- **Acciones correctivas → pendientes automáticos** — hoy el seguimiento se hace con pendientes (ver 6.9), pero el administrador los crea a mano a partir del aviso de la inspección. `Estado_Correccion` no se actualiza al resolver el pendiente; la agenda ya no lo necesita cuando hay pendientes vinculados, pero la columna queda desactualizada en el Sheets.
- **Recordatorios automáticos de pendientes** — por ahora solo existen los manuales (botón "Recordar"); no hay aviso automático de vencidos.
- **Retirar `CLAVE_ADMIN` y `/enviar-programacion`** una vez que todos usen la agenda para enviar.
- **Bloqueo de login y colas de escrituras en memoria** (agenda y pendientes) — funcionan porque hay una sola instancia del servidor; si algún día se escala a varias instancias, habría que moverlos a un almacenamiento compartido.

**Del mapa de problemas original** (los dolores que motivaron el sistema; aún sin resolver del todo):

- **Nómina: horas y millas automáticas** — el registro ya es atómico (cada check-in es una fila en `REGISTRO_TURNOS`, y las horas reales quedan en la fila del servicio), pero todavía no se calculan las horas trabajadas por empleado ni el millaje entre servicios; el millaje se sigue sacando a mano en Google Maps.
- **Historial de calidad al programar** — las quejas (`QUEJAS`) y las inspecciones solo se ven en el detalle de cada servicio. El objetivo original era ver el historial de quejas/observaciones **del cliente y del empleado** en el editor, al momento de programar.
- **Cobranza: servicios pendientes por cliente** — al registrar un pago no se ve qué servicios tiene pendientes ese cliente; hoy hay que buscarlos a mano en la agenda. No está en el servidor.
- **Tareas recurrentes** (ej. "aspirar los viernes" en oficinas) — los pendientes cubren tareas puntuales con seguimiento por WhatsApp, pero no se repiten solos: alguien tiene que crear cada uno. Falta la recurrencia programada.

---

## 10. Cómo hacer cambios de aquí en adelante

1. Editar el archivo correspondiente (`index.js`, `logica.js`, `agenda.js`, `edicion.js`, `pendientes.js`, `auth.js` o `sheets.js`) local o directo en GitHub.
2. Subir el cambio a la rama `main` del repositorio.
3. Render redespliega automáticamente al detectar el cambio.
4. Revisar la pestaña "Logs" del servicio en Render para confirmar que el despliegue fue exitoso.

**Importante:** siempre usar "Nueva versión" al reimplementar cambios que dependan de configuración externa — con Render esto es automático, no aplica el mismo cuidado que sí hacía falta con Apps Script.

**Si se agrega una variable de entorno** (como `SESSION_SECRET` o las `CLAVE_ADMIN_N`), hay que crearla en Render (*Environment*) **antes** de subir el código que la usa.
