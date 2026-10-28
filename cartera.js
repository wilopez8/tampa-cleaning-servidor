const { leerHoja, agregarFila, agregarFilas, actualizarCeldas, asegurarHoja } = require('./sheets');
const { normalizarFecha, fechaValida, hoyFlorida, filasDelRango } = require('./agenda');
const menu = require('./menu');
const P = () => require('./pagos'); // carga diferida: pagos.js usa los helpers de este archivo

const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r2 = x => Math.round(x * 100) / 100;
const usd = n => (n < 0 ? '− $' : '$') + Math.abs(n || 0).toFixed(2);
const p2 = n => String(n).padStart(2, '0');
const ahora = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
const err = g => ({ ok: false, general: g });
function numero(t) {
  let s = String(t ?? '').replace(/[$\s]/g, '');
  if (!s) return NaN;
  const neg = s.startsWith('-') || s.startsWith('−'); s = s.replace(/^[-−]/, '');
  const c = s.lastIndexOf(','), p = s.lastIndexOf('.');
  if (c >= 0 && p >= 0) s = c > p ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (c >= 0) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  const n = parseFloat(s);
  return neg ? -n : n;
}
const mesValido = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
function sumarMes(m, n) { const [a, b] = m.split('-').map(Number); return new Date(Date.UTC(a, b - 1 + n, 1)).toISOString().slice(0, 7); }

const CFG_H = ['Clave', 'Valor', 'Descripcion'];
const CS_H = ['ID_Cobro', 'Clave', 'Fecha', 'Cliente', 'Pagador', 'Empleados', 'IDs_Programacion', 'Estado', 'Motivo', 'Valor_Base', 'Valor_Original', 'Decision', 'Decidido_Por', 'Fecha_Decision', 'Origen', 'Fecha_Creacion'];
const NV_H = ['ID_Novedad', 'Cliente', 'Fecha_Servicio', 'ID_Programacion', 'Tipo', 'Detalle', 'Monto', 'Estado', 'Registrado_Por', 'Fecha_Registro', 'Retroactivo', 'Anulado_Por', 'Motivo_Anulacion'];
const BIT_H = ['Fecha_Hora', 'ID_Cobro', 'Accion', 'Detalle', 'Motivo', 'Admin'];
const TIPOS_NV = ['Tiempo adicional', 'Trabajo adicional', 'Productos o materiales', 'Otro cobro extra', 'Valor final del servicio'];
const TIPO_FINAL = 'Valor final del servicio';

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
  await agregarFila('COBROS_BITACORA', [ahora(), id || '', accion, detalle, motivo || '', admin]);
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
  const h = d[0], iN = h.indexOf('Nombre_Cliente'), iT = h.indexOf('Tarifa_Servicio'), iP = h.indexOf('Pagador'), iE = h.indexOf('Estatus'), iM = h.indexOf('Metodo_Pago'), iNp = h.indexOf('Nota_Pago');
  out.hayColumna = iT >= 0;
  if (iN < 0) return out;
  const val = (f, i) => i >= 0 ? String(f[i] || '').trim() : '';
  for (let i = 1; i < d.length; i++) {
    const n = String(d[i][iN] || '').trim();
    if (!n) continue;
    const activo = iE < 0 ? true : String(d[i][iE] || '').trim() === 'Activo';
    if (out.mapa[n] && out.mapa[n].activo && !activo) continue;
    out.mapa[n] = { tarifa: iT >= 0 ? numero(d[i][iT]) : NaN, pagador: val(d[i], iP), metodo: val(d[i], iM), nota: val(d[i], iNp), activo };
  }
  return out;
}

// ---------- generación de cobros a partir de la agenda (las inspecciones no entran) ----------
function agrupar(filas) {
  const g = new Map();
  filas.filter(r => r.Cliente && r.ID_Programacion && (r.Tipo_Servicio || 'Limpieza') !== 'Inspeccion').forEach(r => {
    const cliente = r.Cliente.trim(), clave = `${cliente}|${r._fecha}`;
    if (!g.has(clave)) g.set(clave, { clave, cliente, fecha: r._fecha, rows: [] });
    g.get(clave).rows.push(r);
  });
  return [...g.values()];
}
const motivosCanc = g => [...new Set(g.rows.map(r => String(r.Motivo_Cancelacion || '').trim()).filter(Boolean))].join('; ');
function evaluar(g, hoy) {
  const act = g.rows.filter(r => r._estado !== 'Cancelado');
  if (!act.length) { const mc = motivosCanc(g); return { estado: 'Cancelado', motivo: 'Cancelado' + (mc ? ': ' + mc : '') }; }
  if (act.every(r => r._estado === 'Finalizado')) return { estado: 'Ejecutado', motivo: '' };
  if (g.fecha < hoy) return { estado: 'Por confirmar', motivo: 'Servicio sin cerrar (' + [...new Set(act.filter(r => r._estado !== 'Finalizado').map(r => r._estado))].join(', ') + ')' };
  return null; // servicio de hoy aún sin terminar: todavía no genera cobro
}

let ultimaSync = 0;
function sincronizar(forzar) {
  return enCola(async () => {
    if (!forzar && Date.now() - ultimaSync < 30000) return;
    const cfg = await cargarConfig();
    const hoy = hoyFlorida();
    const [filas, tar, lista] = await Promise.all([filasDelRango(cfg.inicio, hoy), cargarTarifas(), cargarTabla('COBROS_SERVICIO', CS_H, true)]);
    const apMapa = await P().aplicadoMapa();
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
        const ejec = ev.estado === 'Ejecutado';
        nuevas.push(aFila(lista.h, {
          ID_Cobro: pref + p2(contadores[pref]), Clave: g.clave, Fecha: g.fecha, Cliente: g.cliente, Pagador: t ? t.pagador : '',
          Empleados: empleados, IDs_Programacion: ids, Estado: ev.estado, Motivo: ev.motivo,
          Valor_Base: ejec ? tarifa : '', Valor_Original: ejec ? tarifa : '', Decision: 'Auto', Decidido_Por: 'Sistema', Fecha_Decision: ahora(), Origen: 'Normal', Fecha_Creacion: ahora(),
        }));
        continue;
      }
      if (o.Empleados !== empleados) set(o, 'Empleados', empleados);
      if (o.IDs_Programacion !== ids) set(o, 'IDs_Programacion', ids);
      if ((o.Decision || 'Auto') !== 'Auto' || !ev) continue; // lo decidido a mano no se toca
      if (o.Estado === 'Ejecutado' && ev.estado !== 'Ejecutado' && (apMapa[o.ID_Cobro] || 0) > 0) continue; // con pagos aplicados no cambia solo
      if (o.Estado !== ev.estado) {
        set(o, 'Estado', ev.estado); set(o, 'Motivo', ev.motivo);
        if (ev.estado === 'Ejecutado' && tarifa !== '') { set(o, 'Valor_Base', tarifa); set(o, 'Valor_Original', tarifa); }
      } else if (o.Estado === 'Ejecutado' && !(numero(o.Valor_Base) > 0) && tarifa !== '') {
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

function ejecutar({ id, valor, motivo, admin }) {
  return enCola(async () => {
    if (!motivoOk(motivo)) return err('El motivo es obligatorio (mínimo 3 caracteres).');
    const { lista, c } = await buscar(id);
    if (!c) return err('Cobro no encontrado.');
    if (!(c.Estado === 'Por confirmar' || (c.Estado === 'Cancelado' && c.Decision === 'Manual'))) return err('Este servicio no se puede pasar a Ejecutado.');
    let v;
    if (String(valor ?? '').trim() !== '') {
      v = numero(valor);
      if (!(v > 0)) return err('El valor no es válido.');
    } else {
      const t = (await cargarTarifas()).mapa[c.Cliente];
      v = t && t.tarifa > 0 ? t.tarifa : NaN;
      if (!(v > 0)) return err('Este sitio no tiene tarifa en SITIOS. Escribe el valor.');
    }
    v = r2(v);
    await poner('COBROS_SERVICIO', lista, c, { Estado: 'Ejecutado', Motivo: 'Manual: ' + String(motivo).trim(), Valor_Base: v, Valor_Original: c.Valor_Original || v, Decision: 'Manual', Decidido_Por: admin, Fecha_Decision: ahora() });
    await bit(c.ID_Cobro, 'Ejecutado', `${c.Estado} → Ejecutado, valor ${usd(v)}`, motivo, admin);
    return { ok: true };
  });
}

function cancelar({ id, motivo, admin }) {
  return enCola(async () => {
    if (!motivoOk(motivo)) return err('El motivo es obligatorio (mínimo 3 caracteres).');
    const { lista, c } = await buscar(id);
    if (!c) return err('Cobro no encontrado.');
    if (!['Por confirmar', 'Ejecutado'].includes(c.Estado)) return err('Este servicio ya está cancelado.');
    const apCanc = await P().aplicadoDe(c.ID_Cobro);
    if (apCanc > 0) return err(`Este servicio tiene ${usd(apCanc)} en pagos aplicados. Anula primero el pago.`);
    await poner('COBROS_SERVICIO', lista, c, { Estado: 'Cancelado', Motivo: String(motivo).trim(), Decision: 'Manual', Decidido_Por: admin, Fecha_Decision: ahora() });
    await bit(c.ID_Cobro, 'Cancelado', `${c.Estado} → Cancelado`, motivo, admin);
    return { ok: true };
  });
}

// Novedad de cobro: se registra desde la agenda (idProgramacion) o desde cartera (idCobro)
function registrarNovedad({ idCobro, idProgramacion, tipo, detalle, monto, admin }) {
  return enCola(async () => {
    if (!TIPOS_NV.includes(tipo)) return err('Tipo no válido.');
    if (String(detalle || '').trim().length < 3) return err('El detalle es obligatorio (mínimo 3 caracteres).');
    const final = tipo === TIPO_FINAL;
    const m = numero(monto);
    if (final ? !(m >= 0) : !(m > 0)) return err(final ? 'El valor final no es válido.' : 'El monto debe ser mayor que 0.');
    const hoy = hoyFlorida();
    const lista = await cargarTabla('COBROS_SERVICIO', CS_H, true);

    let cliente, fecha, idProg = '';
    if (idCobro) {
      const c = lista.find(x => x.ID_Cobro === String(idCobro).trim());
      if (!c) return err('Cobro no encontrado.');
      cliente = c.Cliente; fecha = normalizarFecha(c.Fecha); idProg = String(c.IDs_Programacion || '').split(',')[0];
    } else {
      const datos = await leerHoja('PROGRAMACION_DIARIA');
      if (!datos.length) return err('Servicio no encontrado.');
      const h = datos[0], ix = n => h.indexOf(n);
      const f = datos.slice(1).find(x => x[ix('ID_Programacion')] === String(idProgramacion || '').trim());
      if (!f) return err('Servicio no encontrado.');
      if ((f[ix('Tipo_Servicio')] || 'Limpieza') === 'Inspeccion') return err('Las inspecciones no se cobran.');
      if (f[ix('Cancelado')] === 'Sí') return err('El servicio está cancelado.');
      cliente = String(f[ix('Cliente')] || '').trim(); fecha = normalizarFecha(f[ix('Fecha_Servicio')]); idProg = String(idProgramacion).trim();
    }
    const clave = `${cliente}|${fecha}`;
    const c = lista.find(x => x.Clave === clave);
    if (c && c.Estado === 'Cancelado') return err('El servicio está cancelado: no genera cobro.');

    const [nv, tar] = await Promise.all([cargarTabla('NOVEDADES_COBRO', NV_H, true), cargarTarifas()]);
    let montoGuardar = r2(m), det = String(detalle).trim();
    if (final) {
      const activas = nv.filter(n => n.Cliente === cliente && normalizarFecha(n.Fecha_Servicio) === fecha && n.Estado === 'Activa');
      const t = tar.mapa[cliente];
      const base = c && numero(c.Valor_Base) > 0 ? numero(c.Valor_Base) : (t && t.tarifa > 0 ? t.tarifa : 0);
      const actual = r2(base + activas.reduce((a, n) => a + (numero(n.Monto) || 0), 0));
      montoGuardar = r2(m - actual);
      if (montoGuardar === 0) return err('El total del servicio ya es ese valor.');
      if (c) { const ap = await P().aplicadoDe(c.ID_Cobro); if (ap > 0 && r2(m) < ap) return err(`Ya hay ${usd(ap)} pagados: el valor final no puede ser menor. Anula primero el pago.`); }
      det = `Valor final ${usd(r2(m))} (antes ${usd(actual)}) — ${det}`;
    }
    const pref = 'NOV-' + hoy.replace(/-/g, '') + '-';
    const id = pref + p2(nv.filter(n => n.ID_Novedad.startsWith(pref)).length + 1);
    await agregarFila('NOVEDADES_COBRO', aFila(nv.h, { ID_Novedad: id, Cliente: cliente, Fecha_Servicio: fecha, ID_Programacion: idProg, Tipo: tipo, Detalle: det, Monto: montoGuardar, Estado: 'Activa', Registrado_Por: admin, Fecha_Registro: ahora(), Retroactivo: fecha < hoy ? 'Sí' : 'No' }));
    await bit(c ? c.ID_Cobro : '', 'Novedad', `${id} · ${cliente} ${fecha} · ${tipo}: ${usd(montoGuardar)}`, det, admin);
    return { ok: true };
  });
}

function anularNovedad({ id, motivo, admin }) {
  return enCola(async () => {
    if (!motivoOk(motivo)) return err('El motivo es obligatorio (mínimo 3 caracteres).');
    const nv = await cargarTabla('NOVEDADES_COBRO', NV_H, true);
    const n = nv.find(x => x.ID_Novedad === String(id || '').trim());
    if (!n) return err('Novedad no encontrada.');
    if (n.Estado !== 'Activa') return err('La novedad ya estaba anulada.');
    const cg = (await cargarTabla('COBROS_SERVICIO', CS_H, true)).find(x => x.Clave === `${n.Cliente}|${normalizarFecha(n.Fecha_Servicio)}`);
    if (cg) {
      const ap = await P().aplicadoDe(cg.ID_Cobro);
      if (ap > 0) {
        const nov = r2(nv.filter(x => x.Cliente === n.Cliente && normalizarFecha(x.Fecha_Servicio) === normalizarFecha(n.Fecha_Servicio) && x.Estado === 'Activa').reduce((a, x) => a + (numero(x.Monto) || 0), 0));
        const nuevo = r2((numero(cg.Valor_Base) > 0 ? numero(cg.Valor_Base) : 0) + nov - (numero(n.Monto) || 0));
        if (nuevo < ap - 0.004) return err(`Hay ${usd(ap)} pagados: al anular, el total (${usd(nuevo)}) quedaría por debajo. Anula primero el pago.`);
      }
    }
    await poner('NOVEDADES_COBRO', nv, n, { Estado: 'Anulada', Anulado_Por: admin, Motivo_Anulacion: String(motivo).trim() });
    const c = (await cargarTabla('COBROS_SERVICIO', CS_H, true)).find(x => x.Clave === `${n.Cliente}|${normalizarFecha(n.Fecha_Servicio)}`);
    await bit(c ? c.ID_Cobro : '', 'Anular novedad', `${n.ID_Novedad} · ${n.Tipo}: ${usd(numero(n.Monto) || 0)}`, motivo, admin);
    return { ok: true };
  });
}

// ---------- botón y diálogo para la agenda ----------
function botonNovedad(r) {
  if ((r.Tipo_Servicio || 'Limpieza') === 'Inspeccion' || r._estado === 'Cancelado') return '';
  return `<button class="btn" data-id="${esc(r.ID_Programacion)}" data-t="${esc(r.Cliente + ' · ' + r._fecha)}" onclick="nvAbrir(this)">Novedad de cobro</button>`;
}
function dialogoNovedad() {
  return `<style>${CSS_DETALLE}#nvDlg{border:1px solid #ccc;border-radius:10px;padding:18px;max-width:360px;width:90%;}#nvDlg label{display:block;margin:10px 0;font-size:14px;}#nvDlg input,#nvDlg select{width:100%;padding:8px;font-size:15px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;}</style>
<dialog id="nvDlg"><h3 style="margin-top:0;">Novedad de cobro</h3><p id="nvT" style="margin:0 0 6px;color:#555;font-size:14px;"></p>
  <label>Tipo<select id="nvTipo" onchange="nvTipo()">${TIPOS_NV.map(t => `<option>${esc(t)}</option>`).join('')}</select></label>
  <label>Detalle (obligatorio)<input type="text" id="nvDet" maxlength="200"></label>
  <label><span id="nvLbl">Monto (USD)</span><input type="number" id="nvMonto" min="0" step="0.01"></label>
  <p style="font-size:12px;color:#777;">"Valor final del servicio": escribe lo que se va a cobrar en total ($0 = cortesía). El sistema calcula el ajuste.</p>
  <p id="nvErr" style="color:#b91c1c;font-size:13px;"></p>
  <button class="btn hoy" onclick="nvGuardar()">Guardar</button> <button class="btn" onclick="document.getElementById('nvDlg').close()">Cancelar</button></dialog>
<script>
var nvId=null;function tcDetalle(id){var r=document.getElementById('det-'+id);r.style.display=r.style.display==='none'?'table-row':'none';}
function nvE(i){return document.getElementById(i);}
function nvTipo(){nvE('nvLbl').textContent=nvE('nvTipo').value==='${TIPO_FINAL}'?'Valor final a cobrar (USD)':'Monto (USD)';}
function nvAbrir(b){nvId=b.dataset.id;nvE('nvT').textContent=b.dataset.t;nvE('nvTipo').selectedIndex=0;nvE('nvDet').value='';nvE('nvMonto').value='';nvE('nvErr').textContent='';nvTipo();nvE('nvDlg').showModal();}
function nvGuardar(){var d=nvE('nvDet').value.trim(),v=nvE('nvMonto').value.trim();
if(d.length<3){nvE('nvErr').textContent='El detalle es obligatorio.';return;}
if(v===''||!(parseFloat(v)>=0)){nvE('nvErr').textContent='El monto no es válido.';return;}
fetch('/cartera/novedad',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idProgramacion:nvId,tipo:nvE('nvTipo').value,detalle:d,monto:v})}).then(function(r){return r.json();}).then(function(j){if(j.ok){alert('Novedad de cobro registrada.');location.reload();}else{nvE('nvErr').textContent=j.general||'Error';}}).catch(function(){nvE('nvErr').textContent='Error de conexión';});}
</script>`;
}

// ---------- página ----------
const CSS = `
body{font-family:-apple-system,Arial,sans-serif;margin:0;padding:20px 28px;color:#222;background:#f6f7f9;}
a{color:#1d4ed8;text-decoration:none;}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;}
.nav{display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap;}
.btn{background:#fff;border:1px solid #ccc;border-radius:6px;padding:7px 12px;font-size:14px;cursor:pointer;color:#222;display:inline-block;}
.mini{padding:2px 8px;font-size:12px;margin:2px 2px 0 0;}
.hoy{background:#2e7d32;color:#fff;border-color:#2e7d32;}
.aviso{background:#eef2ff;border-radius:6px;padding:8px 12px;font-size:14px;margin-bottom:12px;}
.aviso.r{background:#fef2f2;} .aviso.y{background:#fffbeb;}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;margin-bottom:18px;}
th,td{padding:8px 10px;text-align:left;font-size:13px;border-bottom:1px solid #eee;vertical-align:top;}
th{background:#f1f3f5;} tfoot td{font-weight:700;background:#f9fafb;}
.num{text-align:right;white-space:nowrap;} .neg{color:#b91c1c;} .anu{color:#999;text-decoration:line-through;}
.est{padding:2px 8px;border-radius:10px;font-size:12px;background:#e5e7eb;}
.est.ok{background:#bbf7d0;} .est.rev{background:#fecaca;} .est.cn{background:#e5e7eb;color:#555;}
.mp{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600;margin-left:4px;color:#fff;background:#6b7280;}
.mp.efectivo{background:#15803d;} .mp.cheque{background:#a16207;} .mp.zelle{background:#7e22ce;} .mp.venmo{background:#0369a1;}
small{color:#777;}
.scroll{max-height:340px;overflow:auto;margin-bottom:18px;border-radius:8px;} .scroll table{margin-bottom:0;overflow:visible;}
.res th{position:sticky;top:0;z-index:1;} .res tfoot td{position:sticky;bottom:0;}
.tf th{position:sticky;top:0;z-index:1;} .scroll.g{max-height:calc(100vh - 250px);min-height:260px;}
table.tc{table-layout:fixed;} table.tc td{overflow-wrap:anywhere;} table.tc .btn{white-space:normal;}
table.tc th:nth-child(1){width:8%;} table.tc th:nth-child(2){width:28%;} table.tc th:nth-child(3){width:13%;} table.tc th:nth-child(4){width:8%;}
table.tc th:nth-child(5){width:14%;} table.tc th:nth-child(6){width:8%;} table.tc th:nth-child(7){width:11%;} table.tc th:nth-child(8){width:10%;}
table.tf{table-layout:fixed;} table.tf td{overflow-wrap:anywhere;} table.tf .btn{white-space:normal;}
table.tf th:nth-child(1){width:8%;} table.tf th:nth-child(2){width:16%;} table.tf th:nth-child(3){width:11%;} table.tf th:nth-child(4){width:14%;}
table.tf th:nth-child(5){width:7%;} table.tf th:nth-child(6){width:15%;} table.tf th:nth-child(7){width:7%;} table.tf th:nth-child(8){width:11%;} table.tf th:nth-child(9){width:11%;}
.filtros{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;} .filtros select{padding:7px;border:1px solid #ccc;border-radius:6px;font-size:14px;}
td details summary{cursor:pointer;color:#1d4ed8;}
dialog{border:1px solid #ccc;border-radius:10px;padding:18px;max-width:360px;width:90%;}
dialog label{display:block;margin:10px 0;font-size:14px;}
dialog input,dialog select{width:100%;padding:8px;font-size:15px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;}`;

const SCRIPT = `
function $(i){return document.getElementById(i);}
function post(url,data,errId){fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(function(r){return r.json();}).then(function(j){if(j.ok){location.reload();}else{$(errId).textContent=j.general||'Error';}}).catch(function(){$(errId).textContent='Error de conexión';});}
var modo=null,idSel=null;
function tcDetalle(id){var r=document.getElementById('det-'+id);r.style.display=r.style.display==='none'?'table-row':'none';}
function tcBuscar(q){q=q.toLowerCase().trim();document.querySelectorAll('.res tr[data-n]').forEach(function(tr){tr.style.display=tr.dataset.n.indexOf(q)>=0?'':'none';});}

var AYUDA={ejecutar:'Deja el valor vacío para usar la tarifa del sitio.',novedad:'',cancelar:'',anular:''};
function tcTipo(){$('rvt').textContent=$('dtipo').value==='${TIPO_FINAL}'?'Valor final a cobrar (USD)':'Monto (USD)';
$('dh').textContent=$('dtipo').value==='${TIPO_FINAL}'?'Escribe el total a cobrar ($0 = cortesía). El sistema calcula el ajuste.':'';}
function tcAbrir(b){modo=b.dataset.modo;idSel=b.dataset.id;$('dt').textContent=b.dataset.t;$('dv').value='';$('dd').value='';$('dm').value='';$('de').textContent='';
$('rt').style.display=modo==='novedad'?'block':'none';
$('rd').style.display=modo==='novedad'?'block':'none';
$('rv').style.display=(modo==='ejecutar'||modo==='novedad')?'block':'none';
$('rm').style.display=modo==='novedad'?'none':'block';
$('rvt').textContent=modo==='novedad'?'Monto (USD)':'Valor del servicio (USD)';
$('dtipo').selectedIndex=0;$('dh').textContent=AYUDA[modo]||'';$('dlg').showModal();}
function tcGuardar(){var v=$('dv').value.trim(),d=$('dd').value.trim(),m=$('dm').value.trim();
if(modo==='novedad'){if(d.length<3){$('de').textContent='El detalle es obligatorio.';return;}if(v===''||!(parseFloat(v)>=0)){$('de').textContent='El monto no es válido.';return;}post('/cartera/novedad',{idCobro:idSel,tipo:$('dtipo').value,detalle:d,monto:v},'de');return;}
if(m.length<3){$('de').textContent='El motivo es obligatorio.';return;}
var url={ejecutar:'/cartera/ejecutar',cancelar:'/cartera/cancelar',anular:'/cartera/novedad/anular'}[modo];
post(url,{id:idSel,valor:v,motivo:m},'de');}`;

async function paginaCartera(query, admin, vista) {
  const soloClientes = vista === 'clientes';
  const hoy = hoyFlorida();
  let errSync = '';
  try { await sincronizar(query.sync === '1'); } catch (e) { console.error('Error sincronizando cartera:', e); errSync = e.message; }
  const mes = query.mes === 'todo' ? 'todo' : (mesValido(query.mes) ? query.mes : hoy.slice(0, 7));
  const [cfg, tar, lista, listaNv] = await Promise.all([cargarConfig(), cargarTarifas(), cargarTabla('COBROS_SERVICIO', CS_H), cargarTabla('NOVEDADES_COBRO', NV_H)]);

  const nvPor = {};
  listaNv.filter(n => n.ID_Novedad).forEach(n => { const k = `${n.Cliente}|${normalizarFecha(n.Fecha_Servicio)}`; (nvPor[k] = nvPor[k] || []).push(n); });
  const cobros = lista.filter(o => o.ID_Cobro).map(o => {
    const f = normalizarFecha(o.Fecha);
    const nvs = nvPor[`${o.Cliente}|${f}`] || [];
    const activas = nvs.filter(n => n.Estado === 'Activa');
    const nov = r2(activas.reduce((a, n) => a + (numero(n.Monto) || 0), 0));
    const base = numero(o.Valor_Base), b = base > 0 ? base : 0;
    return { ...o, _fecha: f, _base: b, _nov: nov, _nvs: nvs, _total: r2(b + nov), _sinTarifa: o.Estado === 'Ejecutado' && !(base > 0) && !activas.length };
  });
  const enMes = cobros.filter(c => mes === 'todo' || c._fecha.startsWith(mes));
  const pgd = await P().datos();
  const pe = c => P().estadoCobro(c, pgd);

  const mp = cliente => {
    const t = tar.mapa[cliente];
    if (!t || !t.metodo) return '<span class="mp" title="Sin método de pago en SITIOS">¿Pago?</span>';
    const k = t.metodo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
    return `<span class="mp ${k}" title="${esc(t.nota)}">${esc(t.metodo)}</span>`;
  };

  const res = {};
  enMes.forEach(c => {
    const x = res[c.Cliente] = res[c.Cliente] || { n: 0, base: 0, nov: 0, conf: 0, sin: 0, cob: 0, sal: 0 };
    if (c.Estado === 'Ejecutado') { x.n++; x.base += c._base; x.nov += c._nov; if (c._sinTarifa) x.sin++; const e = pe(c); if (e) { x.cob += e.aplicado; x.sal += e.saldo; } }
    else if (c.Estado === 'Por confirmar') x.conf++;
  });
  const clientes = Object.keys(res).sort((a, b) => a.localeCompare(b));
  const G = { n: 0, base: 0, nov: 0, conf: 0, sin: 0, cob: 0, sal: 0 };
  clientes.forEach(k => Object.keys(G).forEach(f => { G[f] += res[k][f]; }));

  const fCli = String(query.cliente || '').trim();
  const cliExacto = clientes.includes(fCli);
  const ESTADOS = ['Por confirmar', 'Ejecutado', 'Cancelado', 'Sin tarifa', 'Pendiente de pago'];
  const fEst = ESTADOS.includes(query.estado) ? query.estado : '';
  const baseUrl = soloClientes ? '/cartera/clientes?' : '/cartera?';
  const url = (o, b) => (b || baseUrl) + Object.entries({ mes, cliente: fCli, estado: fEst, ...o }).filter(([, v]) => v).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

  const vis = enMes.filter(c => (!fCli || (cliExacto ? c.Cliente === fCli : c.Cliente.toLowerCase().includes(fCli.toLowerCase()))) && (!fEst || (fEst === 'Sin tarifa' ? c._sinTarifa : fEst === 'Pendiente de pago' ? ((pe(c) || {}).saldo > 0) : c.Estado === fEst)))
    .sort((a, b) => a._fecha.localeCompare(b._fecha) || a.Cliente.localeCompare(b.Cliente));

  const orden = [...clientes].sort((a, b) => ((res[b].conf + res[b].sin > 0) - (res[a].conf + res[a].sin > 0)) || ((res[b].base + res[b].nov) - (res[a].base + res[a].nov)) || a.localeCompare(b));
    const filasRes = orden.map(k => { const x = res[k];
    return `<tr data-n="${esc(k.toLowerCase())}"><td><a href="${esc('/cartera/cliente?c=' + encodeURIComponent(k) + '&mes=' + mes)}">${esc(k)}</a>${mp(k)} <a title="Ver los servicios de este cliente" href="${esc('/cartera?mes=' + mes + '&cliente=' + encodeURIComponent(k))}">⇩</a></td><td class="num">${x.n}</td><td class="num">${usd(x.base)}</td><td class="num">${usd(x.nov)}</td><td class="num"><b>${usd(r2(x.base + x.nov))}</b></td><td class="num">${usd(r2(x.cob))}</td><td class="num">${x.sal > 0.004 ? `<span class="est rev">${usd(r2(x.sal))}</span>` : usd(0)}</td>
      <td class="num">${x.conf ? `<span class="est rev">${x.conf}</span>` : '0'}</td><td class="num">${x.sin ? `<span class="est rev">${x.sin}</span>` : '0'}</td></tr>`;
  }).join('') || '<tr><td colspan="9" style="text-align:center;color:#888;padding:20px;">No hay cobros en este período.</td></tr>';

  const filasDet = vis.map(c => {
    const titulo = `${c.Cliente} · ${c._fecha}`;
    const b = (m, txt) => `<button class="btn mini" data-modo="${m}" data-id="${esc(c.ID_Cobro)}" data-t="${esc(titulo)}" onclick="tcAbrir(this)">${txt}</button>`;
    let acc = '';
    if (c.Estado === 'Por confirmar') acc = b('ejecutar', 'Ejecutado') + b('cancelar', 'Cancelar');
    else if (c.Estado === 'Ejecutado') acc = b('novedad', '+ Novedad') + b('cancelar', 'Cancelar');
    else if (c.Estado === 'Cancelado' && c.Decision === 'Manual') acc = b('ejecutar', 'Ejecutado');
    const nvHtml = c._nvs.length ? `<details><summary><small>${c._nvs.filter(n => n.Estado === 'Activa').length} novedad(es) · ${usd(c._nov)}</small></summary>${c._nvs.map(n => `<div${n.Estado !== 'Activa' ? ' class="anu"' : ''}><small>${esc(n.Tipo)}: ${esc(n.Detalle)} (${usd(numero(n.Monto) || 0)}) · ${esc(n.Registrado_Por)}${n.Estado === 'Activa'
      ? ` <button class="btn mini" data-modo="anular" data-id="${esc(n.ID_Novedad)}" data-t="${esc('Anular novedad ' + n.ID_Novedad)}" onclick="tcAbrir(this)">Anular</button>`
      : ' · anulada: ' + esc(n.Motivo_Anulacion)}</small></div>`).join('')}</details>` : '<small>—</small>';
    const cls = c.Estado === 'Ejecutado' ? (c._sinTarifa ? 'rev' : 'ok') : (c.Estado === 'Por confirmar' ? 'rev' : 'cn');
    return `<tr><td>${esc(c._fecha)}</td><td>${esc(c.Cliente)}${mp(c.Cliente)}${c.Pagador && c.Pagador !== c.Cliente ? `<br><small>Paga: ${esc(c.Pagador)}</small>` : ''}</td>
      <td><small>${esc(c.Empleados)}</small></td>
      <td><span class="est ${cls}">${esc(c.Estado)}</span>${c._sinTarifa ? '<br><small class="neg">Sin tarifa en SITIOS</small>' : ''}${c.Motivo ? `<br><small>${esc(c.Motivo)}</small>` : ''}</td>
      <td class="num">${c.Estado === 'Ejecutado' && c._base ? usd(c._base) : '—'}</td><td>${nvHtml}</td>
      <td class="num"><b>${c.Estado === 'Ejecutado' ? usd(c._total) : '—'}</b></td><td>${P().badgePago(pe(c))}</td><td>${acc}</td></tr>`;
  }).join('') || '<tr><td colspan="9" style="text-align:center;color:#888;padding:20px;">Sin servicios para este filtro.</td></tr>';

  const sel = (nombre, etiqueta, opciones, actual) => `<select name="${nombre}"><option value="">${etiqueta}</option>${opciones.map(o => `<option value="${esc(o)}"${actual === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  const etiquetaMes = mes === 'todo' ? 'Todo el histórico' : mes;
  const mesNav = mes === 'todo' ? '' : `<a class="btn" href="${esc(url({ mes: sumarMes(mes, -1) }))}">←</a>
    <a class="btn hoy" href="${esc(url({ mes: hoy.slice(0, 7) }))}">Este mes</a><a class="btn" href="${esc(url({ mes: sumarMes(mes, 1) }))}">→</a>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cartera ${esc(etiquetaMes)}</title><style>${CSS}${P().CSS_PAGOS}${menu.MENU_CSS}</style></head><body>
<div class="top"><h2 style="margin:0;">Cartera — ${esc(etiquetaMes)}</h2>${menu.menuHtml('/cartera', admin)}</div>
<div class="nav">${mesNav}
  <a class="btn" href="${esc(url({ mes: mes === 'todo' ? hoy.slice(0, 7) : 'todo' }))}">${mes === 'todo' ? 'Ver por mes' : 'Ver todo el histórico'}</a>
  <a class="btn" href="${esc(url({ sync: '1' }))}">Sincronizar ahora</a>
  <a class="btn${soloClientes ? '' : ' hoy'}" href="${esc('/cartera?mes=' + mes)}">Servicios</a><a class="btn${soloClientes ? ' hoy' : ''}" href="${esc('/cartera/clientes?mes=' + mes)}">Clientes</a><a class="btn" href="/cartera/pagos">Pagos</a>
</div>
${errSync ? `<div class="aviso r">No se pudo sincronizar con la agenda: ${esc(errSync)}</div>` : ''}
${tar.hayColumna ? '' : '<div class="aviso r">Falta la columna <b>Tarifa_Servicio</b> en la hoja SITIOS: ningún servicio tendrá valor.</div>'}
${(G.conf || G.sin) ? `<div class="aviso y">${G.conf ? `<a href="${esc(url({ estado: 'Por confirmar' }, '/cartera?'))}">${G.conf} servicio(s) por confirmar</a> (sin cerrar: márcalos Ejecutado o Cancelado).` : ''} ${G.sin ? `<a href="${esc(url({ estado: 'Sin tarifa' }, '/cartera?'))}">${G.sin} servicio(s) sin tarifa</a> (llena Tarifa_Servicio en SITIOS y pulsa Sincronizar, o registra un "Valor final").` : ''}</div>` : ''}
<div class="aviso">Se cargan los servicios desde <b>${esc(cfg.inicio)}</b> (hoja CONFIG_CARTERA). Un cobro = un cliente por día (si va un equipo, es un solo cobro). Las inspecciones no entran. Total = valor del servicio + novedades de cobro. Las novedades se registran desde la agenda.</div>
${soloClientes ? `<input type="search" placeholder="Buscar cliente..." oninput="tcBuscar(this.value)" style="padding:7px;border:1px solid #ccc;border-radius:6px;font-size:14px;margin-bottom:8px;width:260px;"><div class="scroll g"><table class="res"><tr><th>Cliente</th><th class="num">Servicios ejecutados</th><th class="num">Valor servicios</th><th class="num">Novedades</th><th class="num">Total a cobrar</th><th class="num">Cobrado</th><th class="num">Saldo</th><th class="num">Por confirmar</th><th class="num">Sin tarifa</th></tr>${filasRes}
<tfoot><tr><td>Total</td><td class="num">${G.n}</td><td class="num">${usd(G.base)}</td><td class="num">${usd(G.nov)}</td><td class="num">${usd(r2(G.base + G.nov))}</td><td class="num">${usd(r2(G.cob))}</td><td class="num">${usd(r2(G.sal))}</td><td class="num">${G.conf}</td><td class="num">${G.sin}</td></tr></tfoot></table></div>` : ''}
${soloClientes ? '' : `<div class="aviso" style="background:#f0fdf4;">Período: <b>${G.n}</b> servicios ejecutados · valor ${usd(G.base)} · novedades ${usd(G.nov)} · <b>total a cobrar ${usd(r2(G.base + G.nov))}</b></div>
<form class="filtros" method="GET" action="/cartera"><input type="hidden" name="mes" value="${esc(mes)}">
  <input type="search" name="cliente" list="lstCli" value="${esc(fCli)}" placeholder="Buscar cliente..." autocomplete="off" onchange="this.form.submit()" style="padding:7px;border:1px solid #ccc;border-radius:6px;font-size:14px;width:260px;"><datalist id="lstCli">${clientes.map(k => `<option value="${esc(k)}">`).join('')}</datalist>${sel('estado', 'Todos los estados', ESTADOS, fEst)}
  <button class="btn">Filtrar</button> <a class="btn" href="${esc(url({ cliente: '', estado: '' }))}">Limpiar</a></form>
<div class="scroll g"><table class="tf"><tr><th>Fecha</th><th>Cliente / pago</th><th>Empleados</th><th>Estado</th><th class="num">Valor</th><th>Novedades</th><th class="num">Total</th><th>Pago</th><th>Acciones</th></tr>${filasDet}</table></div>`}
<dialog id="dlg"><h3 id="dt" style="margin-top:0;"></h3>
  <label id="rt">Tipo<select id="dtipo" onchange="tcTipo()">${TIPOS_NV.map(t => `<option>${esc(t)}</option>`).join('')}</select></label>
  <label id="rd">Detalle (obligatorio)<input type="text" id="dd" maxlength="200"></label>
  <label id="rv"><span id="rvt">Valor (USD)</span><input type="number" id="dv" min="0" step="0.01"></label>
  <label id="rm">Motivo (obligatorio)<input type="text" id="dm" maxlength="200"></label>
  <p id="dh" style="font-size:12px;color:#777;"></p>
  <p id="de" style="color:#b91c1c;font-size:13px;"></p>
  <button class="btn hoy" onclick="tcGuardar()">Guardar</button> <button class="btn" onclick="$('dlg').close()">Cancelar</button></dialog>
<script>${SCRIPT}</script>
</body></html>`;
}

// ---------- detalle horizontal, datos auxiliares y página por cliente ----------
const CSS_DETALLE = `.vidaH{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:8px 4px;}
@media(max-width:1000px){.vidaH{grid-template-columns:repeat(2,minmax(0,1fr));}}
.vidaH .bl{background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:8px 10px;} .vidaH .bl.ancho{grid-column:span 2;}
.vidaH h4{margin:0 0 6px;font-size:13px;color:#555;} .vidaH .par{font-size:13px;margin:3px 0;white-space:pre-wrap;}
.vidaH .par span{color:#777;display:block;font-size:11px;} tr.filadet>td{background:#fff;padding:6px 10px;}`;

const bloqueH = (titulo, pares, ancho) => {
  const llenos = pares.filter(([, v]) => v !== undefined && v !== null && String(v && v.__html ? 'x' : v).trim() !== '');
  if (!llenos.length) return ''; // los bloques sin información no se muestran
  return `<div class="bl${ancho ? ' ancho' : ''}"><h4>${esc(titulo)}</h4>${llenos.map(([k, v]) => `<div class="par"><span>${esc(k)}</span><b>${v && v.__html ? v.__html : esc(v)}</b></div>`).join('')}</div>`;
};

async function leerPorId(hoja, ids) {
  const out = {};
  try {
    const d = await leerHoja(hoja, { cache: true });
    if (d.length < 2) return out;
    const h = d[0], iId = h.indexOf('ID_Programacion');
    if (iId < 0) return out;
    for (let i = 1; i < d.length; i++) {
      const id = d[i][iId];
      if (!id || !ids.has(id)) continue;
      const o = {}; h.forEach((n, j) => { o[n] = d[i][j] === undefined ? '' : String(d[i][j]); });
      (out[id] = out[id] || []).push(o);
    }
  } catch (e) { /* la hoja puede no existir todavía */ }
  return out;
}

function infoCobro(c, nvs) {
  const nov = r2(nvs.filter(n => n.Estado === 'Activa').reduce((a, n) => a + (numero(n.Monto) || 0), 0));
  const base = c && numero(c.Valor_Base) > 0 ? numero(c.Valor_Base) : 0;
  return { estado: c ? c.Estado : 'Aún sin generar', motivo: c ? c.Motivo : '', base, nov, total: r2(base + nov), nvs, ejecutado: !!c && c.Estado === 'Ejecutado' };
}

// Para la agenda: datos de cobro por ID_Programacion (las inspecciones no tienen)
async function datosCobroDia(filas) {
  const out = {};
  const rows = filas.filter(r => r.Cliente && (r.Tipo_Servicio || 'Limpieza') !== 'Inspeccion');
  if (!rows.length) return out;
  const [lista, listaNv] = await Promise.all([cargarTabla('COBROS_SERVICIO', CS_H), cargarTabla('NOVEDADES_COBRO', NV_H)]);
  const porClave = new Map();
  lista.forEach(o => { if (o.Clave) porClave.set(o.Clave, o); });
  rows.forEach(r => {
    const cli = r.Cliente.trim();
    const nvs = listaNv.filter(n => n.ID_Novedad && n.Cliente === cli && normalizarFecha(n.Fecha_Servicio) === r._fecha);
    out[r.ID_Programacion] = infoCobro(porClave.get(`${cli}|${r._fecha}`), nvs);
  });
  return out;
}

function lineaDeVidaH(r, quejas, cambios, pends, cobro) {
  const c = (cambios || []).map(x => `${x.Fecha_Hora} · ${x.Realizado_Por}: ${x.Tipo_Cambio} — ${x.Detalle}${x.Empleado_Notificado ? ` (avisó a ${x.Empleado_Notificado}: ${x.Aviso_Enviado})` : ` (${x.Aviso_Enviado})`}`).join('\n');
  const horario = (r.Hora_Inicio && r.Hora_Fin) ? `${r.Hora_Inicio} – ${r.Hora_Fin}` : r.Horario;
  const maps = /^https?:\/\//i.test(r.Google_Maps_Link) ? { __html: `<a href="${esc(r.Google_Maps_Link)}" target="_blank" rel="noopener">Abrir mapa</a>` } : r.Google_Maps_Link;
  const q = (quejas || []).map(x => `${x.Tipo} (${x.Estado}): ${x.Descripcion}`).join('\n');
  const pv = (pends || []).map(p => `${p.ID_Pendiente} (${p.Estado}${p.Responsable ? ', ' + p.Responsable : ''}): ${p.Titulo}`).join('\n');
  const bloqueCobro = cobro ? bloqueH('Cobro', [
    ['Estado en cartera', cobro.estado + (cobro.motivo ? ' — ' + cobro.motivo : '')],
    ['Valor del servicio', cobro.ejecutado && cobro.base ? usd(cobro.base) : ''],
    ['Total a cobrar', cobro.ejecutado ? usd(cobro.total) : ''],
    ['Novedades de cobro', cobro.nvs.map(n => `${n.Fecha_Registro} · ${n.Registrado_Por}: ${n.Tipo} — ${n.Detalle} (${usd(numero(n.Monto) || 0)})${n.Estado === 'Activa' ? '' : ' [ANULADA: ' + n.Motivo_Anulacion + ']'}`).join('\n')],
  ], true) : '';
  return '<div class="vidaH">' + [
    bloqueH('Programación', [['ID', r.ID_Programacion], ['Horario', horario], ['Dirección', r.Direccion], ['Mapa', maps],
      ['Descripción', r.Descripcion_Servicio], ['Instrucciones', r.Instrucciones], ['Observaciones del día', r.Observaciones_Puntuales],
      ['Creado por', r.Creado_Por && `${r.Creado_Por} (${r.Fecha_Creacion})`], ['Modificado por', r.Modificado_Por && `${r.Modificado_Por} (${r.Fecha_Modificacion})`],
      ['Cancelación', r.Cancelado === 'Sí' ? (r.Motivo_Cancelacion || 'Sí') : ''],
      ['Retroactivo', r.Registro_Retroactivo === 'Sí' ? 'Sí — ' + r.Motivo_Retroactivo : ''], ['Origen del registro', r.Origen_Registro]]),
    bloqueH('Envío y confirmación', [['Envío', r.Estado_Envio], ['Confirmación', r.Estado_Confirmacion], ['Motivo "No puedo"', r.Motivo_No_Puede], ['Fecha/hora', r.Fecha_Hora_Confirmacion]]),
    bloqueH('Entrada', [['Hora', r.Hora_Entrada_Real], ['Latitud', r.Lat_Entrada], ['Longitud', r.Lon_Entrada], ['Dentro de rango', r.Dentro_Rango_Entrada]]),
    bloqueH('Salida', [['Hora', r.Hora_Salida_Real], ['Latitud', r.Lat_Salida], ['Longitud', r.Lon_Salida], ['Dentro de rango', r.Dentro_Rango_Salida]]),
    bloqueH('Cierre', [['Tareas pendientes', r.Tareas_Pendientes], ['Insumos faltantes', r.Insumos_Faltantes], ['Comentario', r.Comentario_Empleado], ['Fotos', r.Fotos_Resultado], ['Finalizado', r.Servicio_Finalizado]]),
    bloqueH('Inspección', [['Servicio inspeccionado', r.ID_Servicio_Inspeccionado], ['Resultado', r.Resultado_Inspeccion], ['Requiere acción correctiva', r.Requiere_Accion_Correctiva], ['Estado corrección', r.Estado_Correccion]]),
    bloqueH('Avisos', [['Avisos durante el servicio', r.Avisos_Durante_Servicio], ['Aviso confirmado', r.Aviso_Confirmado]]),
    bloqueCobro,
    bloqueH('Cambios posteriores al envío', [['Registro', c]], true),
    bloqueH('Pendientes vinculados', [['Lista', pv]]),
    bloqueH('Quejas y dudas', [['Asociadas', q]]),
  ].join('') + '</div>';
}

function badgeMetodo(tar, cliente) {
  const t = tar.mapa[cliente];
  if (!t || !t.metodo) return '<span class="mp" title="Sin método de pago en SITIOS">¿Pago?</span>';
  const k = t.metodo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
  return `<span class="mp ${k}" title="${esc(t.nota)}">${esc(t.metodo)}</span>`;
}

function armar(lista, listaNv) {
  const nvPor = {};
  listaNv.filter(n => n.ID_Novedad).forEach(n => { const k = `${n.Cliente}|${normalizarFecha(n.Fecha_Servicio)}`; (nvPor[k] = nvPor[k] || []).push(n); });
  return lista.filter(o => o.ID_Cobro).map(o => {
    const f = normalizarFecha(o.Fecha);
    const nvs = nvPor[`${o.Cliente}|${f}`] || [];
    const activas = nvs.filter(n => n.Estado === 'Activa');
    const nov = r2(activas.reduce((a, n) => a + (numero(n.Monto) || 0), 0));
    const base = numero(o.Valor_Base), b = base > 0 ? base : 0;
    return { ...o, _fecha: f, _base: b, _nov: nov, _nvs: nvs, _total: r2(b + nov), _sinTarifa: o.Estado === 'Ejecutado' && !(base > 0) && !activas.length };
  });
}

const DIALOGO_COBRO = `<dialog id="dlg"><h3 id="dt" style="margin-top:0;"></h3>
  <label id="rt">Tipo<select id="dtipo" onchange="tcTipo()">${TIPOS_NV.map(t => `<option>${esc(t)}</option>`).join('')}</select></label>
  <label id="rd">Detalle (obligatorio)<input type="text" id="dd" maxlength="200"></label>
  <label id="rv"><span id="rvt">Valor (USD)</span><input type="number" id="dv" min="0" step="0.01"></label>
  <label id="rm">Motivo (obligatorio)<input type="text" id="dm" maxlength="200"></label>
  <p id="dh" style="font-size:12px;color:#777;"></p>
  <p id="de" style="color:#b91c1c;font-size:13px;"></p>
  <button class="btn hoy" onclick="tcGuardar()">Guardar</button> <button class="btn" onclick="$('dlg').close()">Cancelar</button></dialog>
<script>${SCRIPT}</script>`;

async function paginaCliente(query, admin) {
  const cliente = String(query.c || '').trim();
  if (!cliente) return null;
  const hoy = hoyFlorida();
  let errSync = '';
  try { await sincronizar(query.sync === '1'); } catch (e) { console.error('Error sincronizando cartera:', e); errSync = e.message; }
  const mes = query.mes === 'todo' ? 'todo' : (mesValido(query.mes) ? query.mes : hoy.slice(0, 7));
  const [cfg, tar, lista, listaNv] = await Promise.all([cargarConfig(), cargarTarifas(), cargarTabla('COBROS_SERVICIO', CS_H), cargarTabla('NOVEDADES_COBRO', NV_H)]);
  const todos = armar(lista, listaNv);
  const cobros = todos.filter(c => c.Cliente === cliente && (mes === 'todo' || c._fecha.startsWith(mes))).sort((a, b) => b._fecha.localeCompare(a._fecha));
  const pgd = await P().datos();
  const pe = c => P().estadoCobro(c, pgd);

  let desde, hasta;
  if (mes === 'todo') { desde = cfg.inicio; hasta = hoy; }
  else { const [a, b] = mes.split('-').map(Number); desde = mes + '-01'; hasta = new Date(Date.UTC(a, b, 0)).toISOString().slice(0, 10); }
  const filas = (await filasDelRango(desde, hasta)).filter(r => r.Cliente && r.Cliente.trim() === cliente && (r.Tipo_Servicio || 'Limpieza') !== 'Inspeccion');
  const ids = new Set(filas.map(r => r.ID_Programacion));
  const [quejas, cambios, pends] = await Promise.all([leerPorId('QUEJAS', ids), leerPorId('CAMBIOS_PROGRAMACION', ids), leerPorId('PENDIENTES', ids)]);

  const T = { n: 0, base: 0, nov: 0, conf: 0, sin: 0, cob: 0, sal: 0 };
  cobros.forEach(c => {
    if (c.Estado === 'Ejecutado') { T.n++; T.base += c._base; T.nov += c._nov; if (c._sinTarifa) T.sin++; const e = pe(c); if (e) { T.cob += e.aplicado; T.sal += e.saldo; } }
    else if (c.Estado === 'Por confirmar') T.conf++;
  });
  const t = tar.mapa[cliente];

  const filasHtml = cobros.map(c => {
    const fs = filas.filter(r => r._fecha === c._fecha).sort((a, b) => (a.Hora_Inicio || a.Horario || '').localeCompare(b.Hora_Inicio || b.Horario || ''));
    const titulo = `${c.Cliente} · ${c._fecha}`;
    const b = (m, txt) => `<button class="btn mini" data-modo="${m}" data-id="${esc(c.ID_Cobro)}" data-t="${esc(titulo)}" onclick="tcAbrir(this)">${txt}</button>`;
    let acc = `<button class="btn mini" data-id="${esc(c.ID_Cobro)}" onclick="tcDetalle(this.dataset.id)">Detalle</button>`;
    if (c.Estado === 'Por confirmar') acc += b('ejecutar', 'Ejecutado') + b('cancelar', 'Cancelar');
    else if (c.Estado === 'Ejecutado') acc += b('novedad', '+ Novedad') + b('cancelar', 'Cancelar');
    else if (c.Estado === 'Cancelado' && c.Decision === 'Manual') acc += b('ejecutar', 'Ejecutado');
    const equipo = fs.map(r => {
      const hp = (r.Hora_Inicio && r.Hora_Fin) ? `${r.Hora_Inicio}–${r.Hora_Fin}` : r.Horario;
      return `<div><b>${esc(r.Empleado)}</b>${r._estado === 'Cancelado' ? ' <small>(cancelado)</small>' : ''}<br><small>Prog. ${esc(hp || '—')} · Real ${esc(r.Hora_Entrada_Real || '—')} → ${esc(r.Hora_Salida_Real || '—')}</small></div>`;
    }).join('') || '<small>—</small>';
    const nvHtml = c._nvs.length ? `<details><summary><small>${c._nvs.filter(n => n.Estado === 'Activa').length} novedad(es) · ${usd(c._nov)}</small></summary>${c._nvs.map(n => `<div${n.Estado !== 'Activa' ? ' class="anu"' : ''}><small>${esc(n.Tipo)}: ${esc(n.Detalle)} (${usd(numero(n.Monto) || 0)}) · ${esc(n.Registrado_Por)}${n.Estado === 'Activa'
      ? ` <button class="btn mini" data-modo="anular" data-id="${esc(n.ID_Novedad)}" data-t="${esc('Anular novedad ' + n.ID_Novedad)}" onclick="tcAbrir(this)">Anular</button>`
      : ' · anulada: ' + esc(n.Motivo_Anulacion)}</small></div>`).join('')}</details>` : '<small>—</small>';
    const info = infoCobro(c, c._nvs);
    const det = fs.map((r, i) => `<div style="margin:6px 0 2px;"><b>${esc(r.Empleado)}</b> <small>${esc(r.ID_Programacion)}</small></div>${lineaDeVidaH(r, quejas[r.ID_Programacion], cambios[r.ID_Programacion], pends[r.ID_Programacion], i === 0 ? info : null)}`).join('') || '<small>No hay servicios en la agenda para esta fecha.</small>';
    const cls = c.Estado === 'Ejecutado' ? (c._sinTarifa ? 'rev' : 'ok') : (c.Estado === 'Por confirmar' ? 'rev' : 'cn');
    return `<tr><td>${esc(c._fecha)}</td><td>${equipo}</td>
      <td><span class="est ${cls}">${esc(c.Estado)}</span>${c._sinTarifa ? '<br><small class="neg">Sin tarifa en SITIOS</small>' : ''}${c.Motivo ? `<br><small>${esc(c.Motivo)}</small>` : ''}</td>
      <td class="num">${c.Estado === 'Ejecutado' && c._base ? usd(c._base) : '—'}</td><td>${nvHtml}</td>
      <td class="num"><b>${c.Estado === 'Ejecutado' ? usd(c._total) : '—'}</b></td><td>${P().badgePago(pe(c))}</td><td>${acc}</td></tr>
      <tr class="filadet" id="det-${esc(c.ID_Cobro)}" style="display:none"><td colspan="8">${det}</td></tr>`;
  }).join('') || '<tr><td colspan="8" style="text-align:center;color:#888;padding:20px;">Sin servicios en este período.</td></tr>';

  const u = o => '/cartera/cliente?' + Object.entries({ c: cliente, mes, ...o }).filter(([, v]) => v).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const etiquetaMes = mes === 'todo' ? 'Todo el histórico' : mes;
  const mesNav = mes === 'todo' ? '' : `<a class="btn" href="${esc(u({ mes: sumarMes(mes, -1) }))}">←</a>
    <a class="btn hoy" href="${esc(u({ mes: hoy.slice(0, 7) }))}">Este mes</a><a class="btn" href="${esc(u({ mes: sumarMes(mes, 1) }))}">→</a>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cartera · ${esc(cliente)}</title><style>${CSS}${CSS_DETALLE}${P().CSS_PAGOS}${menu.MENU_CSS}</style></head><body>
<div class="top"><h2 style="margin:0;">${esc(cliente)} ${badgeMetodo(tar, cliente)}</h2>${menu.menuHtml('/cartera', admin)}</div>
<div class="nav"><a class="btn" href="${esc('/cartera?mes=' + mes)}">← Cartera</a>${mesNav}
  <a class="btn" href="${esc(u({ mes: mes === 'todo' ? hoy.slice(0, 7) : 'todo' }))}">${mes === 'todo' ? 'Ver por mes' : 'Ver todo el histórico'}</a>
  <a class="btn" href="${esc(u({ sync: '1' }))}">Sincronizar ahora</a>${P().botonesPago(cliente, tar)}<a class="btn" href="/cartera/pagos">Todos los pagos</a><b style="margin-left:8px;">${esc(etiquetaMes)}</b></div>
${errSync ? `<div class="aviso r">No se pudo sincronizar con la agenda: ${esc(errSync)}</div>` : ''}
${t && (t.nota || t.pagador) ? `<div class="aviso">${t.pagador ? `Paga: <b>${esc(t.pagador)}</b>. ` : ''}${esc(t.nota)}</div>` : ''}
<table style="width:auto;"><tr><th class="num">Servicios ejecutados</th><th class="num">Valor servicios</th><th class="num">Novedades</th><th class="num">Total a cobrar</th><th class="num">Cobrado</th><th class="num">Saldo</th><th class="num">Por confirmar</th><th class="num">Sin tarifa</th></tr>
<tr><td class="num">${T.n}</td><td class="num">${usd(T.base)}</td><td class="num">${usd(T.nov)}</td><td class="num"><b>${usd(r2(T.base + T.nov))}</b></td><td class="num">${usd(r2(T.cob))}</td><td class="num"><b>${usd(r2(T.sal))}</b></td><td class="num">${T.conf}</td><td class="num">${T.sin}</td></tr></table>
<table class="tc"><tr><th>Fecha</th><th>Equipo y horas</th><th>Estado</th><th class="num">Valor</th><th>Novedades</th><th class="num">Total</th><th>Pago</th><th>Acciones</th></tr>${filasHtml}</table>
${P().seccionCliente(cliente, todos, pgd, tar)}
${DIALOGO_COBRO}
</body></html>`;
}


// ---------- rutas ----------
function rutas(app, auth) {
  const api = (ruta, fn) => app.post(ruta, auth.requiereAdmin, async (req, res) => {
    try { res.json(await fn(req.body || {}, req.admin)); }
    catch (e) { console.error('Error en POST ' + ruta, e); res.status(500).json({ ok: false, general: 'Error: ' + e.message }); }
  });
  app.get('/cartera', auth.requiereAdmin, async (req, res) => {
    try { res.set('Content-Type', 'text/html; charset=utf-8'); res.send(await paginaCartera(req.query, req.admin)); }
    catch (e) { console.error('Error en GET /cartera:', e); res.status(500).send('Error cargando la cartera: ' + e.message); }
  });
  app.get('/cartera/clientes', auth.requiereAdmin, async (req, res) => {
    try { res.set('Content-Type', 'text/html; charset=utf-8'); res.send(await paginaCartera(req.query, req.admin, 'clientes')); }
    catch (e) { console.error('Error en GET /cartera/clientes:', e); res.status(500).send('Error cargando los clientes: ' + e.message); }
  });
  app.get('/cartera/cliente', auth.requiereAdmin, async (req, res) => {
    try {
      const html = await paginaCliente(req.query, req.admin);
      if (html === null) return res.redirect('/cartera');
      res.set('Content-Type', 'text/html; charset=utf-8'); res.send(html);
    } catch (e) { console.error('Error en GET /cartera/cliente:', e); res.status(500).send('Error cargando el cliente: ' + e.message); }
  });
  api('/cartera/ejecutar', (b, a) => ejecutar({ id: b.id, valor: b.valor, motivo: b.motivo, admin: a }));
  api('/cartera/cancelar', (b, a) => cancelar({ id: b.id, motivo: b.motivo, admin: a }));
  api('/cartera/novedad', (b, a) => registrarNovedad({ idCobro: b.idCobro, idProgramacion: b.idProgramacion, tipo: b.tipo, detalle: b.detalle, monto: b.monto, admin: a }));
  api('/cartera/novedad/anular', (b, a) => anularNovedad({ id: b.id, motivo: b.motivo, admin: a }));
}

module.exports = {
  rutas, paginaCartera, botonNovedad, dialogoNovedad, datosCobroDia, lineaDeVidaH,
  helpers: { cargarTabla, cargarTarifas, armar, enCola, bit, aFila, poner, numero, r2, usd, esc, err, motivoOk, ahora, mesValido, sumarMes, CS_H, NV_H, CSS },
};