# Arquitectura — Sistema Tampa Cleaning

**Última actualización:** 12 de noviembre de 2026
**Propósito de este documento:** referencia técnica para entender cómo funciona el sistema, qué piezas lo componen y cómo se conectan.

---

## 1. Resumen en una frase

Los empleados de Tampa Cleaning interactúan por **WhatsApp** para registrar su ubicación (check-in), confirmar su programación y reportar novedades. Un **servidor propio en Node.js** (hosteado en Render) procesa esos mensajes, valida la información contra **Google Sheets** (que funciona como base de datos central), y notifica a gerencia por WhatsApp cuando algo requiere atención. El cierre de cada servicio (checklist, insumos, comentario — o la evaluación por áreas, si el servicio es una inspección de calidad) se completa en una **página web propia**, generada por el mismo servidor — no se usa ninguna herramienta externa de formularios. Los administradores programan, editan, reasignan y cancelan servicios desde una **agenda web** protegida con clave (`/agenda`), también generada por el servidor. Desde esa misma sesión asignan **pendientes** (tareas sueltas como acciones correctivas o diligencias) que el empleado recibe por WhatsApp y cierra respondiendo "Ok". Además calculan la **nómina semanal** (`/nomina`): horas pagadas por servicio a partir de lo programado y del check-in, millas recorridas entre servicios (con Google Routes), propinas/bonos/descuentos, y cierre de la liquidación de cada empleado; la liquidación cerrada se le comparte al empleado con un **enlace firmado** (`/liquidacion`) para que vea su detalle sin iniciar sesión. Por último, llevan la **cartera** (`/cartera`): lo que hay que cobrarle a cada cliente, generado solo a partir de los servicios de la agenda (un cobro por cliente y día, con la tarifa del sitio) más las **novedades de cobro** (tiempo o trabajo adicional, productos, valor final ajustado). Sobre la cartera registran el dinero que entra (**ingresos**, aplicados a los servicios para saber qué está pagado y qué saldo queda) y el que sale (**egresos**: pagos de nómina y gastos), con **reportes** de flujo, antigüedad de cartera y pagos a empleados. Llevan además **notas de retroalimentación** por servicio o cliente, un **semáforo de calidad** por cliente (`/cartera/calidad`), un **resumen del día** (`/resumen`, la página de inicio tras el login) y un **directorio** para crear y editar clientes y empleados sin tocar el Sheets.

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
9. **Cartera (cobros a clientes):** se agregó `cartera.js` (`/cartera`), que convierte los servicios de la agenda en cobros por cliente y día, permite confirmar o cancelar los que quedaron sin cerrar y registrar novedades de cobro, tanto desde la cartera como desde un botón en la agenda. En el mismo cambio, el "Detalle" de la agenda pasó a mostrarse como un bloque horizontal debajo de la fila (con un bloque nuevo de **Cobro**), y se **retiró** el enlace antiguo `/enviar-programacion` junto con la variable `CLAVE_ADMIN`.
10. **Ingresos y egresos:** se agregó `pagos.js` (`/cartera/pagos`): cada dinero recibido se registra una vez y se **reparte** entre los servicios ejecutados del pagador; el estado de pago de cada cobro (Pendiente / Parcial / Pagado) se **calcula**, no se escribe. Luego `egresos.js` (`/cartera/egresos`) para pagos de nómina (atados a una liquidación cerrada) y gastos, y `reportes.js` (`/cartera/reportes`). Ingresos y egresos cuentan por su **fecha de banco** (o la de pago si es efectivo en mano), para poder conciliar con el extracto.
11. **Notas y calidad:** `notas.js` agrega retroalimentación (calidad con calificación de 1 a 5, comentarios del cliente) por servicio o por cliente, visible en la línea de vida y en la página del cliente. `calidad.js` (`/cartera/calidad`) junta quejas, inspecciones, cierres y notas en un **semáforo por cliente**.
12. **Interfaz común y resumen:** las páginas de administración pasaron a una cabecera común (`layout.js`: barra con logo, secciones y sub-pestañas, tarjetas KPI) con estilos y diálogos compartidos en `public/tc.css` y `public/tc.js` (servidos en `/static`), y datos de marca configurables (`marca.js`). Los `alert`/`confirm`/`prompt` del navegador se reemplazaron por diálogos propios (`TC.alerta`, `TC.confirmar`, `TC.pedir`, `TC.toast`). Se agregó `/resumen` (`resumen.js`) como página de inicio tras el login.
13. **Directorio:** `directorio.js` (`/directorio`) permite crear, editar y activar/desactivar clientes (escribe en `CLIENTES` y `SITIOS` a la vez) y empleados (`EMPLEADOS`) desde la web, y obtiene las coordenadas a partir del enlace de Google Maps.

---

## 3. Componentes del sistema

| Componente | Rol | Dónde vive |
|---|---|---|
| **WhatsApp** | Interfaz que usan los empleados y gerencia | App de WhatsApp de cada persona |
| **Twilio** | Traduce entre WhatsApp y el servidor (recibe mensajes entrantes, envía salientes) | Cuenta en twilio.com — actualmente en modo **Sandbox** (pendiente migrar a número verificado) |
| **Servidor Node.js** | Toda la lógica de negocio y las páginas web del sistema (formulario de cierre, login, resumen, agenda, pendientes, nómina, cartera con ingresos/egresos/reportes, calidad, directorio) | Hosteado en Render.com (`tampa-cleaning-servidor.onrender.com`), código en GitHub |
| **Google Sheets** | Base de datos central | `Tampa_Cleaning_BUILD` (Google Drive) |
| **Google Cloud (cuenta de servicio)** | Permite que el servidor lea/escriba en Sheets sin intervención humana | Proyecto `tampa-cleaning-509423` |

---

## 4. Estructura del código (repositorio en GitHub)

```
tampa-cleaning-servidor/
├── index.js       → Rutas HTTP: webhook de Twilio, formulario de cierre / inspección, login, agenda, pendientes, archivos estáticos (/static). El resto de módulos registran sus propias rutas con <modulo>.rutas(app, auth)
├── logica.js      → Lógica de negocio de WhatsApp: check-in, envío de programación, confirmaciones, avisos de cambio, cierre
├── auth.js        → Inicio de sesión de administradores (claves, cookie firmada, bloqueo por intentos fallidos)
├── agenda.js      → Página /agenda: vista semanal/diaria, filtros, "línea de vida" de cada servicio, franja de pendientes del día
├── edicion.js     → Editor de la agenda: validaciones, crear/editar/reasignar, cancelar, guardar y enviar, registro retroactivo
├── pendientes.js  → Pendientes: página /pendientes, envío y recordatorios por WhatsApp, respuestas "Ok"/"Pendiente", página del empleado
├── nomina.js      → Nómina semanal: página /nomina, cálculo de horas pagadas, ajustes, conceptos adicionales, millas, cierre/reapertura de liquidaciones, página /liquidacion del empleado con enlace firmado (registra sus rutas con nomina.rutas(app, auth))
├── millas.js      → Millas de la nómina (lo usa nomina.js): distancias con Google Routes + caché en DISTANCIAS, cálculo de millas por día, registro de paradas y ajustes de monto, foto al cerrar, tablas HTML de millas
├── cartera.js     → Cartera: páginas /cartera, /cartera/clientes y /cartera/cliente, sincronización de cobros desde la agenda, confirmar/cancelar cobros, novedades de cobro; también el botón y diálogo "Novedad de cobro" y la "línea de vida" horizontal (lineaDeVidaH) que usa la agenda (registra sus rutas con cartera.rutas(app, auth))
├── pagos.js       → Ingresos: página /cartera/pagos, registro de ingresos (por servicios u otros), reparto entre servicios, saldo a favor, depósito, anulación; estado de pago de cada cobro (estadoCobro) y sección de ingresos de la página del cliente
├── egresos.js     → Egresos: página /cartera/egresos, pagos de nómina (por liquidación o eventuales) y gastos, débito en banco, anulación
├── reportes.js    → Página /cartera/reportes (solo lectura): antigüedad de cartera, ingresos/egresos por cuenta, método y categoría, conciliación, por depositar/debitar, pagos a empleados, mes a mes
├── notas.js       → Notas de retroalimentación por servicio o cliente (NOTAS_SERVICIO): botón y diálogo en la agenda, bloque en la línea de vida, sección en la página del cliente
├── calidad.js     → Páginas /cartera/calidad y /cartera/calidad/cliente (solo lectura): semáforo de calidad por cliente y ficha con su historial
├── resumen.js     → Página /resumen (inicio tras el login): semáforos de hoy y mañana, cartera vencida, pendientes, quejas, acciones correctivas, clientes sin inspección
├── directorio.js  → Páginas /directorio/clientes y /directorio/empleados: alta, edición y activación/desactivación; coordenadas desde el enlace de Google Maps
├── layout.js      → Cabecera común de las páginas de administración (head, cabecera con secciones y sub-pestañas, kpis)
├── marca.js       → Nombre de la empresa, del producto y logos (sobrescribibles con variables MARCA_*)
├── menu.js        → Menú antiguo (MENU_CSS, menuHtml). Ya casi no se usa: lo reemplazó layout.js
├── public/        → tc.css (estilos comunes), tc.js (TC.post, TC.toast, TC.alerta, TC.confirmar, TC.pedir) y logos; se sirven en /static
├── sheets.js      → Módulo genérico de lectura/escritura a Google Sheets (con caché corta opcional)
├── package.json   → Dependencias: express, googleapis, twilio (el login usa `crypto`, incluido en Node)
├── CLAUDE.md      → Guía para Claude Code (resumen técnico del repositorio)
└── Arquitectura_Tampa_Cleaning.md → Este documento
```

### 4.1 Rutas HTTP

| Ruta | Protección | Para qué |
|---|---|---|
| `POST /webhook` | — (Twilio) | Mensajes entrantes de WhatsApp |
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
| `GET /cartera?mes=&cliente=&estado=&sync=1` | Sesión | Cartera, vista **Servicios**: un renglón por cobro del mes (`mes=AAAA-MM` o `todo`); `sync=1` fuerza la sincronización con la agenda |
| `GET /cartera/clientes?mes=` | Sesión | Cartera, vista **Clientes**: resumen por cliente del mes |
| `GET /cartera/cliente?c=&mes=` | Sesión | Página de un cliente: sus cobros con equipo, horas y la línea de vida de cada servicio |
| `POST /cartera/ejecutar` | Sesión | Pasa un cobro a Ejecutado (valor opcional — si va vacío usa la tarifa del sitio; motivo obligatorio) |
| `POST /cartera/cancelar` | Sesión | Cancela un cobro (motivo obligatorio) |
| `POST /cartera/novedad` | Sesión | Registra una novedad de cobro, por `idCobro` (desde la cartera) o por `idProgramacion` (desde la agenda) |
| `POST /cartera/novedad/anular` | Sesión | Anula una novedad de cobro (motivo obligatorio) |
| `GET /cartera/pagos?mes=&tipo=&estado=&metodo=&cuenta=` | Sesión | Ingresos del mes (`metodo` y `cuenta` admiten varios valores) |
| `POST /cartera/pagos/registrar` | Sesión | Registra un ingreso (de servicios, con su reparto, u otro ingreso) |
| `POST /cartera/pagos/aplicar` | Sesión | Aplica el saldo a favor de un ingreso a servicios pendientes |
| `POST /cartera/pagos/deposito` | Sesión | Registra fecha de banco (y cuenta/código) de un ingreso por depositar |
| `POST /cartera/pagos/anular` | Sesión | Anula un ingreso (motivo obligatorio); sus servicios vuelven a quedar pendientes |
| `GET /cartera/egresos?…` | Sesión | Egresos del mes |
| `POST /cartera/egresos/registrar` | Sesión | Registra un egreso: pago de una liquidación, pago eventual a un empleado o gasto |
| `POST /cartera/egresos/debito` | Sesión | Registra la fecha de banco de un egreso por debitar |
| `POST /cartera/egresos/anular` | Sesión | Anula un egreso (motivo obligatorio) |
| `GET /cartera/reportes?desde=&hasta=&anio=&metodo=&cuenta=` | Sesión | Reportes de cartera y flujo |
| `POST /cartera/notas/registrar`, `POST /cartera/notas/anular` | Sesión | Registra o anula una nota de retroalimentación |
| `GET /cartera/calidad?nivel=` | Sesión | Semáforo de calidad de los clientes vigentes (`nivel` = rojo / amarillo / verde) |
| `GET /cartera/calidad/cliente?c=` | Sesión | Ficha de calidad de un cliente |
| `GET /resumen` | Sesión | Resumen del día (página de inicio tras el login) |
| `GET /directorio` → `/directorio/clientes`, `GET /directorio/empleados` | Sesión | Directorio de clientes y empleados |
| `POST /directorio/cliente/guardar`, `POST /directorio/empleado/guardar` | Sesión | Crea o edita un cliente / empleado |
| `POST /directorio/estado` | Sesión | Activa o desactiva un cliente o empleado |
| `POST /directorio/coordenadas` | Sesión | Obtiene latitud/longitud de un enlace de Google Maps |
| `POST /pendientes/editar` | Sesión | Edita un pendiente abierto (avisa al empleado si ya estaba enviado) |
| `GET /static/*` | — | Estilos, scripts y logos de `public/` |
| `GET /liquidacion?t=` | — (token firmado, vence a los 60 días) | Página del empleado con el detalle de su liquidación cerrada (solo lectura) |
| `GET/POST /pendiente?id=` | — (link único por pendiente) | Página del empleado para marcar el pendiente como resuelto o "sigue pendiente" |
| `GET /test-sheets` | — | Prueba de conexión con Sheets |

### 4.2 Caché de lectura (`sheets.js`)

`leerHoja(nombre)` sigue leyendo en vivo por defecto. Con `leerHoja(nombre, { cache: true })` devuelve datos de hasta **45 segundos** — lo usan las vistas de la agenda, la nómina, la cartera, la calidad, el resumen y el directorio (`PROGRAMACION_DIARIA`, `EMPLEADOS`, `SITIOS`, `CONFIG_NOMINA`, `CONFIG_CARTERA` y las hojas propias de la nómina, las millas y la cartera) para no releer el Sheets en cada clic. La nómina, las millas y la cartera además recuerdan qué pestañas ya verificaron con `asegurarHoja`, para no repetir esa llamada en cada carga. Toda escritura (`agregarFila`, `agregarFilas`, `actualizarCelda`, `actualizarCeldas`) invalida la caché de esa hoja. Las operaciones que **escriben** (guardar, cancelar, enviar) siempre releen en vivo antes de validar; el cierre de nómina invalida antes la caché de todas las hojas que usa. La caché vive en memoria del proceso: se pierde al redesplegar, sin consecuencias.

Funciones nuevas en `sheets.js`: `actualizarCeldas` (varias celdas en una sola llamada), `agregarFilas` (varias filas a la vez), `asegurarHoja` (crea una pestaña con encabezados si no existe), `invalidarCache`, `edadCacheSegundos`.

---

## 5. Variables de entorno (en Render, nunca en el código)

| Variable | Para qué sirve |
|---|---|
| `GOOGLE_CLIENT_EMAIL` | Identifica la cuenta de servicio de Google |
| `GOOGLE_PRIVATE_KEY` | Clave privada de esa cuenta de servicio |
| `TWILIO_ACCOUNT_SID` | Identifica la cuenta de Twilio |
| `TWILIO_AUTH_TOKEN` | Autentica las llamadas a la API de Twilio |
| `CLAVE_ADMIN_1` … `CLAVE_ADMIN_4` | Clave personal de cada administrador para entrar a la agenda (1 = Wilmar Lopez, 2 = Carolina Gallego, 3 = Andres Madrid, 4 = Claudia Lopez). El orden es fijo y las cuatro deben ser distintas. Si una no está definida, ese administrador simplemente no puede entrar |
| `SESSION_SECRET` | Firma las cookies de sesión. **Obligatoria, mínimo 32 caracteres** — sin ella el login falla. Cambiarla cierra la sesión de todos **e invalida todos los enlaces de liquidación** ya enviados a empleados (`/liquidacion`) |
| `MARCA_PRODUCTO`, `MARCA_EMPRESA`, `MARCA_LOGO`, `MARCA_LOGO_CLARO` | **Opcionales.** Cambian el nombre del producto (por defecto "ADB Consulting"), de la empresa ("Tampa Cleaning") y los logos (`/static/logo-adb.png`, `/static/logo-adb-claro.png`) que muestran el login y la cabecera (`marca.js`) |
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

El enlace antiguo `/enviar-programacion?clave=...` (que enviaba la programación de mañana) **ya no existe**: todo envío se hace desde la agenda. La variable `CLAVE_ADMIN` ya no se usa y se puede borrar de Render.

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
- Navegación por día (←, Hoy, →, selector de fecha) y filtros por cliente, empleado, estado y tipo. En la cabecera, la barra común (`layout.js`, ver 6.19). Debajo, tarjetas con los totales del día: servicios, finalizados, en curso, por confirmar, borrador y "no puede".
- Cada servicio muestra un **estado calculado** a partir de sus columnas: Borrador → Enviado → Confirmado / No puede → En curso → Salida (falta cierre) → Finalizado, o Cancelado. Marcas adicionales: **Retroactivo** (con el motivo al pasar el mouse), ✍️ si las horas reales se escribieron a mano (`Origen_Registro = Manual`), 👥N si varios empleados atienden el mismo cliente y tipo ese día (equipo).
- ⚠️ **Acción pendiente:** si el servicio tiene pendientes vinculados (`PENDIENTES.ID_Programacion`), se marca mientras alguno siga `Abierto`. Si no tiene ninguno, se usa el criterio antiguo (`Requiere_Accion_Correctiva = Sí` y `Estado_Correccion = Pendiente`).
- **Franja de pendientes:** debajo del editor se listan los pendientes abiertos cuya fecha límite es la del día mostrado; si el día mostrado es hoy, también los **vencidos**.
- **"Detalle" (línea de vida):** botón que abre, en un renglón ancho debajo del servicio, todo lo que se sabe de él en bloques horizontales (4 columnas, 2 en pantallas angostas; los bloques sin datos no se muestran) — programación (con quién lo creó/modificó, cancelación, retroactivo y origen del registro), envío y confirmación, entrada, salida, cierre, inspección, avisos, **cobro** (estado en cartera, valor, total y novedades de cobro; no aparece en inspecciones), **retroalimentación** (notas de `NOTAS_SERVICIO`, ver 6.15), cambios posteriores al envío (de `CAMBIOS_PROGRAMACION`), pendientes vinculados y quejas/dudas asociadas. La función que lo dibuja (`lineaDeVidaH`) vive en `cartera.js` y la comparte la página de cliente de la cartera.
- **Menú "Acciones ▾"** en cada fila: reúne Editar / Reasignar / Cancelar, **"Novedad de cobro"** (servicios de limpieza no cancelados; registra una novedad, ver 6.11, sin salir de la agenda) y **"Nota"** (retroalimentación del servicio, ver 6.15).
- Usa la caché de 45 s; la pantalla indica la antigüedad de los datos y el botón **"Actualizar"** fuerza una lectura nueva.

**Edición (`edicion.js`).** Para hoy y fechas futuras aparece una grilla "Programar servicios" (para fechas pasadas, ver *Registro retroactivo* más abajo):
- Cada fila: Tipo (Limpieza / Inspeccion), Cliente, Empleado, Hora inicio – Hora fin, Observaciones del día. Al seleccionar un cliente se muestra su dirección, instrucciones, checklist y si tiene coordenadas.
- Solo se ofrecen **clientes activos** (`Cliente Vigente` en `CLIENTES` **y** `Activo` en `SITIOS`) y **empleados activos** (`Estatus = Activo` en `EMPLEADOS`).
- **Validación en vivo** (mientras se escribe) y otra vez al guardar: cliente activo y con coordenadas, empleado activo y con WhatsApp, horas válidas y fin posterior al inicio, el mismo **empleado** no puede estar dos veces en el mismo cliente con el mismo tipo el mismo día, y un empleado no puede tener **horarios cruzados**. Varios empleados distintos **sí** pueden ir al mismo cliente el mismo día (servicio en equipo: una fila por empleado). Si una fila falla, no se guarda nada del lote.
- Los servicios nuevos reciben un ID `PRG-AAAAMMDD-NN` (consecutivo por fecha) y quedan en **Borrador** con `Estado_Confirmacion = Pendiente`. `Horario` se llena solo a partir de las horas (ej. `8:00-12:00`).
- **Editar / Reasignar / Cancelar** desde la tabla. "Reasignar" abre la fila con solo el empleado editable. Un servicio **ya iniciado** (con hora de entrada) no se puede cancelar ni cambiar — solo sus observaciones.
- **Cancelar** pide un motivo obligatorio. La fila **nunca se borra**: queda `Cancelado = Sí` + `Motivo_Cancelacion`. Los servicios cancelados se ignoran en check-in, confirmación y envío. Si es el **último servicio de limpieza no cancelado** de ese cliente ese día y su cobro ya tiene **pagos aplicados** (ver 6.12), la cancelación se rechaza: primero hay que anular el ingreso.
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

**Seguimiento (administrador).** La lista se filtra por responsable, estado (por defecto solo `Abierto`), tipo y "solo vencidos" (abiertos con fecha límite anterior a hoy), y ordena los vencidos primero. Acciones por fila: **Resolver** (nota opcional), **Recordar** (reenvía el mensaje como "Recordatorio", solo si ya fue enviado), **Editar**, **Cancelar** (motivo obligatorio).

**Editar (`POST /pendientes/editar`).** Solo pendientes `Abierto`. Se validan igual que al crearlos (un cliente o responsable que ya no está activo se acepta si no se cambió) y se escriben solo los campos que cambiaron. Si el pendiente **ya estaba enviado**: si cambió el responsable, el anterior recibe "ya no estás asignado/a" y el nuevo recibe el pendiente completo como "Nuevo pendiente" (si ese envío falla, el pendiente vuelve a **Borrador** para reenviarlo); si cambió otro campo que no sea las observaciones, el responsable recibe el antes → después (el SID de ese mensaje también se guarda en `PENDIENTES_MENSAJES`, así que puede responder con Reply). Cambiar solo las observaciones no avisa. Si un aviso falla, se alerta a gerencia 🔴. Queda en `PENDIENTES_HISTORIAL` como `Editado`, con cada cambio y el resultado de los avisos. Con un responsable filtrado aparece "Recordar los abiertos de …". Los recordatorios son **manuales** — no hay envío automático. Cada evento (creado, enviado, recordatorio, resuelto, sigue abierto, cancelado) queda en `PENDIENTES_HISTORIAL`.

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

Una liquidación cerrada se muestra desde la foto, **no** desde el cálculo en vivo; si después cambiaron la agenda, la tarifa o la configuración, aparece un aviso ⚠️ de que el cálculo de **horas** en vivo ya no coincide (las millas no se comparan), pero lo cerrado no se toca. Si la liquidación ya tiene un **egreso** de pago activo (ver 6.13), el resumen y el detalle la marcan **Pagada** y **no se puede reabrir** hasta anular ese egreso. **Reabrir** pide motivo y marca la liquidación como `Reabierta` (con quién, cuándo y por qué); desde ahí vuelve el cálculo en vivo, y al cerrar de nuevo se crea una liquidación nueva (siguiente `NN`) — la anterior y su foto quedan como historial.

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

### 6.11 Cartera (`/cartera`, `cartera.js`)

Lleva lo que hay que **cobrarle a cada cliente**. No envía WhatsApp. Muestra qué se ejecutó y cuánto vale; lo **cobrado** y el **saldo** salen de los ingresos aplicados (ver 6.12). Tiene sub-pestañas: Servicios · Clientes · Ingresos · Egresos · Reportes.

**Qué es un cobro.** Un cobro = **un cliente en un día**. Si ese día va un equipo (varias filas de `PROGRAMACION_DIARIA` del mismo cliente), es un solo cobro, con todos los empleados y los `ID_Programacion` listados. Las **inspecciones no se cobran** y no entran. Cada cobro se identifica por su `Clave` = `Cliente|AAAA-MM-DD` y recibe un ID `COB-AAAAMMDD-NN` (consecutivo por **fecha del servicio**). Se guardan en `COBROS_SERVICIO`.

**Sincronización con la agenda.** Cada vez que se abre una página de la cartera (como máximo una vez cada 30 s, o siempre con **"Sincronizar ahora"**), el servidor revisa los servicios desde `Fecha_Inicio_Cobros` (hoja `CONFIG_CARTERA`, por defecto el día 1 del mes en que se creó) hasta **hoy**, y para cada cliente/día decide el estado:
- **Ejecutado** — todos los servicios no cancelados están `Finalizado`. `Valor_Base` = `Tarifa_Servicio` del sitio en `SITIOS` (si no hay tarifa, queda vacío y se completa en una sincronización posterior cuando se llene).
- **Por confirmar** — fecha pasada con algún servicio sin cerrar (el motivo indica en qué estado quedaron).
- **Cancelado** — todos los servicios del día cancelados (con sus motivos).
- Un servicio de **hoy** aún sin terminar todavía no genera cobro; las fechas futuras tampoco.

Los cobros con `Decision = Auto` se actualizan solos si la agenda cambia; los que un administrador decidió a mano (`Decision = Manual`) **no se tocan** — solo se refrescan la lista de empleados y de IDs. La sincronización pasa por una cola en memoria propia (mismo patrón que agenda, pendientes y nómina).

**Acciones del administrador** (todas con motivo obligatorio de mínimo 3 caracteres, y registradas en `COBROS_BITACORA`):
- **Ejecutado** — para un cobro *Por confirmar* (o uno cancelado a mano). Valor opcional: si va vacío se usa la tarifa del sitio; si el sitio no tiene tarifa, hay que escribirlo.
- **Cancelar** — para un cobro *Por confirmar* o *Ejecutado*.
- **+ Novedad** — ver abajo.

**Novedades de cobro (`NOVEDADES_COBRO`).** Cargos que se suman al valor del servicio: `Tiempo adicional`, `Trabajo adicional`, `Productos o materiales`, `Otro cobro extra` (monto > 0), o **`Valor final del servicio`**: el administrador escribe el **total** que se va a cobrar ($0 = cortesía) y el sistema guarda la diferencia contra el total actual (puede ser negativa), con el detalle "Valor final $X (antes $Y)". Se registran desde la cartera o desde el botón **"Novedad de cobro"** de la agenda (no para inspecciones, servicios cancelados ni cobros cancelados; sí para un día cuyo cobro aún no se generó). Reciben un ID `NOV-AAAAMMDD-NN` (por **día de registro**), quedan `Retroactivo = Sí` si la fecha del servicio ya pasó, y se asocian al cobro por cliente + fecha (no por `ID_Cobro`). Se pueden **anular** con motivo; nunca se borran.

**Total a cobrar** = `Valor_Base` + suma de novedades activas. Un cobro *Ejecutado* sin valor base ni novedades se marca **"Sin tarifa"**.

**Vistas.**
- **Servicios** (`/cartera`): navegación por mes (←, Este mes, →) o "Ver todo el histórico", barra con el total del período, filtro por cliente (búsqueda con autocompletado: nombre exacto o parte del nombre) y por estado (`Por confirmar`, `Ejecutado`, `Cancelado`, `Sin tarifa`). Un renglón por cobro: fecha, cliente con su **método de pago** (etiqueta de color desde `SITIOS.Metodo_Pago`, con `Nota_Pago` al pasar el mouse) y quién paga si es distinto (`SITIOS.Pagador`), empleados, estado y motivo, valor, novedades (plegables, con botón Anular), total y acciones.
- **Clientes** (`/cartera/clientes`): una fila por cliente con servicios ejecutados, valor, novedades, total, *por confirmar* y *sin tarifa*; primero los que tienen algo por revisar, luego por total. Buscador instantáneo. El nombre lleva a la página del cliente y la flecha ⇩ a la vista Servicios filtrada.
- **Cliente** (`/cartera/cliente?c=`): totales del cliente en el período (incluidos cobrado y saldo), quién paga y la nota de pago, y un renglón por día con el equipo (horas programadas y reales de cada empleado), estado, valor, novedades, total, **estado de pago** y acciones; **"Detalle"** abre la línea de vida de cada servicio de ese día (la misma de la agenda, con el bloque de Cobro). Debajo: los **ingresos del pagador** (con botón para aplicar un saldo a favor) y las **notas** del cliente (ver 6.15).

En las vistas Servicios y Clientes también aparecen **Cobrado**, **Saldo** y una columna de **Pago** (Pendiente / Parcial / Pagado / Cortesía / Sin valor). Las acciones de cada cobro son un botón principal (Ejecutado o + Novedad) y un menú "⋯" con "Cancelar servicio".

Avisos en pantalla: falta la columna `Tarifa_Servicio` en `SITIOS`, cuántos cobros están *por confirmar* o *sin tarifa* (con enlace al filtro), o error al sincronizar.

### 6.12 Ingresos (`/cartera/pagos`, `pagos.js`)

Registra el **dinero que entra**. Nada se envía por WhatsApp.

**Tipos.** `Servicios` (pago de un cliente/pagador, que se reparte entre sus servicios) u `Otro ingreso` (categoría `Venta de productos`, `Reembolso recibido`, `Propina` u `Otro`, con concepto obligatorio; no se aplica a servicios).

**Datos de cada ingreso:** pagador, valor, fecha de recibido (no futura), método (`Efectivo`, `Cheque`, `Zelle`, `Venmo`), cuenta destino (`Personal de la propietaria`, `Corriente empresa`, `Ahorros empresa`, `Efectivo en mano`), fecha de banco opcional, código de banco opcional y referencia (cheque/Zelle). Reglas: efectivo sin cuenta = "Efectivo en mano"; Zelle y Venmo no pueden quedar "en mano"; la fecha de banco no puede ser anterior a la de recibido; Venmo exige código de transacción (único entre los ingresos activos) y fecha. Reciben un ID `PAG-AAAAMMDD-NN` (por **día de registro**) y se guardan en `PAGOS`.

**Reparto.** Un ingreso de servicios se aplica a uno o varios cobros *Ejecutado* con saldo (filas en `PAGOS_APLICACION`). No se puede aplicar más que el saldo de cada servicio ni más que el valor del ingreso. Lo que no se aplica queda como **saldo a favor** del pagador y se puede aplicar después ("Aplicar saldo").

**Estado de pago de un cobro** (calculado, nunca escrito): **Pagado**, **Parcial** (muestra pagado y saldo), **Pendiente**, **Cortesía** (total $0) o **Sin valor** (sin tarifa). Solo cuentan los ingresos activos: **anular** un ingreso (motivo obligatorio) devuelve sus servicios a pendiente.

**Por depositar.** Un ingreso sin fecha de banco está "por depositar" (o "por acreditar" si entró a una cuenta); con **"Depositado"** se registra la fecha de banco, la cuenta y el código. La **fecha efectiva** de un ingreso es la de banco o, si sigue como efectivo en mano, la de recibido; es la que usan la lista del mes y los reportes.

**Vista.** Navegación por mes o histórico, filtros por tipo, estado (`Activo`, `Anulado`, `Por depositar`), métodos y cuentas (casillas múltiples), y una barra con el total del filtro, lo por depositar y el saldo a favor sin aplicar. Los ingresos por depositar se ven en cualquier mes. Toda acción queda en `COBROS_BITACORA` y pasa por la cola en memoria de la cartera.

### 6.13 Egresos (`/cartera/egresos`, `egresos.js`)

Registra el **dinero que sale**:
- **Nómina de una liquidación** — se elige una liquidación `Cerrada` con total > 0; el valor, beneficiario y concepto ("Liquidación semana …") salen de ella. Cada liquidación admite **un solo** pago activo; mientras exista, la liquidación no se puede reabrir (ver 6.10).
- **Pago eventual a un empleado** (bono, adelanto…) — tipo `Nómina` sin liquidación, concepto "Pago eventual: …".
- **Gasto** — categoría (`Insumos y productos`, `Combustible y transporte`, `Equipos y herramientas`, `Seguros y licencias`, `Publicidad`, `Impuestos`, `Servicios (teléfono, software)`, `Créditos`, `Otro`), beneficiario, concepto y factura opcionales. Si el beneficiario coincide con el nombre de un empleado, se guarda automáticamente como **nómina** (pago eventual) y se avisa en pantalla.

Mismas reglas de método, cuenta, fecha de banco y código que los ingresos (con "fecha de pago" en lugar de "recibido"). Sin fecha de banco, un egreso de banco queda **por debitar** hasta registrar "Debitado". Reciben un ID `EGR-AAAAMMDD-NN` (por día de registro) y se guardan en `EGRESOS`; se anulan con motivo (si era el pago de una liquidación, esta vuelve a quedar por pagar). Bitácora en `COBROS_BITACORA`.

### 6.14 Reportes (`/cartera/reportes`, `reportes.js`)

Solo lectura, con secciones plegables y pestañas. Rango `desde`–`hasta` (por defecto el mes en curso), año, y filtro de métodos y cuentas. Ingresos y egresos cuentan por su **fecha efectiva**; los que aún no la tienen solo aparecen en sus listas de pendientes.
- **Antigüedad de cartera** — saldos pendientes por pagador/sitio en tramos de 0-30, 31-60, 61-90 y 90+ días desde la fecha del servicio.
- **Ingresos** y **Egresos** del rango — por cuenta × método y por categoría.
- **Movimiento por cuenta** (conciliación) — ingresos, egresos y neto por cuenta.
- **Por depositar** (efectivo en mano), **ingresos por acreditar** y **egresos por debitar**.
- **Pagos a empleados** del año (enero a diciembre), con aviso de los pagos de nómina aún por debitar y de los empleados activos sin pagos.
- **Ingresos vs egresos por mes** del año (resumen y por categoría).

### 6.15 Notas de retroalimentación (`notas.js`)

Sirven **solo para retroalimentación**: las instrucciones permanentes van en `CLIENTES.Instrucciones` y las del día en las observaciones de la agenda. Cada nota tiene fuente (`Cliente` / `Interna`), categoría (`Calidad del servicio`, `Comentario del cliente`, `Otro`), calificación opcional de 1 a 5 en medios puntos (**obligatoria** en "Calidad del servicio") y detalle. Puede ir atada a un servicio (que debe ser de ese cliente y no futuro) o ser general del cliente con una fecha. Se registran desde el menú de acciones de la agenda o desde la página del cliente en la cartera, reciben un ID `NOT-AAAAMMDD-NN`, se guardan en `NOTAS_SERVICIO` y se anulan con motivo. Se ven en la línea de vida (bloque "Retroalimentación") y en la página del cliente, con su calificación promedio.

### 6.16 Calidad de clientes (`/cartera/calidad`, `calidad.js`)

Solo lectura. Para cada cliente **vigente** calcula un semáforo:
- 🔴 **Rojo** — queja o duda abierta de urgencia alta; 2 o más quejas en los últimos 60 días; última inspección con "No cumple"; o acción correctiva de inspección pendiente.
- 🟡 **Amarillo** — 1 queja en 60 días; quejas/dudas abiertas; tareas pendientes o insumos faltantes en 2 de los últimos 3 cierres; o **sin revisión de supervisor** (inspección) desde el 5.º servicio ejecutado más reciente.
- 🟢 **Verde** — nada de lo anterior.

La lista ordena de mayor a menor riesgo, con último servicio ejecutado, número de servicios, quejas abiertas, última inspección, supervisor y calificación promedio de las notas. La ficha (`/cartera/calidad/cliente?c=`) muestra los motivos y el historial: quejas, observaciones de los últimos 10 cierres, inspecciones y la cartera del cliente (saldo por antigüedad). Un "servicio ejecutado" es uno de limpieza finalizado; varias filas del mismo cliente y día cuentan como uno.

### 6.17 Resumen (`/resumen`, `resumen.js`)

Página de inicio después del login (y destino por defecto de `volver`). Se recarga sola cada 2 minutos si la pestaña está visible. Muestra:
- **KPIs:** servicios de hoy, hoy en rojo, mañana sin notificar, cartera vencida, pendientes vencidos, quejas abiertas.
- **Hoy**, en tres columnas (Por iniciar · Iniciado · Finalizado) con semáforo por servicio: atrasado o "no puede" = rojo, a 15 min de iniciar = amarillo; sin salida pasada la hora de fin (+15 min) = rojo; salida sin cierre: amarillo, rojo a los 30 min; finalizado con entrada/salida fuera de rango o duración menor al 70 % de lo programado = rojo, llegada tarde (>15 min) o cierre con tareas/insumos pendientes = amarillo.
- **Mañana** (Sin notificar · Por confirmar · Confirmada); lo sin notificar pasa a rojo después de las 5:00 PM.
- **Cartera vencida** — saldos por pagador con más de 10 días después de su **fecha regular de cobro**, calculada con `SITIOS.Frecuencia_Cobro` (Semanal / Quincenal / Mensual) y `SITIOS.Fecha_Referencia_Cobro`; sin esos datos, se usa la fecha del servicio.
- **Seguimiento** — pendientes (vencidos primero), quejas y dudas abiertas, acciones correctivas pendientes (indicando si ya tienen un pendiente creado) y clientes sin inspección.

Los parámetros (minutos, días de gracia, hora de corte, cuántos ítems mostrar) están al principio de `resumen.js`.

### 6.18 Directorio (`/directorio`, `directorio.js`)

Alta y edición de **clientes** y **empleados** sin entrar al Sheets. Las filas **nunca se borran** (se desactivan) y el **nombre queda bloqueado** una vez creado, porque es la llave que usa el resto del sistema.
- **Cliente** — escribe a la vez en `CLIENTES` (dirección, enlace de Maps, descripción, instrucciones, ciudad, vigente/vencido) y en `SITIOS` (dirección, enlace, coordenadas, radio de tolerancia, checklist, tipo de cliente, estatus, tarifa, pagador, método y nota de pago, frecuencia y fecha de referencia de cobro). Un sitio nuevo recibe el siguiente `ID_Sitio` (ej. `SIT-NNN`). El pagador por defecto es el mismo cliente. Frecuencia y fecha de referencia de cobro van juntas o vacías.
- **Coordenadas** — se sacan del enlace de Google Maps (también enlaces cortos, que el servidor sigue solo hacia dominios de Google) o se escriben a mano como "latitud, longitud". Se guardan como texto y se aceptan con punto o coma decimal. Guardar sin coordenadas está permitido, con aviso: los check-ins de ese cliente saldrán fuera de rango.
- **Empleado** — WhatsApp (10 dígitos → se antepone el 1; no puede repetirse entre empleados), rol, estatus, tarifa por hora y dirección de residencia (sin ella, aviso: no se calculan millas).
- **Activar / desactivar** — cliente: `Cliente Vigente/Vencido` + `SITIOS.Estatus`; empleado: `Estatus`.
- Exige que existan todas sus columnas en `CLIENTES`, `SITIOS` y `EMPLEADOS` (ver sección 7); si falta alguna, la página muestra el error con los nombres. Escribe por nombre de columna, solo las celdas que cambiaron, y antepone `'` a textos que empiecen con `= + - @` para que Sheets no los tome como fórmula. Usa su propia cola en memoria.

### 6.19 Interfaz común (`layout.js`, `public/`)

Todas las páginas de administración comparten la cabecera de `layout.js`: barra con logo, secciones **Resumen · Agenda · Pendientes · Calidad · Cartera · Nómina · Directorio**, nombre del administrador y "Cerrar sesión"; sub-pestañas en Cartera (Servicios · Clientes · Ingresos · Egresos · Reportes) y Directorio (Clientes · Empleados); y tarjetas KPI. `public/tc.css` (fuente Inter) y `public/tc.js` se sirven en `/static` con caché de 1 hora y un `?v=` según la fecha del archivo, así que un cambio se ve sin forzar recarga. `tc.js` define `TC.post` (fetch JSON que manda al login si la sesión venció), `TC.toast`, `TC.alerta`, `TC.confirmar` y `TC.pedir` (diálogos con promesa que reemplazan `alert`/`confirm`/`prompt`). El pie de página y el login muestran la marca de `marca.js`.

---

## 7. Estructura de las hojas de Google Sheets relevantes

| Hoja | Contiene |
|---|---|
| `EMPLEADOS` | Nombre, número de WhatsApp (columna `ID_Telegram`, heredada), `Rol`, `Estatus` (solo los `Activo` aparecen en la agenda), `Tarifa_Hora` (USD por hora, para la nómina — se crea a mano), `Direccion_Residencia` (punto de salida y regreso para las millas — se crea a mano) |
| `CLIENTES` | Nombre (columna `clientes`), `Direccion`, `Google Maps`, `Descripcion_Servicio`, `Instrucciones`, `Cliente Vigente/Vencido`, `Ciudad` (la exige el directorio). Es la fuente **en vivo** de dirección/instrucciones cuando la fila de programación no las trae |
| `SITIOS` | `Nombre_Cliente`, coordenadas GPS (`Latitud`, `Longitud`) y radio de tolerancia para geofencing, `Checklist_Tareas` (lista separada por comas) para el formulario de cierre, `Estatus`. Para la cartera (se crean a mano, opcionales salvo la tarifa): `Tarifa_Servicio` (USD por servicio/día), `Pagador` (si paga alguien distinto del cliente), `Metodo_Pago` (Efectivo, Cheque, Zelle, Venmo…) y `Nota_Pago`. Para el resumen: `Frecuencia_Cobro` (Semanal / Quincenal / Mensual) y `Fecha_Referencia_Cobro`. El directorio exige además `ID_Sitio`, `Direccion`, `Google_Maps_Link`, `Radio_Tolerancia_m` y `Tipo_Cliente` |
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
| `CONFIG_CARTERA` | **Nueva.** Parámetros de la cartera (`Clave`, `Valor`, `Descripcion`); por ahora solo `Fecha_Inicio_Cobros` (AAAA-MM-DD). Para cargar meses anteriores, poner una fecha más antigua. **Se crea sola** |
| `COBROS_SERVICIO` | **Nueva.** Un cobro por cliente y día: `ID_Cobro`, `Clave`, `Fecha`, `Cliente`, `Pagador`, `Empleados`, `IDs_Programacion`, `Estado` (`Ejecutado` / `Por confirmar` / `Cancelado`), `Motivo`, `Valor_Base`, `Valor_Original`, `Decision` (`Auto` / `Manual`), `Decidido_Por`, `Fecha_Decision`, `Origen`, `Fecha_Creacion`. **Se crea sola** |
| `NOVEDADES_COBRO` | **Nueva.** `ID_Novedad`, `Cliente`, `Fecha_Servicio`, `ID_Programacion`, `Tipo`, `Detalle`, `Monto`, `Estado` (`Activa` / `Anulada`), `Registrado_Por`, `Fecha_Registro`, `Retroactivo`, `Anulado_Por`, `Motivo_Anulacion`. **Se crea sola** |
| `COBROS_BITACORA` | **Nueva.** Bitácora de la cartera, los ingresos y los egresos: `Fecha_Hora`, `ID_Cobro` (o `ID_Pago` / `ID_Egreso`), `Accion`, `Detalle`, `Motivo`, `Admin`. **Se crea sola** |
| `PAGOS` | **Nueva.** Un ingreso por fila: `ID_Pago`, `Tipo` (`Servicios` / `Otro ingreso`), `Pagador`, `Cliente`, `Categoria`, `Concepto`, `Valor`, `Fecha_Recibido`, `Fecha_Banco`, `Metodo`, `Cuenta_Destino`, `Venmo_ID`, `Venmo_Fecha`, `Referencia`, `Estado` (`Activo` / `Anulado`), `Motivo_Anulacion`, `Anulado_Por`, `Fecha_Anulacion`, `Registrado_Por`, `Fecha_Registro`, `Codigo_Banco`. **Se crea sola**; si le falta `Codigo_Banco`, el servidor la agrega al final |
| `PAGOS_APLICACION` | **Nueva.** Reparto de cada ingreso entre cobros: `ID_Pago`, `ID_Cobro`, `Valor_Aplicado`, `Registrado_Por`, `Fecha_Registro`. Solo se agregan filas; anular el ingreso las deja sin efecto. **Se crea sola** |
| `EGRESOS` | **Nueva.** Un egreso por fila: `ID_Egreso`, `Tipo` (`Nómina` / `Gasto`), `Beneficiario`, `ID_Liquidacion`, `Categoria`, `Concepto`, `Factura`, `Valor`, `Fecha_Pago`, `Metodo`, `Cuenta_Origen`, `Codigo_Banco`, `Referencia`, `Estado`, `Motivo_Anulacion`, `Anulado_Por`, `Fecha_Anulacion`, `Registrado_Por`, `Fecha_Registro`, `Fecha_Banco`. **Se crea sola**; si le falta `Fecha_Banco`, el servidor la agrega al final |
| `NOTAS_SERVICIO` | **Nueva.** `ID_Nota`, `Cliente`, `ID_Programacion` (vacío = nota general del cliente), `Fecha`, `Fuente`, `Categoria`, `Calificacion`, `Detalle`, `Estado` (`Activa` / `Anulada`), `Registrado_Por`, `Fecha_Registro`, `Anulado_Por`, `Motivo_Anulacion`, `Fecha_Anulacion`. **Se crea sola** |

**Columnas de `PROGRAMACION_DIARIA` que exige la agenda.** A diferencia del resto del sistema (donde las columnas son opcionales), la agenda **se niega a guardar** si falta alguna de estas: `ID_Programacion`, `Fecha_Servicio`, `Tipo_Servicio`, `Cliente`, `Empleado`, `Horario`, `Hora_Inicio`, `Hora_Fin`, `Observaciones_Puntuales`, `Estado_Envio`, `Estado_Confirmacion`, `Creado_Por`, `Fecha_Creacion`, `Modificado_Por`, `Fecha_Modificacion`, `Cancelado`, `Motivo_Cancelacion`. Las filas nuevas se escriben por **nombre de columna** (no por posición), así que el orden de las columnas puede cambiar sin romper nada.

**Columnas adicionales para el registro retroactivo:** `Registro_Retroactivo` (Sí / vacío), `Motivo_Retroactivo`, `Origen_Registro` (`Manual` cuando las horas reales las escribió un administrador). Solo se exigen al guardar en una fecha pasada. `PENDIENTES_MENSAJES` usa posiciones fijas (columna A = SID, B = ID_Pendiente) y `PENDIENTES_HISTORIAL` se escribe en orden fijo: no reordenar sus columnas. Lo mismo para las hojas de nómina (`NOMINA_AJUSTES`, `PAGOS_ADICIONALES`, `LIQUIDACIONES`, `NOMINA_DIAS`, y las de millas: `DISTANCIAS`, `NOMINA_PARADAS`, `NOMINA_MILLAS_AJUSTES`, `NOMINA_TRAMOS`, `NOMINA_MILLAS_DIA`): las filas nuevas se escriben en el orden fijo de sus encabezados (aunque se leen por nombre de columna), así que tampoco se deben reordenar. En la cartera, `COBROS_SERVICIO` y `NOVEDADES_COBRO` se escriben según los encabezados que tenga la hoja (el orden puede cambiar), pero `COBROS_BITACORA` y `CONFIG_CARTERA` se escriben en orden fijo. `PAGOS`, `PAGOS_APLICACION`, `EGRESOS` y `NOTAS_SERVICIO` se escriben según sus encabezados (el orden puede cambiar). El directorio escribe `CLIENTES`, `SITIOS` y `EMPLEADOS` por nombre de columna, pero **exige** que existan: `CLIENTES`: `clientes`, `Direccion`, `Google Maps`, `Descripcion_Servicio`, `Instrucciones`, `Ciudad`, `Cliente Vigente/Vencido`; `SITIOS`: `ID_Sitio`, `Nombre_Cliente`, `Direccion`, `Google_Maps_Link`, `Latitud`, `Longitud`, `Radio_Tolerancia_m`, `Checklist_Tareas`, `Tipo_Cliente`, `Estatus`, `Tarifa_Servicio`, `Pagador`, `Metodo_Pago`, `Nota_Pago`, `Frecuencia_Cobro`, `Fecha_Referencia_Cobro`; `EMPLEADOS`: `ID_Telegram`, `Nombre`, `Rol`, `Estatus`, `Tarifa_Hora`, `Direccion_Residencia`.

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
- **Borrar `CLAVE_ADMIN` de Render** — la ruta `/enviar-programacion` ya se retiró del código; la variable quedó sin uso.
- **Error en `/cartera/cliente`** — la plantilla de `paginaCliente` (`cartera.js`) quedó con la cabecera de una página de ingresos y usa variables que no existen ahí (`etiqueta`, `nav`, `CSS_PAGOS`), así que la página de cliente de la cartera responde con error 500 ("etiqueta is not defined"). Viene del commit `1c2eef4`. Hay que cambiarla a `layout.head` / `layout.cabecera` como las demás.
- **Cartera: llenar `Tarifa_Servicio`** (y `Metodo_Pago` / `Pagador` / `Nota_Pago` / `Frecuencia_Cobro` / `Fecha_Referencia_Cobro`) en `SITIOS` para todos los clientes activos — ahora se puede hacer desde el directorio. Sin tarifa los cobros quedan "Sin tarifa"; sin frecuencia, la cartera vencida del resumen se mide desde la fecha del servicio.
- **IDs `PAG-` repetidos en dos hojas** — los ingresos (`PAGOS`) y los conceptos de nómina (`PAGOS_ADICIONALES`) usan el mismo formato `PAG-AAAAMMDD-NN`. No chocan (cada hoja lleva su consecutivo), pero un mismo ID puede referirse a dos cosas distintas; conviene cambiar el prefijo de uno de los dos.
- **`menu.js`** solo lo usa ya la plantilla rota de `/cartera/cliente`; al corregirla se puede borrar.
- **Millas: revisar la regla de "Servicios_Pago_Siempre"** — hoy el pago fijo se aplica solo cuando el día tiene **exactamente** 2 paradas; un día con 3 o más paradas y menos de 10 millas paga $0. Confirmar si la intención era "2 o más".
- **Millas: requisitos de datos** — confirmar que `GOOGLE_MAPS_API_KEY` existe en Render y que cada empleado activo tiene `Direccion_Residencia` en `EMPLEADOS`; sin eso los días quedan en "Revisar" y bloquean el cierre.
- **Envío automático del enlace de liquidación** — hoy el administrador copia el mensaje y lo manda a mano; podría enviarse por Twilio al cerrar (requiere plantilla aprobada una vez se migre a WhatsApp Business).
- **Bloqueo de login y colas de escrituras en memoria** (agenda, pendientes, nómina, cartera —que incluye ingresos, egresos y notas— y directorio) — funcionan porque hay una sola instancia del servidor; si algún día se escala a varias instancias, habría que moverlos a un almacenamiento compartido.

**Del mapa de problemas original** (los dolores que motivaron el sistema; aún sin resolver del todo). *Ya resuelto: nómina con horas y millas automáticas (`/nomina`, ver 6.10) — el millaje ya no se saca a mano en Google Maps; y cobranza — al registrar un ingreso se ven los servicios pendientes del pagador y el saldo de cada uno (6.12).*

- **Historial de calidad al programar** — *en parte resuelto*: el historial **por cliente** ya existe (semáforo y ficha en `/cartera/calidad`, notas en la página del cliente, ver 6.15–6.16), pero no se muestra en el editor de la agenda al momento de programar, y no hay un historial **por empleado**.
- **Ingresos y egresos con estructura estándar** — *resuelto en el servidor* (6.12–6.14): mes derivado de la fecha efectiva, categorías fijas y reportes. Queda pendiente decidir qué hacer con las hojas antiguas de ingresos/egresos del Sheets.
- **Maestro de empleados** — `EMPLEADOS` es la única fuente que usa el servidor y ya se edita desde el directorio (6.18); las hojas antiguas (Valor empleados, Soporte de Nómina) no se usan.
- **Tareas recurrentes** (ej. "aspirar los viernes" en oficinas) — los pendientes cubren tareas puntuales con seguimiento por WhatsApp, pero no se repiten solos: alguien tiene que crear cada uno. Falta la recurrencia programada.

---

## 10. Cómo hacer cambios de aquí en adelante

1. Editar el archivo correspondiente (ver la sección 4: `index.js`, `logica.js`, `agenda.js`, `edicion.js`, `pendientes.js`, `nomina.js`, `millas.js`, `cartera.js`, `pagos.js`, `egresos.js`, `reportes.js`, `notas.js`, `calidad.js`, `resumen.js`, `directorio.js`, `layout.js`, `public/tc.css`, `public/tc.js`, `auth.js` o `sheets.js`) local o directo en GitHub.
2. Subir el cambio a la rama `main` del repositorio.
3. Render redespliega automáticamente al detectar el cambio.
4. Revisar la pestaña "Logs" del servicio en Render para confirmar que el despliegue fue exitoso.

**Importante:** siempre usar "Nueva versión" al reimplementar cambios que dependan de configuración externa — con Render esto es automático, no aplica el mismo cuidado que sí hacía falta con Apps Script.

**Si se agrega una variable de entorno** (como `SESSION_SECRET`, las `CLAVE_ADMIN_N` o `GOOGLE_MAPS_API_KEY`), hay que crearla en Render (*Environment*) **antes** de subir el código que la usa.
