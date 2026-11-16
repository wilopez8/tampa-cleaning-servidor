// Enlaces comunes entre páginas de administración.
// Regla: un nombre de cliente o empleado, o un ID (PRG-, PND-), siempre lleva al mismo lugar.
//   cliente   → /cartera/cliente?c=      (cobros, servicios con su línea de vida, ingresos y notas)
//   empleado  → /nomina?empleado=        (su semana: servicios, horas, millas y liquidación)
//   servicio  → /servicio?id=            (redirige al día de la agenda con el Detalle abierto)
//   pendiente → /pendientes?id=          (la lista mostrando solo ese pendiente)
//   nuevoPendiente → /pendientes?nuevo=PRG-…  (nuevo pendiente pre-llenado desde ese servicio)
const { leerHoja } = require('./sheets');

const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const enc = encodeURIComponent;
const limpio = t => String(t ?? '').trim();
const RE_SERVICIO = /^PRG-\d{8}-\d+$/;

const url = {
  cliente: (c, mes) => '/cartera/cliente?c=' + enc(limpio(c)) + (mes ? '&mes=' + enc(mes) : ''),
  calidadCliente: c => '/cartera/calidad/cliente?c=' + enc(limpio(c)),
  empleado: (e, fecha) => '/nomina?' + (fecha ? 'fecha=' + enc(fecha) + '&' : '') + 'empleado=' + enc(limpio(e)),
  servicio: id => '/servicio?id=' + enc(limpio(id)),
  pendiente: id => '/pendientes?id=' + enc(limpio(id)),
  registrarIngreso: (cliente, fecha, idCobro) => '/cartera/cliente?c=' + enc(limpio(cliente)) + (fecha ? '&mes=' + enc(String(fecha).slice(0, 7)) : '') + '&ingreso=' + enc(limpio(idCobro)), // abre el ingreso de ese cobro
  pagarLiquidacion: idLiq => '/cartera/egresos?pagar=' + enc(limpio(idLiq)), // abre el pago de esa liquidación
  nuevoPendiente: idServicio => '/pendientes?nuevo=' + enc(limpio(idServicio)), // grilla con el pendiente pre-llenado
};

const a = (href, texto, titulo) => `<a class="lnk" href="${esc(href)}" title="${esc(titulo)}">${esc(texto)}</a>`;
// opts.texto: texto visible (por defecto, el nombre o ID). Si el valor está vacío se devuelve el texto sin enlace.
const cliente = (nombre, opts = {}) => limpio(nombre) ? a(url.cliente(nombre, opts.mes), opts.texto ?? limpio(nombre), 'Ver cliente') : esc(opts.texto ?? nombre);
const empleado = (nombre, opts = {}) => limpio(nombre) ? a(url.empleado(nombre, opts.fecha), opts.texto ?? limpio(nombre), 'Ver su semana en Nómina') : esc(opts.texto ?? nombre);
const servicio = (id, opts = {}) => limpio(id) ? a(url.servicio(id), opts.texto ?? limpio(id), 'Ver servicio en la agenda') : esc(opts.texto ?? id);
const pendiente = (id, opts = {}) => limpio(id) ? a(url.pendiente(id), opts.texto ?? limpio(id), 'Ver pendiente') : esc(opts.texto ?? id);

// Fecha de un servicio: la de PROGRAMACION_DIARIA; si no se encuentra, la que trae el propio ID (PRG-AAAAMMDD-NN).
async function fechaServicio(id) {
  const { normalizarFecha, fechaValida } = require('./agenda'); // carga diferida: agenda.js usa este módulo
  try {
    const datos = await leerHoja('PROGRAMACION_DIARIA', { cache: true });
    const enc0 = datos[0] || [];
    const iId = enc0.indexOf('ID_Programacion'), iF = enc0.indexOf('Fecha_Servicio');
    const fila = iId >= 0 ? datos.slice(1).find(r => String(r[iId] || '').trim() === id) : null;
    const f = fila && iF >= 0 ? normalizarFecha(fila[iF]) : '';
    if (fechaValida(f)) return f;
  } catch (e) { console.error('Error buscando la fecha del servicio ' + id + ':', e); }
  const m = id.match(/^PRG-(\d{4})(\d{2})(\d{2})-/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function rutas(app, auth) {
  app.get('/servicio', auth.requiereAdmin, async (req, res) => {
    const id = limpio(req.query.id);
    if (!RE_SERVICIO.test(id)) return res.redirect('/agenda');
    const fecha = await fechaServicio(id);
    res.redirect('/agenda?' + (fecha ? 'fecha=' + fecha + '&' : '') + 'id=' + enc(id));
  });
}

module.exports = { url, cliente, empleado, servicio, pendiente, rutas, RE_SERVICIO };
