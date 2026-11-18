// Enlaces comunes entre páginas de administración.
// Regla: un nombre de cliente o empleado, o un ID (PRG-, PND-), siempre lleva al mismo lugar.
//   cliente   → /cartera/cliente?c=      (ficha de cliente; abre en Resumen, o en la pestaña opts.tab, p. ej. 'cobros' desde la Cartera)
//   empleado  → /empleado?e=             (ficha de empleado, empleado.js; con fecha, su Semana abre en esa semana)
//   nominaEmpleado → /nomina?fecha=&empleado=  (su semana en Nómina, donde se ajusta y se cierra)
//   servicio  → /servicio?id=            (ficha de servicio, servicio.js)
//   pendiente → /pendientes?id=          (la lista mostrando solo ese pendiente)
//   liquidación (LIQ-) → /nomina?fecha=&empleado=  (la semana del empleado, donde se ve la liquidación)
//   nuevoPendiente → /pendientes?nuevo=PRG-…  (nuevo pendiente pre-llenado desde ese servicio)

const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const enc = encodeURIComponent;
const limpio = t => String(t ?? '').trim();
const RE_SERVICIO = /^PRG-\d{8}-\d+$/;

const url = {
  cliente: (c, mes, tab) => '/cartera/cliente?c=' + enc(limpio(c)) + (tab ? '&tab=' + enc(tab) : '') + (mes ? '&mes=' + enc(mes) : ''),
  calidadCliente: c => '/cartera/cliente?c=' + enc(limpio(c)) + '&tab=calidad',
  empleado: (e, fecha) => '/empleado?e=' + enc(limpio(e)) + (fecha ? '&fecha=' + enc(fecha) : ''),
  nominaEmpleado: (e, fecha) => '/nomina?' + (fecha ? 'fecha=' + enc(fecha) + '&' : '') + 'empleado=' + enc(limpio(e)),
  servicio: id => '/servicio?id=' + enc(limpio(id)),
  pendiente: id => '/pendientes?id=' + enc(limpio(id)),
  liquidacion: (empleado, semana) => '/nomina?' + (semana ? 'fecha=' + enc(semana) + '&' : '') + 'empleado=' + enc(limpio(empleado)), // la liquidación se ve en la semana del empleado
  registrarIngreso: (cliente, fecha, idCobro) => '/cartera/cliente?c=' + enc(limpio(cliente)) + (fecha ? '&mes=' + enc(String(fecha).slice(0, 7)) : '') + '&ingreso=' + enc(limpio(idCobro)), // abre el ingreso de ese cobro
  pagarLiquidacion: idLiq => '/cartera/egresos?pagar=' + enc(limpio(idLiq)), // abre el pago de esa liquidación
  nuevoPendiente: idServicio => '/pendientes?nuevo=' + enc(limpio(idServicio)), // grilla con el pendiente pre-llenado
};

const a = (href, texto, titulo) => `<a class="lnk" href="${esc(href)}" title="${esc(titulo)}">${esc(texto)}</a>`;
// opts.texto: texto visible (por defecto, el nombre o ID). Si el valor está vacío se devuelve el texto sin enlace.
const cliente = (nombre, opts = {}) => limpio(nombre) ? a(url.cliente(nombre, opts.mes, opts.tab), opts.texto ?? limpio(nombre), 'Ver ficha del cliente') : esc(opts.texto ?? nombre);
const empleado = (nombre, opts = {}) => limpio(nombre) ? a(url.empleado(nombre, opts.fecha), opts.texto ?? limpio(nombre), 'Ver ficha del empleado') : esc(opts.texto ?? nombre);
const servicio = (id, opts = {}) => limpio(id) ? a(url.servicio(id), opts.texto ?? limpio(id), 'Ver ficha del servicio') : esc(opts.texto ?? id);
const pendiente = (id, opts = {}) => limpio(id) ? a(url.pendiente(id), opts.texto ?? limpio(id), 'Ver pendiente') : esc(opts.texto ?? id);
// opts.empleado (obligatorio para enlazar) y opts.semana (lunes AAAA-MM-DD): el ID solo no dice de quién es.
const liquidacion = (id, opts = {}) => limpio(id) && limpio(opts.empleado) ? a(url.liquidacion(opts.empleado, opts.semana), opts.texto ?? limpio(id), 'Ver liquidación en Nómina') : esc(opts.texto ?? id);

module.exports = { url, cliente, empleado, servicio, pendiente, liquidacion, RE_SERVICIO };
