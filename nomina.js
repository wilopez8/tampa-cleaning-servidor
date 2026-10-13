const { leerHoja, agregarFila, agregarFilas, asegurarHoja, edadCacheSegundos } = require('./sheets');
const { normalizarFecha, fechaValida, hoyFlorida, sumarDias, inicioSemana, diaSemana, filasDelRango } = require('./agenda');

const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const HORA = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp])?\.?[Mm]?/g;
const p2 = n => String(n).padStart(2, '0');

const CONFIG_HEADERS = ['Clave', 'Valor', 'Descripcion'];
const CONFIG_DEFAULTS = [
  ['Recargo_Sabado_Hora', '1', 'USD adicionales por cada hora trabajada en sábado'],
  ['Tarifa_Milla', '0.37', 'Fase 2: USD por milla'],
  ['Umbral_Millas_Dia', '10', 'Fase 2: el día paga millas solo si el total de millas pagadas llega a este número'],
  ['Servicios_Pago_Siempre', '2', 'Fase 2: con esta cantidad de servicios en el día, los tramos se pagan siempre'],
  ['Umbral_Tarifa_Fija', '20', 'Fase 2: por encima de estas millas el administrador fija un monto'],
];
const AJ_HEADERS = ['Fecha_Hora', 'ID_Programacion', 'Empleado', 'Fecha_Servicio', 'Pago_Inicio', 'Pago_Fin', 'Motivo', 'Ajustado_Por', 'Referencia'];

// ---------- utilidades ----------
function numero(t) {
  let s = String(t ?? '').replace(/[$\s]/g, '');
  if (!s) return NaN;
  if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.'); else s = s.replace(/,/g, '');
  return parseFloat(s);
}
function aMinutos(m) {
  if (!m) return null;
  let h = +m[1]; const ap = m[3] && m[3].toLowerCase();
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  return h * 60 + +m[2];
}
const minutosDe = t => aMinutos([...String(t || '').matchAll(HORA)][0]);
function rangoProg(r) {
  let ini = minutosDe(r.Hora_Inicio), fin = minutosDe(r.Hora_Fin);
  if (ini === null || fin === null) {
    const ms = [...String(r.Horario || '').matchAll(HORA)];
    if (ms.length >= 2) { ini = aMinutos(ms[0]); fin = aMinutos(ms[1]); }
  }
  return { ini, fin };
}
function f12(min) {
  if (min === null || min === undefined) return '—';
  const m = ((min % 1440) + 1440) % 1440, h = Math.floor(m / 60);
  return `${h % 12 || 12}:${p2(m % 60)} ${h < 12 ? 'AM' : 'PM'}`;
}
function f24(min) {
  if (min === null || min === undefined) return '';
  const m = ((min % 1440) + 1440) % 1440;
  return `${p2(Math.floor(m / 60))}:${p2(m % 60)}`;
}
const fmtDur = min => `${Math.floor(min / 60)} h ${p2(min % 60)} min`;
const usd = n => '$' + n.toFixed(2);

// ---------- datos ----------
async function cargarConfig() {
  await asegurarHoja('CONFIG_NOMINA', CONFIG_HEADERS);
  let datos = await leerHoja('CONFIG_NOMINA', { cache: true });
  if (datos.length < 2) { await agregarFilas('CONFIG_NOMINA', CONFIG_DEFAULTS); datos = [CONFIG_HEADERS, ...CONFIG_DEFAULTS]; }
  const h = datos[0], iK = h.indexOf('Clave'), iV = h.indexOf('Valor');
  const cfg = {};
  CONFIG_DEFAULTS.forEach(([k, v]) => { cfg[k] = numero(v); });
  datos.slice(1).forEach(f => { const k = String(f[iK] || '').trim(), v = numero(f[iV]); if (k && !isNaN(v)) cfg[k] = v; });
  return cfg;
}

async function cargarTarifas() {
  const d = await leerHoja('EMPLEADOS', { cache: true });
  const out = { mapa: {}, hayColumna: false };
  if (d.length < 2) return out;
  const h = d[0], iN = h.indexOf('Nombre'), iT = h.indexOf('Tarifa_Hora');
  out.hayColumna = iT >= 0;
  if (iN < 0) return out;
  d.slice(1).forEach(f => { const n = String(f[iN] || '').trim(); if (n) out.mapa[n] = iT < 0 ? NaN : numero(f[iT]); });
  return out;
}

async function cargarAjustes() {
  await asegurarHoja('NOMINA_AJUSTES', AJ_HEADERS);
  const d = await leerHoja('NOMINA_AJUSTES');
  const mapa = {};
  if (d.length < 2) return mapa;
  const h = d[0], ix = n => h.indexOf(n);
  d.slice(1).forEach(f => {
    const id = f[ix('ID_Programacion')];
    if (!id) return;
    const ini = String(f[ix('Pago_Inicio')] || '').trim(), fin = String(f[ix('Pago_Fin')] || '').trim();
    if (!ini && !fin) delete mapa[id];
    else mapa[id] = { ini, fin, motivo: f[ix('Motivo')] || '', por: f[ix('Ajustado_Por')] || '' };
  });
  return mapa;
}

// ---------- cálculo de una fila ----------
function calcular(r, ajuste, tarifa, cfg) {
  const prog = rangoProg(r);
  let pIni = prog.ini, pFin = prog.fin;
  if (pIni !== null && pFin !== null && pFin < pIni) pFin += 1440;
  const eIni = minutosDe(r.Hora_Entrada_Real);
  let eFin = minutosDe(r.Hora_Salida_Real);
  if (eIni !== null && eFin !== null && eFin < eIni) eFin += 1440;
  const refMin = (pIni !== null && pFin !== null) ? pFin - pIni : 0;

  let ini = null, fin = null, estado, nota = '';
  if (ajuste) {
    ini = minutosDe(ajuste.ini); fin = minutosDe(ajuste.fin);
    if (ini !== null && fin !== null && fin < ini) fin += 1440;
    estado = 'Ajustado';
  } else if (eIni === null || eFin === null) {
    estado = 'Revisar'; nota = eIni === null ? 'Sin check-in de entrada' : 'Sin check-in de salida';
  } else if (pIni === null || pFin === null) {
    estado = 'Revisar'; nota = 'Sin horario programado';
  } else {
    ini = Math.max(pIni, eIni); fin = Math.min(pFin, eFin); estado = 'Calculado';
  }
  let min = (ini !== null && fin !== null) ? fin - ini : 0;
  if (estado !== 'Revisar' && min <= 0) { estado = 'Revisar'; nota = 'Horas pagadas ≤ 0'; min = 0; ini = fin = null; }

  const sabado = diaSemana(r._fecha) === 'Sáb';
  const sinTarifa = !(tarifa > 0);
  const efectiva = sinTarifa ? 0 : tarifa + (sabado ? (cfg.Recargo_Sabado_Hora || 0) : 0);
  const monto = (sinTarifa || estado === 'Revisar') ? 0 : Math.round(min / 60 * efectiva * 100) / 100;
  return { r, prog: { ini: pIni, fin: pFin }, real: { ini: eIni, fin: eFin }, pago: { ini, fin }, min, refMin, sabado, efectiva, monto, estado, nota, sinTarifa, ajuste };
}

// ---------- ajuste manual ----------
async function ajustar({ id, inicio, fin, motivo, admin }) {
  id = String(id || '').trim();
  inicio = String(inicio || '').trim(); fin = String(fin || '').trim();
  if (String(motivo || '').trim().length < 3) return { ok: false, general: 'El motivo es obligatorio (mínimo 3 caracteres).' };
  if ((inicio && !fin) || (!inicio && fin)) return { ok: false, general: 'Indica inicio y fin, o deja ambos vacíos para quitar el ajuste.' };
  if (inicio) {
    const a = minutosDe(inicio), b = minutosDe(fin);
    if (a === null || b === null) return { ok: false, general: 'Hora no válida.' };
    if (a === b) return { ok: false, general: 'El inicio y el fin no pueden ser iguales.' };
  }
  const datos = await leerHoja('PROGRAMACION_DIARIA');
  if (!datos.length) return { ok: false, general: 'PROGRAMACION_DIARIA está vacía.' };
  const h = datos[0], ix = n => h.indexOf(n);
  const f = datos.slice(1).find(x => x[ix('ID_Programacion')] === id);
  if (!f) return { ok: false, general: 'Servicio no encontrado.' };
  if (f[ix('Cancelado')] === 'Sí') return { ok: false, general: 'El servicio está cancelado.' };
  await asegurarHoja('NOMINA_AJUSTES', AJ_HEADERS);
  const referencia = `Prog: ${f[ix('Horario')] || ''} | Real: ${f[ix('Hora_Entrada_Real')] || '—'} → ${f[ix('Hora_Salida_Real')] || '—'}`;
  await agregarFila('NOMINA_AJUSTES', [
    new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }), id, f[ix('Empleado')] || '',
    normalizarFecha(f[ix('Fecha_Servicio')]), inicio, fin, String(motivo).trim(), admin, referencia,
  ]);
  return { ok: true };
}

// ---------- página ----------
const CSS = `
body{font-family:-apple-system,Arial,sans-serif;margin:0;padding:20px 28px;color:#222;background:#f6f7f9;}
a{color:#1d4ed8;text-decoration:none;}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;}
.nav{display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap;}
.btn{background:#fff;border:1px solid #ccc;border-radius:6px;padding:7px 12px;font-size:14px;cursor:pointer;color:#222;}
.hoy{background:#2e7d32;color:#fff;border-color:#2e7d32;}
.aviso{background:#eef2ff;border-radius:6px;padding:8px 12px;font-size:14px;margin-bottom:12px;}
.aviso.r{background:#fef2f2;}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;margin-bottom:18px;}
th,td{padding:8px 10px;text-align:left;font-size:13px;border-bottom:1px solid #eee;vertical-align:top;}
th{background:#f1f3f5;} tfoot td{font-weight:700;background:#f9fafb;}
.num{text-align:right;white-space:nowrap;}
.est{padding:2px 8px;border-radius:10px;font-size:12px;background:#e5e7eb;}
.est.ok{background:#bbf7d0;} .est.aj{background:#bfdbfe;} .est.rev{background:#fecaca;}
small{color:#777;}
dialog{border:1px solid #ccc;border-radius:10px;padding:18px;max-width:340px;}
dialog label{display:block;margin:10px 0;font-size:14px;}
dialog input{width:100%;padding:8px;font-size:15px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;}`;

async function paginaNomina(query, admin) {
  const hoy = hoyFlorida();
  const fecha = fechaValida(query.fecha) ? query.fecha : hoy;
  const lunes = inicioSemana(fecha), domingo = sumarDias(lunes, 6);

  const [filas, cfg, tar, ajustes] = await Promise.all([filasDelRango(lunes, domingo), cargarConfig(), cargarTarifas(), cargarAjustes()]);

  const grupos = {};
  filas.filter(r => r._estado !== 'Cancelado' && r.Empleado).forEach(r => {
    const nombre = r.Empleado.trim();
    const c = calcular(r, ajustes[r.ID_Programacion], tar.mapa[nombre], cfg);
    (grupos[nombre] = grupos[nombre] || []).push(c);
  });
  const nombres = Object.keys(grupos).sort((a, b) => a.localeCompare(b));
  nombres.forEach(n => grupos[n].sort((a, b) => a.r._fecha.localeCompare(b.r._fecha) || (a.prog.ini ?? 0) - (b.prog.ini ?? 0)));

  const q = (f, e) => `/nomina?fecha=${f}${e ? '&empleado=' + encodeURIComponent(e) : ''}`;
  const emp = grupos[query.empleado] ? query.empleado : '';

  // resumen
  let tMin = 0, tMonto = 0, tRev = 0;
  const resumen = nombres.map(n => {
    const g = grupos[n];
    const min = g.reduce((s, c) => s + c.min, 0), monto = g.reduce((s, c) => s + c.monto, 0);
    const rev = g.filter(c => c.estado === 'Revisar' || c.sinTarifa).length, aj = g.filter(c => c.estado === 'Ajustado').length;
    tMin += min; tMonto += monto; tRev += rev;
    return `<tr><td><a href="${q(lunes, n)}">${esc(n)}</a></td><td class="num">${g.length}</td><td class="num">${fmtDur(min)}</td><td class="num">${usd(monto)}</td>
      <td class="num">${rev ? `<span class="est rev">${rev}</span>` : '0'}</td><td class="num">${aj}</td></tr>`;
  }).join('') || '<tr><td colspan="6" style="text-align:center;color:#888;padding:20px;">No hay servicios esta semana.</td></tr>';

  // detalle
  let detalle = '';
  if (emp) {
    const g = grupos[emp];
    const filasHtml = g.map(c => {
      const r = c.r;
      const cls = c.estado === 'Revisar' ? 'rev' : (c.estado === 'Ajustado' ? 'aj' : 'ok');
      const horas = c.min ? fmtDur(c.min) : (c.refMin ? `<small>prog. ${fmtDur(c.refMin)}</small>` : '—');
      const titulo = c.ajuste ? ` title="${esc(c.ajuste.motivo + ' — ' + c.ajuste.por)}"` : '';
      return `<tr>
        <td>${diaSemana(r._fecha)} ${r._fecha.slice(8)}${c.sabado ? '<br><small>sábado</small>' : ''}</td>
        <td>${esc(r.Cliente)}<br><small>${esc(r.Tipo_Servicio || 'Limpieza')}</small></td>
        <td>${f12(c.prog.ini)} – ${f12(c.prog.fin)}</td>
        <td>${f12(c.real.ini)} – ${f12(c.real.fin)}${r.Origen_Registro === 'Manual' ? ' ✍️' : ''}</td>
        <td>${c.pago.ini !== null ? `${f12(c.pago.ini)} – ${f12(c.pago.fin)}` : '—'}</td>
        <td class="num">${horas}</td>
        <td class="num">${c.sinTarifa ? '—' : usd(c.efectiva) + '/h'}</td>
        <td class="num">${usd(c.monto)}</td>
        <td><span class="est ${cls}"${titulo}>${esc(c.estado)}</span>${c.nota ? `<br><small>${esc(c.nota)}</small>` : ''}${c.sinTarifa ? '<br><small>Sin tarifa</small>' : ''}</td>
        <td><button class="btn" data-id="${esc(r.ID_Programacion)}" data-t="${esc(r.Cliente + ' · ' + r._fecha)}" data-ini="${f24(c.pago.ini ?? c.prog.ini)}" data-fin="${f24(c.pago.fin ?? c.prog.fin)}" onclick="tcAjustar(this)">Ajustar</button></td></tr>`;
    }).join('');
    const min = g.reduce((s, c) => s + c.min, 0), monto = g.reduce((s, c) => s + c.monto, 0);
    detalle = `<h3>${esc(emp)}</h3>
      <table><tr><th>Día</th><th>Servicio</th><th>Programado</th><th>Real (check-in)</th><th>Pagado</th><th class="num">Horas</th><th class="num">Tarifa</th><th class="num">Monto</th><th>Estado</th><th></th></tr>
      ${filasHtml}<tfoot><tr><td colspan="5">Total semana</td><td class="num">${fmtDur(min)}</td><td></td><td class="num">${usd(monto)}</td><td colspan="2"></td></tr></tfoot></table>`;
  }

  const volver = esc(q(fecha, emp));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nómina ${lunes}</title><style>${CSS}</style></head><body>
<div class="top"><h2 style="margin:0;">Nómina — semana ${lunes} → ${domingo}</h2>
  <div>${esc(admin)} · <a href="/agenda">Agenda</a> · <a href="/pendientes">Pendientes</a> · <a href="/logout">Cerrar sesión</a></div></div>
<div class="nav">
  <a class="btn" href="${q(sumarDias(lunes, -7), emp)}">←</a>
  <a class="btn hoy" href="${q(hoy, emp)}">Esta semana</a>
  <a class="btn" href="${q(sumarDias(lunes, 7), emp)}">→</a>
  <input type="date" class="btn" value="${fecha}" onchange="if(this.value)location='/nomina?fecha='+this.value${emp ? "+'&empleado=" + encodeURIComponent(emp).replace(/'/g, '') + "'" : ''}">
  <form method="POST" action="/actualizar-cache" style="margin:0 0 0 auto;display:flex;gap:8px;align-items:center;">
    <span style="font-size:12px;color:#777;">Datos de hace ${edadCacheSegundos('PROGRAMACION_DIARIA') ?? 0} s</span>
    <input type="hidden" name="volver" value="${volver}"><button class="btn">Actualizar</button></form>
</div>
<div class="aviso">Fase 1: solo horas. Los montos son de referencia hasta que exista el cierre de liquidación. Pagado = inicio más tarde y fin más temprano entre lo programado y el check-in. Sin check-in: queda en cero hasta que lo ajustes.</div>
${tar.hayColumna ? '' : '<div class="aviso r">Falta la columna <b>Tarifa_Hora</b> en la hoja EMPLEADOS: todos los montos salen en $0.00.</div>'}
<table><tr><th>Empleado</th><th class="num">Servicios</th><th class="num">Horas pagadas</th><th class="num">Monto horas</th><th class="num">Por revisar</th><th class="num">Ajustados</th></tr>${resumen}
<tfoot><tr><td>Total</td><td></td><td class="num">${fmtDur(tMin)}</td><td class="num">${usd(tMonto)}</td><td class="num">${tRev}</td><td></td></tr></tfoot></table>
${detalle}
<dialog id="dlg"><h3 id="dt" style="margin-top:0;"></h3>
  <label>Inicio pagado<input type="time" id="di"></label>
  <label>Fin pagado<input type="time" id="df"></label>
  <label>Motivo (obligatorio)<input type="text" id="dm" maxlength="200"></label>
  <p style="font-size:12px;color:#777;">Deja inicio y fin vacíos para quitar un ajuste y volver al cálculo automático.</p>
  <p id="de" style="color:#b91c1c;font-size:13px;"></p>
  <button class="btn hoy" onclick="tcGuardar()">Guardar</button> <button class="btn" onclick="document.getElementById('dlg').close()">Cancelar</button></dialog>
<script>
var ajId=null;
function tcAjustar(b){ajId=b.dataset.id;document.getElementById('dt').textContent=b.dataset.t;document.getElementById('di').value=b.dataset.ini;document.getElementById('df').value=b.dataset.fin;document.getElementById('dm').value='';document.getElementById('de').textContent='';document.getElementById('dlg').showModal();}
function tcGuardar(){var m=document.getElementById('dm').value.trim();if(m.length<3){document.getElementById('de').textContent='El motivo es obligatorio.';return;}
fetch('/nomina/ajustar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:ajId,inicio:document.getElementById('di').value,fin:document.getElementById('df').value,motivo:m})}).then(function(r){return r.json();}).then(function(j){if(j.ok){location.reload();}else{document.getElementById('de').textContent=j.general||'Error';}}).catch(function(){document.getElementById('de').textContent='Error de conexión';});}
</script>
</body></html>`;
}

module.exports = { paginaNomina, ajustar };