const { leerHoja } = require('./sheets');
const { normalizarFecha, fechaValida, hoyFlorida, filasDelRango } = require('./agenda');
const menu = require('./menu');
const K = require('./cartera').helpers;
const P = require('./pagos');
const { cargarTabla, cargarTarifas, armar, numero, r2, usd, esc, CS_H, NV_H, CSS } = K;
const EPS = 0.004;

// Reporte de calidad por cliente. Solo lectura. Un "servicio ejecutado" es un servicio de limpieza finalizado
// (no inspección, no cancelado); varias filas del mismo cliente y fecha cuentan como un solo servicio (equipo).
const NT_H = ['ID_Nota', 'Cliente', 'ID_Programacion', 'Fecha', 'Fuente', 'Categoria', 'Calificacion', 'Detalle', 'Estado',
  'Registrado_Por', 'Fecha_Registro', 'Anulado_Por', 'Motivo_Anulacion', 'Fecha_Anulacion'];
const VENTANA_SUP = 5, VENTANA_QUEJAS = 60, VENTANA_CIERRES = 3;
const kp = s => String(s ?? '').trim().toLowerCase();
const dias = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const tipoDe = r => r.Tipo_Servicio || 'Limpieza';
const vacioTxt = t => { const x = kp(t); return !x || x === 'ninguna' || x === 'ninguno' || x === '(sin comentario)'; };
const abierta = q => !/cerrad|resuelt|complet/i.test(String(q.Estado || ''));
const esQueja = q => /queja/i.test(String(q.Tipo || ''));
const fechaQ = q => normalizarFecha(q.Fecha_Recepcion);
const NIVEL = { rojo: 2, amarillo: 1, verde: 0 };
const ETQ = { rojo: 'Rojo', amarillo: 'Amarillo', verde: 'Verde' };

async function leerTodo() {
  const hoy = hoyFlorida();
  const [filas, qd, vd, notas, tar] = await Promise.all([
    filasDelRango('2000-01-01', hoy),
    leerHoja('QUEJAS', { cache: true }), leerHoja('CLIENTES', { cache: true }),
    cargarTabla('NOTAS_SERVICIO', NT_H, false), cargarTarifas()]);
  const quejas = [];
  if (qd.length > 1) { const h = qd[0]; qd.slice(1).forEach(f => { const q = {}; h.forEach((n, j) => { q[n] = f[j] === undefined ? '' : String(f[j]); }); if (q.Cliente || q.ID_Queja) quejas.push(q); }); }
  // clientes vigentes: CLIENTES."Cliente Vigente/Vencido" (si dice "Vencido" se excluye; sin columna o vacío = vigente)
  const vig = new Set();
  if (vd.length > 1) {
    const h = vd[0], iN = h.indexOf('clientes'), iV = h.indexOf('Cliente Vigente/Vencido');
    vd.slice(1).forEach(f => { const n = String(f[iN] || '').trim(); if (n && !(iV >= 0 && /^venc/i.test(String(f[iV] || '').trim()))) vig.add(n); });
  }
  if (!vig.size) filas.forEach(r => { if (r.Cliente) vig.add(r.Cliente.trim()); });
  return { hoy, filas, quejas, notas: notas.filter(n => n.ID_Nota), vig, tar };
}

// Servicios ejecutados del cliente, agrupados por fecha (más reciente primero)
function ejecutadosDe(filas, cliente) {
  const g = {};
  filas.filter(r => r.Cliente.trim() === cliente && tipoDe(r) !== 'Inspeccion' && r._estado === 'Finalizado').forEach(r => { (g[r._fecha] = g[r._fecha] || []).push(r); });
  return Object.keys(g).sort().reverse().map(f => ({ fecha: f, filas: g[f], emps: [...new Set(g[f].map(r => String(r.Empleado || '').trim()).filter(Boolean))] }));
}
const inspeccionesDe = (filas, cliente) => filas.filter(r => r.Cliente.trim() === cliente && tipoDe(r) === 'Inspeccion' && r._estado === 'Finalizado')
  .sort((a, b) => b._fecha.localeCompare(a._fecha) || String(b.Hora_Salida_Real).localeCompare(String(a.Hora_Salida_Real)));

function evaluar(cliente, d) {
  const ej = ejecutadosDe(d.filas, cliente), ins = inspeccionesDe(d.filas, cliente);
  const qs = d.quejas.filter(q => q.Cliente.trim() === cliente).sort((a, b) => fechaQ(b).localeCompare(fechaQ(a)));
  const motivos = []; let nivel = 'verde';
  const sube = (n, t) => { motivos.push(t); if (NIVEL[n] > NIVEL[nivel]) nivel = n; };

  const abiertas = qs.filter(abierta);
  if (abiertas.some(q => kp(q.Urgencia) === 'alta')) sube('rojo', 'Queja o duda abierta de urgencia alta');
  const recientes = qs.filter(q => esQueja(q) && fechaValida(fechaQ(q)) && dias(fechaQ(q), d.hoy) <= VENTANA_QUEJAS);
  if (recientes.length >= 2) sube('rojo', `${recientes.length} quejas en los últimos ${VENTANA_QUEJAS} días`);
  else if (recientes.length === 1) sube('amarillo', `1 queja en los últimos ${VENTANA_QUEJAS} días`);
  if (abiertas.length && !abiertas.some(q => kp(q.Urgencia) === 'alta')) sube('amarillo', `${abiertas.length} queja(s) o duda(s) abierta(s)`);

  const ultIns = ins[0];
  if (ultIns && /no cumple/i.test(ultIns.Resultado_Inspeccion || '')) sube('rojo', `Última inspección (${ultIns._fecha}) con "No cumple"`);
  const corr = ins.filter(r => r.Requiere_Accion_Correctiva === 'Sí' && r.Estado_Correccion === 'Pendiente');
  if (corr.length) sube('rojo', `${corr.length} acción(es) correctiva(s) pendiente(s) de inspección`);

  const ult3 = ej.slice(0, VENTANA_CIERRES);
  const conPend = ult3.filter(s => s.filas.some(r => !vacioTxt(r.Tareas_Pendientes) || !vacioTxt(r.Insumos_Faltantes))).length;
  if (conPend >= 2) sube('amarillo', `Tareas pendientes o insumos faltantes en ${conPend} de los últimos ${ult3.length} cierres`);

  // supervisor: inspección finalizada desde la fecha del 5.º servicio ejecutado más reciente
  let supervisor = null;
  if (ej.length) {
    const desde = ej[Math.min(VENTANA_SUP, ej.length) - 1].fecha;
    const hay = ins.some(r => r._fecha >= desde);
    supervisor = { ok: hay, desde, n: Math.min(VENTANA_SUP, ej.length), completa: ej.length >= VENTANA_SUP };
    if (!hay) {
      motivos.push(`Sin revisión de supervisor en los últimos ${supervisor.n} servicio(s) ejecutado(s) (desde ${desde})`);
      if (nivel === 'verde') nivel = 'amarillo';
    }
  }
  return { cliente, nivel, motivos, ej, ins, qs, abiertas, supervisor };
}

const punto = n => `<span class="sem ${n}" title="${ETQ[n]}"></span>`;
const CSS_CAL = `.sem{display:inline-block;width:14px;height:14px;border-radius:50%;vertical-align:middle;margin-right:6px;} .sem.verde{background:#16a34a;} .sem.amarillo{background:#eab308;} .sem.rojo{background:#dc2626;}
.rep .sec{margin:14px 0;} .rep .sec>summary{cursor:pointer;font-size:17px;font-weight:bold;padding:6px 0;border-bottom:1px solid #ddd;margin-bottom:8px;}
.alertaSup{background:#fff7ed;border:1px solid #fdba74;border-radius:6px;padding:8px 12px;margin:8px 0;font-size:14px;} .okSup{background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:8px 12px;margin:8px 0;font-size:14px;}
.wrap{white-space:pre-wrap;} td small{color:#666;}`;
const sec = (t, c, abierta) => `<details class="sec"${abierta === false ? '' : ' open'}><summary>${t}</summary>${c}</details>`;
const estr = n => (numero(n.Calificacion) > 0) ? `★ ${numero(n.Calificacion)}` : '—';

// ---------- lista ----------
async function paginaLista(query, admin) {
  const d = await leerTodo();
  const filtro = ['rojo', 'amarillo', 'verde'].includes(query.nivel) ? query.nivel : '';
  const evs = [...d.vig].map(c => evaluar(c, d)).sort((a, b) => NIVEL[b.nivel] - NIVEL[a.nivel] || b.motivos.length - a.motivos.length || a.cliente.localeCompare(b.cliente));
  const cuenta = { rojo: 0, amarillo: 0, verde: 0 };
  evs.forEach(e => { cuenta[e.nivel]++; });
  const vis = evs.filter(e => !filtro || e.nivel === filtro);
  const filas = vis.map(e => {
    const ult = e.ej[0], ci = e.ins[0];
    const sup = e.supervisor ? (e.supervisor.ok ? '<span style="color:#15803d;">Revisado</span>' : '<b style="color:#c2410c;">Sin revisión</b>') : '<small>—</small>';
    const cal = (d.notas.filter(n => n.Cliente === e.cliente && n.Estado === 'Activa' && numero(n.Calificacion) > 0));
    const prom = cal.length ? '★ ' + (Math.round(cal.reduce((a, n) => a + numero(n.Calificacion), 0) / cal.length * 10) / 10) : '<small>—</small>';
    return `<tr data-n="${esc(kp(e.cliente))}"><td>${punto(e.nivel)}${ETQ[e.nivel]}</td><td><a href="/cartera/calidad/cliente?c=${encodeURIComponent(e.cliente)}"><b>${esc(e.cliente)}</b></a>${e.motivos.length ? `<br><small>${esc(e.motivos.join(' · '))}</small>` : ''}</td>
      <td>${ult ? esc(ult.fecha) + `<br><small>${esc(ult.emps.join(', '))}</small>` : '<small>Sin servicios ejecutados</small>'}</td><td class="num">${e.ej.length}</td><td class="num">${e.abiertas.length || '<small>0</small>'}</td>
      <td>${ci ? esc(ci._fecha) : '<small>Nunca</small>'}</td><td>${sup}</td><td class="num">${prom}</td></tr>`;
  }).join('') || '<tr><td colspan="8" style="text-align:center;color:#888;padding:20px;">No hay clientes para este filtro.</td></tr>';
  const btn = (n, t) => `<a class="btn${filtro === n ? ' hoy' : ''}" href="/cartera/calidad${n ? '?nivel=' + n : ''}">${t}</a>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Calidad de clientes</title><style>${CSS}${CSS_CAL}${menu.MENU_CSS}</style></head><body class="rep">
<div class="top"><h2 style="margin:0;">Calidad de clientes</h2>${menu.menuHtml('/cartera', admin)}</div>
<div class="nav"><a class="btn" href="/cartera">← Cartera</a><a class="btn" href="/cartera/reportes">Reportes</a>
  ${btn('', 'Todos (' + evs.length + ')')}${btn('rojo', '🔴 Rojo (' + cuenta.rojo + ')')}${btn('amarillo', '🟡 Amarillo (' + cuenta.amarillo + ')')}${btn('verde', '🟢 Verde (' + cuenta.verde + ')')}</div>
<div class="aviso">Solo clientes vigentes, ordenados del mayor al menor riesgo. "Servicios" cuenta solo los ejecutados. El semáforo considera quejas, inspecciones, cierres con pendientes y si hubo revisión de supervisor en los últimos ${VENTANA_SUP} servicios ejecutados.</div>
<input type="search" placeholder="Buscar cliente..." oninput="cBuscar(this.value)" style="padding:7px;border:1px solid #ccc;border-radius:6px;font-size:14px;margin-bottom:8px;width:260px;">
<div class="scroll g"><table><tr><th>Semáforo</th><th>Cliente</th><th>Último servicio ejecutado</th><th class="num">Servicios ejecutados</th><th class="num">Quejas abiertas</th><th>Última inspección</th><th>Supervisor (últ. ${VENTANA_SUP})</th><th class="num">Calif. notas</th></tr>${filas}</table></div>
<script>function cBuscar(t){t=t.toLowerCase();var r=document.querySelectorAll('tr[data-n]');for(var i=0;i<r.length;i++){r[i].style.display=r[i].getAttribute('data-n').indexOf(t)>=0?'':'none';}}</script>
</body></html>`;
}

// ---------- ficha ----------
async function carteraCliente(cliente) {
  const [cs, nv, tar, pgd] = await Promise.all([cargarTabla('COBROS_SERVICIO', CS_H, false), cargarTabla('NOVEDADES_COBRO', NV_H, false), cargarTarifas(), P.datos(false)]);
  const hoy = hoyFlorida(), B = [0, 0, 0, 0];
  let saldo = 0;
  armar(cs, nv).filter(c => c.Cliente === cliente).forEach(c => {
    const e = P.estadoCobro(c, pgd);
    if (!e || e.saldo <= EPS) return;
    saldo = r2(saldo + e.saldo);
    const n = Math.max(0, dias(c._fecha, hoy)), i = n <= 30 ? 0 : n <= 60 ? 1 : n <= 90 ? 2 : 3;
    B[i] = r2(B[i] + e.saldo);
  });
  if (!saldo) return '<p><small>Sin saldo pendiente.</small></p>';
  return `<div class="scroll"><table><tr><th class="num">0-30 días</th><th class="num">31-60</th><th class="num">61-90</th><th class="num">90+</th><th class="num">Saldo pendiente</th></tr><tr>${B.map(v => `<td class="num">${v ? usd(v) : '<small>—</small>'}</td>`).join('')}<td class="num"><b>${usd(saldo)}</b></td></tr></table></div>
    <p><a href="/cartera/cliente?c=${encodeURIComponent(cliente)}">Ver cobros y registrar ingresos de este cliente</a></p>`;
}

async function paginaFicha(query, admin) {
  const cliente = String(query.c || '').trim();
  if (!cliente) return null;
  const d = await leerTodo();
  const e = evaluar(cliente, d);
  const ultimos = e.ej.slice(0, 10);

  const motivos = e.motivos.length ? `<ul style="margin:6px 0;">${e.motivos.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : '<p><small>Sin alertas.</small></p>';
  let supHtml = '<div class="alertaSup">Aún no hay servicios ejecutados para evaluar la revisión de supervisor.</div>';
  if (e.supervisor) {
    const s = e.supervisor;
    supHtml = s.ok ? `<div class="okSup">✅ Hubo revisión de supervisor entre los últimos ${s.n} servicios ejecutados (desde ${esc(s.desde)}).</div>`
      : `<div class="alertaSup">⚠️ <b>No se ha enviado supervisor a revisar a este cliente</b> en los últimos ${s.n} servicios ejecutados (desde ${esc(s.desde)}).${s.completa ? '' : ' (Aún tiene menos de ' + VENTANA_SUP + ' servicios ejecutados.)'} El semáforo baja por esto.</div>`;
  }
  const cont = {};
  ultimos.forEach(s => s.emps.forEach(n => { cont[n] = (cont[n] || 0) + 1; }));
  const quienes = Object.entries(cont).sort((a, b) => b[1] - a[1]).map(([n, v]) => `${esc(n)} (${v})`).join(' · ');

  const tablaServ = ultimos.length ? `<div class="scroll"><table><tr><th>Fecha</th><th>Atendió</th><th>Horario</th></tr>${ultimos.map(s => {
    const r = s.filas[0], h = (r.Hora_Inicio && r.Hora_Fin) ? `${r.Hora_Inicio}–${r.Hora_Fin}` : r.Horario;
    return `<tr><td>${esc(s.fecha)}</td><td>${esc(s.emps.join(', ') || '—')}${s.emps.length > 1 ? ' 👥' : ''}</td><td>${esc(h)}</td></tr>`;
  }).join('')}</table></div>` : '<p><small>Sin servicios ejecutados.</small></p>';

  const obs = ultimos.map(s => ({ s, filas: s.filas.filter(r => !vacioTxt(r.Comentario_Empleado) || !vacioTxt(r.Tareas_Pendientes) || !vacioTxt(r.Insumos_Faltantes)) })).filter(x => x.filas.length);
  const tablaObs = obs.length ? `<div class="scroll"><table><tr><th>Fecha</th><th>Empleado</th><th>Comentario</th><th>Tareas pendientes</th><th>Insumos faltantes</th></tr>${obs.map(({ s, filas }) => filas.map(r => `<tr><td>${esc(s.fecha)}</td><td>${esc(r.Empleado)}</td><td class="wrap">${vacioTxt(r.Comentario_Empleado) ? '<small>—</small>' : esc(r.Comentario_Empleado)}</td><td>${vacioTxt(r.Tareas_Pendientes) ? '<small>—</small>' : esc(r.Tareas_Pendientes)}</td><td>${vacioTxt(r.Insumos_Faltantes) ? '<small>—</small>' : esc(r.Insumos_Faltantes)}</td></tr>`).join('')).join('')}</table></div>`
    : '<p><small>Sin observaciones en los últimos 10 servicios ejecutados.</small></p>';

  const tablaQ = e.qs.length ? `<div class="scroll"><table><tr><th>Fecha</th><th>Tipo</th><th>Urgencia</th><th>Descripción</th><th>Reportado por</th><th>Responsable</th><th>Acción correctiva</th><th>Estado</th></tr>${e.qs.map(q => `<tr><td>${esc(fechaQ(q))}</td><td>${esc(q.Tipo)}</td><td>${esc(q.Urgencia)}</td><td class="wrap">${esc(q.Descripcion)}${/^https?:\/\//i.test(q.Foto_Soporte) ? ` <a href="${esc(q.Foto_Soporte)}" target="_blank" rel="noopener">foto</a>` : ''}</td><td>${esc(q.Reportado_Por)}</td><td>${esc(q.Responsable_Asignado)}</td><td class="wrap">${esc(q.Accion_Correctiva)}</td><td>${abierta(q) ? '<b>' + esc(q.Estado || 'Abierta') + '</b>' : esc(q.Estado)}</td></tr>`).join('')}</table></div>` : '<p><small>Este cliente no tiene quejas ni dudas.</small></p>';

  const tablaIns = e.ins.length ? `<div class="scroll"><table><tr><th>Fecha</th><th>Supervisor</th><th>Resultado por área</th><th>Hallazgos</th><th>Acción correctiva</th></tr>${e.ins.slice(0, 10).map(r => `<tr><td>${esc(r._fecha)}</td><td>${esc(r.Empleado)}</td><td class="wrap">${esc(String(r.Resultado_Inspeccion || '').replace(/; /g, '\n'))}</td><td class="wrap">${esc(r.Comentario_Empleado)}</td><td>${esc(r.Requiere_Accion_Correctiva || '—')}${r.Estado_Correccion ? ' · ' + esc(r.Estado_Correccion) : ''}</td></tr>`).join('')}</table></div>` : '<p><small>Nunca se ha inspeccionado a este cliente.</small></p>';

  const notas = d.notas.filter(n => n.Cliente === cliente).sort((a, b) => normalizarFecha(b.Fecha).localeCompare(normalizarFecha(a.Fecha)) || String(b.ID_Nota).localeCompare(String(a.ID_Nota)));
  const act = notas.filter(n => n.Estado === 'Activa'), conCal = act.filter(n => numero(n.Calificacion) > 0);
  const prom = conCal.length ? Math.round(conCal.reduce((a, n) => a + numero(n.Calificacion), 0) / conCal.length * 10) / 10 : null;
  const resNotas = `<div class="aviso" style="background:#f0fdf4;">${act.length} nota(s) activa(s)${prom !== null ? ` · calificación promedio <b>★ ${prom}</b> (${conCal.length} con calificación)` : ' · sin calificaciones'} · ${act.filter(n => n.Fuente === 'Cliente').length} del cliente · ${act.filter(n => n.Fuente === 'Interna').length} internas · <a href="/cartera/cliente?c=${encodeURIComponent(cliente)}">agregar o anular notas</a></div>`;
  const tablaNotas = act.length ? `<div class="scroll"><table><tr><th>Fecha</th><th>Fuente</th><th>Categoría</th><th class="num">Calif.</th><th>Detalle</th></tr>${act.slice(0, 20).map(n => `<tr><td>${esc(normalizarFecha(n.Fecha))}</td><td>${esc(n.Fuente)}</td><td>${esc(n.Categoria)}</td><td class="num">${estr(n)}</td><td class="wrap">${esc(n.Detalle)}</td></tr>`).join('')}</table></div>` : '<p><small>Sin notas.</small></p>';

  const cartera = await carteraCliente(cliente);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Calidad — ${esc(cliente)}</title><style>${CSS}${CSS_CAL}${menu.MENU_CSS}</style></head><body class="rep">
<div class="top"><h2 style="margin:0;">${punto(e.nivel)}${esc(cliente)}</h2>${menu.menuHtml('/cartera', admin)}</div>
<div class="nav"><a class="btn" href="/cartera/calidad">← Calidad de clientes</a><a class="btn" href="/cartera/cliente?c=${encodeURIComponent(cliente)}">Cobros del cliente</a></div>
${sec(`Semáforo: ${ETQ[e.nivel]}`, motivos + supHtml)}
${sec('Resumen de notas y retroalimentación', resNotas + tablaNotas)}
${sec(`Últimos ${ultimos.length || 10} servicios ejecutados (quién atendió)`, `<p><small>Solo servicios ejecutados, del más reciente al más antiguo.${quienes ? ' Atendieron: ' + quienes + '.' : ''}</small></p>` + tablaServ)}
${sec('Quejas y dudas', tablaQ)}
${sec('Observaciones de los servicios (últimos 10 ejecutados)', tablaObs)}
${sec('Inspecciones de supervisor', tablaIns)}
${sec('Cartera del cliente', cartera, false)}
</body></html>`;
}

function rutas(app, auth) {
  const get = (ruta, fn) => app.get(ruta, auth.requiereAdmin, async (req, res) => {
    try {
      const html = await fn(req.query, req.admin);
      if (html === null) return res.redirect('/cartera/calidad');
      res.set('Content-Type', 'text/html; charset=utf-8'); res.send(html);
    } catch (e) { console.error('Error en GET ' + ruta, e); res.status(500).send('Error cargando la calidad de clientes: ' + e.message); }
  });
  get('/cartera/calidad', paginaLista);
  get('/cartera/calidad/cliente', paginaFicha);
}

module.exports = { rutas, evaluar, paginaLista, paginaFicha };
