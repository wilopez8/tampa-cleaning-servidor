// Ficha de empleado: /empleado?e=<nombre>&tab=&fecha=. Junta en una página lo que hoy está repartido
// entre Nómina, Pendientes, Egresos y el Directorio. Solo lectura: lo que se edita sigue en su página.
const layout = require('./layout');
const E = require('./enlaces');
const { hoyFlorida, normalizarFecha, fechaValida, cargarPendientes } = require('./agenda');
const Dir = () => require('./directorio'); // carga diferida
const S = () => require('./servicio'); // estilos de las fichas (tarjetas, chips)

const esc = layout.esc;
const limpio = t => String(t ?? '').trim();
const usd = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TABS = [['pendientes', 'Pendientes'], ['datos', 'Datos']];
const url = (e, o = {}) => '/empleado?' + Object.entries({ e, ...o }).filter(([, v]) => v).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
const urlEditar = e => '/directorio/empleados?editar=' + encodeURIComponent(e);
const urlNomina = (e, fecha) => '/nomina?' + (fecha ? 'fecha=' + encodeURIComponent(fecha) + '&' : '') + 'empleado=' + encodeURIComponent(e);
const vencido = (p, hoy) => p.Estado === 'Abierto' && fechaValida(normalizarFecha(p.Fecha_Limite)) && normalizarFecha(p.Fecha_Limite) < hoy;

const CSS = `.fs-acc .btn{margin:0;} .em-sub{margin:-6px 0 14px;color:var(--gray-d);font-size:14.5px;}
.em-cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:start;} @media(max-width:900px){.em-cols{grid-template-columns:1fr;}}
tr.venc td{background:#fef2f2;}`;

// ---------- pestaña Pendientes ----------
async function tabPendientes(nombre, hoy) {
  const ps = (await cargarPendientes()).filter(p => limpio(p.Responsable) === nombre);
  const abiertos = ps.filter(p => p.Estado === 'Abierto')
    .sort((a, b) => (vencido(b, hoy) - vencido(a, hoy)) || (normalizarFecha(a.Fecha_Limite) || '9').localeCompare(normalizarFecha(b.Fecha_Limite) || '9'));
  const otros = ps.filter(p => p.Estado !== 'Abierto').sort((a, b) => b.ID_Pendiente.localeCompare(a.ID_Pendiente)).slice(0, 20);
  const nV = abiertos.filter(p => vencido(p, hoy)).length;
  const estado = p => vencido(p, hoy) ? '<span class="chip mal">Vencido</span>' : p.Estado === 'Abierto' ? '<span class="chip am">Abierto</span>' : `<span class="chip${p.Estado === 'Cerrado' ? ' ok' : ''}">${esc(p.Estado)}</span>`;
  const fila = (p, cerr) => `<tr${vencido(p, hoy) ? ' class="venc"' : ''}><td><b>${E.pendiente(p.ID_Pendiente, { texto: p.Titulo || p.ID_Pendiente })}</b><br><small>${esc(p.ID_Pendiente)}${p.Tipo ? ' · ' + esc(p.Tipo) : ''}${p.Prioridad === 'Alta' ? ' · ❗ Alta' : ''}</small></td>
    <td>${p.Cliente ? E.cliente(p.Cliente) : '<small>—</small>'}${p.ID_Programacion ? '<br><small>' + E.servicio(p.ID_Programacion) + '</small>' : ''}</td>
    <td>${esc(normalizarFecha(p.Fecha_Limite)) || '<small>—</small>'}</td>
    <td>${estado(p)}${cerr ? '' : `<br><small>${p.Estado_Envio === 'Enviado' ? 'Enviado por WhatsApp' : 'Sin enviar'}</small>`}</td>
    ${cerr ? `<td><small>${esc(p.Cerrado_Por)}${p.Fecha_Cierre ? ' · ' + esc(p.Fecha_Cierre) : ''}${p.Nota_Cierre ? '<br>' + esc(p.Nota_Cierre) : ''}</small></td>` : ''}</tr>`;
  const vacio = n => `<tr><td colspan="${n}" style="text-align:center;color:#888;padding:16px;">Ninguno.</td></tr>`;
  return `${layout.kpis([['Abiertos', abiertos.length], ['Vencidos', nV, nV ? 'neg' : ''], ['Cerrados o cancelados', ps.length - abiertos.length]])}
<div class="fs-acc"><a class="btn" href="${esc('/pendientes?responsable=' + encodeURIComponent(nombre))}">Ver en Pendientes →</a></div>
<h3>Abiertos</h3>
<div class="scroll"><table><tr><th>Pendiente</th><th>Cliente / servicio</th><th>Fecha límite</th><th>Estado</th></tr>${abiertos.map(p => fila(p, false)).join('') || vacio(4)}</table></div>
<h3 style="margin-top:18px;">Cerrados y cancelados <small>(últimos 20)</small></h3>
<div class="scroll"><table><tr><th>Pendiente</th><th>Cliente / servicio</th><th>Fecha límite</th><th>Estado</th><th>Cierre</th></tr>${otros.map(p => fila(p, true)).join('') || vacio(5)}</table></div>`;
}

// ---------- pestaña Datos ----------
function tabDatos(nombre, x, errDir) {
  if (!x) return `<div class="aviso r">${errDir ? 'No se pudo leer el Directorio: ' + esc(errDir) : 'Este empleado no está en el Directorio (hoja EMPLEADOS).'}</div><p><a class="btn" href="/directorio/empleados">Ir al Directorio</a></p>`;
  const v = t => t === '' || t === undefined || t === null ? '<small>—</small>' : esc(t);
  const par = (k, val) => `<div class="fs-par"><span>${esc(k)}</span>${val}</div>`;
  const card = (t, cuerpo) => `<div class="fs-card"><h3>${t}</h3>${cuerpo}</div>`;
  return `<div class="fs-acc"><a class="btn hoy" href="${esc(urlEditar(nombre))}">Editar en el Directorio →</a></div>
<div class="em-cols">
${card('Contacto', par('WhatsApp', x.wa.length >= 10 ? '+' + esc(x.wa) : '<span class="neg">Falta o no es válido</span>') + par('Rol', v(x.rol)) + par('Estado', esc(x.estado)))}
${card('Pago', par('Tarifa por hora', x.tarifa === '' ? '<span class="neg">Sin tarifa: sus horas salen en $0</span>' : usd(x.tarifa) + '/h'))}
${card('Millas', par('Dirección de residencia', x.dir ? esc(x.dir) : '<span class="neg">Falta: no se le calculan millas</span>') + '<p><small>Las millas se calculan desde esta dirección hasta el primer servicio del día y entre servicios.</small></p>')}
</div>`;
}

// ---------- página ----------
async function pagina(query, admin) {
  const nombre = limpio(query.e);
  if (!nombre) return null;
  const hoy = hoyFlorida();
  const fecha = fechaValida(query.fecha) ? query.fecha : '';
  const tab = TABS.some(([k]) => k === query.tab) ? query.tab : TABS[0][0];

  let x = null, errDir = '';
  try { x = (await Dir().leerEmpleados(false)).lista.find(o => o.nombre === nombre) || null; }
  catch (e) { console.error('Error leyendo EMPLEADOS:', e.message); errDir = e.message; }

  const chips = x ? `<span class="chip ${x.act ? 'ok' : ''}">${esc(x.estado)}</span>${x.rol ? ` <span class="chip az">${esc(x.rol)}</span>` : ''}` : '<span class="chip am">No está en el Directorio</span>';
  const sub = x ? [x.wa.length >= 10 ? 'WhatsApp +' + esc(x.wa) : '<span class="neg">Sin WhatsApp válido</span>', x.tarifa === '' ? '<span class="neg">sin tarifa</span>' : usd(x.tarifa) + '/h',
    x.dir ? 'vive en ' + esc(x.dir) : '<span class="neg">sin dirección (no se calculan millas)</span>'].join(' · ') : '';

  let cuerpo;
  if (tab === 'datos') cuerpo = tabDatos(nombre, x, errDir);
  else cuerpo = await tabPendientes(nombre, hoy);

  return `${layout.head(nombre, S().CSS + CSS)}
${layout.cabecera({ tituloHtml: `${esc(nombre)} ${chips}`, seccion: '/directorio', admin, ruta: [['Directorio', '/directorio/clientes'], ['Empleados', '/directorio/empleados'], [nombre]] })}
${sub ? `<p class="em-sub">${sub}</p>` : ''}
<div class="fs-acc">${x ? `<a class="btn" href="${esc(urlEditar(nombre))}">Editar datos</a>` : ''}<a class="btn" href="${esc(urlNomina(nombre, fecha))}">Ver semana en Nómina</a></div>
<div class="tc-tabs">${TABS.map(([k, t]) => `<a href="${esc(url(nombre, { tab: k, fecha }))}"${k === tab ? ' class="act"' : ''}>${t}</a>`).join('')}</div>
${cuerpo}
</body></html>`;
}

function rutas(app, auth) {
  app.get('/empleado', auth.requiereAdmin, async (req, res) => {
    try {
      const html = await pagina(req.query, req.admin);
      if (html === null) return res.redirect('/directorio/empleados');
      res.set('Content-Type', 'text/html; charset=utf-8'); res.send(html);
    } catch (e) { console.error('Error en GET /empleado:', e); res.status(500).send('Error cargando la ficha del empleado: ' + e.message); }
  });
}

module.exports = { rutas, url };
