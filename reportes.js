const { normalizarFecha, fechaValida, hoyFlorida } = require('./agenda');
const menu = require('./menu');
const K = require('./cartera').helpers;
const C = () => require('./cartera'); // diferido: evita ciclos
const P = require('./pagos');
const E = require('./egresos');
const { cargarTabla, cargarTarifas, armar, numero, r2, usd, esc, CS_H, NV_H, CSS } = K;
const { METODOS, CUENTAS, EFECTIVO_MANO, CSS_PAGOS, seleccion, qsDe, grupoChecks } = P;
const EPS = 0.004;
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const kp = s => String(s ?? '').trim().toLowerCase();

// Reglas: ingresos y egresos cuentan por su fecha efectiva (fecha de banco; efectivo en mano: su propia fecha).
// Sin fecha efectiva (por depositar / por debitar) no entran a los reportes de flujo.
const dias = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const sumar = (l, f) => r2(l.reduce((a, x) => a + (f(x) || 0), 0));
const val = x => numero(x.Valor) || 0;
const nombreIngreso = p => p.Tipo === 'Servicios' ? 'Servicios' : (p.Categoria || 'Otro ingreso');

// tabla cuenta x método
function matriz(lista, filas, cols, fFila, fCol, f) {
  const m = {};
  filas.forEach(r => { m[r] = {}; cols.forEach(c => { m[r][c] = 0; }); });
  lista.forEach(x => { const r = fFila(x), c = fCol(x); if (m[r] && c in m[r]) m[r][c] = r2(m[r][c] + f(x)); });
  const tc = {}; cols.forEach(c => { tc[c] = r2(filas.reduce((a, r) => a + m[r][c], 0)); });
  const head = `<tr><th></th>${cols.map(c => `<th class="num">${esc(c)}</th>`).join('')}<th class="num">Total</th></tr>`;
  const body = filas.map(r => `<tr><td>${esc(r)}</td>${cols.map(c => `<td class="num">${m[r][c] ? usd(m[r][c]) : '<small>—</small>'}</td>`).join('')}<td class="num"><b>${usd(r2(cols.reduce((a, c) => a + m[r][c], 0)))}</b></td></tr>`).join('');
  const pie = `<tr><td><b>Total</b></td>${cols.map(c => `<td class="num"><b>${usd(tc[c])}</b></td>`).join('')}<td class="num"><b>${usd(r2(cols.reduce((a, c) => a + tc[c], 0)))}</b></td></tr>`;
  return `<div class="scroll"><table>${head}${body}${pie}</table></div>`;
}

async function datosReportes() {
  try { await C().sincronizar(false); } catch (e) { console.error('Error sincronizando reportes:', e); }
  const [pg, eg, cs, nv, tar, emps] = await Promise.all([P.datos(true), E.datos(true), cargarTabla('COBROS_SERVICIO', CS_H, true), cargarTabla('NOVEDADES_COBRO', NV_H, true), cargarTarifas(), E.empleadosTodos(true)]);
  return { pg, eg, cobros: armar(cs, nv), tar, emps };
}

function rangoDe(q, hoy) {
  let desde = fechaValida(q.desde) ? q.desde : hoy.slice(0, 7) + '-01';
  let hasta = fechaValida(q.hasta) ? q.hasta : hoy;
  if (!fechaValida(q.hasta) && !fechaValida(q.desde)) { const [y, m] = hoy.split('-').map(Number); hasta = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
  if (desde > hasta) { const t = desde; desde = hasta; hasta = t; }
  const anio = /^\d{4}$/.test(String(q.anio || '')) ? String(q.anio) : hoy.slice(0, 4);
  return { desde, hasta, anio };
}

function reporteAging(cobros, d, tar, hoy) {
  const B = ['0-30', '31-60', '61-90', '90+'];
  const cubo = n => n <= 30 ? 0 : n <= 60 ? 1 : n <= 90 ? 2 : 3;
  const porPag = {}, porSitio = {};
  cobros.forEach(c => {
    const e = require('./pagos').estadoCobro(c, d);
    if (!e || e.saldo <= EPS) return;
    const pag = String(c.Pagador || '').trim() || P.pagadorDeCliente(c.Cliente, tar);
    const i = cubo(Math.max(0, dias(c._fecha, hoy)));
    [[porPag, pag], [porSitio, c.Cliente]].forEach(([mp, k]) => { mp[k] = mp[k] || [0, 0, 0, 0]; mp[k][i] = r2(mp[k][i] + e.saldo); });
  });
  const tabla = (mp, tit) => {
    const ks = Object.keys(mp).sort((a, b) => sumar(mp[b], x => x) - sumar(mp[a], x => x));
    const tot = [0, 1, 2, 3].map(i => r2(ks.reduce((a, k) => a + mp[k][i], 0)));
    if (!ks.length) return `<p><small>Sin saldos pendientes.</small></p>`;
    return `<div class="scroll"><table><tr><th>${tit}</th>${B.map(b => `<th class="num">${b} días</th>`).join('')}<th class="num">Total</th></tr>
      ${ks.map(k => `<tr><td>${esc(k)}</td>${mp[k].map(v => `<td class="num">${v ? usd(v) : '<small>—</small>'}</td>`).join('')}<td class="num"><b>${usd(sumar(mp[k], x => x))}</b></td></tr>`).join('')}
      <tr><td><b>Total</b></td>${tot.map(v => `<td class="num"><b>${usd(v)}</b></td>`).join('')}<td class="num"><b>${usd(sumar(tot, x => x))}</b></td></tr></table></div>`;
  };
  const favor = {};
  d.libres.forEach(p => { const k = String(p.Pagador || '').trim() || '(sin pagador)'; favor[k] = r2((favor[k] || 0) + p._libre); });
  const fk = Object.keys(favor).sort((a, b) => favor[b] - favor[a]);
  const tfav = sumar(fk, k => favor[k]);
  return `<h3>Antigüedad de cartera (por fecha del servicio, a hoy)</h3>
    <h4>Por cliente (pagador)</h4>${tabla(porPag, 'Cliente')}<h4>Por sitio</h4>${tabla(porSitio, 'Sitio')}
    <h4>Saldo a favor (aparte, no se resta de la cartera)</h4>
    ${fk.length ? `<div class="scroll"><table><tr><th>Cliente</th><th class="num">Saldo a favor</th></tr>${fk.map(k => `<tr><td>${esc(k)}</td><td class="num">${usd(favor[k])}</td></tr>`).join('')}<tr><td><b>Total</b></td><td class="num"><b>${usd(tfav)}</b></td></tr></table></div>` : '<p><small>Sin saldos a favor.</small></p>'}`;
}

async function paginaReportes(q, admin) {
  const hoy = hoyFlorida();
  const { desde, hasta, anio } = rangoDe(q, hoy);
  const sMet = seleccion(q, 'metodo', METODOS), sCta = seleccion(q, 'cuenta', CUENTAS);
  const { pg, eg, cobros, tar, emps } = await datosReportes();

  const pasa = (met, cta) => sMet.includes(met) && sCta.includes(cta);
  const ing = pg.pagos.filter(p => p.ID_Pago && p.Estado === 'Activo').map(p => ({ ...p, _f: P.fechaEfectivaIngreso(p) })).filter(p => pasa(p.Metodo, p.Cuenta_Destino));
  const egr = eg.egresos.filter(e => e.ID_Egreso && e.Estado === 'Activo').map(e => ({ ...e, _f: E.fechaEfectivaEgreso(e) })).filter(e => pasa(e.Metodo, e.Cuenta_Origen));
  const enRango = l => l.filter(x => x._f && x._f >= desde && x._f <= hasta);
  const ingR = enRango(ing), egrR = enRango(egr);
  const tIng = sumar(ingR, val), tEgr = sumar(egrR, val);

  // por depositar / por debitar (sin fecha efectiva; sin límite de fechas)
  const enMano = ing.filter(p => p.Cuenta_Destino === EFECTIVO_MANO && !fechaValida(normalizarFecha(p.Fecha_Banco)));
  const porAcreditar = ing.filter(p => !p._f);
  const porDebitar = egr.filter(e => !e._f);

  // flujo por cuenta
  const flujo = CUENTAS.filter(c => sCta.includes(c)).map(c => {
    const i = sumar(ingR.filter(p => p.Cuenta_Destino === c), val), o = sumar(egrR.filter(e => e.Cuenta_Origen === c), val);
    return `<tr><td>${esc(c)}</td><td class="num">${usd(i)}</td><td class="num">${usd(o)}</td><td class="num ${r2(i - o) < 0 ? 'neg' : ''}"><b>${usd(r2(i - o))}</b></td></tr>`;
  }).join('');

  // pagos a empleados del año (sin filtros de cuenta/método: importa cuánto se le entregó a cada uno)
  const nom = eg.egresos.filter(e => e.ID_Egreso && e.Estado === 'Activo' && e.Tipo === 'Nómina').map(e => ({ e, f: E.fechaEfectivaEgreso(e) })).filter(x => x.f.startsWith(anio));
  const nomPend = eg.egresos.filter(e => e.ID_Egreso && e.Estado === 'Activo' && e.Tipo === 'Nómina' && !E.fechaEfectivaEgreso(e));
  const porEmp = {};
  nom.forEach(({ e, f }) => { const k = e.Beneficiario || '(sin nombre)'; porEmp[k] = porEmp[k] || new Array(12).fill(0); const m = +f.slice(5, 7) - 1; porEmp[k][m] = r2(porEmp[k][m] + val(e)); });
  const nombres = Object.keys(porEmp).sort((a, b) => sumar(porEmp[b], x => x) - sumar(porEmp[a], x => x));
  const totMes = MESES.map((_, i) => r2(nombres.reduce((a, k) => a + porEmp[k][i], 0)));
  const tablaEmp = nombres.length ? `<div class="scroll"><table><tr><th>Empleado</th>${MESES.map(m => `<th class="num">${m}</th>`).join('')}<th class="num">Total ${esc(anio)}</th></tr>
    ${nombres.map(k => `<tr><td>${esc(k)}</td>${porEmp[k].map(v => `<td class="num">${v ? usd(v) : '<small>—</small>'}</td>`).join('')}<td class="num"><b>${usd(sumar(porEmp[k], x => x))}</b></td></tr>`).join('')}
    <tr><td><b>Total</b></td>${totMes.map(v => `<td class="num"><b>${v ? usd(v) : '—'}</b></td>`).join('')}<td class="num"><b>${usd(sumar(totMes, x => x))}</b></td></tr></table></div>` : '<p><small>Sin pagos a empleados con fecha de banco en este año.</small></p>';
  const sinPago = emps.filter(x => x.activo && !porEmp[x.n]).map(x => x.n);

  // egresos vs ingresos por mes del año (con filtros)
  const mesI = MESES.map((_, i) => sumar(ing.filter(p => p._f && p._f.startsWith(anio) && +p._f.slice(5, 7) - 1 === i), val));
  const mesE = MESES.map((_, i) => sumar(egr.filter(e => e._f && e._f.startsWith(anio) && +e._f.slice(5, 7) - 1 === i), val));
  const tablaMes = `<div class="scroll"><table><tr><th>${esc(anio)}</th>${MESES.map(m => `<th class="num">${m}</th>`).join('')}<th class="num">Total</th></tr>
    <tr><td>Ingresos</td>${mesI.map(v => `<td class="num">${v ? usd(v) : '<small>—</small>'}</td>`).join('')}<td class="num"><b>${usd(sumar(mesI, x => x))}</b></td></tr>
    <tr><td>Egresos</td>${mesE.map(v => `<td class="num">${v ? usd(v) : '<small>—</small>'}</td>`).join('')}<td class="num"><b>${usd(sumar(mesE, x => x))}</b></td></tr>
    <tr><td><b>Neto</b></td>${mesI.map((v, i) => { const n = r2(v - mesE[i]); return `<td class="num ${n < 0 ? 'neg' : ''}"><b>${v || mesE[i] ? usd(n) : '—'}</b></td>`; }).join('')}<td class="num"><b>${usd(r2(sumar(mesI, x => x) - sumar(mesE, x => x)))}</b></td></tr></table></div>`;

  // por categoría en el rango
  const cat = (l, f) => { const m = {}; l.forEach(x => { const k = f(x) || 'Sin categoría'; m[k] = r2((m[k] || 0) + val(x)); }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const tcat = (arr, tot) => arr.length ? `<div class="scroll"><table>${arr.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${usd(v)}</td></tr>`).join('')}<tr><td><b>Total</b></td><td class="num"><b>${usd(tot)}</b></td></tr></table></div>` : '<p><small>Sin movimientos.</small></p>';

  const lista = (l, tit, f) => l.length ? `<div class="scroll"><table><tr><th>Fecha</th><th>${tit}</th><th>Método y cuenta</th><th class="num">Valor</th></tr>${l.slice().sort((a, b) => f.fecha(a).localeCompare(f.fecha(b))).map(x => `<tr><td>${esc(f.fecha(x))}</td><td>${esc(f.quien(x))}</td><td>${esc(x.Metodo)} · <small>${esc(f.cuenta(x))}</small></td><td class="num">${usd(val(x))}</td></tr>`).join('')}</table></div>` : '<p><small>Nada pendiente.</small></p>';
  const fIng = { fecha: p => normalizarFecha(p.Fecha_Recibido), quien: p => p.Pagador || p.Cliente || p.Concepto, cuenta: p => p.Cuenta_Destino };
  const fEgr = { fecha: e => normalizarFecha(e.Fecha_Pago), quien: e => e.Beneficiario || e.Categoria, cuenta: e => e.Cuenta_Origen };

  const aging = reporteAging(cobros, pg, tar, hoy);
  const base = { desde, hasta, anio, metodo: sMet.length === METODOS.length ? '' : sMet, cuenta: sCta.length === CUENTAS.length ? '' : sCta };
  const mesAct = hoy.slice(0, 7);
  const [ay, am] = [+hoy.slice(0, 4), +hoy.slice(5, 7)];
  const finMes = new Date(Date.UTC(ay, am, 0)).toISOString().slice(0, 10);
  const css = `.rep h3{margin:22px 0 6px;border-bottom:1px solid #ddd;padding-bottom:4px;} .rep h4{margin:12px 0 4px;} .rep .scroll{max-height:none;} .rep td,.rep th{padding:5px 8px;}
    .ctl{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px;} .ctl label{font-size:13px;display:block;} .ctl input{padding:6px;border:1px solid #ccc;border-radius:6px;}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Reportes</title><style>${CSS}${CSS_PAGOS}${css}${menu.MENU_CSS}</style></head><body class="rep">
<div class="top"><h2 style="margin:0;">Reportes de cartera</h2>${menu.menuHtml('/cartera', admin)}</div>
<div class="nav"><a class="btn" href="/cartera">← Cartera</a><a class="btn" href="/cartera/pagos">Ingresos</a><a class="btn" href="/cartera/egresos">Egresos</a>
  <a class="btn" href="/cartera/reportes?${esc(qsDe({ ...base, desde: mesAct + '-01', hasta: finMes }))}">Este mes</a>
  <a class="btn" href="/cartera/reportes?${esc(qsDe({ ...base, desde: ay + '-01-01', hasta: ay + '-12-31', anio: String(ay) }))}">Este año</a></div>
<form method="GET" action="/cartera/reportes"><div class="ctl">
  <label>Desde<input type="date" name="desde" value="${esc(desde)}"></label><label>Hasta<input type="date" name="hasta" value="${esc(hasta)}"></label>
  <label>Año (empleados y meses)<input type="number" name="anio" value="${esc(anio)}" min="2020" max="2100" style="width:90px"></label>
  ${grupoChecks('metodo', 'Métodos', METODOS, sMet)}${grupoChecks('cuenta', 'Cuentas', CUENTAS, sCta)}
  <button class="btn hoy">Aplicar</button></div></form>
<div class="aviso">Los reportes usan la fecha de banco (efectivo en mano: su propia fecha). Lo que aún no tiene fecha de banco no entra en ingresos/egresos y se lista como pendiente. Cuentas y métodos marcados: ${sCta.length === CUENTAS.length && sMet.length === METODOS.length ? 'todos' : 'filtrado'}.</div>

<h3>Ingresos ${esc(desde)} a ${esc(hasta)}: ${usd(tIng)}</h3>
${matriz(ingR, CUENTAS.filter(c => sCta.includes(c)), METODOS.filter(m => sMet.includes(m)), p => p.Cuenta_Destino, p => p.Metodo, val)}
<h3>Egresos ${esc(desde)} a ${esc(hasta)}: ${usd(tEgr)}</h3>
${matriz(egrR, CUENTAS.filter(c => sCta.includes(c)), METODOS.filter(m => sMet.includes(m)), e => e.Cuenta_Origen, e => e.Metodo, val)}
<h3>Movimiento por cuenta (conciliación)</h3>
<div class="scroll"><table><tr><th>Cuenta</th><th class="num">Ingresos</th><th class="num">Egresos</th><th class="num">Neto</th></tr>${flujo}<tr><td><b>Total</b></td><td class="num"><b>${usd(tIng)}</b></td><td class="num"><b>${usd(tEgr)}</b></td><td class="num"><b>${usd(r2(tIng - tEgr))}</b></td></tr></table></div>

<h3>Por depositar: efectivo en mano sin depositar — ${usd(sumar(enMano, val))} (${enMano.length})</h3>
${lista(enMano, 'Pagador', fIng)}
<h3>Ingresos por acreditar (cuenta de banco sin fecha de banco) — ${usd(sumar(porAcreditar, val))} (${porAcreditar.length})</h3>
${lista(porAcreditar, 'Pagador', fIng)}
<h3>Egresos por debitar — ${usd(sumar(porDebitar, val))} (${porDebitar.length})</h3>
${lista(porDebitar, 'Beneficiario / categoría', fEgr)}

<h3>Pagos a empleados ${esc(anio)} (enero a diciembre, sin importar la cuenta)</h3>
${tablaEmp}
${nomPend.length ? `<p><small>Hay ${nomPend.length} pago(s) de nómina por debitar (${usd(sumar(nomPend, val))}) que aún no cuentan aquí.</small></p>` : ''}
${sinPago.length ? `<p><small>Empleados activos sin pagos en ${esc(anio)}: ${esc(sinPago.join(', '))}.</small></p>` : ''}

<h3>Ingresos vs egresos por mes</h3>
${tablaMes}
<h3>Por categoría (${esc(desde)} a ${esc(hasta)})</h3>
<div class="ctl" style="align-items:flex-start"><div style="min-width:280px"><h4>Ingresos</h4>${tcat(cat(ingR, nombreIngreso), tIng)}</div><div style="min-width:280px"><h4>Egresos</h4>${tcat(cat(egrR, e => e.Categoria), tEgr)}</div></div>

${aging}
</body></html>`;
}

function rutas(app, auth) {
  app.get('/cartera/reportes', auth.requiereAdmin, async (req, res) => {
    try { res.set('Content-Type', 'text/html; charset=utf-8'); res.send(await paginaReportes(req.query, req.admin)); }
    catch (e) { console.error('Error en GET /cartera/reportes:', e); res.status(500).send('Error cargando los reportes: ' + e.message); }
  });
}

module.exports = { rutas, paginaReportes };
