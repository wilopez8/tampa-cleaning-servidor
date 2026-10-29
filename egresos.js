const { leerHoja, agregarFila } = require('./sheets');
const { normalizarFecha, fechaValida, hoyFlorida } = require('./agenda');
const menu = require('./menu');
const K = require('./cartera').helpers; // cartera.js no carga este archivo, así que no hay ciclo
const { METODOS, CUENTAS, EFECTIVO_MANO } = require('./pagos');
const { cargarTabla, enCola, bit, aFila, poner, numero, r2, usd, esc, err, motivoOk, ahora, mesValido, sumarMes, CSS } = K;

// EGRESOS: una fila por salida de dinero. Tipo "Nómina" = pago de una liquidación cerrada (un pago por liquidación, por el total);
// Tipo "Gasto" = gasto ingresado a mano. Las filas nunca se borran: se anulan con motivo.
const EG_H = ['ID_Egreso', 'Tipo', 'Beneficiario', 'ID_Liquidacion', 'Categoria', 'Concepto', 'Factura', 'Valor', 'Fecha_Pago', 'Metodo', 'Cuenta_Origen',
  'Codigo_Banco', 'Referencia', 'Estado', 'Motivo_Anulacion', 'Anulado_Por', 'Fecha_Anulacion', 'Registrado_Por', 'Fecha_Registro'];
const TIPO_NOM = 'Nómina', TIPO_GASTO = 'Gasto';
const CATEGORIAS = ['Insumos y productos', 'Combustible y transporte', 'Equipos y herramientas', 'Seguros y licencias', 'Publicidad', 'Impuestos',
  'Servicios (teléfono, software)', 'Créditos', 'Otro'];
const EPS = 0.004;
const texto = v => (v === '' || v === undefined || v === null) ? '' : "'" + v; // apóstrofo: Sheets lo guarda como texto (códigos largos, ceros a la izquierda)

// ---------- lectura y cálculo ----------
async function liquidaciones(directo) {
  const d = await leerHoja('LIQUIDACIONES', directo ? {} : { cache: true });
  if (d.length < 2) return [];
  const h = d[0];
  return d.slice(1).map(r => { const o = {}; h.forEach((n, j) => { o[n] = r[j] === undefined ? '' : String(r[j]); }); return o; }).filter(o => o.ID_Liquidacion);
}
async function datos(directo) {
  const egresos = await cargarTabla('EGRESOS', EG_H, directo);
  const porLiq = {};
  egresos.forEach(e => { if (e.ID_Egreso && e.Estado === 'Activo' && e.ID_Liquidacion) porLiq[e.ID_Liquidacion] = e; });
  return { egresos, porLiq };
}
// Para nomina.js: ¿esta liquidación ya tiene un pago activo? (devuelve el ID del egreso o '')
async function egresoDeLiquidacion(idLiq) {
  if (!idLiq) return '';
  const d = await datos(true);
  return d.porLiq[idLiq] ? d.porLiq[idLiq].ID_Egreso : '';
}
// Una liquidación se paga cuando está Cerrada (las Reabiertas fueron reemplazadas por otra) y su total es mayor que cero
const pagable = l => l.Estado === 'Cerrada' && numero(l.Total) > EPS;

// ---------- validaciones comunes ----------
function validarPago(b, hoy) {
  const fecha = String(b.fechaPago || '').trim();
  if (!fechaValida(fecha) || fecha > hoy) return { error: 'La fecha de pago no es válida (no puede ser futura).' };
  const metodo = String(b.metodo || '').trim();
  if (!METODOS.includes(metodo)) return { error: 'Elige el método de pago.' };
  let cuenta = String(b.cuenta || '').trim();
  if (!cuenta && metodo === 'Efectivo') cuenta = EFECTIVO_MANO;
  if (!CUENTAS.includes(cuenta)) return { error: 'Elige la cuenta de la que salió el dinero.' };
  if (cuenta === EFECTIVO_MANO && (metodo === 'Venmo' || metodo === 'Zelle')) return { error: `Un pago por ${metodo} sale de una cuenta, no de "Efectivo en mano".` };
  const codigo = String(b.codigoBanco || '').trim().slice(0, 60);
  if (codigo && cuenta === EFECTIVO_MANO) return { error: 'El efectivo en mano no tiene código de banco.' };
  const referencia = String(b.referencia || '').trim().slice(0, 60);
  return { fecha, metodo, cuenta, codigo, referencia };
}

// ---------- acciones ----------
function registrarEgreso(b, admin) {
  return enCola(async () => {
    const hoy = hoyFlorida();
    const tipo = [TIPO_NOM, TIPO_GASTO].includes(b.tipo) ? b.tipo : null;
    if (!tipo) return err('Tipo de egreso no válido.');
    const v = validarPago(b, hoy);
    if (v.error) return err(v.error);
    const d = await datos(true);

    let fila;
    if (tipo === TIPO_NOM) {
      const idLiq = String(b.idLiquidacion || '').trim();
      const l = (await liquidaciones(true)).find(x => x.ID_Liquidacion === idLiq);
      if (!l) return err('Liquidación no encontrada.');
      if (l.Estado !== 'Cerrada') return err(`La liquidación está ${l.Estado.toLowerCase()}: solo se paga una liquidación cerrada.`);
      if (!pagable(l)) return err('Esta liquidación tiene total $0 o negativo: no hay nada que pagar.');
      if (d.porLiq[idLiq]) return err(`Esta liquidación ya está pagada (${d.porLiq[idLiq].ID_Egreso}).`);
      const sem = normalizarFecha(l.Semana_Inicio);
      fila = { Tipo: tipo, Beneficiario: l.Empleado, ID_Liquidacion: idLiq, Categoria: 'Nómina', Concepto: `Liquidación semana ${sem}`, Valor: r2(numero(l.Total)) };
    } else {
      const valor = r2(numero(b.valor));
      if (!(valor > 0)) return err('El valor debe ser mayor que 0.');
      const categoria = String(b.categoria || '').trim();
      if (!CATEGORIAS.includes(categoria)) return err('Elige la categoría del gasto.');
      const concepto = String(b.concepto || '').trim();
      if (concepto.length < 3) return err('El concepto es obligatorio (mínimo 3 caracteres).');
      fila = { Tipo: tipo, Beneficiario: String(b.beneficiario || '').trim().slice(0, 100), Categoria: categoria, Concepto: concepto.slice(0, 200),
        Factura: String(b.factura || '').trim().slice(0, 60), Valor: valor };
    }
    const pref = 'EGR-' + hoy.replace(/-/g, '') + '-';
    let mx = 0;
    d.egresos.forEach(e => { const m = String(e.ID_Egreso).match(/^EGR-\d{8}-(\d+)$/); if (m && String(e.ID_Egreso).startsWith(pref)) mx = Math.max(mx, +m[1]); });
    const id = pref + String(mx + 1).padStart(2, '0');
    await agregarFila('EGRESOS', aFila(d.egresos.h, {
      ID_Egreso: id, ...fila, Factura: texto(fila.Factura || ''), Fecha_Pago: v.fecha, Metodo: v.metodo, Cuenta_Origen: v.cuenta,
      Codigo_Banco: texto(v.codigo), Referencia: texto(v.referencia), Estado: 'Activo', Registrado_Por: admin, Fecha_Registro: ahora(),
    }));
    await bit(id, 'Egreso', `${tipo} ${usd(fila.Valor)} · ${v.metodo} · ${v.cuenta} · ${fila.Beneficiario || fila.Categoria}${fila.ID_Liquidacion ? ' · ' + fila.ID_Liquidacion : ''}`, fila.Concepto, admin);
    return { ok: true, id };
  });
}

function anularEgreso({ id, motivo }, admin) {
  return enCola(async () => {
    if (!motivoOk(motivo)) return err('El motivo es obligatorio (mínimo 3 caracteres).');
    const d = await datos(true);
    const e = d.egresos.find(x => x.ID_Egreso === String(id || '').trim());
    if (!e) return err('Egreso no encontrado.');
    if (e.Estado !== 'Activo') return err('El egreso ya estaba anulado.');
    await poner('EGRESOS', d.egresos, e, { Estado: 'Anulado', Motivo_Anulacion: String(motivo).trim(), Anulado_Por: admin, Fecha_Anulacion: ahora() });
    await bit(e.ID_Egreso, 'Anular egreso', `${usd(numero(e.Valor) || 0)} · ${e.Beneficiario || e.Categoria}${e.ID_Liquidacion ? '; la liquidación ' + e.ID_Liquidacion + ' vuelve a quedar por pagar' : ''}`, motivo, admin);
    return { ok: true };
  });
}

// ---------- pantalla ----------
const CSS_EGRESOS = `#egDlg{max-width:640px;width:94%;} #egDlg .egGrid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px;} .egNota{font-size:12px;color:#777;margin:4px 0;}
#egAnDlg{max-width:360px;} .est.egp{background:#fde68a;} @media(max-width:700px){#egDlg .egGrid{grid-template-columns:1fr;}}`;

const opt = arr => arr.map(o => `<option>${esc(o)}</option>`).join('');

const SCRIPT_EGRESOS = String.raw`
var egTipo='Gasto',egLiq='',egAnId='';
function egE(i){return document.getElementById(i);}
function egPost(url,data,errId){fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(function(r){return r.json();}).then(function(j){if(j.ok){location.reload();}else{egE(errId).textContent=j.general||'Error';}}).catch(function(){egE(errId).textContent='Error de conexión';});}
function egMetodoCambio(){var m=egE('egMetodo').value,c=egE('egCuenta');
 if(m==='Efectivo'&&c.value==='')c.value='Efectivo en mano';
 if((m==='Venmo'||m==='Zelle')&&c.value==='Efectivo en mano')c.value='';
 egE('egRefL').textContent=m==='Cheque'?'N.º de cheque (opcional)':(m==='Zelle'?'Confirmación Zelle (opcional)':(m==='Venmo'?'Código Venmo (opcional)':'Referencia (opcional)'));}
function egReset(){['egConc','egBenef','egFact','egValor','egCod','egRef'].forEach(function(i){egE(i).value='';});
 egE('egFecha').value=EGD.hoy;egE('egMetodo').selectedIndex=0;egE('egCuenta').value='';egE('egCat').selectedIndex=0;egE('egErr').textContent='';egMetodoCambio();}
function egMostrar(){var nom=egTipo==='Nómina';egE('egNom').style.display=nom?'block':'none';egE('egGasto').style.display=nom?'none':'block';
 egE('egTit').textContent=nom?'Pagar liquidación':'Registrar gasto';}
function egGasto(){egTipo='Gasto';egLiq='';egReset();egMostrar();egE('egDlg').showModal();}
function egPagarLiq(b){egTipo='Nómina';egLiq=b.dataset.id;egReset();egMostrar();egE('egNomInfo').textContent=b.dataset.t;egE('egDlg').showModal();}
function egGuardar(){
 egPost('/cartera/egresos/registrar',{tipo:egTipo,idLiquidacion:egLiq,categoria:egE('egCat').value,concepto:egE('egConc').value,beneficiario:egE('egBenef').value,
  factura:egE('egFact').value,valor:egE('egValor').value,fechaPago:egE('egFecha').value,metodo:egE('egMetodo').value,cuenta:egE('egCuenta').value,
  codigoBanco:egE('egCod').value,referencia:egE('egRef').value},'egErr');}
function egAnular(b){egAnId=b.dataset.id;egE('egAnT').textContent=b.dataset.t;egE('egMotivo').value='';egE('egAnErr').textContent='';egE('egAnDlg').showModal();}
function egAnularOk(){var m=egE('egMotivo').value.trim();if(m.length<3){egE('egAnErr').textContent='El motivo es obligatorio.';return;}egPost('/cartera/egresos/anular',{id:egAnId,motivo:m},'egAnErr');}
`;

function dialogos() {
  const json = JSON.stringify({ hoy: hoyFlorida() });
  return `<dialog id="egDlg"><h3 id="egTit" style="margin-top:0;">Registrar gasto</h3>
  <div id="egNom"><p id="egNomInfo" style="margin:0 0 6px;font-size:14px;"></p><p class="egNota">Se paga la liquidación completa, por su total. Si hay que cambiar el valor, ajusta primero la nómina (conceptos o descuentos) y vuelve a cerrar la liquidación.</p></div>
  <div id="egGasto"><div class="egGrid"><label>Categoría<select id="egCat">${opt(CATEGORIAS)}</select></label><label>Valor (USD)<input type="number" id="egValor" min="0" step="0.01"></label></div>
    <label>Concepto (obligatorio)<input type="text" id="egConc" maxlength="200"></label>
    <div class="egGrid"><label>Proveedor o beneficiario (opcional)<input type="text" id="egBenef" maxlength="100"></label><label>N.º de factura o recibo (opcional)<input type="text" id="egFact" maxlength="60"></label></div></div>
  <div class="egGrid"><label>Fecha de pago<input type="date" id="egFecha"></label>
    <label>Método<select id="egMetodo" onchange="egMetodoCambio()">${opt(METODOS)}</select></label>
    <label>Cuenta de la que salió<select id="egCuenta"><option value="">— elegir —</option>${opt(CUENTAS)}</select></label>
    <label>Código de transacción en el banco (opcional)<input type="text" id="egCod" maxlength="60"></label></div>
  <label><span id="egRefL">Referencia (opcional)</span><input type="text" id="egRef" maxlength="60"></label>
  <p id="egErr" style="color:#b91c1c;font-size:13px;"></p>
  <button class="btn hoy" onclick="egGuardar()">Guardar</button> <button class="btn" onclick="egE('egDlg').close()">Cancelar</button></dialog>
<dialog id="egAnDlg"><h3 id="egAnT" style="margin-top:0;"></h3><label>Motivo (obligatorio)<input type="text" id="egMotivo" maxlength="200"></label>
  <p id="egAnErr" style="color:#b91c1c;font-size:13px;"></p>
  <button class="btn hoy" onclick="egAnularOk()">Anular</button> <button class="btn" onclick="egE('egAnDlg').close()">Cancelar</button></dialog>
<script>var EGD=${json};${SCRIPT_EGRESOS}</script>`;
}

async function paginaEgresos(query, admin) {
  const hoy = hoyFlorida();
  const mes = query.mes === 'todo' ? 'todo' : (mesValido(query.mes) ? query.mes : hoy.slice(0, 7));
  const [d, liqs] = await Promise.all([datos(), liquidaciones()]);
  const fTipo = [TIPO_NOM, TIPO_GASTO].includes(query.tipo) ? query.tipo : '';
  const fCat = [...CATEGORIAS, 'Nómina'].includes(query.categoria) ? query.categoria : '';
  const fMet = METODOS.includes(query.metodo) ? query.metodo : '';
  const fCta = CUENTAS.includes(query.cuenta) ? query.cuenta : '';
  const fEst = ['Activo', 'Anulado'].includes(query.estado) ? query.estado : '';
  const vis = d.egresos.filter(e => e.ID_Egreso).filter(e => {
    const f = normalizarFecha(e.Fecha_Pago);
    return (mes === 'todo' || f.startsWith(mes)) && (!fTipo || e.Tipo === fTipo) && (!fCat || e.Categoria === fCat) && (!fMet || e.Metodo === fMet) && (!fCta || e.Cuenta_Origen === fCta) && (!fEst || e.Estado === fEst);
  }).sort((a, b) => normalizarFecha(b.Fecha_Pago).localeCompare(normalizarFecha(a.Fecha_Pago)) || String(b.ID_Egreso).localeCompare(String(a.ID_Egreso)));
  const act = vis.filter(e => e.Estado === 'Activo');
  const suma = l => r2(l.reduce((a, e) => a + (numero(e.Valor) || 0), 0));
  const porCat = {};
  act.forEach(e => { porCat[e.Categoria] = r2((porCat[e.Categoria] || 0) + (numero(e.Valor) || 0)); });
  const catTxt = Object.entries(porCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${usd(v)}`).join(' · ');

  const porPagar = liqs.filter(l => pagable(l) && !d.porLiq[l.ID_Liquidacion]).sort((a, b) => normalizarFecha(a.Semana_Inicio).localeCompare(normalizarFecha(b.Semana_Inicio)) || a.Empleado.localeCompare(b.Empleado));
  const totPorPagar = r2(porPagar.reduce((a, l) => a + numero(l.Total), 0));
  const filasPP = porPagar.map(l => {
    const t = `${l.Empleado} · semana ${normalizarFecha(l.Semana_Inicio)} · ${usd(numero(l.Total))}`;
    return `<tr><td>${esc(normalizarFecha(l.Semana_Inicio))}<br><small>${esc(l.ID_Liquidacion)}</small></td><td>${esc(l.Empleado)}</td><td class="num">${esc(l.Servicios)}</td><td class="num"><b>${usd(numero(l.Total))}</b></td>
      <td><button class="btn mini hoy" data-id="${esc(l.ID_Liquidacion)}" data-t="${esc(t)}" onclick="egPagarLiq(this)">Registrar pago</button></td></tr>`;
  }).join('');

  const filas = vis.map(e => {
    const act2 = e.Estado === 'Activo';
    const quien = e.Tipo === TIPO_NOM ? `<b>${esc(e.Beneficiario)}</b><br><small>${esc(e.Concepto)} · ${esc(e.ID_Liquidacion)}</small>`
      : `<b>${esc(e.Categoria)}</b>: ${esc(e.Concepto)}${e.Beneficiario ? `<br><small>${esc(e.Beneficiario)}</small>` : ''}${e.Factura ? `<br><small>Factura ${esc(e.Factura)}</small>` : ''}`;
    const t = `Anular egreso ${e.ID_Egreso} · ${e.Beneficiario || e.Categoria}`;
    return `<tr${act2 ? '' : ' class="anu"'}><td>${esc(normalizarFecha(e.Fecha_Pago))}<br><small>${esc(e.ID_Egreso)}</small></td><td>${quien}</td>
      <td><span class="mp ${esc(String(e.Metodo).toLowerCase())}" style="margin-left:0;">${esc(e.Metodo)}</span><br><small>${esc(e.Cuenta_Origen)}${e.Referencia ? '<br>Ref. ' + esc(e.Referencia) : ''}</small></td>
      <td class="num"><b>${usd(numero(e.Valor) || 0)}</b></td><td>${e.Codigo_Banco ? esc(e.Codigo_Banco) : '<small>—</small>'}</td>
      <td><span class="est ${act2 ? 'ok' : 'cn'}">${esc(e.Estado)}</span><br>${act2 ? `<button class="btn mini" data-id="${esc(e.ID_Egreso)}" data-t="${esc(t)}" onclick="egAnular(this)">Anular</button>` : `<small>Anulado por ${esc(e.Anulado_Por)}: ${esc(e.Motivo_Anulacion)}</small>`}</td></tr>`;
  }).join('') || '<tr><td colspan="6" style="text-align:center;color:#888;padding:20px;">No hay egresos para este filtro.</td></tr>';

  const u = o => '/cartera/egresos?' + Object.entries({ mes, tipo: fTipo, categoria: fCat, metodo: fMet, cuenta: fCta, estado: fEst, ...o }).filter(([, v]) => v).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const sel = (n, et, ops, a) => `<select name="${n}"><option value="">${et}</option>${ops.map(o => `<option value="${esc(o)}"${a === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  const etiqueta = mes === 'todo' ? 'Todo el histórico' : mes;
  const nav = mes === 'todo' ? '' : `<a class="btn" href="${esc(u({ mes: sumarMes(mes, -1) }))}">←</a><a class="btn hoy" href="${esc(u({ mes: hoy.slice(0, 7) }))}">Este mes</a><a class="btn" href="${esc(u({ mes: sumarMes(mes, 1) }))}">→</a>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Egresos ${esc(etiqueta)}</title><style>${CSS}${CSS_EGRESOS}${menu.MENU_CSS}</style></head><body>
<div class="top"><h2 style="margin:0;">Egresos — ${esc(etiqueta)}</h2>${menu.menuHtml('/cartera', admin)}</div>
<div class="nav"><a class="btn" href="/cartera">← Cartera</a><a class="btn" href="/cartera/pagos">Ingresos</a>${nav}
  <a class="btn" href="${esc(u({ mes: mes === 'todo' ? hoy.slice(0, 7) : 'todo' }))}">${mes === 'todo' ? 'Ver por mes' : 'Ver todo el histórico'}</a>
  <button class="btn hoy" onclick="egGasto()">Registrar gasto</button></div>
<h3 style="margin:8px 0;">Liquidaciones por pagar${porPagar.length ? ` <small>(${porPagar.length} · ${usd(totPorPagar)})</small>` : ''}</h3>
${porPagar.length ? `<div class="scroll"><table><tr><th>Semana</th><th>Empleado</th><th class="num">Servicios</th><th class="num">Total</th><th></th></tr>${filasPP}</table></div>` : '<div class="aviso">No hay liquidaciones cerradas pendientes de pago.</div>'}
<div class="aviso" style="background:#fef2f2;">Egresos activos en el filtro: <b>${act.length}</b> · <b>${usd(suma(act))}</b> (nómina ${usd(suma(act.filter(e => e.Tipo === TIPO_NOM)))} · gastos ${usd(suma(act.filter(e => e.Tipo === TIPO_GASTO)))})${catTxt ? `<br><small>Por categoría: ${catTxt}</small>` : ''}</div>
<form class="filtros" method="GET" action="/cartera/egresos"><input type="hidden" name="mes" value="${esc(mes)}">
  ${sel('tipo', 'Todos los tipos', [TIPO_NOM, TIPO_GASTO], fTipo)}${sel('categoria', 'Todas las categorías', ['Nómina', ...CATEGORIAS], fCat)}${sel('metodo', 'Todos los métodos', METODOS, fMet)}${sel('cuenta', 'Todas las cuentas', CUENTAS, fCta)}${sel('estado', 'Todos los estados', ['Activo', 'Anulado'], fEst)}
  <button class="btn">Filtrar</button> <a class="btn" href="${esc(u({ tipo: '', categoria: '', metodo: '', cuenta: '', estado: '' }))}">Limpiar</a></form>
<div class="scroll g"><table><tr><th>Pagado</th><th>Beneficiario / concepto</th><th>Método y cuenta</th><th class="num">Valor</th><th>Código banco</th><th>Estado</th></tr>${filas}</table></div>
${dialogos()}
</body></html>`;
}

// ---------- rutas ----------
function rutas(app, auth) {
  const api = (ruta, fn) => app.post(ruta, auth.requiereAdmin, async (req, res) => {
    try { res.json(await fn(req.body || {}, req.admin)); }
    catch (e) { console.error('Error en POST ' + ruta, e); res.status(500).json({ ok: false, general: 'Error: ' + e.message }); }
  });
  app.get('/cartera/egresos', auth.requiereAdmin, async (req, res) => {
    try { res.set('Content-Type', 'text/html; charset=utf-8'); res.send(await paginaEgresos(req.query, req.admin)); }
    catch (e) { console.error('Error en GET /cartera/egresos:', e); res.status(500).send('Error cargando los egresos: ' + e.message); }
  });
  api('/cartera/egresos/registrar', (b, a) => registrarEgreso(b, a));
  api('/cartera/egresos/anular', (b, a) => anularEgreso(b, a));
}

module.exports = { rutas, datos, egresoDeLiquidacion, registrarEgreso, anularEgreso, paginaEgresos };
