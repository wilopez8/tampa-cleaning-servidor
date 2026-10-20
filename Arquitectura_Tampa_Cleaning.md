# Arquitectura — Sistema Tampa Cleaning

**Última actualización:** 20 de octubre de 2026
**Propósito de este documento:** referencia técnica para entender cómo funciona el sistema, qué piezas lo componen y cómo se conectan.

---

## 1. Resumen en una frase

Los empleados de Tampa Cleaning interactúan por **WhatsApp** para registrar su ubicación (check-in), confirmar su programación y reportar novedades. Un **servidor propio en Node.js** (hosteado en Render) procesa esos mensajes, valida la información contra **Google Sheets** (que funciona como base de datos central), y notifica a gerencia por WhatsApp cuando algo requiere atención. El cierre de cada servicio (checklist, insumos, comentario — o la evaluación por áreas, si el servicio es una inspección de calidad) se completa en una **página web propia**, generada por el mismo servidor — no se usa ninguna herramienta externa de formularios. Los administradores programan, editan, reasignan y cancelan servicios desde una **agenda web** protegida con clave (`/agenda`), también generada por el servidor. Desde esa misma sesión asignan **pendientes** (tareas sueltas como acciones correctivas o diligencias) que el empleado recibe por WhatsApp y cierra respondiendo "Ok". Además calculan la **nómina semanal** (`/nomina`): horas pagadas por servicio a partir de lo programado y del check-in, millas recorridas entre servicios (con Google Routes), propinas/bonos/descuentos, y cierre de la liquidación de cada empleado; la liquidación cerrada se le comparte al empleado con un **enlace firmado** (`/liquidacion`) para que vea su detalle sin iniciar sesión.

---

## 2. Historial de decisiones de arquitectura

1. **Versión inicial (abandonada):** Telegram + Google Apps Script. Se abandonó por fallas persistentes e imposibles de diagnosticar bien (errores 302 intermitentes, URLs de webhook que se corrompían, reintentos infinitos, logs insuficientes).
2. **Segunda versión:** WhatsApp (vía Twilio) + servidor propio en Render — resolvió la inestabilidad. Para el cierre de servicio se probó **AppSheet** (Google), pero se abandonó tras acumular demasiada fricción de configuración (vistas duplicadas, columnas que se ocultaban solas, nombres que dejaban de coincidir, interfaz con menús que el empleado no necesitaba).
3. **Cierre de servicio propio:** el cierre se resuelve con una **página HTML generada por el propio servidor** — mismo patrón que todo lo demás, sin depender de configuración externa.
4. **Versión actual — agenda de administración:** la programación ya no se llena a mano en el Sheets. Se agregó un panel web (`/agenda`) con inicio de sesión por administrador, validaciones antes de guardar, envío por WhatsApp desde el mismo panel y registro de todo cambio hecho después de enviar. Mismo principio: HTML generado por el servidor, sin frameworks ni herramientas externas.
5. **Pendientes y registro retroactivo:** se agregó un módulo de **pendientes** (tareas fuera de la programación diaria, con seguimiento por WhatsApp) para cubrir, entre otras cosas, el seguimiento de acciones correctivas de las inspecciones. Las fechas pasadas de la agenda dejaron de ser de solo lectura: ahora admiten **registro retroactivo** (con motivo obligatorio, marcado y sin enviar WhatsApp).
6. **Nómina semanal (fase 1 — horas):** se agregó `/nomina`, que calcula lo que se paga a cada empleado por semana (lunes a domingo) con los datos que ya existían en `PROGRAMACION_DIARIA` (horario programado + horas reales del check-in). Permite ajustes manuales con motivo, conceptos adicionales (propinas, bonos, descuentos) y cerrar la liquidación de cada empleado, que queda congelada en el Sheets. El millaje queda para la fase 2.
7. **Nómina fase 2 — millas:** se agregó `millas.js`, que calcula el recorrido diario de cada empleado (casa → servicios → casa) con la **API de Google Routes** y guarda las distancias en una hoja-caché (`DISTANCIAS`) para no volver a consultar el mismo trayecto. Está conectado a `/nomina`: las millas suman al total, se pueden ajustar por parada o por día, bloquean el cierre si quedan por revisar y se congelan al cerrar (ver 6.10). En el mismo cambio, las páginas de administración (agenda, pendientes, nómina) pasaron a compartir un **menú de navegación** común (`menu.js`).
8. **Liquidación visible para el empleado:** cada liquidación cerrada tiene un **enlace propio** (`/liquidacion?t=…`) con un token firmado que vence a los 60 días, para que el empleado vea sus horas, millas, conceptos y total sin cuenta ni clave. El enlace no se envía por Twilio: el administrador copia un mensaje ya redactado con el botón "Copiar mensaje con enlace" y lo manda él mismo.

---

## 3. Componentes del sistema

| Componente | Rol | Dónde vive |
|---|---|---|
| **WhatsApp** | Interfaz que usan los empleados y gerencia | App de WhatsApp de cada persona |
| **Twilio** | Traduce entre WhatsApp y el servidor (recibe mensajes entrantes, envía salientes) | Cuenta en twilio.com — actualmente en modo **Sandbox** (pendiente migrar a número verificado) |
| **Servidor Node.js** | Toda la lógica de negocio y las páginas web del sistema (formulario de cierre, login, agenda, pendientes, nómina) | Hosteado en Render.com (`tampa-cleaning-servidor.onrender.com`), código en GitHub |
| **Google Sheets** | Base de datos central | `Tampa_Cleaning_BUILD` (Google Drive) |
| **Google Cloud (cuenta de servicio)** | Permite que el servidor lea/escriba en Sheets sin intervención humana | Proyecto `tampa-cleaning-509423` |

---

## 4. Estructura del código (repositorio en GitHub)

```
tampa-cleaning-servidor/
├── index.js       → Rutas HTTP: webhook de Twilio, programación, formulario de cierre / inspección, login, agenda, pendientes (las de nómina las registra nomina.js)
├── logica.js      → Lógica de negocio de WhatsApp: check-in, envío de programación, confirmaciones, avisos de cambio, cierre
├── auth.js        → Inicio de sesión de administradores (claves, cookie firmada, bloqueo por intentos fallidos)
├── agenda.js      → Página /agenda: vista semanal/diaria, filtros, "línea de vida" de cada servicio, franja de pendientes del día
├── edicion.js     → Editor de la agenda: validaciones, crear/editar/reasignar, cancelar, guardar y enviar, registro retroactivo
├── pendientes.js  → Pendientes: página /pendientes, envío y recordatorios por WhatsApp, respuestas "Ok"/"Pendiente", página del empleado
├── nomina.js      → Nómina semanal: página /nomina, cálculo de horas pagadas, ajustes, conceptos adicionales, millas, cierre/reapertura de liquidaciones, página /liquidacion del empleado con enlace firmado (registra sus rutas con nomina.rutas(app, auth))
├── millas.js      → Millas de la nómina (lo usa nomina.js): distancias con Google Routes + caché en DISTANCIAS, cálculo de millas por día, registro de paradas y ajustes de monto, foto al cerrar, tablas HTML de millas
├── menu.js        → Menú de navegación común de las páginas de administración (Agenda · Pendientes · Nómina · Cerrar sesión): MENU_CSS y menuHtml(rutaActual, admin)
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
| `GET /nomina?fecha=&empleado=` | Sesión | Nómina de la semana que contiene `fecha` (resumen por empleado; con `empleado`, su detalle) |
| `POST /nomina/ajustar` | Sesión | Ajusta el horario pagado de un servicio, lo marca "Sin pago" o quita el ajuste (motivo obligatorio) |
| `POST /nomina/parada` | Sesión | Indica si un servicio cuenta como parada para las millas (`cuenta` = Sí / No / vacío = automático; motivo obligatorio) |
| `POST /nomina/millas/ajustar` | Sesión | Fija el monto de millas de un empleado en un día (monto vacío = volver al cálculo automático; motivo obligatorio) |
| `POST /nomina/concepto` | Sesión | Agrega una propina, bono, descuento u otro concepto a la semana de un empleado |
| `POST /nomina/concepto/anular` | Sesión | Anula un concepto (motivo obligatorio) |
| `POST /nomina/cerrar` | Sesión | Cierra (congela) la liquidación semanal de un empleado |
| `POST /nomina/reabrir` | Sesión | Reabre una liquidación cerrada (motivo obligatorio) |
| `GET /liquidacion?t=` | — (token firmado, vence a los 60 días) | Página del empleado con el detalle de su liquidación cerrada (solo lectura) |
| `GET/POST /pendiente?id=` | — (link único por pendiente) | Página del empleado para marcar el pendiente como resuelto o "sigue pendiente" |
| `GET /test-sheets` | — | Prueba de conexión con Sheets |

### 4.2 Caché de lectura (`sheets.js`)

`leerHoja(nombre)` sigue leyendo en vivo por defecto. Con `leerHoja(nombre, { cache: true })` devuelve datos de hasta **45 segundos** — lo usan las vistas de la agenda y de la nómina (`PROGRAMACION_DIARIA`, `EMPLEADOS`, `SITIOS`, `CONFIG_NOMINA` y las hojas propias de la nómina y de las millas) para no releer el Sheets en cada clic. La nómina y las millas además recuerdan qué pestañas ya verificaron con `asegurarHoja`, para no repetir esa llamada en cada carga. Toda escritura (`agregarFila`, `agregarFilas`, `actualizarCelda`, `actualizarCeldas`) invalida la caché de esa hoja. Las operaciones que **escriben** (guardar, cancelar, enviar) siempre releen en vivo antes de validar; el cierre de nómina invalida antes la caché de todas las hojas que usa. La caché vive en memoria del proceso: se pierde al redesplegar, sin consecuencias.

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
| `SESSION_SECRET` | Firma las cookies de sesión. **Obligatoria, mínimo 32 caracteres** — sin ella el login falla. Cambiarla cierra la sesión de todos **e invalida todos los enlaces de liquidación** ya enviados a empleados (`/liquidacion`) |
| `GOOGLE_MAPS_API_KEY` | Clave de Google Maps Platform con la **Routes API** habilitada, para calcular millas (`millas.js`). **Necesaria** desde que las millas están conectadas a `/nomina`. Si falta, los días con millas quedan en "Revisar" con el mensaje "Falta GOOGLE_MAPS_API_KEY en Render". Requiere Node 18+ (usa `fetch`) |

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
- Navegación por día (←, Hoy, →, selector de fecha) y filtros por cliente, empleado, estado y tipo. En la cabecera, el menú común (`menu.js`): nombre del administrador, Agenda · Pendientes · Nómina (resaltando la página actual) y Cerrar sesión.
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

### 6.10 Nómina semanal (`/nomina`, `nomina.js`)

Calcula horas, millas, propinas, bonos y descuentos. La nómina **no envía WhatsApp** a nadie.

**Vista.** Semana de lunes a domingo, con navegación (←, Esta semana, →, selector de fecha) y el mismo botón "Actualizar" de la agenda (misma caché de 45 s). Se llega desde **Nómina** en el menú común (`menu.js`) de las páginas de administración. Arriba, un **resumen por empleado**: servicios, horas pagadas, monto por horas, millas, propinas y bonos, descuentos, total, cuántas cosas están "por revisar" (servicios + días de millas) y si la liquidación está Abierta o Cerrada. Al hacer clic en un empleado se ve su **detalle**, en tres secciones plegables (con botones "Abrir todo" / "Cerrar todo"): **Horas (servicios)** — un renglón por servicio con lo programado, lo real (check-in, con ✍️ si fue registro manual), lo pagado, horas, tarifa, monto y estado; **Millas** — un renglón por día (ver más abajo); y **Otros conceptos**. Al final, la caja de totales (Horas + Millas + Propinas y bonos − Descuentos).

**Cálculo de cada servicio** (los cancelados se ignoran):
- **Horas pagadas** = desde el **inicio más tarde** hasta el **fin más temprano** entre lo programado (`Hora_Inicio`/`Hora_Fin`, o `Horario` si faltan) y lo real (`Hora_Entrada_Real`/`Hora_Salida_Real`). Es decir: no se paga llegar antes ni quedarse después de lo programado, y sí se descuenta llegar tarde o salir antes. Los turnos que cruzan medianoche se manejan.
- **Tarifa** = columna `Tarifa_Hora` de `EMPLEADOS` (buscada por `Nombre`). Los **sábados** se suma `Recargo_Sabado_Hora` por hora (por defecto $1). Si falta la columna `Tarifa_Hora`, la página lo advierte y todo sale en $0.
- **Estados:** `Calculado` (automático), `Ajustado` (lo fijó un administrador), `Sin pago` ($0 a propósito) o `Revisar` — sin check-in de entrada o de salida, sin horario programado, u horas pagadas ≤ 0. Un servicio de un empleado sin tarifa también cuenta como "por revisar". Lo que está en `Revisar` paga $0 hasta que se ajuste.

**Ajustes (botón "Ajustar").** El administrador fija inicio/fin pagado con motivo obligatorio, o marca **"Sin pago"**. Dejar inicio y fin vacíos **quita el ajuste** y vuelve al cálculo automático. Cada ajuste se agrega como fila nueva en `NOMINA_AJUSTES` (nunca se edita): vale la **última** fila de cada `ID_Programacion`, y queda guardada como referencia lo programado y lo real de ese momento. No se puede ajustar un servicio de una semana ya cerrada para ese empleado.

**Conceptos adicionales ("+ Agregar concepto").** Tipo (`Propina`, `Bono`, `Descuento`, `Otro`), descripción obligatoria, monto > 0 y, opcionalmente, el servicio relacionado. Reciben un ID `PAG-AAAAMMDD-NN` (por día de creación) y se guardan en `PAGOS_ADICIONALES`. Los descuentos restan; todo lo demás suma. Si la semana de ese empleado ya está cerrada, el concepto pasa **automáticamente a la siguiente semana abierta** y se avisa en pantalla. Se pueden **anular** con motivo (nunca se borran), salvo que pertenezcan a una liquidación cerrada.

**Cierre de liquidación.** "Cerrar liquidación de …" solo se habilita si **no queda ningún servicio por revisar ni ningún día de millas en "Revisar"**. Al cerrar (siempre con datos frescos, sin caché):
1. Se guarda una **foto** de cada servicio calculado en `NOMINA_DIAS` (programado, real, pagado, minutos, tarifa, recargo, monto, estado, motivo del ajuste). Las columnas de millas de esta hoja quedan en 0: las millas son por día, no por servicio, y se guardan aparte.
2. Se guarda la foto de las millas: tramos en `NOMINA_TRAMOS` y resumen por día en `NOMINA_MILLAS_DIA`.
3. Se agrega la liquidación en `LIQUIDACIONES` con ID `LIQ-<lunes AAAAMMDD>-NN`, `Estado = Cerrada`, totales (incluido `Monto_Millas`), quién y cuándo.
4. Los conceptos de la semana quedan marcados con ese `ID_Liquidacion`.

Se puede cerrar una semana que solo tenga millas (sin servicios ni conceptos), por ejemplo si se marcó como parada un servicio cancelado.

Una liquidación cerrada se muestra desde la foto, **no** desde el cálculo en vivo; si después cambiaron la agenda, la tarifa o la configuración, aparece un aviso ⚠️ de que el cálculo de **horas** en vivo ya no coincide (las millas no se comparan), pero lo cerrado no se toca. **Reabrir** pide motivo y marca la liquidación como `Reabierta` (con quién, cuándo y por qué); desde ahí vuelve el cálculo en vivo, y al cerrar de nuevo se crea una liquidación nueva (siguiente `NN`) — la anterior y su foto quedan como historial.

**Enlace para el empleado (`/liquidacion`).** En el detalle de una liquidación cerrada aparece el botón **"Copiar mensaje con enlace"**, que copia al portapapeles (o muestra para copiar, si el navegador no lo permite) un mensaje del tipo *"Hola <empleado>, esta es tu liquidación de la semana <lunes> al <domingo> (el enlace vale 60 días): <URL>"*. El administrador lo pega y lo envía por WhatsApp él mismo; el servidor no lo manda. Cómo funciona:
- El enlace lleva un token `t` = datos (`ID_Liquidacion` + vencimiento, en base64url) + firma HMAC-SHA256. La clave de firma se deriva de `SESSION_SECRET`, así que no hace falta otra variable de entorno; si cambia `SESSION_SECRET`, todos los enlaces dejan de servir. La firma se compara en tiempo constante y el enlace vence a los **60 días** (`DIAS_ENLACE`). Cada clic en el botón genera un token nuevo, con 60 días desde ese momento.
- La página no pide sesión, muestra solo **una** liquidación (la del token), se sirve con `Cache-Control: no-store`, `Referrer-Policy: no-referrer` y `noindex`, y se lee desde la **foto** congelada: servicios con horario pagado y horas (`NOMINA_DIAS`), millas pagadas por día con sus tramos (`NOMINA_TRAMOS` / `NOMINA_MILLAS_DIA`, indicando si la oficina ajustó el monto), conceptos activos y el resumen con el total. No muestra tarifas, check-ins ni motivos de ajuste.
- Si el token es inválido, venció o la liquidación no existe: "Este enlace no es válido o venció". Si la liquidación fue **reabierta**: "Esta liquidación está en revisión" — al volver a cerrar se crea una liquidación nueva con otro ID, así que hay que mandarle al empleado el **enlace nuevo** (el viejo queda mostrando "en revisión").
- No hay forma de revocar un enlace puntual antes de que venza, salvo reabrir la liquidación (o cambiar `SESSION_SECRET`, que afecta a todos).

**Configuración (`CONFIG_NOMINA`).** Pestaña `Clave` / `Valor` / `Descripcion` que se crea sola con valores por defecto: `Recargo_Sabado_Hora` = 1 y, para las millas, `Tarifa_Milla` = 0.37, `Umbral_Millas_Dia` = 10, `Servicios_Pago_Siempre` = 2 y `Umbral_Tarifa_Fija` = 20. Los valores se cambian directamente en el Sheets. (Las descripciones de una pestaña creada antes de la fase 2 todavía dicen "Fase 2:"; no afecta el cálculo.)

Agregar concepto, anular, cerrar y reabrir pasan por una cola en memoria propia de la nómina (mismo patrón que agenda y pendientes), para no generar IDs repetidos ni cerrar dos veces la misma semana. Los ajustes de horas, de paradas y de monto de millas solo agregan filas a su bitácora, así que no pasan por la cola; todos se rechazan si la semana de ese empleado está cerrada.

**Millas (`millas.js`).** La sección "Millas" del detalle muestra un renglón por día: paradas (plegable; se abre sola si el día está en "Revisar") con un botón **"Parada"** por servicio, recorrido (plegable, con las millas de cada tramo), millas pagadas, millas totales, monto, estado y el botón **"Ajustar monto"**. Al cargar la página se calculan las millas de los empleados con liquidación abierta (los cerrados usan su foto), y las distancias nuevas que haya pedido a Google se guardan en `DISTANCIAS` en ese momento. Cómo calcula:
- **Recorrido del día:** por cada empleado y día, se arma la ruta **Casa → servicio 1 → … → servicio N → Casa**, con los servicios ordenados por hora de entrada real (o la programada si no hay check-in). La casa sale de la columna `Direccion_Residencia` de `EMPLEADOS` y cada sitio de las coordenadas de `SITIOS`. Se pagan todos los tramos **menos el regreso a casa** ("Mi. pagadas"); "Mi. total" incluye el regreso solo como referencia.
- **Qué servicios cuentan como parada:** los que no están cancelados ni en "Sin pago". Un servicio en `Revisar` (sin check-in) deja el día en **Revisar** hasta que se ajusten sus horas o se indique con el botón **"Parada"** si cuenta o no. Ese botón también permite incluir un servicio cancelado (ej. el empleado sí se desplazó) o excluir uno normal; la opción "Automático" vuelve al criterio por horas y check-in. Se guarda en `NOMINA_PARADAS` con motivo obligatorio (vale la última fila de cada servicio; `Cuenta` distinto de Sí/No quita el ajuste).
- **Regla de pago** (parámetros de `CONFIG_NOMINA`): si las millas pagadas superan `Umbral_Tarifa_Fija` (20), el día queda en **Revisar** y el administrador escribe el monto. Si no, se paga `millas pagadas × Tarifa_Milla` (0.37) cuando el día tiene **exactamente** `Servicios_Pago_Siempre` (2) paradas o cuando las millas pagadas llegan a `Umbral_Millas_Dia` (10); en cualquier otro caso el día paga $0.
- **Ajustar monto:** el administrador puede fijar el monto de millas de un día con motivo; se agrega una fila en `NOMINA_MILLAS_AJUSTES` (vale la última por empleado y fecha; monto vacío quita el ajuste). El día queda `Ajustado` y se sigue mostrando el cálculo automático como referencia.
- **Otros motivos de "Revisar":** falta la dirección de residencia del empleado (o la columna), un sitio sin coordenadas, o Google no pudo calcular un tramo.
- **Distancias y caché (`DISTANCIAS`):** cada tramo se pide a la **Google Routes API** (en carro, sin tráfico) y se guarda en `DISTANCIAS` con los dos puntos (`CASA: <empleado>` / `SITIO: <cliente>`, ordenados — la distancia se trata como simétrica) y una **huella** (dirección o coordenadas). Si la dirección de la casa o las coordenadas del sitio cambian, la huella deja de coincidir y el tramo se recalcula. Una fila con `Fuente = Manual` **nunca** se sobrescribe — sirve para corregir a mano una distancia. Las distancias nuevas se escriben al Sheets en una sola operación al final (`volcarDistancias`) para no pasarse de la cuota de escritura.
- **Al cerrar la liquidación** se guarda una foto de los tramos en `NOMINA_TRAMOS` y del resumen por día en `NOMINA_MILLAS_DIA`; una liquidación cerrada muestra las millas desde esa foto. Las liquidaciones cerradas antes de la fase 2 muestran un aviso de que no tienen detalle de millas.

---

## 7. Estructura de las hojas de Google Sheets relevantes

| Hoja | Contiene |
|---|---|
| `EMPLEADOS` | Nombre, número de WhatsApp (columna `ID_Telegram`, heredada), `Rol`, `Estatus` (solo los `Activo` aparecen en la agenda), `Tarifa_Hora` (USD por hora, para la nómina — se crea a mano), `Direccion_Residencia` (punto de salida y regreso para las millas — se crea a mano) |
| `CLIENTES` | Nombre (columna `clientes`), `Direccion`, `Google Maps`, `Descripcion_Servicio`, `Instrucciones`, `Cliente Vigente/Vencido`. Es la fuente **en vivo** de dirección/instrucciones cuando la fila de programación no las trae |
| `SITIOS` | `Nombre_Cliente`, coordenadas GPS (`Latitud`, `Longitud`) y radio de tolerancia para geofencing, `Checklist_Tareas` (lista separada por comas) para el formulario de cierre, `Estatus` |
| `PROGRAMACION_DIARIA` | El corazón del sistema — un renglón por servicio, con columnas para programación, confirmación, check-in, y cierre. `Tipo_Servicio` distingue limpieza de `Inspeccion`; las inspecciones usan además `Resultado_Inspeccion`, `Requiere_Accion_Correctiva` y `Estado_Correccion` (todas opcionales — si la columna no existe, el servidor simplemente no la escribe). Ver columnas de la agenda abajo |
| `REGISTRO_TURNOS` | Bitácora de auditoría de cada check-in |
| `QUEJAS` | Quejas y dudas, diferenciadas por columna `Tipo`, asociadas al servicio por `ID_Programacion` |
| `CAMBIOS_PROGRAMACION` | Bitácora de cambios hechos desde la agenda (incluidos los retroactivos): `Fecha_Hora`, `ID_Programacion`, `Fecha_Servicio`, `Tipo_Cambio`, `Detalle`, `Realizado_Por`, `Empleado_Notificado`, `Aviso_Enviado`. **El servidor la crea sola** (con encabezados) la primera vez que registra un cambio |
| `PENDIENTES` | **Nueva.** Un renglón por pendiente: `ID_Pendiente`, `Tipo`, `Titulo`, `Observaciones`, `Cliente`, `ID_Programacion` (servicio vinculado, opcional), `Responsable`, `Fecha_Limite`, `Hora_Inicio`, `Hora_Fin`, `Prioridad`, `Estado` (`Abierto` / `Resuelto` / `Cancelado`), `Estado_Envio` (`Borrador` / `Enviado`), `Creado_Por`, `Fecha_Creacion`, `Notas_Seguimiento`, `Fecha_Cierre`, `Cerrado_Por` (quién y por qué vía: WhatsApp, Enlace o Agenda web), `Nota_Cierre`, `Ultimo_Recordatorio`. Se escribe por nombre de columna. **Se crea sola** |
| `PENDIENTES_MENSAJES` | **Nueva.** Relaciona cada WhatsApp enviado con su pendiente: `SID`, `ID_Pendiente`, `Fecha_Hora`, `Tipo_Envio`. Es lo que permite reconocer una respuesta por Reply. **Se crea sola** |
| `PENDIENTES_HISTORIAL` | Bitácora de eventos de cada pendiente: `Fecha_Hora`, `ID_Pendiente`, `Evento`, `Detalle`, `Realizado_Por`. **Se crea sola** |
| `CONFIG_NOMINA` | **Nueva.** Parámetros de la nómina (`Clave`, `Valor`, `Descripcion`). **Se crea sola** con valores por defecto |
| `NOMINA_AJUSTES` | **Nueva.** Bitácora de ajustes de horas pagadas: `Fecha_Hora`, `ID_Programacion`, `Empleado`, `Fecha_Servicio`, `Pago_Inicio`, `Pago_Fin` (`SIN PAGO` = sin pago; ambos vacíos = quitar ajuste), `Motivo`, `Ajustado_Por`, `Referencia`. Vale la última fila de cada servicio. **Se crea sola** |
| `PAGOS_ADICIONALES` | **Nueva.** Propinas, bonos, descuentos y otros: `ID_Concepto`, `Semana_Inicio`, `Empleado`, `Fecha`, `Tipo`, `Descripcion`, `Monto`, `ID_Programacion`, `Creado_Por`, `Fecha_Creacion`, `Estado` (`Activo` / `Anulado`), `Anulado_Por`, `Motivo_Anulacion`, `ID_Liquidacion`. **Se crea sola** |
| `LIQUIDACIONES` | **Nueva.** Una fila por cierre semanal de un empleado: `ID_Liquidacion`, `Semana_Inicio`, `Empleado`, `Estado` (`Cerrada` / `Reabierta`), `Servicios`, `Minutos`, `Monto_Horas`, `Monto_Millas`, `Monto_Propinas_Bonos`, `Monto_Descuentos`, `Total`, `Cerrado_Por`, `Fecha_Cierre`, `Reabierto_Por`, `Fecha_Reapertura`, `Motivo_Reapertura`. **Se crea sola** |
| `NOMINA_DIAS` | **Nueva.** Foto congelada de cada servicio al cerrar una liquidación (programado, real, pagado, minutos, tarifa, recargo de sábado, monto, estado y motivo del ajuste). Sus columnas `Millas_Pagadas` / `Monto_Millas` siempre quedan en 0: las millas se guardan por día en `NOMINA_MILLAS_DIA`. **Se crea sola** |
| `DISTANCIAS` | **Nueva (fase 2).** Caché de distancias en millas entre puntos: `Punto_A`, `Punto_B`, `Millas`, `Fuente` (`Google` / `Manual`), `Huella`, `Fecha`. Se puede corregir a mano poniendo `Fuente = Manual`. **Se crea sola** |
| `NOMINA_PARADAS` | **Nueva (fase 2).** Bitácora de "¿este servicio cuenta como parada?": `Fecha_Hora`, `ID_Programacion`, `Empleado`, `Fecha_Servicio`, `Cuenta` (Sí / No / otro = quitar), `Motivo`, `Ajustado_Por`. Vale la última fila de cada servicio. **Se crea sola** |
| `NOMINA_MILLAS_AJUSTES` | **Nueva (fase 2).** Montos de millas fijados a mano: `Fecha_Hora`, `Empleado`, `Fecha_Servicio`, `Monto` (vacío = quitar), `Motivo`, `Ajustado_Por`. Vale la última fila por empleado y fecha. **Se crea sola** |
| `NOMINA_TRAMOS` | **Nueva (fase 2).** Foto de cada tramo al cerrar: `ID_Liquidacion`, `Semana_Inicio`, `Empleado`, `Fecha`, `Orden`, `Origen`, `Destino`, `Millas`, `Pagado`, `Fuente`. **Se crea sola** |
| `NOMINA_MILLAS_DIA` | **Nueva (fase 2).** Foto del resumen de millas por día al cerrar: `ID_Liquidacion`, `Semana_Inicio`, `Empleado`, `Fecha`, `Paradas`, `Millas_Pagadas`, `Millas_Total`, `Monto_Millas`, `Estado`, `Motivo_Ajuste`, `Notas`. **Se crea sola** |

**Columnas de `PROGRAMACION_DIARIA` que exige la agenda.** A diferencia del resto del sistema (donde las columnas son opcionales), la agenda **se niega a guardar** si falta alguna de estas: `ID_Programacion`, `Fecha_Servicio`, `Tipo_Servicio`, `Cliente`, `Empleado`, `Horario`, `Hora_Inicio`, `Hora_Fin`, `Observaciones_Puntuales`, `Estado_Envio`, `Estado_Confirmacion`, `Creado_Por`, `Fecha_Creacion`, `Modificado_Por`, `Fecha_Modificacion`, `Cancelado`, `Motivo_Cancelacion`. Las filas nuevas se escriben por **nombre de columna** (no por posición), así que el orden de las columnas puede cambiar sin romper nada.

**Columnas adicionales para el registro retroactivo:** `Registro_Retroactivo` (Sí / vacío), `Motivo_Retroactivo`, `Origen_Registro` (`Manual` cuando las horas reales las escribió un administrador). Solo se exigen al guardar en una fecha pasada. `PENDIENTES_MENSAJES` usa posiciones fijas (columna A = SID, B = ID_Pendiente) y `PENDIENTES_HISTORIAL` se escribe en orden fijo: no reordenar sus columnas. Lo mismo para las hojas de nómina (`NOMINA_AJUSTES`, `PAGOS_ADICIONALES`, `LIQUIDACIONES`, `NOMINA_DIAS`, y las de millas: `DISTANCIAS`, `NOMINA_PARADAS`, `NOMINA_MILLAS_AJUSTES`, `NOMINA_TRAMOS`, `NOMINA_MILLAS_DIA`): las filas nuevas se escriben en el orden fijo de sus encabezados (aunque se leen por nombre de columna), así que tampoco se deben reordenar.

---

## 8. Costos mensuales estimados

| Servicio | Costo | Nota |
|---|---|---|
| Twilio (WhatsApp) | ~$1–5 USD | Depende de cuántos mensajes inicia el negocio (no el empleado). Los avisos de cambio/cancelación, los pendientes y sus recordatorios suman mensajes salientes |
| Google Sheets API | $0 | Gratuito |
| Google Maps Platform (Routes API) | Probablemente $0 | Se usa al ver o cerrar la nómina. Cada par de puntos se consulta una sola vez (queda en `DISTANCIAS`), así que el volumen debería quedar dentro de la cuota gratuita mensual — confirmar en la consola de Google Cloud y poner un límite de cuota |
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
- **Millas: revisar la regla de "Servicios_Pago_Siempre"** — hoy el pago fijo se aplica solo cuando el día tiene **exactamente** 2 paradas; un día con 3 o más paradas y menos de 10 millas paga $0. Confirmar si la intención era "2 o más".
- **Millas: requisitos de datos** — confirmar que `GOOGLE_MAPS_API_KEY` existe en Render y que cada empleado activo tiene `Direccion_Residencia` en `EMPLEADOS`; sin eso los días quedan en "Revisar" y bloquean el cierre.
- **Envío automático del enlace de liquidación** — hoy el administrador copia el mensaje y lo manda a mano; podría enviarse por Twilio al cerrar (requiere plantilla aprobada una vez se migre a WhatsApp Business).
- **Bloqueo de login y colas de escrituras en memoria** (agenda, pendientes y nómina) — funcionan porque hay una sola instancia del servidor; si algún día se escala a varias instancias, habría que moverlos a un almacenamiento compartido.

**Del mapa de problemas original** (los dolores que motivaron el sistema; aún sin resolver del todo). *Ya resuelto: nómina con horas y millas automáticas (`/nomina`, ver 6.10) — el millaje ya no se saca a mano en Google Maps.*

- **Historial de calidad al programar** — las quejas (`QUEJAS`) y las inspecciones solo se ven en el detalle de cada servicio. El objetivo original era ver el historial de quejas/observaciones **del cliente y del empleado** en el editor, al momento de programar.
- **Cobranza: servicios pendientes por cliente** — al registrar un pago no se ve qué servicios tiene pendientes ese cliente; hoy hay que buscarlos a mano en la agenda. No está en el servidor.
- **Tareas recurrentes** (ej. "aspirar los viernes" en oficinas) — los pendientes cubren tareas puntuales con seguimiento por WhatsApp, pero no se repiten solos: alguien tiene que crear cada uno. Falta la recurrencia programada.

---

## 10. Cómo hacer cambios de aquí en adelante

1. Editar el archivo correspondiente (`index.js`, `logica.js`, `agenda.js`, `edicion.js`, `pendientes.js`, `nomina.js`, `millas.js`, `menu.js`, `auth.js` o `sheets.js`) local o directo en GitHub.
2. Subir el cambio a la rama `main` del repositorio.
3. Render redespliega automáticamente al detectar el cambio.
4. Revisar la pestaña "Logs" del servicio en Render para confirmar que el despliegue fue exitoso.

**Importante:** siempre usar "Nueva versión" al reimplementar cambios que dependan de configuración externa — con Render esto es automático, no aplica el mismo cuidado que sí hacía falta con Apps Script.

**Si se agrega una variable de entorno** (como `SESSION_SECRET`, las `CLAVE_ADMIN_N` o `GOOGLE_MAPS_API_KEY`), hay que crearla en Render (*Environment*) **antes** de subir el código que la usa.
