// Ficha de empleado: /empleado?e=<nombre>&tab=&fecha=. Junta en una página lo que hoy está repartido
// entre Nómina, Pendientes, Egresos y el Directorio. Solo lectura: lo que se edita sigue en su página.
const layout = require('./layout');
const E = require('./enlaces');
const { hoyFlorida, normalizarFecha, fechaValida, cargarPendientes, inicioSemana, sumarDias, diaSemana, filasDelRango } = require('./agenda');
const Dir = () => require('./directorio'); // carga diferida
const S = () => require('./servicio'); // estilos de las fichas (tarjetas, chips)
const Nm = () => require('./nomina'); // cálculo de la semana y liquidaciones (solo lectura)

const esc = layout.esc;
const limpio = t => String(t ?? '').trim();
const usd = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = t => { const x = parseFloat(String(t ?? '').replace(/[$,\s]/g, '')); return isFinite(x) ? x : 0; };

const TABS = [['resumen', 'Resumen'], ['semana', 'Semana'], ['pendientes', 'Pendientes'], ['nomina', 'Nómina'], ['datos', 'Datos']];
const DEFECTO = 'resumen';
const url = (e, o = {}) => '/empleado?' + Object.entries({ e, ...o }).filter(([, v]) => v).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
const urlEditar = e => '/directorio/empleados?editar=' + encodeURIComponent(e);
const urlNomina = (e, fecha) => '/nomina?' + (fecha ? 'fecha=' + encodeURIComponent(fecha) + '&' : '') + 'empleado=' + encodeURIComponent(e);
const vencido = (p, hoy) => p.Estado === 'Abierto' && fechaValida(normalizarFecha(p.Fecha_Limite)) && normalizarFecha(p.Fecha_Limite) < hoy;

const CSS = `.fs-acc .btn{margin:0;} .em-sub{margin:-6px 0 14px;color:var(--gray-d);font-size:14.5px;}
.em-cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:start;} @media(max-width:900px){.em-cols{grid-template-columns:1fr;}}
.kpi small{font-weight:400;font-size:12px;color:var(--gray-d);} tr.venc td{background:#fef2f2;} tr.anu td{color:var(--gray);} .em-nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 14px;}`;

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

// ---------- pestaña Resumen: KPIs, siguiente paso y tres tarjetas ----------
const CHIP_ESTADO = { Confirmado: 'ok', Finalizado: 'ok', Enviado: 'am', 'Salida (falta cierre)': 'am', 'No puede': 'mal', 'En curso': 'az' };
async function tabResumen(nombre, x, hoy) {
  const { fmtDur } = Nm().calculoTexto;
  const lunes = inicioSemana(hoy), lunesAnt = sumarDias(lunes, -7);
  const [w, liqs, pends, filas] = await Promise.all([Nm().semanaEmpleado(nombre, hoy), Nm().liquidacionesEmpleado(nombre), cargarPendientes(),
    filasDelRango(lunesAnt, sumarDias(hoy, 7))]);
  const mias = filas.filter(r => limpio(r.Empleado) === nombre && r._estado !== 'Cancelado')
    .sort((a, b) => a._fecha.localeCompare(b._fecha) || String(a.Hora_Inicio || a.Horario || '').localeCompare(String(b.Hora_Inicio || b.Horario || '')));
  const abiertos = pends.filter(p => limpio(p.Responsable) === nombre && p.Estado === 'Abierto')
    .sort((a, b) => (vencido(b, hoy) - vencido(a, hoy)) || (normalizarFecha(a.Fecha_Limite) || '9').localeCompare(normalizarFecha(b.Fecha_Limite) || '9'));
  const vencidos = abiertos.filter(p => vencido(p, hoy));
  const porPagar = liqs.filter(l => l.Estado === 'Cerrada' && !l.pago).sort((a, b) => a._semana.localeCompare(b._semana));
  const totPorPagar = porPagar.reduce((a, l) => a + num(l.Total), 0);
  const dia = f => `${diaSemana(f)} ${f.slice(8)}/${f.slice(5, 7)}`;
  const hora = r => (r.Hora_Inicio && r.Hora_Fin) ? r.Hora_Inicio + '–' + r.Hora_Fin : (r.Horario || '');

  const semana = w.rows.map(c => c.r);
  const kp = layout.kpis([
    ['Esta semana', `${semana.length} servicio(s)<br><small>${semana.filter(r => r._estado === 'Finalizado').length} hechos</small>`],
    ['Horas pagadas', `${fmtDur(w.t.min)}<br><small>${w.t.cerrada ? 'semana cerrada' : 'semana en curso'}</small>`],
    ['Millas', `${usd(w.t.millas)}<br><small>esta semana</small>`],
    ['Pendientes', `${abiertos.length}<br><small>${vencidos.length} vencido(s)</small>`, vencidos.length ? 'neg' : ''],
    ['Por pagar', `${usd(totPorPagar)}<br><small>${porPagar.length} liquidación(es) cerrada(s)</small>`, porPagar.length ? 'neg' : ''],
  ]);

  // siguiente paso, en este orden: no puede → sin check-in o sin cierre → semana anterior sin cerrar → sin pagar → pendiente vencido → faltan datos → al día
  const caja = (cls, titulo, texto, href, boton) => `<div class="fs-sig${cls ? ' ' + cls : ''}"><div><span class="t">${esc(titulo)}</span>${texto}</div>${href ? `<a class="btn hoy" href="${esc(href)}">${esc(boton)}</a>` : ''}</div>`;
  const SP = 'SIGUIENTE PASO';
  const noPuede = mias.find(r => r._fecha >= hoy && r._estado === 'No puede');
  const sinEntrada = mias.find(r => r._fecha < hoy && !r.Hora_Entrada_Real && r._estado !== 'No puede');
  const sinCierre = mias.find(r => r._fecha <= hoy && r._estado === 'Salida (falta cierre)');
  const antSinCerrar = mias.some(r => r._fecha >= lunesAnt && r._fecha < lunes) && !liqs.some(l => l.Estado === 'Cerrada' && l._semana === lunesAnt);
  const faltan = x ? [x.wa.length >= 10 ? '' : 'WhatsApp', x.dir ? '' : 'dirección de residencia'].filter(Boolean) : [];
  let sig;
  if (noPuede) sig = caja('mal', SP, `Dijo que <b>no puede</b> el ${esc(dia(noPuede._fecha))} (${esc(noPuede.Cliente)})${noPuede.Motivo_No_Puede ? ': ' + esc(noPuede.Motivo_No_Puede) : ''}. Hay que reasignar el servicio.`,
    '/agenda?fecha=' + noPuede._fecha + '&id=' + encodeURIComponent(noPuede.ID_Programacion), 'Reasignar en la agenda →');
  else if (sinEntrada) sig = caja('mal', SP, `El servicio del ${esc(dia(sinEntrada._fecha))} (${esc(sinEntrada.Cliente)}) <b>no tiene check-in</b>. Revisa si se hizo.`, E.url.servicio(sinEntrada.ID_Programacion), 'Revisar el servicio →');
  else if (sinCierre) sig = caja('', SP, `Salió del servicio del ${esc(dia(sinCierre._fecha))} (${esc(sinCierre.Cliente)}) pero <b>no hizo el cierre</b>.`, E.url.servicio(sinCierre.ID_Programacion), 'Ver el servicio →');
  else if (antSinCerrar) sig = caja('', SP, `La liquidación de la semana del ${esc(lunesAnt)} <b>no está cerrada</b>.`, urlNomina(nombre, lunesAnt), 'Cerrar en Nómina →');
  else if (porPagar.length) sig = caja('', SP, `La liquidación de la semana del ${esc(porPagar[0]._semana)} está <b>cerrada y sin pagar</b> (${usd(num(porPagar[0].Total))})${porPagar.length > 1 ? `; hay ${porPagar.length} por pagar` : ''}.`, E.url.pagarLiquidacion(porPagar[0].ID_Liquidacion), 'Registrar pago →');
  else if (vencidos.length) sig = caja('', SP, `Tiene ${vencidos.length} <b>pendiente(s) vencido(s)</b>; el más antiguo: "${esc(vencidos[0].Titulo || vencidos[0].ID_Pendiente)}" (límite ${esc(normalizarFecha(vencidos[0].Fecha_Limite))}).`, E.url.pendiente(vencidos[0].ID_Pendiente), 'Ver el pendiente →');
  else if (faltan.length) sig = caja('', SP, `Falta su <b>${esc(faltan.join(' y '))}</b> en el Directorio${x.dir ? '' : ' (sin ella no se calculan millas)'}.`, urlEditar(nombre), 'Editar datos →');
  else sig = caja('ok', 'AL DÍA', 'Sin servicios por reasignar o por revisar, liquidaciones cerradas y pagadas, sin pendientes vencidos.');

  const lst = filas => `<div class="fs-lst">${filas.join('') || '<div><small>Nada.</small></div>'}</div>`;
  const cardSemana = `<div class="fs-card"><h3>Esta semana · ${esc(dia(w.lunes))}–${esc(dia(w.domingo))}</h3>${lst(semana.map(r =>
    `<div><span><b>${esc(dia(r._fecha))}</b> <small>${esc(hora(r))}</small><br><small>${E.servicio(r.ID_Programacion, { texto: r.Cliente })}${r.Tipo_Servicio && r.Tipo_Servicio !== 'Limpieza' ? ' · ' + esc(r.Tipo_Servicio) : ''}</small></span><span class="chip ${CHIP_ESTADO[r._estado] || ''}">${esc(r._estado)}</span></div>`))}
  <div class="fs-par"><a href="${esc(url(nombre, { tab: 'semana' }))}">Ver la semana completa →</a></div></div>`;
  const cardPend = `<div class="fs-card"><h3>Pendientes abiertos</h3>${lst(abiertos.slice(0, 5).map(p =>
    `<div><span><b>${E.pendiente(p.ID_Pendiente, { texto: p.Titulo || p.ID_Pendiente })}</b><br><small>${p.Cliente ? esc(p.Cliente) + ' · ' : ''}límite ${esc(normalizarFecha(p.Fecha_Limite)) || '—'}</small></span>${vencido(p, hoy) ? '<span class="chip mal">Vencido</span>' : '<span class="chip am">Abierto</span>'}</div>`))}
  <div class="fs-par"><a href="${esc(url(nombre, { tab: 'pendientes' }))}">Ver todos sus pendientes →</a></div></div>`;
  const filaAbierta = w.t.cerrada ? [] : [`<div><span><b>Semana ${esc(w.lunes)}</b><br><small>abierta · ${usd(w.t.total)} hasta ahora</small></span><span class="chip">Abierta</span></div>`];
  const cardNom = `<div class="fs-card"><h3>Nómina · últimas liquidaciones</h3>${lst(filaAbierta.concat(liqs.filter(l => l.Estado === 'Cerrada').slice(0, 4).map(l =>
    `<div><span><b>Semana ${esc(l._semana)}</b><br><small>${esc(l.ID_Liquidacion)} · ${usd(num(l.Total))}</small></span>${l.pago ? '<span class="chip ok">Pagada</span>' : `<a class="chip am" href="${esc(E.url.pagarLiquidacion(l.ID_Liquidacion))}">Por pagar →</a>`}</div>`)))}
  <div class="fs-par"><a href="${esc(url(nombre, { tab: 'nomina' }))}">Ver todas las liquidaciones →</a></div></div>`;
  return `${kp}${sig}<div class="em-cols">${cardSemana}${cardPend}${cardNom}</div>`;
}

// ---------- pestaña Semana (solo lectura; se ajusta y se cierra en Nómina) ----------
const CHIP_CALC = { Calculado: 'ok', Ajustado: 'az', Revisar: 'mal' };
async function tabSemana(nombre, fecha, hoy) {
  const { fmtDur, f12 } = Nm().calculoTexto;
  const w = await Nm().semanaEmpleado(nombre, fecha), t = w.t;
  const ir = f => url(nombre, { tab: 'semana', fecha: f });
  const nav = `<div class="em-nav"><a class="btn" href="${esc(ir(sumarDias(w.lunes, -7)))}">←</a><a class="btn${inicioSemana(hoy) === w.lunes ? ' hoy' : ''}" href="${esc(ir(hoy))}">Esta semana</a><a class="btn" href="${esc(ir(sumarDias(w.lunes, 7)))}">→</a>
  <b>Semana ${esc(w.lunes)} → ${esc(w.domingo)}</b><a class="btn hoy" style="margin-left:auto;" href="${esc(urlNomina(nombre, w.lunes))}">Abrir en Nómina para ajustar o cerrar →</a></div>`;
  const kp = layout.kpis([['Servicios', t.n], ['Horas pagadas', fmtDur(t.min)], ['Monto horas', usd(t.montoH)], ['Millas', usd(t.millas)],
    ['Propinas y bonos', usd(t.mas)], ['Descuentos', (t.menos ? '− ' : '') + usd(t.menos)], ['Total a pagar', usd(t.total)]]);
  const aviso = t.cerrada ? `<div class="aviso">Semana <b>cerrada</b> (${esc(t.id)}): los totales son los congelados al cerrar. El detalle de horas y millas cerrado está en Nómina.</div>`
    : t.rev ? `<div class="aviso r">${t.rev} punto(s) por revisar en Nómina (servicios sin check-in o sin tarifa, días con millas por revisar). Quedan en $0 y no dejan cerrar la liquidación.</div>`
    : '<div class="aviso">Semana abierta: horas y millas calculadas en vivo, igual que en Nómina.</div>';
  const filas = w.rows.map(c => {
    const r = c.r;
    return `<tr><td>${esc(diaSemana(r._fecha))} ${esc(r._fecha.slice(8))}</td><td>${E.cliente(r.Cliente, { mes: r._fecha.slice(0, 7) })}<br><small>${E.servicio(r.ID_Programacion, { texto: r.Tipo_Servicio || 'Limpieza' })}</small></td>
      <td>${f12(c.prog.ini)} – ${f12(c.prog.fin)}</td><td>${f12(c.real.ini)} – ${f12(c.real.fin)}</td>
      ${t.cerrada ? '' : `<td>${c.pago.ini !== null ? `${f12(c.pago.ini)} – ${f12(c.pago.fin)}` : '—'}</td><td class="num">${c.min ? fmtDur(c.min) : '—'}</td><td class="num">${usd(c.monto)}</td>`}
      <td><span class="chip ${CHIP_CALC[c.estado] || ''}">${esc(c.estado)}</span>${c.nota ? `<br><small>${esc(c.nota)}</small>` : ''}${c.sinTarifa ? '<br><small>Sin tarifa</small>' : ''}</td></tr>`;
  }).join('') || `<tr><td colspan="${t.cerrada ? 5 : 8}" style="text-align:center;color:#888;padding:16px;">Sin servicios esta semana.</td></tr>`;
  const canc = w.canceladas.length ? `<p><small>Cancelados esta semana: ${w.canceladas.map(r => `${esc(diaSemana(r._fecha))} ${esc(r._fecha.slice(8))} ${E.servicio(r.ID_Programacion, { texto: r.Cliente })}`).join(' · ')}</small></p>` : '';
  return `${nav}${kp}${aviso}
<div class="scroll"><table><tr><th>Día</th><th>Servicio</th><th>Programado</th><th>Real (check-in)</th>${t.cerrada ? '' : '<th>Pagado</th><th class="num">Horas</th><th class="num">Monto</th>'}<th>Estado</th></tr>${filas}</table></div>${canc}`;
}

// ---------- pestaña Nómina: liquidaciones ----------
const SCRIPT_COPIAR = `function tcCopiar(b){var t=b.dataset.msg.replace('{URL}',location.origin+b.dataset.path);function ok(){TC.toast('Mensaje copiado.');}function fb(){TC.alerta(t,{titulo:'Copia el mensaje'});}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,fb);}else{fb();}}`;
async function tabNomina(nombre) {
  const { fmtDur } = Nm().calculoTexto;
  const todas = await Nm().liquidacionesEmpleado(nombre), ls = todas.slice(0, 12);
  const porPagar = todas.filter(l => l.Estado === 'Cerrada' && !l.pago);
  const filas = ls.map(l => {
    let est, acc = '';
    if (l.Estado === 'Cerrada') {
      const e = Nm().enlaceLiquidacion(l);
      const copiar = `<button type="button" class="btn mini" data-msg="${esc(e.msg)}" data-path="${esc(e.ruta)}" onclick="tcCopiar(this)">Copiar mensaje con enlace</button>`;
      if (l.pago) { est = `<span class="chip ok">Pagada</span><br><small>${esc(l.pago.ID_Egreso)}${l.pago.Fecha_Pago ? ' · ' + esc(normalizarFecha(l.pago.Fecha_Pago) || l.pago.Fecha_Pago) : ''}</small>`; acc = copiar; }
      else { est = '<span class="chip am">Por pagar</span>'; acc = `<a class="btn mini hoy" href="${esc(E.url.pagarLiquidacion(l.ID_Liquidacion))}">Registrar pago</a> ${copiar}`; }
    } else est = `<span class="chip">${esc(l.Estado || '—')}</span>${l.Estado === 'Reabierta' ? `<br><small>${esc(l.Reabierto_Por)}${l.Motivo_Reapertura ? ': ' + esc(l.Motivo_Reapertura) : ''}</small>` : ''}`;
    return `<tr${l.Estado === 'Reabierta' ? ' class="anu"' : ''}><td><a href="${esc(urlNomina(nombre, l._semana))}">${esc(l._semana)}</a><br><small>${esc(l.ID_Liquidacion)}</small></td>
      <td class="num">${num(l.Servicios)}</td><td class="num">${fmtDur(num(l.Minutos))}</td><td class="num">${usd(num(l.Monto_Horas))}</td><td class="num">${usd(num(l.Monto_Millas))}</td>
      <td class="num"><b>${usd(num(l.Total))}</b></td><td>${est}</td><td>${acc}<br><small>Cerrada por ${esc(l.Cerrado_Por)}${l.Fecha_Cierre ? ' · ' + esc(l.Fecha_Cierre) : ''}</small></td></tr>`;
  }).join('') || '<tr><td colspan="8" style="text-align:center;color:#888;padding:16px;">Todavía no tiene liquidaciones cerradas.</td></tr>';
  return `${layout.kpis([['Por pagar', usd(porPagar.reduce((a, l) => a + num(l.Total), 0)), porPagar.length ? 'neg' : ''], ['Liquidaciones por pagar', porPagar.length], ['Pagadas', todas.filter(l => l.pago).length]])}
<div class="aviso">La semana en curso aparece aquí cuando se cierra su liquidación en Nómina; mientras tanto, ver la pestaña Semana. Una liquidación <b>reabierta</b> aparece tachada: la vigente es la que se cierre de nuevo.</div>
<div class="fs-acc"><a class="btn" href="/cartera/egresos">Ver pagos en Egresos →</a></div>
<div class="scroll"><table><tr><th>Semana</th><th class="num">Servicios</th><th class="num">Horas</th><th class="num">Horas $</th><th class="num">Millas</th><th class="num">Total</th><th>Estado</th><th></th></tr>${filas}</table></div>
${todas.length > 12 ? `<p><small>Se muestran las últimas 12 de ${todas.length}.</small></p>` : ''}
<script>${SCRIPT_COPIAR}</script>`;
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
  const tab = TABS.some(([k]) => k === query.tab) ? query.tab : DEFECTO;

  let x = null, errDir = '';
  try { x = (await Dir().leerEmpleados(false)).lista.find(o => o.nombre === nombre) || null; }
  catch (e) { console.error('Error leyendo EMPLEADOS:', e.message); errDir = e.message; }

  const chips = x ? `<span class="chip ${x.act ? 'ok' : ''}">${esc(x.estado)}</span>${x.rol ? ` <span class="chip az">${esc(x.rol)}</span>` : ''}` : '<span class="chip am">No está en el Directorio</span>';
  const sub = x ? [x.wa.length >= 10 ? 'WhatsApp +' + esc(x.wa) : '<span class="neg">Sin WhatsApp válido</span>', x.tarifa === '' ? '<span class="neg">sin tarifa</span>' : usd(x.tarifa) + '/h',
    x.dir ? 'vive en ' + esc(x.dir) : '<span class="neg">sin dirección (no se calculan millas)</span>'].join(' · ') : '';

  let cuerpo;
  if (tab === 'resumen') cuerpo = await tabResumen(nombre, x, hoy);
  else if (tab === 'datos') cuerpo = tabDatos(nombre, x, errDir);
  else if (tab === 'semana') cuerpo = await tabSemana(nombre, fecha || hoy, hoy);
  else if (tab === 'nomina') cuerpo = await tabNomina(nombre);
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
