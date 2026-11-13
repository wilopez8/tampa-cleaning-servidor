const { leerHoja, edadCacheSegundos } = require('./sheets');
const { normalizarFecha, fechaValida, hoyFlorida, sumarDias, diaSemana, filasDelRango, cargarPendientes, tipoDe } = require('./agenda');
const layout = require('./layout');
const { zonaHoraria: ZONA } = require('./empresa');
const Cart = require('./cartera');
const P = require('./pagos');
const Cal = require('./calidad');
const { cargarTabla, cargarTarifas, armar, usd, esc, CS_H, NV_H } = Cart.helpers;

// ---------- parámetros (un solo lugar) ----------
const GRACIA_COBRO = 10;      // días después de la fecha regular de cobro para considerar vencido
const AVISO_MIN = 15;         // minutos: amarillo antes de iniciar / después de la hora de fin / llegada tarde
const CIERRE_MIN = 30;        // minutos con salida registrada y sin cierre antes de pasar a rojo
const DURACION_MIN = 0.7;     // duración real mínima (fracción de lo programado) antes de rojo
const HORA_NOTIFICAR = 17 * 60; // 5:00 PM: pasada esta hora, lo de mañana sin notificar queda en rojo
const TOP = 5, TOP_CARTERA = 10, EPS = 0.004;

const NV = { verde: 0, amarillo: 1, rojo: 2 };
const kp = s => String(s ?? '').trim().toLowerCase();
const vacioTxt = t => { const x = kp(t); return !x || x === 'ninguna' || x === 'ninguno' || x === '(sin comentario)'; };
const dias = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const fechaLeg = f => String(f).split('-').reverse().join('/');
const corto = (t, n) => { t = String(t ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const urlCliente = c => '/cartera/calidad/cliente?c=' + encodeURIComponent(c);
const urlCobros = c => '/cartera/cliente?c=' + encodeURIComponent(c);

// ---------- tiempo (hora de Florida) ----------
function minAhora() {
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
// "8:00 AM", "08:00", "11/11/2026, 9:05:12 AM" -> minutos desde medianoche (o null)
function aMin(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/);
  if (!m) return null;
  let h = +m[1];
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + (+m[2]);
}
const hh = m => { const h = Math.floor(m / 60), ap = h >= 12 ? 'PM' : 'AM'; return ((h % 12) || 12) + ':' + String(m % 60).padStart(2, '0') + ' ' + ap; };
function horario(r) {
  let ini = aMin(r.Hora_Inicio), fin = aMin(r.Hora_Fin);
  if ((ini === null || fin === null) && r.Horario) {
    const p = String(r.Horario).split(/[-–]/);
    if (p.length === 2) { if (ini === null) ini = aMin(p[0]); if (fin === null) fin = aMin(p[1]); }
  }
  return { ini, fin };
}

// ---------- semáforos de los servicios de hoy ----------
function porIniciar(r, now) {
  if (r._estado === 'No puede') return { n: 'rojo', t: 'No puede' + (r.Motivo_No_Puede ? ': ' + corto(r.Motivo_No_Puede, 60) : '') };
  const sub = r._estado === 'Borrador' ? 'Sin enviar' : r._estado === 'Enviado' ? 'Sin confirmar' : 'Confirmado';
  const { ini } = horario(r);
  if (ini === null) return { n: 'verde', t: sub };
  const falta = ini - now;
  if (falta < 0) return { n: 'rojo', t: `Atrasado ${-falta} min · ${sub}` };
  if (falta <= AVISO_MIN) return { n: 'amarillo', t: `Inicia en ${falta} min · ${sub}` };
  return { n: 'verde', t: sub };
}
function iniciado(r, now) {
  if (r._estado === 'Salida (falta cierre)') {
    const sal = aMin(r.Hora_Salida_Real), hace = sal === null ? 0 : Math.max(0, now - sal);
    return { n: hace >= CIERRE_MIN ? 'rojo' : 'amarillo', t: `Falta el cierre (salió hace ${hace} min)` };
  }
  const { fin } = horario(r);
  if (fin === null) return { n: 'verde', t: 'En curso' };
  const pasado = now - fin;
  if (pasado <= 0) return { n: 'verde', t: 'En curso · termina ' + hh(fin) };
  if (pasado <= AVISO_MIN) return { n: 'amarillo', t: `Pasó la hora de fin hace ${pasado} min` };
  return { n: 'rojo', t: `Sin salida, pasó la hora de fin hace ${pasado} min` };
}
function finalizado(r) {
  const { ini, fin } = horario(r), ent = aMin(r.Hora_Entrada_Real), sal = aMin(r.Hora_Salida_Real);
  const m = []; let n = 'verde';
  const sube = (nivel, t) => { m.push(t); if (NV[nivel] > NV[n]) n = nivel; };
  if (r.Dentro_Rango_Entrada === 'NO') sube('rojo', 'Entrada fuera de rango');
  if (r.Dentro_Rango_Salida === 'NO') sube('rojo', 'Salida fuera de rango');
  if (ini !== null && fin !== null && ent !== null && sal !== null && fin > ini && sal >= ent && (sal - ent) < DURACION_MIN * (fin - ini)) {
    sube('rojo', `Duración ${Math.round((sal - ent) / (fin - ini) * 100)}% de lo programado`);
  }
  if (ini !== null && ent !== null && ent - ini > AVISO_MIN) sube('amarillo', `Llegó ${ent - ini} min tarde`);
  if (!vacioTxt(r.Tareas_Pendientes) || !vacioTxt(r.Insumos_Faltantes)) sube('amarillo', 'Cierre con tareas pendientes o insumos faltantes');
  return { n, t: m.join(' · ') || 'Sin novedades' };
}

function itemServicio(r, s) {
  const { ini, fin } = horario(r), ent = aMin(r.Hora_Entrada_Real), sal = aMin(r.Hora_Salida_Real);
  const prog = ini !== null ? hh(ini) + (fin !== null ? ' – ' + hh(fin) : '') : esc(r.Horario);
  const real = [ent !== null ? 'Entrada ' + hh(ent) : '', sal !== null ? 'Salida ' + hh(sal) : ''].filter(Boolean).join(' · ');
  return `<div class="it ${s.n}"><b>${esc(r.Cliente)}</b>${tipoDe(r) === 'Inspeccion' ? ' <span class="est">Inspección</span>' : ''}<br><small>${esc(r.Empleado)} · ${prog}</small>${real ? `<br><small>${real}</small>` : ''}<br><span class="ds">${esc(s.t)}</span></div>`;
}
const ordenar = (a, b) => NV[b.s.n] - NV[a.s.n] || ((horario(a.r).ini ?? 9999) - (horario(b.r).ini ?? 9999));

// ---------- cartera vencida ----------
const frecDe = t => { const x = kp(t); return /^sem/.test(x) ? 7 : /^(quin|bisem|14)/.test(x) ? 14 : /^mens/.test(x) ? 30 : 0; }; // 30 = mensual
const cand = (y, mo, dd) => `${y}-${String(mo).padStart(2, '0')}-${String(Math.min(dd, new Date(Date.UTC(y, mo, 0)).getUTCDate())).padStart(2, '0')}`;
// primera fecha regular de cobro igual o posterior a la fecha del servicio
function fechaCobro(f, frec, ref) {
  if (frec === 7 || frec === 14) return sumarDias(ref, frec * Math.ceil(dias(ref, f) / frec));
  const [y, mo] = f.split('-').map(Number), dd = +ref.slice(8, 10);
  let c = cand(y, mo, dd);
  if (c < f) c = mo === 12 ? cand(y + 1, 1, dd) : cand(y, mo + 1, dd);
  return c;
}
async function frecuencias() {
  const d = await leerHoja('SITIOS', { cache: true }), out = {};
  if (d.length < 2) return out;
  const h = d[0], iN = h.indexOf('Nombre_Cliente'), iF = h.indexOf('Frecuencia_Cobro'), iR = h.indexOf('Fecha_Referencia_Cobro');
  if (iN < 0 || iF < 0 || iR < 0) return out;
  d.slice(1).forEach(f => {
    const n = String(f[iN] || '').trim(), fr = frecDe(f[iF]), ref = normalizarFecha(f[iR]);
    if (n && fr && fechaValida(ref)) out[n] = { fr, ref };
  });
  return out;
}
async function cartera(hoy) {
  try { await Cart.sincronizar(); } catch (e) { console.error('Resumen: no se pudo sincronizar cobros:', e.message); }
  const [lista, nv, tar, d, fr] = await Promise.all([cargarTabla('COBROS_SERVICIO', CS_H), cargarTabla('NOVEDADES_COBRO', NV_H), cargarTarifas(), P.datos(), frecuencias()]);
  const por = new Map();
  armar(lista, nv).forEach(c => {
    const e = P.estadoCobro(c, d);
    if (!e || e.saldo <= EPS) return;
    const pagador = String(c.Pagador || '').trim() || P.pagadorDeCliente(c.Cliente, tar);
    const f = fr[c.Cliente], cobro = f ? fechaCobro(c._fecha, f.fr, f.ref) : c._fecha;
    const venc = dias(cobro, hoy) - GRACIA_COBRO;
    if (!por.has(pagador)) por.set(pagador, { pagador, clientes: new Set(), sinFrec: new Set(), n: 0, saldo: 0, ultimo: '', vN: 0, vSaldo: 0, vCobro: '', vMax: 0 });
    const g = por.get(pagador);
    g.clientes.add(c.Cliente); if (!f) g.sinFrec.add(c.Cliente);
    g.n++; g.saldo += e.saldo;
    if (c._fecha > g.ultimo) g.ultimo = c._fecha;
    if (venc > 0) { g.vN++; g.vSaldo += e.saldo; if (!g.vCobro || cobro < g.vCobro) g.vCobro = cobro; if (venc > g.vMax) g.vMax = venc; }
  });
  const venc = [...por.values()].filter(g => g.vN > 0).map(g => ({ ...g, desdeUltimo: dias(g.ultimo, hoy) }))
    .sort((a, b) => b.desdeUltimo - a.desdeUltimo || b.saldo - a.saldo);
  return { venc, total: venc.reduce((a, g) => a + g.vSaldo, 0) };
}
function itemCartera(g) {
  const cl = [...g.clientes].sort().map(c => `<a href="${esc(urlCobros(c))}">${esc(c)}</a>`).join(', ');
  const sf = g.sinFrec.size ? `<br><small class="mal">Sin frecuencia de cobro en SITIOS: ${esc([...g.sinFrec].join(', '))} (se cuenta desde la fecha del servicio)</small>` : '';
  return `<div class="it"><div class="fila"><div><b>${esc(g.pagador)}</b><br><small>${cl}</small><br><small>${g.n} servicio(s) pendiente(s) · saldo <b>${usd(Math.round(g.saldo * 100) / 100)}</b><br>Cobro vencido desde ${fechaLeg(g.vCobro)} (hace ${g.vMax + GRACIA_COBRO} días)</small>${sf}</div>
    <div class="dias"><b>${g.desdeUltimo}</b><small>días desde el<br>último servicio</small></div></div></div>`;
}

// ---------- piezas de pantalla ----------
const sec = (titulo, n, items, vacio, pie) => `<details class="sec" ><summary>${esc(titulo)}<span class="cnt">${n}</span></summary>${items.length ? items.join('') : `<p class="vacio">${vacio}</p>`}${pie ? `<p class="pie">${pie}</p>` : ''}<div class="fin"></div></details>`;
const masQue = (total, mostrados) => total > mostrados ? `<p class="vacio">y ${total - mostrados} más…</p>` : '';

const CSS_RES = `
.g3,.g2{display:grid;gap:14px;align-items:start;} .g3{grid-template-columns:repeat(3,minmax(0,1fr));} .g2{grid-template-columns:repeat(2,minmax(0,1fr));}
.g3 details.sec,.g2 details.sec{margin:0;}
@media(max-width:800px){.g3,.g2{grid-template-columns:1fr;gap:10px;}}
.h2r{margin:24px 0 10px;font-size:18px;} .h2r small{font-weight:400;}
.it{border-left:4px solid #cdd3d9;background:#f7f9fb;border-radius:8px;padding:8px 12px;margin:0 0 8px;line-height:1.35;}
.it.verde{border-left-color:#16a34a;} .it.amarillo{border-left-color:#eab308;} .it.rojo{border-left-color:#dc2626;background:#fff7f7;}
.it .ds{font-size:13px;font-weight:500;} .it.verde .ds{color:#15803d;} .it.amarillo .ds{color:#8a6100;} .it.rojo .ds{color:#b91c1c;}
.fila{display:flex;justify-content:space-between;gap:12px;align-items:center;}
.dias{text-align:center;min-width:92px;} .dias b{display:block;font-size:28px;line-height:1;font-variant-numeric:tabular-nums;} .dias small{font-size:11px;}
.cnt{display:inline-block;min-width:24px;text-align:center;padding:0 8px;border-radius:999px;background:#e8ebee;font-size:12.5px;margin-left:8px;font-weight:600;}
.vacio{color:var(--gray-d);font-size:13px;margin:0 0 10px;} .pie{margin:4px 0 0;font-size:13px;} .fin{height:12px;}`;

async function paginaResumen(query, admin) {
  const hoy = hoyFlorida(), man = sumarDias(hoy, 1), now = minAhora();
  const errores = [];
  const seguro = async (nombre, fn, def) => { try { return await fn(); } catch (e) { console.error('Resumen · ' + nombre + ':', e); errores.push(nombre); return def; } };
  const [filas2, pend, cal, cart] = await Promise.all([
    seguro('agenda', () => filasDelRango(hoy, man), []),
    seguro('pendientes', cargarPendientes, []),
    seguro('calidad', Cal.leerTodo, null),
    seguro('cartera', () => cartera(hoy), null),
  ]);

  // ----- hoy -----
  const activos = filas2.filter(r => r._fecha === hoy && r._estado !== 'Cancelado');
  const cH = { ini: [], curso: [], fin: [] };
  activos.forEach(r => {
    if (r._estado === 'Finalizado') cH.fin.push({ r, s: finalizado(r) });
    else if (r._estado === 'En curso' || r._estado === 'Salida (falta cierre)') cH.curso.push({ r, s: iniciado(r, now) });
    else cH.ini.push({ r, s: porIniciar(r, now) });
  });
  Object.values(cH).forEach(l => l.sort(ordenar));
  const rojoHoy = [...cH.ini, ...cH.curso, ...cH.fin].filter(x => x.s.n === 'rojo').length;
  const colH = (titulo, l) => sec(titulo, l.length, l.map(x => itemServicio(x.r, x.s)), 'Sin servicios.');

  // ----- mañana -----
  const cM = { sin: [], por: [], ok: [] };
  filas2.filter(r => r._fecha === man && r._estado !== 'Cancelado' && r.Estado_Envio !== 'No aplica').forEach(r => {
    if (r._estado === 'Borrador') cM.sin.push({ r, s: now >= HORA_NOTIFICAR ? { n: 'rojo', t: 'Sin notificar (ya pasaron las 5:00 PM)' } : { n: 'amarillo', t: 'Sin notificar' } });
    else if (r._estado === 'No puede') cM.por.push({ r, s: { n: 'rojo', t: 'No puede' + (r.Motivo_No_Puede ? ': ' + corto(r.Motivo_No_Puede, 60) : '') } });
    else if (r._estado === 'Enviado') cM.por.push({ r, s: { n: 'amarillo', t: 'Esperando confirmación' } });
    else if (r._estado === 'Confirmado') cM.ok.push({ r, s: { n: 'verde', t: 'Confirmado' } });
  });
  Object.values(cM).forEach(l => l.sort(ordenar));
  const colM = (titulo, l) => sec(titulo, l.length, l.map(x => itemServicio(x.r, x.s)), 'Sin servicios.');
  const sinNotifRojo = cM.sin.some(x => x.s.n === 'rojo');

  // ----- pendientes -----
  const abiertos = pend.filter(p => p.Estado === 'Abierto');
  const fLim = p => normalizarFecha(p.Fecha_Limite);
  const vencidos = abiertos.filter(p => fechaValida(fLim(p)) && fLim(p) < hoy);
  const listaP = [...vencidos.sort((a, b) => fLim(a).localeCompare(fLim(b))), ...abiertos.filter(p => !vencidos.includes(p)).sort((a, b) => (fLim(a) || '9').localeCompare(fLim(b) || '9'))];
  const itemsP = listaP.slice(0, TOP).map(p => {
    const v = vencidos.includes(p);
    return `<div class="it ${v ? 'rojo' : ''}"><b>${p.Prioridad === 'Alta' ? '❗ ' : ''}${esc(p.Titulo)}</b><br><small>${esc(p.Responsable)}${p.Cliente ? ' · ' + esc(p.Cliente) : ''}${fechaValida(fLim(p)) ? ' · ' + fechaLeg(fLim(p)) : ''}</small>${v ? `<br><span class="ds">Vencido hace ${dias(fLim(p), hoy)} día(s)</span>` : ''}</div>`;
  });
  const pieP = `<a href="/pendientes?vencidos=1">Ver vencidos (${vencidos.length})</a> · <a href="/pendientes">Ver abiertos (${abiertos.length})</a>`;

  // ----- calidad: quejas, acciones correctivas, sin inspección -----
  let blQ = '', blA = '', blI = '', nQ = 0;
  if (cal) {
    const qs = cal.quejas.filter(Cal.abierta).sort((a, b) => (kp(b.Urgencia) === 'alta') - (kp(a.Urgencia) === 'alta') || normalizarFecha(b.Fecha_Recepcion).localeCompare(normalizarFecha(a.Fecha_Recepcion)));
    nQ = qs.length;
    blQ = sec('Quejas y dudas abiertas', qs.length, qs.slice(0, TOP).map(q => {
      const alta = kp(q.Urgencia) === 'alta';
      return `<div class="it ${alta ? 'rojo' : 'amarillo'}"><b><a href="${esc(urlCliente(q.Cliente))}">${esc(q.Cliente)}</a></b><br><small>${esc(q.Tipo)} · ${esc(q.Urgencia || 'sin urgencia')}${fechaValida(normalizarFecha(q.Fecha_Recepcion)) ? ' · ' + fechaLeg(normalizarFecha(q.Fecha_Recepcion)) : ''}</small><br><span class="ds">${esc(corto(q.Descripcion, 110))}</span></div>`;
    }).concat(masQue(qs.length, TOP) ? [masQue(qs.length, TOP)] : []), 'Sin quejas ni dudas abiertas.', '<a href="/cartera/calidad">Ver calidad de clientes</a>');

    const porServ = {};
    pend.forEach(p => { if (p.ID_Programacion) (porServ[p.ID_Programacion] = porServ[p.ID_Programacion] || []).push(p); });
    const acc = cal.filas.filter(r => tipoDe(r) === 'Inspeccion' && r._estado === 'Finalizado' && r.Requiere_Accion_Correctiva === 'Sí'
      && (porServ[r.ID_Programacion] && porServ[r.ID_Programacion].length ? porServ[r.ID_Programacion].some(p => p.Estado === 'Abierto') : r.Estado_Correccion === 'Pendiente'))
      .sort((a, b) => a._fecha.localeCompare(b._fecha));
    blA = sec('Acciones correctivas pendientes', acc.length, acc.slice(0, TOP).map(r => {
      const l = (porServ[r.ID_Programacion] || []).filter(p => p.Estado === 'Abierto');
      return `<div class="it rojo"><b><a href="${esc(urlCliente(r.Cliente))}">${esc(r.Cliente)}</a></b><br><small>Inspección ${esc(fechaLeg(r._fecha))} · ${esc(r.Empleado)}</small><br><span class="ds">${esc(corto(r.Comentario_Empleado, 110))}</span><br><small>${l.length ? 'Pendiente abierto: ' + esc(l.map(p => p.ID_Pendiente).join(', ')) : 'Aún no tiene un pendiente creado'}</small></div>`;
    }).concat(masQue(acc.length, TOP) ? [masQue(acc.length, TOP)] : []), 'Sin acciones correctivas pendientes.', '<a href="/cartera/calidad?nivel=rojo">Ver clientes en rojo</a> · <a href="/pendientes">Crear o ver pendientes</a>');

    const sin = [...cal.vig].map(c => Cal.evaluar(c, cal)).filter(e => e.supervisor && !e.supervisor.ok && e.supervisor.completa).map(e => {
      const ult = e.ins[0] ? e.ins[0]._fecha : '';
      return { e, ult, n: e.ej.filter(s => !ult || s.fecha > ult).length };
    }).sort((a, b) => b.n - a.n || a.e.cliente.localeCompare(b.e.cliente));
    blI = sec('Clientes sin inspección', sin.length, sin.slice(0, TOP).map(x => `<div class="it amarillo"><b><a href="${esc(urlCliente(x.e.cliente))}">${esc(x.e.cliente)}</a></b><br><span class="ds">${x.n} servicios ejecutados sin inspección</span><br><small>Última inspección: ${x.ult ? esc(fechaLeg(x.ult)) : 'nunca'}</small></div>`)
      .concat(masQue(sin.length, TOP) ? [masQue(sin.length, TOP)] : []), 'Todos los clientes tienen inspección al día.', '<a href="/cartera/calidad">Ver calidad de clientes</a>');
  }

  // ----- cartera -----
  const blC = cart
    ? sec('Cartera vencida (más de ' + GRACIA_COBRO + ' días después de la fecha regular de cobro)', cart.venc.length, cart.venc.slice(0, TOP_CARTERA).map(itemCartera).concat(masQue(cart.venc.length, TOP_CARTERA) ? [masQue(cart.venc.length, TOP_CARTERA)] : []),
      'No hay clientes con cartera vencida.', 'Ordenado por días desde el último servicio pendiente de pago · <a href="/cartera/clientes">Ver clientes en Cartera</a> · <a href="/cartera/pagos">Ingresos</a>')
    : '';

  const edad = edadCacheSegundos('PROGRAMACION_DIARIA');
  const kp6 = layout.kpis([
    ['Servicios hoy', activos.length],
    ['Hoy en rojo', rojoHoy, rojoHoy ? 'neg' : ''],
    ['Mañana sin notificar', cM.sin.length, sinNotifRojo ? 'neg' : ''],
    ['Cartera vencida', cart ? usd(Math.round(cart.total * 100) / 100) : '—', cart && cart.total > 0 ? 'neg' : ''],
    ['Pendientes vencidos', vencidos.length, vencidos.length ? 'neg' : ''],
    ['Quejas abiertas', cal ? nQ : '—', nQ ? 'neg' : ''],
  ]);

  return `${layout.head('Resumen', CSS_RES)}
${layout.cabecera({ titulo: 'Resumen — ' + diaSemana(hoy) + ' ' + hoy, seccion: '/resumen', admin })}
<div class="nav"><a class="btn hoy" href="/agenda?fecha=${hoy}">Agenda de hoy</a><a class="btn" href="/agenda?fecha=${man}">Agenda de mañana</a>
  <form method="POST" action="/actualizar-cache" style="margin:0 0 0 auto;display:flex;gap:8px;align-items:center;"><small>Hora en Florida ${hh(now)} · datos de hace ${edad ?? 0} s</small>
  <input type="hidden" name="volver" value="/resumen"><button class="btn">Actualizar</button></form></div>
${errores.length ? `<div class="aviso r">No se pudo cargar: ${esc(errores.join(', '))}. Revisa los logs de Render.</div>` : ''}
${kp6}
<h3 class="h2r">Hoy <small>· ${fechaLeg(hoy)}</small></h3>
<div class="g3">${colH('Por iniciar', cH.ini)}${colH('Iniciado', cH.curso)}${colH('Finalizado', cH.fin)}</div>
<h3 class="h2r">Mañana <small>· ${fechaLeg(man)}</small></h3>
<div class="g3">${colM('Sin notificar', cM.sin)}${colM('Por confirmar', cM.por)}${colM('Confirmada', cM.ok)}</div>
<h3 class="h2r">Cartera</h3>
${blC}
<h3 class="h2r">Seguimiento</h3>
<div class="g2">${sec('Pendientes', abiertos.length, itemsP.concat(masQue(abiertos.length, TOP) ? [masQue(abiertos.length, TOP)] : []), 'No hay pendientes abiertos.', pieP)}${blQ}${blA}${blI}</div>
<script>setInterval(function(){if(!document.hidden)location.reload();},120000);</script>
</body></html>`;
}

function rutas(app, auth) {
  app.get('/resumen', auth.requiereAdmin, async (req, res) => {
    try { res.set('Content-Type', 'text/html; charset=utf-8'); res.send(await paginaResumen(req.query, req.admin)); }
    catch (e) { console.error('Error en GET /resumen:', e); res.status(500).send('Error cargando el resumen: ' + e.message); }
  });
}

module.exports = { rutas, paginaResumen, _t: { aMin, horario, porIniciar, iniciado, finalizado, fechaCobro, frecDe } };