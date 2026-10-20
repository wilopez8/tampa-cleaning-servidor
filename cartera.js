const { leerHoja, agregarFila, agregarFilas, actualizarCeldas, asegurarHoja } = require('./sheets');
const { normalizarFecha, fechaValida, hoyFlorida, filasDelRango } = require('./agenda');
const menu = require('./menu');

const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r2 = x => Math.round(x * 100) / 100;
const usd = n => '$' + (n || 0).toFixed(2);
const p2 = n => String(n).padStart(2, '0');
const ahora = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
function numero(t) {
  let s = String(t ?? '').replace(/[$\s]/g, '');
  if (!s) return NaN;
  const c = s.lastIndexOf(','), p = s.lastIndexOf('.');
  if (c >= 0 && p >= 0) s = c > p ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (c >= 0) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  return parseFloat(s);
}
const mesValido = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
function sumarMes(m, n) { const [a, b] = m.split('-').map(Number); return new Date(Date.UTC(a, b - 1 + n, 1)).toISOString().slice(0, 7); }

const CFG_H = ['Clave', 'Valor', 'Descripcion'];
const CS_H = ['ID_Cobro', 'Clave', 'Fecha', 'Cliente', 'Pagador', 'Tipo', 'Empleados', 'IDs_Programacion', 'Estado', 'Motivo', 'Valor_Base', 'Valor_Original', 'Decision', 'Decidido_Por', 'Fecha_Decision', 'Origen', 'Fecha_Creacion'];
const EX_H = ['ID_Extra', 'ID_Cobro', 'Descripcion', 'Monto', 'Estado', 'Creado_Por', 'Fecha_Creacion', 'Anulado_Por', 'Motivo_Anulacion'];
const BIT_H = ['Fecha_Hora', 'ID_Cobro', 'Accion', 'Detalle', 'Motivo', 'Admin'];

// Una sola escritura a la vez (evita IDs repetidos y filas duplicadas)
let cola = Promise.resolve();
const enCola = fn => { const p = cola.then(fn); cola = p.catch(() => {}); return p; };

const aseguradas = new Set();
async function cargarTabla(nombre, headers, directo) {
  if (!aseguradas.has(nombre)) { await asegurarHoja(nombre, headers); aseguradas.add(nombre); }
  const d = await leerHoja(nombre, directo ? {} : { cache: true });
  const lista = [];
  lista.h = (d[0] && d[0].length) ? d[0] : headers;
  for (let i = 1; i < d.length; i++) {
    const o = { _fila: i + 1 };
    lista.h.forEach((n, j) => { o[n] = d[i][j] === undefined ? '' : String(d[i][j]); });
    lista.push(o);
  }
  return lista;
}
const aFila = (h, o) => h.map(k => o[k] ?? '');
const poner = (hoja, lista, o, mapa) => actualizarCeldas(hoja, Object.entries(mapa)
  .map(([k, v]) => ({ fila: o._fila, columna: lista.h.indexOf(k) + 1, valor: v })).filter(x => x.columna > 0));
async function bit(id, accion, detalle, motivo, admin) {
  await asegurarHoja('COBROS_BITACORA', BIT_H);
  await agregarFila('COBROS_BITACORA', [ahora(), id, accion, detalle, motivo || '', admin]);
}

async function cargarConfig() {
  if (!aseguradas.has('CONFIG_CARTERA')) { await asegurarHoja('CONFIG_CARTERA', CFG_H); aseguradas.add('CONFIG_CARTERA'); }
  let d = await leerHoja('CONFIG_CARTERA', { cache: true });
  const defecto = hoyFlorida().slice(0, 8) + '01';
  if (d.length < 2) {
    await agregarFila('CONFIG_CARTERA', ['Fecha_Inicio_Cobros', defecto, 'Se generan cobros de los servicios desde esta fecha (AAAA-MM-DD). Para cargar meses anteriores, pon una fecha más antigua.']);
    d = [CFG_H, ['Fecha_Inicio_Cobros', defecto]];
  }
  const h = d[0], iK = h.indexOf('Clave'), iV = h.indexOf('Valor');
  let inicio = null;
  d.slice(1).forEach(f => { if (String(f[iK] || '').trim() === 'Fecha_Inicio_Cobros') inicio = normalizarFecha(f[iV]); });
  return { inicio: fechaValida(inicio) ? inicio : defecto };
}

async function cargarTarifas() {
  const d = await leerHoja('SITIOS', { cache: true });
  const out = { mapa: {}, hayColumna: false };
  if (d.length < 2) return out;
  const h = d[0], iN = h.indexOf('Nombre_Cliente'), iT = h.indexOf('Tarifa_Servicio'), iP = h.indexOf('Pagador'), iE = h.indexOf('Estatus');
  out.hayColumna = iT >= 0;
  if (iN < 0) return out;
  for (let i = 1; i < d.length; i++) {
    const n = String(d[i][iN] || '').trim();
    if (!n) continue;
    const activo = iE < 0 ? true : String(d[i][iE] || '').trim() === 'Activo';
    if (out.mapa[n] && out.mapa[n].activo && !activo) continue;
    out.mapa[n] = { tarifa: iT >= 0 ? numero(d[i][iT]) : NaN, pagador: iP >= 0 ? String(d[i][iP] || '').trim() : '', activo };
  }
  return out;
}

// ---------- generación de cobros a partir de la agenda ----------
function agrupar(filas) {
  const g = new Map();
  filas.filter(r => r.Cliente && r.ID_Programacion).forEach(r => {
    const tipo = r.Tipo_Servicio || 'Limpieza', cliente = r.Cliente.trim();
    const clave = `${cliente}|${r._fecha}|${tipo}`;
    if (!g.has(clave)) g.set(clave, { clave, cliente, fecha: r._fecha, tipo, rows: [] });
    g.get(clave).rows.push(r);
  });
  return [...g.values()];
}
const motivosCanc = g => [...new Set(g.rows.map(r => String(r.Motivo_Cancelacion || '').trim()).filter(Boolean))].join('; ');
function evaluar(g, hoy) {
  const act = g.rows.filter(r => r._estado !== 'Cancelado');
  const mc = motivosCanc(g);
  if (g.tipo === 'Inspeccion') return { estado: 'No se cobra', motivo: act.length ? 'Inspección (no se cobra)' : 'Inspección cancelada' + (mc ? ': ' + mc : '') };
  if (!act.length) return { estado: 'No se cobra', motivo: 'Cancelado' + (mc ? ': ' + mc : '') };
  if (act.every(r => r._estado === 'Finalizado')) return { estado: 'Por cobrar', motivo: '' };
  if (g.fecha < hoy) return { estado: 'Por definir', motivo: 'Servicio sin completar (' + [...new Set(act.filter(r => r._estado !== 'Finalizado').map(r => r._estado))].join(', ') + ')' };
  return null; // servicio de hoy aún sin terminar: todavía no genera cobro
}

let ultimaSync = 0;
function sincronizar(forzar) {
  return enCola(async () => {
    if (!forzar && Date.now() - ultimaSync < 30000) return;
    const cfg = await cargarConfig();
    const hoy = hoyFlorida();
    const [filas, tar, lista] = await Promise.all([filasDelRango(cfg.inicio, hoy), cargarTarifas(), cargarTabla('COBROS_SERVICIO', CS_H, true)]);
    const porClave = new Map();
    const contadores = {};
    lista.forEach(o => {
      if (o.Clave) porClave.set(o.Clave, o);
      const m = String(o.ID_Cobro).match(/^(COB-\d{8}-)(\d+)$/);
      if (m) contadores[m[1]] = Math.max(contadores[m[1]] || 0, +m[2]);
    });
    const nuevas = [], celdas = [];
    const col = n => lista.h.indexOf(n) + 1;
    const set = (o, n, v) => { if (col(n) > 0) celdas.push({ fila: o._fila, columna: col(n), valor: v }); };

    for (const g of agrupar(filas)) {
      const ev = evaluar(g, hoy);
      const act = g.rows.filter(r => r._estado !== 'Cancelado');
      const base = act.length ? act : g.rows;
      const empleados = [...new Set(base.map(r => String(r.Empleado || '').trim()).filter(Boolean))].join(', ');
      const ids = base.map(r => r.ID_Programacion).join(',');
      const t = tar.mapa[g.cliente];
      const tarifa = t && t.tarifa > 0 ? r2(t.tarifa) : '';
      const o = porClave.get(g.clave);
      if (!o) {
        if (!ev) continue;
        const pref = 'COB-' + g.fecha.replace(/-/g, '') + '-';
        contadores[pref] = (contadores[pref] || 0) + 1;
        const cobra = ev.estado === 'Por cobrar';
        nuevas.push(aFila(lista.h, {
          ID_Cobro: pref + p2(contadores[pref]), Clave: g.clave, Fecha: g.fecha, Cliente: g.cliente, Pagador: t ? t.pagador : '', Tipo: g.tipo,
          Empleados: empleados, IDs_Programacion: ids, Estado: ev.estado, Motivo: ev.motivo,
          Valor_Base: cobra ? tarifa : '', Valor_Original: cobra ? tarifa : '', Decision: 'Auto', Decidido_Por: 'Sistema', Fecha_Decision: ahora(), Origen: 'Normal', Fecha_Creacion: ahora(),
        }));
        continue;
      }
      if (o.Empleados !== empleados) set(o, 'Empleados', empleados);
      if (o.IDs_Programacion !== ids) set(o, 'IDs_Programacion', ids);
      if ((o.Decision || 'Auto') !== 'Auto' || !ev) continue; // lo decidido a mano no se toca
      if (o.Estado !== ev.estado) {
        set(o, 'Estado', ev.estado); set(o, 'Motivo', ev.motivo);
        if (ev.estado === 'Por cobrar' && tarifa !== '') { set(o, 'Valor_Base', tarifa); set(o, 'Valor_Original', tarifa); }
      } else if (o.Estado === 'Por cobrar' && !(numero(o.Valor_Base) > 0) && tarifa !== '') {
        set(o, 'Valor_Base', tarifa); set(o, 'Valor_Original', tarifa);
      }
    }
    if (celdas.length) await actualizarCeldas('COBROS_SERVICIO', celdas);
    if (nuevas.length) await agregarFilas('COBROS_SERVICIO', nuevas);
    ultimaSync = Date.now();
  });
}

// ---------- acciones del administrador ----------
async function buscar(id) {
  const lista = await cargarTabla('COBROS_SERVICIO', CS_H, true);
  return { lista, c: lista.find(x => x.ID_Cobro === String(id || '').trim()) };
}
const motivoOk = m => String(m || '').trim().length >= 3;

function cobrar({ id, valor, motivo, admin }) {
  return enCola(async () => {
    if (!motivoOk(motivo)) return { ok: false, general: 'El motivo es obligatorio (mínimo 3 caracteres).' };
    const { lista, c } = await buscar(id);
    if (!c) return { ok: false, general: 'Cobro no encontrado.' };
    if (!(c.Estado === 'Por definir' || (c.Estado === 'No se cobra' && c.Decision === 'Manual'))) return { ok: false, general: 'Este servicio no se puede pasar a cobrar.' };
    let v;
    if (String(valor ?? '').trim() !== '') {
      v = numero(valor);
      if (!(v > 0)) return { ok: false, general: 'El valor no es válido.' };
    } else {
      const t = (await cargarTarifas()).mapa[c.Cliente];
      v = t && t.tarifa > 0 ? t.tarifa : NaN;
      if (!(v > 0)) return { ok: false, general: 'Este sitio no tiene tarifa en SITIOS. Escribe el valor.' };
    }
    v = r2(v);
    await poner('COBROS_SERVICIO', lista, c, { Estado: 'Por cobrar', Motivo: 'Manual: ' + String(motivo).trim(), Valor_Base: v, Valor_Original: c.Valor_Original || v, Decision: 'Manual', Decidido_Por: admin, Fecha_Decision: ahora() });
    await bit(c.ID_Cobro, 'Cobrar', `${c.Estado} → Por cobrar, valor ${usd(v)}`, motivo, admin);
    return { ok: true };
  });
}

function noCobrar({ id, motivo, admin }) {
  return enCola(async () => {
    if (!motivoOk(motivo)) return { ok: false, general: 'El motivo es obligatorio (mínimo 3 caracteres).' };
    const { lista, c } = await buscar(id);
    if (!c) return { ok: false, general: 'Cobro no encontrado.' };
    if (!['Por definir', 'Por cobrar'].includes(c.Estado)) return { ok: false, general: 'Este servicio ya no se cobra.' };
    await poner('COBROS_SERVICIO', lista, c, { Estado: 'No se cobra', Motivo: String(motivo).trim(), Decision: 'Manual', Decidido_Por: admin, Fecha_Decision: ahora() });
    await bit(c.ID_Cobro, 'No cobrar', `${c.Estado} → No se cobra`, motivo, admin);
    return { ok: true };
  });
}

function ajustarValor({ id, valor, motivo, admin }) {
  return enCola(async () => {
    if (!motivoOk(motivo)) return { ok: false, general: 'El motivo es obligatorio (mínimo 3 caracteres).' };
    const v = numero(valor);
    if (!(v > 0)) return { ok: false, general: 'El valor no es válido.' };
    const { lista, c } = await buscar(id);
    if (!c) return { ok: false, general: 'Cobro no encontrado.' };
    if (c.Estado !== 'Por cobrar') return { ok: false, general: 'Solo se ajusta el valor de un servicio por cobrar.' };
    const nuevo = r2(v), anterior = numero(c.Valor_Base);
    await poner('COBROS_SERVICIO', lista, c, { Valor_Base: nuevo, Valor_Original: c.Valor_Original || (anterior > 0 ? anterior : nuevo), Motivo: 'Valor ajustado: ' + String(motivo).trim() });
    await bit(c.ID_Cobro, 'Ajustar valor', `${anterior > 0 ? usd(anterior) : 'sin valor'} → ${usd(nuevo)}`, motivo, admin);
    return { ok: true };
  });
}

function agregarExtra({ id, descripcion, monto, admin }) {
  return enCola(async () => {
    if (String(descripcion || '').trim().length < 3) return { ok: false, general: 'La descripción es obligatoria (mínimo 3 caracteres).' };
    const m = numero(monto);
    if (!(m > 0)) return { ok: false, general: 'El monto debe ser mayor que 0.' };
    const { c } = await buscar(id);
    if (!c) return { ok: false, general: 'Cobro no encontrado.' };
    if (c.Estado !== 'Por cobrar') return { ok: false, general: 'Solo se agregan extras a un servicio por cobrar.' };
    const ex = await cargarTabla('COBROS_EXTRAS', EX_H, true);
    const pref = 'EXT-' + hoyFlorida().replace(/-/g, '') + '-';
    const idExtra = pref + p2(ex.filter(e => e.ID_Extra.startsWith(pref)).length + 1);
    await agregarFila('COBROS_EXTRAS', aFila(ex.h, { ID_Extra: idExtra, ID_Cobro: c.ID_Cobro, Descripcion: String(descripcion).trim(), Monto: r2(m), Estado: 'Activo', Creado_Por: admin, Fecha_Creacion: ahora() }));
    await bit(c.ID_Cobro, 'Agregar extra', `${idExtra}: ${String(descripcion).trim()} ${usd(r2(m))}`, '', admin);
    return { ok: true };
  });
}

function anularExtra({ id, motivo, admin }) {
  return enCola(async () => {
    if (!motivoOk(motivo)) return { ok: false, general: 'El motivo es obligatorio (mínimo 3 caracteres).' };
    const ex = await cargarTabla('COBROS_EXTRAS', EX_H, true);
    const e = ex.find(x => x.ID_Extra === String(id || '').trim());
    if (!e) return { ok: false, general: 'Extra no encontrado.' };
    if (e.Estado !== 'Activo') return { ok: false, general: 'El extra ya estaba anulado.' };
    await poner('COBROS_EXTRAS', ex, e, { Estado: 'Anulado', Anulado_Por: admin, Motivo_Anulacion: String(motivo).trim() });
    await bit(e.ID_Cobro, 'Anular extra', `${e.ID_Extra}: ${e.Descripcion} ${usd(numero(e.Monto) || 0)}`, motivo, admin);
    return { ok: true };
  });
}

// ---------- página ----------
const CSS = `
body{font-family:-apple-system,Arial,sans-serif;margin:0;padding:20px 28px;color:#222;background:#f6f7f9;}
a{color:#1d4ed8;text-decoration:none;}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;}
.nav{display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap;}
.btn{background:#fff;border:1px solid #ccc;border-radius:6px;padding:7px 12px;font-size:14px;cursor:pointer;color:#222;display:inline-block;}
.mini{padding:2px 8px;font-size:12px;margin:2px 2px 0 0;}
.hoy{background:#2e7d32;color:#fff;border-color:#2e7d32;} .warn{background:#b45309;color:#fff;border-color:#b45309;}
.aviso{background:#eef2ff;border-radius:6px;padding:8px 12px;font-size:14px;margin-bottom:12px;}
.aviso.r{background:#fef2f2;} .aviso.y{background:#fffbeb;}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;margin-bottom:18px;}
th,td{padding:8px 10px;text-align:left;font-size:13px;border-bottom:1px solid #eee;vertical-align:top;}
th{background:#f1f3f5;} tfoot td{font-weight:700;background:#f9fafb;}
.num{text-align:right;white-space:nowrap;} .neg{color:#b91c1c;} .anu{color:#999;text-decoration:line-through;}
.est{padding:2px 8px;border-radius:10px;font-size:12px;background:#e5e7eb;}
.est.ok{background:#bbf7d0;} .est.rev{background:#fecaca;} .est.sp{background:#e5e7eb;color:#555;}
small{color:#777;}
.filtros{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;} .filtros select{padding:7px;border:1px solid #ccc;border-radius:6px;font-size:14px;}
td details summary{cursor:pointer;color:#1d4ed8;}
dialog{border:1px solid #ccc;border-radius:10px;padding:18px;max-width:360px;width:90%;}
dialog label{display:block;margin:10px 0;font-size:14px;}
dialog input{width:100%;padding:8px;font-size:15px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;}`;

const SCRIPT = `
function $(i){return document.getElementById(i);}
function post(url,data,errId){fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(function(r){return r.json();}).then(function(j){if(j.ok){location.reload();}else{$(errId).textContent=j.general||'Error';}}).catch(function(){$(errId).textContent='Error de conexión';});}
var modo=null,idSel=null;
var AYUDA={cobrar:'Deja el valor vacío para usar la tarifa del sitio.',valor:'El valor original queda guardado.',extra:'Productos u otros cobros. Se suma al valor del servicio.',nocobrar:'',anular:''};
function tcAbrir(b){modo=b.dataset.modo;idSel=b.dataset.id;$('dt').textContent=b.dataset.t;$('dv').value=b.dataset.v||'';$('dd').value='';$('dm').value='';$('de').textContent='';
$('rv').style.display=(modo==='cobrar'||modo==='valor'||modo==='extra')?'block':'none';
$('rvt').textContent=modo==='extra'?'Monto del extra (USD)':'Valor del servicio (USD)';
$('rd').style.display=modo==='extra'?'block':'none';
$('rm').style.display=modo==='extra'?'none':'block';
$('dh').textContent=AYUDA[modo]||'';$('dlg').showModal();}
function tcGuardar(){var v=$('dv').value.trim(),d=$('dd').value.trim(),m=$('dm').value.trim();
if(modo==='extra'){if(d.length<3){$('de').textContent='La descripción es obligatoria.';return;}if(!(parseFloat(v)>0)){$('de').textContent='El monto no es válido.';return;}post('/cartera/extra',{id:idSel,descripcion:d,monto:v},'de');return;}
if(m.length<3){$('de').textContent='El motivo es obligatorio.';return;}
if(modo==='valor'&&!(parseFloat(v)>0)){$('de').textContent='El valor no es válido.';return;}
var url={cobrar:'/cartera/cobrar',nocobrar:'/cartera/nocobrar',valor:'/cartera/valor',anular:'/cartera/extra/anular'}[modo];
post(url,{id:idSel,valor:v,motivo:m},'de');}`;

async function paginaCartera(query, admin) {
  const hoy = hoyFlorida();
  let errSync = '';
  try { await sincronizar(query.sync === '1'); } catch (e) { console.error('Error sincronizando cartera:', e); errSync = e.message; }
  const mes = query.mes === 'todo' ? 'todo' : (mesValido(query.mes) ? query.mes : hoy.slice(0, 7));
  const [cfg, tar, lista, listaEx] = await Promise.all([cargarConfig(), cargarTarifas(), cargarTabla('COBROS_SERVICIO', CS_H), cargarTabla('COBROS_EXTRAS', EX_H)]);

  const extrasPor = {};
  listaEx.filter(e => e.ID_Extra).forEach(e => { (extrasPor[e.ID_Cobro] = extrasPor[e.ID_Cobro] || []).push(e); });
  const cobros = lista.filter(o => o.ID_Cobro).map(o => {
    const ext = r2((extrasPor[o.ID_Cobro] || []).filter(e => e.Estado === 'Activo').reduce((a, e) => a + (numero(e.Monto) || 0), 0));
    const base = numero(o.Valor_Base);
    return { ...o, _fecha: normalizarFecha(o.Fecha), _base: base > 0 ? base : 0, _ext: ext, _total: r2((base > 0 ? base : 0) + ext), _sinTarifa: o.Estado === 'Por cobrar' && !(base > 0) };
  });
  const enMes = cobros.filter(c => mes === 'todo' || c._fecha.startsWith(mes));

  // resumen por cliente
  const res = {};
  enMes.forEach(c => {
    const x = res[c.Cliente] = res[c.Cliente] || { n: 0, base: 0, ext: 0, def: 0, sin: 0 };
    if (c.Estado === 'Por cobrar') { x.n++; x.base += c._base; x.ext += c._ext; if (c._sinTarifa) x.sin++; }
    else if (c.Estado === 'Por definir') x.def++;
  });
  const clientes = Object.keys(res).sort((a, b) => a.localeCompare(b));
  const G = { n: 0, base: 0, ext: 0, def: 0, sin: 0 };
  clientes.forEach(k => Object.keys(G).forEach(f => { G[f] += res[k][f]; }));

  const fCli = clientes.includes(query.cliente) ? query.cliente : '';
  const ESTADOS = ['Por definir', 'Por cobrar', 'No se cobra', 'Sin tarifa'];
  const fEst = ESTADOS.includes(query.estado) ? query.estado : '';
  const url = o => '/cartera?' + Object.entries({ mes, cliente: fCli, estado: fEst, ...o }).filter(([, v]) => v).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

  const vis = enMes.filter(c => (!fCli || c.Cliente === fCli) && (!fEst || (fEst === 'Sin tarifa' ? c._sinTarifa : c.Estado === fEst)))
    .sort((a, b) => a._fecha.localeCompare(b._fecha) || a.Cliente.localeCompare(b.Cliente));

  const filasRes = clientes.map(k => { const x = res[k];
    return `<tr><td><a href="${esc(url({ cliente: k, estado: '' }))}">${esc(k)}</a></td><td class="num">${x.n}</td><td class="num">${usd(x.base)}</td><td class="num">${usd(x.ext)}</td><td class="num"><b>${usd(x.base + x.ext)}</b></td>
      <td class="num">${x.def ? `<span class="est rev">${x.def}</span>` : '0'}</td><td class="num">${x.sin ? `<span class="est rev">${x.sin}</span>` : '0'}</td></tr>`;
  }).join('') || '<tr><td colspan="7" style="text-align:center;color:#888;padding:20px;">No hay cobros en este período.</td></tr>';

  const filasDet = vis.map(c => {
    const ex = extrasPor[c.ID_Cobro] || [];
    const titulo = `${c.Cliente} · ${c._fecha}`;
    const b = (modo, t, txt, v) => `<button class="btn mini" data-modo="${modo}" data-id="${esc(c.ID_Cobro)}" data-t="${esc(t)}" data-v="${v ?? ''}" onclick="tcAbrir(this)">${txt}</button>`;
    let acc = '';
    if (c.Estado === 'Por definir') acc = b('cobrar', titulo, 'Cobrar') + b('nocobrar', titulo, 'No cobrar');
    else if (c.Estado === 'Por cobrar') acc = b('valor', titulo, 'Ajustar valor', c._base || '') + b('extra', titulo, '+ Extra') + b('nocobrar', titulo, 'No cobrar');
    else if (c.Estado === 'No se cobra' && c.Decision === 'Manual') acc = b('cobrar', titulo, 'Cobrar');
    const extrasHtml = ex.length ? `<details><summary><small>${ex.filter(e => e.Estado === 'Activo').length} extra(s) · ${usd(c._ext)}</small></summary>${ex.map(e => `<div${e.Estado !== 'Activo' ? ' class="anu"' : ''}><small>${esc(e.Descripcion)}: ${usd(numero(e.Monto) || 0)}${e.Estado === 'Activo'
      ? ` <button class="btn mini" data-modo="anular" data-id="${esc(e.ID_Extra)}" data-t="${esc('Anular extra ' + e.ID_Extra)}" onclick="tcAbrir(this)">Anular</button>`
      : ' (anulado: ' + esc(e.Motivo_Anulacion) + ')'}</small></div>`).join('')}</details>` : '<small>—</small>';
    const cls = c.Estado === 'Por cobrar' ? (c._sinTarifa ? 'rev' : 'ok') : (c.Estado === 'Por definir' ? 'rev' : 'sp');
    return `<tr><td>${esc(c._fecha)}</td><td>${esc(c.Cliente)}${c.Pagador && c.Pagador !== c.Cliente ? `<br><small>Paga: ${esc(c.Pagador)}</small>` : ''}<br><small>${esc(c.Tipo)}</small></td>
      <td><small>${esc(c.Empleados)}</small></td>
      <td><span class="est ${cls}">${esc(c.Estado)}</span>${c._sinTarifa ? '<br><small class="neg">Sin tarifa en SITIOS</small>' : ''}${c.Motivo ? `<br><small>${esc(c.Motivo)}</small>` : ''}</td>
      <td class="num">${c.Estado === 'Por cobrar' && c._base ? usd(c._base) : '—'}</td><td>${extrasHtml}</td>
      <td class="num"><b>${c.Estado === 'Por cobrar' ? usd(c._total) : '—'}</b></td><td>${acc}</td></tr>`;
  }).join('') || '<tr><td colspan="8" style="text-align:center;color:#888;padding:20px;">Sin servicios para este filtro.</td></tr>';

  const sel = (nombre, etiqueta, opciones, actual) => `<select name="${nombre}"><option value="">${etiqueta}</option>${opciones.map(o => `<option value="${esc(o)}"${actual === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  const etiquetaMes = mes === 'todo' ? 'Todo el histórico' : mes;
  const mesNav = mes === 'todo' ? '' : `<a class="btn" href="${esc(url({ mes: sumarMes(mes, -1) }))}">←</a>
    <a class="btn hoy" href="${esc(url({ mes: hoy.slice(0, 7) }))}">Este mes</a><a class="btn" href="${esc(url({ mes: sumarMes(mes, 1) }))}">→</a>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cartera ${esc(etiquetaMes)}</title><style>${CSS}${menu.MENU_CSS}</style></head><body>
<div class="top"><h2 style="margin:0;">Cartera — ${esc(etiquetaMes)}</h2>${menu.menuHtml('/cartera', admin)}</div>
<div class="nav">${mesNav}
  <a class="btn" href="${esc(url({ mes: mes === 'todo' ? hoy.slice(0, 7) : 'todo' }))}">${mes === 'todo' ? 'Ver por mes' : 'Ver todo el histórico'}</a>
  <a class="btn" href="${esc(url({ sync: '1' }))}">Sincronizar ahora</a>
</div>
${errSync ? `<div class="aviso r">No se pudo sincronizar con la agenda: ${esc(errSync)}</div>` : ''}
${tar.hayColumna ? '' : '<div class="aviso r">Falta la columna <b>Tarifa_Servicio</b> en la hoja SITIOS: ningún servicio tendrá valor.</div>'}
${(G.def || G.sin) ? `<div class="aviso y">${G.def ? `<a href="${esc(url({ estado: 'Por definir' }))}">${G.def} servicio(s) por definir</a> (sin completar: decide si se cobran).` : ''} ${G.sin ? `<a href="${esc(url({ estado: 'Sin tarifa' }))}">${G.sin} servicio(s) sin tarifa</a> (llena Tarifa_Servicio en SITIOS y pulsa Sincronizar, o ajusta el valor).` : ''}</div>` : ''}
<div class="aviso">Se cargan los servicios desde <b>${esc(cfg.inicio)}</b> (hoja CONFIG_CARTERA). Un cobro = un cliente por día y tipo de servicio (si va un equipo, es un solo cobro). Total a cobrar = valor del servicio + extras.</div>
<table><tr><th>Cliente</th><th class="num">Servicios por cobrar</th><th class="num">Valor servicios</th><th class="num">Extras</th><th class="num">Total a cobrar</th><th class="num">Por definir</th><th class="num">Sin tarifa</th></tr>${filasRes}
<tfoot><tr><td>Total</td><td class="num">${G.n}</td><td class="num">${usd(G.base)}</td><td class="num">${usd(G.ext)}</td><td class="num">${usd(G.base + G.ext)}</td><td class="num">${G.def}</td><td class="num">${G.sin}</td></tr></tfoot></table>
<form class="filtros" method="GET" action="/cartera"><input type="hidden" name="mes" value="${esc(mes)}">
  ${sel('cliente', 'Todos los clientes', clientes, fCli)}${sel('estado', 'Todos los estados', ESTADOS, fEst)}
  <button class="btn">Filtrar</button> <a class="btn" href="${esc(url({ cliente: '', estado: '' }))}">Limpiar</a></form>
<table><tr><th>Fecha</th><th>Cliente</th><th>Empleados</th><th>Estado</th><th class="num">Valor</th><th>Extras</th><th class="num">Total</th><th>Acciones</th></tr>${filasDet}</table>
<dialog id="dlg"><h3 id="dt" style="margin-top:0;"></h3>
  <label id="rv"><span id="rvt">Valor (USD)</span><input type="number" id="dv" min="0" step="0.01"></label>
  <label id="rd">Descripción del extra (obligatoria)<input type="text" id="dd" maxlength="200"></label>
  <label id="rm">Motivo (obligatorio)<input type="text" id="dm" maxlength="200"></label>
  <p id="dh" style="font-size:12px;color:#777;"></p>
  <p id="de" style="color:#b91c1c;font-size:13px;"></p>
  <button class="btn hoy" onclick="tcGuardar()">Guardar</button> <button class="btn" onclick="$('dlg').close()">Cancelar</button></dialog>
<script>${SCRIPT}</script>
</body></html>`;
}

// ---------- rutas ----------
function rutas(app, auth) {
  const api = (ruta, fn) => app.post(ruta, auth.requiereAdmin, async (req, res) => {
    try { res.json(await fn(req.body || {}, req.admin)); }
    catch (err) { console.error('Error en POST ' + ruta, err); res.status(500).json({ ok: false, general: 'Error: ' + err.message }); }
  });
  app.get('/cartera', auth.requiereAdmin, async (req, res) => {
    try { res.set('Content-Type', 'text/html; charset=utf-8'); res.send(await paginaCartera(req.query, req.admin)); }
    catch (err) { console.error('Error en GET /cartera:', err); res.status(500).send('Error cargando la cartera: ' + err.message); }
  });
  api('/cartera/cobrar', (b, a) => cobrar({ id: b.id, valor: b.valor, motivo: b.motivo, admin: a }));
  api('/cartera/nocobrar', (b, a) => noCobrar({ id: b.id, motivo: b.motivo, admin: a }));
  api('/cartera/valor', (b, a) => ajustarValor({ id: b.id, valor: b.valor, motivo: b.motivo, admin: a }));
  api('/cartera/extra', (b, a) => agregarExtra({ id: b.id, descripcion: b.descripcion, monto: b.monto, admin: a }));
  api('/cartera/extra/anular', (b, a) => anularExtra({ id: b.id, motivo: b.motivo, admin: a }));
}

module.exports = { rutas, paginaCartera };