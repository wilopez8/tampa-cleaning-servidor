const { agregarFila, agregarFilas } = require('./sheets');
const { normalizarFecha, fechaValida, hoyFlorida } = require('./agenda');
const menu = require('./menu');
const K = require('./cartera').helpers; // cartera.js solo carga pagos.js de forma diferida, así que no hay ciclo
const { cargarTabla, cargarTarifas, armar, enCola, bit, aFila, poner, numero, r2, usd, esc, err, motivoOk, ahora, mesValido, sumarMes, CS_H, NV_H, CSS } = K;

// ---------- hojas ----------
// PAGOS: una fila por dinero recibido (servicios u otros ingresos). PAGOS_APLICACION: reparto de un pago entre servicios.
const PG_H = ['ID_Pago', 'Tipo', 'Pagador', 'Cliente', 'Categoria', 'Concepto', 'Valor', 'Fecha_Recibido', 'Fecha_Banco', 'Metodo', 'Cuenta_Destino',
  'Venmo_ID', 'Venmo_Fecha', 'Referencia', 'Estado', 'Motivo_Anulacion', 'Anulado_Por', 'Fecha_Anulacion', 'Registrado_Por', 'Fecha_Registro'];
const PA_H = ['ID_Pago', 'ID_Cobro', 'Valor_Aplicado', 'Registrado_Por', 'Fecha_Registro'];

const TIPO_SERV = 'Servicios', TIPO_OTRO = 'Otro ingreso';
const METODOS = ['Efectivo', 'Cheque', 'Zelle', 'Venmo'];
const CUENTAS = ['Personal de la propietaria', 'Corriente empresa', 'Ahorros empresa', 'Efectivo en mano'];
const EFECTIVO_MANO = 'Efectivo en mano';
const CATEGORIAS = ['Venta de productos', 'Reembolso recibido', 'Propina', 'Otro'];
const EPS = 0.004;
const kp = s => String(s ?? '').trim().toLowerCase();
const normId = s => String(s ?? '').replace(/\s/g, '').toLowerCase();
const texto = v => (v === '' || v === undefined || v === null) ? '' : "'" + v; // el apóstrofo obliga a Sheets a guardar texto (códigos largos, ceros a la izquierda)

// ---------- lectura y cálculo (nada de esto se escribe: el estado de pago es calculado) ----------
async function datos(directo) {
  const [pagos, apl] = await Promise.all([cargarTabla('PAGOS', PG_H, directo), cargarTabla('PAGOS_APLICACION', PA_H, directo)]);
  const activos = new Map();
  pagos.forEach(p => { if (p.ID_Pago && p.Estado === 'Activo') activos.set(p.ID_Pago, p); });
  const porCobro = {}, porPago = {};
  apl.forEach(a => {
    if (!activos.has(a.ID_Pago)) return; // un pago anulado deja de contar
    const v = numero(a.Valor_Aplicado) || 0;
    porCobro[a.ID_Cobro] = r2((porCobro[a.ID_Cobro] || 0) + v);
    porPago[a.ID_Pago] = r2((porPago[a.ID_Pago] || 0) + v);
  });
  const libres = [], saldoPor = {};
  activos.forEach(p => {
    if (p.Tipo !== TIPO_SERV) return;
    const libre = r2((numero(p.Valor) || 0) - (porPago[p.ID_Pago] || 0));
    if (libre > EPS) { libres.push({ ...p, _libre: libre }); saldoPor[kp(p.Pagador)] = r2((saldoPor[kp(p.Pagador)] || 0) + libre); }
  });
  return { pagos, apl, activos, porCobro, porPago, libres, saldoPor };
}
async function contextoCobros(directo) {
  const [lista, nv, tar] = await Promise.all([cargarTabla('COBROS_SERVICIO', CS_H, directo), cargarTabla('NOVEDADES_COBRO', NV_H, directo), cargarTarifas()]);
  return { todos: armar(lista, nv), tar };
}
const aplicadoDe = async idCobro => idCobro ? ((await datos(true)).porCobro[idCobro] || 0) : 0;
const aplicadoMapa = async () => (await datos(true)).porCobro;

// c = cobro armado (con _total y _sinTarifa). Solo los servicios Ejecutado se cobran.
function estadoCobro(c, d) {
  if (!c || c.Estado !== 'Ejecutado') return null;
  const ap = d.porCobro[c.ID_Cobro] || 0, total = c._total;
  if (c._sinTarifa) return { clave: 'sin', txt: 'Sin valor', aplicado: ap, saldo: 0, total };
  if (total <= EPS) return { clave: 'cortesia', txt: 'Cortesía', aplicado: ap, saldo: 0, total }; // total $0: nunca queda pendiente
  const saldo = r2(total - ap);
  if (saldo <= EPS) return { clave: 'pagado', txt: 'Pagado', aplicado: ap, saldo: 0, total };
  if (ap > EPS) return { clave: 'parcial', txt: 'Parcial', aplicado: ap, saldo, total };
  return { clave: 'pendiente', txt: 'Pendiente', aplicado: 0, saldo, total };
}
function badgePago(e) {
  if (!e) return '<small>—</small>';
  const k = { pagado: 'ok', parcial: 'par', pendiente: 'rev' }[e.clave] || 'cn';
  return `<span class="est ${k}">${esc(e.txt)}</span>${e.clave === 'parcial' ? `<br><small>Pagado ${usd(e.aplicado)}</small>` : ''}${e.saldo > EPS ? `<br><small>Saldo ${usd(e.saldo)}</small>` : ''}`;
}
const pagadorDeCliente = (cliente, tar) => (tar.mapa[cliente] && tar.mapa[cliente].pagador) || cliente;
const pagadorDe = (c, tar) => String(c.Pagador || '').trim() || pagadorDeCliente(c.Cliente, tar);

function pendientes(todos, d, tar) {
  return todos.map(c => ({ c, e: estadoCobro(c, d) })).filter(x => x.e && x.e.saldo > EPS)
    .sort((a, b) => a.c._fecha.localeCompare(b.c._fecha) || a.c.Cliente.localeCompare(b.c.Cliente))
    .map(({ c, e }) => ({ id: c.ID_Cobro, fecha: c._fecha, cliente: c.Cliente, pagador: pagadorDe(c, tar), total: c._total, saldo: e.saldo }));
}

// ---------- reglas de reparto ----------
function validarAplic(aplic, d, todos, maximo) {
  const lista = [], vistos = new Set();
  let suma = 0;
  for (const a of Array.isArray(aplic) ? aplic : []) {
    const v = r2(numero(a.valor));
    if (!(v > 0)) continue; // las filas en cero se ignoran
    const id = String(a.idCobro || '').trim();
    if (vistos.has(id)) return { error: 'Un servicio aparece dos veces en el reparto.' };
    vistos.add(id);
    const c = todos.find(x => x.ID_Cobro === id);
    if (!c) return { error: 'Servicio no encontrado: ' + id };
    const e = estadoCobro(c, d);
    if (!e || e.saldo <= EPS) return { error: `${c.Cliente} ${c._fecha} no tiene saldo pendiente.` };
    if (v > e.saldo + EPS) return { error: `${c.Cliente} ${c._fecha}: aplicas ${usd(v)} y el saldo es ${usd(e.saldo)}.` };
    suma = r2(suma + v); lista.push({ idCobro: id, valor: v });
  }
  if (suma > maximo + EPS) return { error: `Lo aplicado (${usd(suma)}) supera el pago (${usd(maximo)}).` };
  return { lista, suma };
}

// ---------- acciones ----------
function registrarPago(b, admin) {
  return enCola(async () => {
    const hoy = hoyFlorida();
    const tipo = [TIPO_SERV, TIPO_OTRO].includes(b.tipo) ? b.tipo : null;
    if (!tipo) return err('Tipo de ingreso no válido.');
    const valor = r2(numero(b.valor));
    if (!(valor > 0)) return err('El valor debe ser mayor que 0.');
    const pagador = String(b.pagador || '').trim();
    if (pagador.length < 2) return err('Escribe quién entrega el dinero (pagador).');
    const recibido = String(b.fechaRecibido || '').trim();
    if (!fechaValida(recibido) || recibido > hoy) return err('La fecha de recibido no es válida (no puede ser futura).');
    const metodo = String(b.metodo || '').trim();
    if (!METODOS.includes(metodo)) return err('Elige el método de pago.');

    let cuenta = String(b.cuenta || '').trim();
    if (!cuenta && metodo === 'Efectivo') cuenta = EFECTIVO_MANO;
    if (!CUENTAS.includes(cuenta)) return err(metodo === 'Venmo' ? 'Indica a qué cuenta se trasladó el Venmo.' : 'Elige la cuenta destino.');
    if (cuenta === EFECTIVO_MANO && (metodo === 'Venmo' || metodo === 'Zelle')) return err(`Un pago por ${metodo} entra a una cuenta, no queda "en mano".`);
    const banco = String(b.fechaBanco || '').trim();
    if (banco) {
      if (!fechaValida(banco) || banco > hoy) return err('La fecha de banco no es válida (no puede ser futura).');
      if (banco < recibido) return err('La fecha de banco no puede ser anterior a la fecha de recibido.');
      if (cuenta === EFECTIVO_MANO) return err('Si ya está en el banco, elige la cuenta donde entró (no "Efectivo en mano").');
    }
    let venmoId = '', venmoFecha = '';
    if (metodo === 'Venmo') {
      venmoId = String(b.venmoId || '').trim();
      if (venmoId.length < 4) return err('El código de transacción de Venmo es obligatorio.');
      venmoFecha = String(b.venmoFecha || '').trim();
      if (!fechaValida(venmoFecha) || venmoFecha > hoy) return err('La fecha del Venmo no es válida.');
    }
    const referencia = (metodo === 'Cheque' || metodo === 'Zelle') ? String(b.referencia || '').trim() : '';
    const concepto = String(b.concepto || '').trim();
    let categoria = '', cliente = '';
    if (tipo === TIPO_OTRO) {
      if (concepto.length < 3) return err('El concepto es obligatorio para otros ingresos (mínimo 3 caracteres).');
      categoria = String(b.categoria || '').trim();
      if (!CATEGORIAS.includes(categoria)) return err('Elige la categoría del ingreso.');
      cliente = String(b.cliente || '').trim();
      if (Array.isArray(b.aplicaciones) && b.aplicaciones.some(a => numero(a.valor) > 0)) return err('Un ingreso que no es de servicios no se aplica a servicios.');
    }

    const [d, ctx] = await Promise.all([datos(true), contextoCobros(true)]);
    if (venmoId) {
      const rep = d.pagos.find(p => p.Estado === 'Activo' && p.Venmo_ID && normId(p.Venmo_ID) === normId(venmoId));
      if (rep) return err(`Ese código de Venmo ya está registrado en ${rep.ID_Pago}.`);
    }
    let lista = [], suma = 0;
    if (tipo === TIPO_SERV) {
      const v = validarAplic(b.aplicaciones, d, ctx.todos, valor);
      if (v.error) return err(v.error);
      lista = v.lista; suma = v.suma;
    }
    const pref = 'PAG-' + hoy.replace(/-/g, '') + '-';
    let mx = 0;
    d.pagos.forEach(p => { const m = String(p.ID_Pago).match(/^PAG-\d{8}-(\d+)$/); if (m && String(p.ID_Pago).startsWith(pref)) mx = Math.max(mx, +m[1]); });
    const id = pref + String(mx + 1).padStart(2, '0');

    await agregarFila('PAGOS', aFila(d.pagos.h, {
      ID_Pago: id, Tipo: tipo, Pagador: pagador, Cliente: cliente, Categoria: categoria, Concepto: concepto, Valor: valor, Fecha_Recibido: recibido, Fecha_Banco: banco,
      Metodo: metodo, Cuenta_Destino: cuenta, Venmo_ID: texto(venmoId), Venmo_Fecha: venmoFecha, Referencia: texto(referencia), Estado: 'Activo',
      Registrado_Por: admin, Fecha_Registro: ahora(),
    }));
    if (lista.length) await agregarFilas('PAGOS_APLICACION', lista.map(x => aFila(d.apl.h, { ID_Pago: id, ID_Cobro: x.idCobro, Valor_Aplicado: x.valor, Registrado_Por: admin, Fecha_Registro: ahora() })));
    await bit(id, 'Pago', `${tipo} ${usd(valor)} · ${metodo} · ${cuenta} · ${pagador}${tipo === TIPO_SERV ? ` · aplicado ${usd(suma)} en ${lista.length} servicio(s)` : ` · ${categoria}`}`, concepto, admin);
    return { ok: true, id };
  });
}

function aplicarSaldo({ idPago, aplicaciones }, admin) {
  return enCola(async () => {
    const [d, ctx] = await Promise.all([datos(true), contextoCobros(true)]);
    const p = d.pagos.find(x => x.ID_Pago === String(idPago || '').trim());
    if (!p) return err('Pago no encontrado.');
    if (p.Estado !== 'Activo') return err('El pago está anulado.');
    if (p.Tipo !== TIPO_SERV) return err('Solo los pagos de servicios se aplican a servicios.');
    const libre = r2((numero(p.Valor) || 0) - (d.porPago[p.ID_Pago] || 0));
    if (libre <= EPS) return err('Este pago no tiene saldo disponible.');
    const v = validarAplic(aplicaciones, d, ctx.todos, libre);
    if (v.error) return err(v.error);
    if (!v.lista.length) return err('Elige al menos un servicio.');
    await agregarFilas('PAGOS_APLICACION', v.lista.map(x => aFila(d.apl.h, { ID_Pago: p.ID_Pago, ID_Cobro: x.idCobro, Valor_Aplicado: x.valor, Registrado_Por: admin, Fecha_Registro: ahora() })));
    await bit(p.ID_Pago, 'Aplicar saldo', `${usd(v.suma)} en ${v.lista.length} servicio(s); quedan ${usd(r2(libre - v.suma))} a favor`, '', admin);
    return { ok: true };
  });
}

function anularPago({ id, motivo }, admin) {
  return enCola(async () => {
    if (!motivoOk(motivo)) return err('El motivo es obligatorio (mínimo 3 caracteres).');
    const d = await datos(true);
    const p = d.pagos.find(x => x.ID_Pago === String(id || '').trim());
    if (!p) return err('Pago no encontrado.');
    if (p.Estado !== 'Activo') return err('El pago ya estaba anulado.');
    await poner('PAGOS', d.pagos, p, { Estado: 'Anulado', Motivo_Anulacion: String(motivo).trim(), Anulado_Por: admin, Fecha_Anulacion: ahora() });
    await bit(p.ID_Pago, 'Anular pago', `${usd(numero(p.Valor) || 0)} · ${p.Pagador}; sus servicios vuelven a quedar pendientes`, motivo, admin);
    return { ok: true };
  });
}

// Efectivo/cheque llegan "por depositar" (Fecha_Banco vacía); aquí se registra cuándo y dónde entraron al banco
function marcarDeposito({ id, fechaBanco, cuenta }, admin) {
  return enCola(async () => {
    const d = await datos(true);
    const p = d.pagos.find(x => x.ID_Pago === String(id || '').trim());
    if (!p) return err('Pago no encontrado.');
    if (p.Estado !== 'Activo') return err('El pago está anulado.');
    const f = String(fechaBanco || '').trim();
    if (!fechaValida(f) || f > hoyFlorida()) return err('La fecha de banco no es válida (no puede ser futura).');
    if (f < normalizarFecha(p.Fecha_Recibido)) return err('La fecha de banco no puede ser anterior a la fecha de recibido.');
    const cta = String(cuenta || '').trim() || p.Cuenta_Destino;
    if (!CUENTAS.includes(cta) || cta === EFECTIVO_MANO) return err('Elige la cuenta bancaria donde entró el dinero.');
    await poner('PAGOS', d.pagos, p, { Fecha_Banco: f, Cuenta_Destino: cta });
    await bit(p.ID_Pago, 'Depositado', `Fecha banco ${f} · ${cta}` + (p.Cuenta_Destino !== cta ? ` (antes ${p.Cuenta_Destino})` : ''), '', admin);
    return { ok: true };
  });
}

// Para la agenda: pagos aplicados al cobro de un cliente en una fecha
async function aplicadoServicio(cliente, fecha) {
  const lista = await cargarTabla('COBROS_SERVICIO', CS_H, true);
  const c = lista.find(x => x.Clave === `${cliente}|${fecha}`);
  return c ? aplicadoDe(c.ID_Cobro) : 0;
}

// ---------- piezas de pantalla ----------
const CSS_PAGOS = `.est.par{background:#fde68a;}
#pgDlg{max-width:780px;width:94%;} #pgDlg .pgGrid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px;}
#pgDlg input[type=checkbox]{width:auto;} #pgDlg table input[type=number]{width:90px;padding:4px;}
#acDlg{max-width:360px;} .pgNota{font-size:12px;color:#777;margin:4px 0;}
@media(max-width:700px){#pgDlg .pgGrid{grid-template-columns:1fr;}}`;

const opt = (arr, sel) => arr.map(o => `<option${o === sel ? ' selected' : ''}>${esc(o)}</option>`).join('');

const SCRIPT_PAGOS = String.raw`
var pgModo='nuevo',pgIdPago='',pgTipo='Servicios',pgLibre=0,pgRows=[],pgAcc='',pgAccId='';
function pgE(i){return document.getElementById(i);}
function pgN(v){var n=parseFloat(String(v).replace(',','.'));return isNaN(n)?0:Math.round(n*100)/100;}
function pgUsd(n){return '$'+(Math.round(n*100)/100).toFixed(2);}
function pgEsc(t){return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function pgPost(url,data,errId){fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(function(r){return r.json();}).then(function(j){if(j.ok){location.reload();}else{pgE(errId).textContent=j.general||'Error';}}).catch(function(){pgE(errId).textContent='Error de conexión';});}
function pgValorActual(){return pgModo==='aplicar'?pgLibre:pgN(pgE('pgValor').value);}
function pgReset(){
 ['pgValor','pgBanco','pgVenmoId','pgVenmoF','pgRef','pgConc','pgCli'].forEach(function(i){pgE(i).value='';});
 pgE('pgRecibido').value=PGD.hoy;pgE('pgMetodo').selectedIndex=0;pgE('pgCuenta').value='';pgE('pgCat').selectedIndex=0;
 pgE('pgTodos').checked=false;pgE('pgErr').textContent='';pgE('pgPagador').readOnly=false;pgE('pgSub').textContent='';}
function pgMetodoCambio(){var m=pgE('pgMetodo').value,c=pgE('pgCuenta');
 if(m==='Efectivo'&&c.value==='')c.value='Efectivo en mano';
 if((m==='Venmo'||m==='Zelle')&&c.value==='Efectivo en mano')c.value='';
 pgMostrar();}
function pgMostrar(){
 var ap=pgModo==='aplicar',otro=pgTipo==='Otro ingreso',m=pgE('pgMetodo').value;
 pgE('pgTit').textContent=ap?'Aplicar saldo a favor':(otro?'Registrar otro ingreso':'Registrar pago de servicios');
 pgE('pgCampos').style.display=ap?'none':'block';
 pgE('pgOtro').style.display=otro?'block':'none';
 pgE('pgServ').style.display=otro?'none':'block';
 pgE('pgVenmo').style.display=m==='Venmo'?'grid':'none';
 pgE('pgRefW').style.display=(m==='Cheque'||m==='Zelle')?'block':'none';
 pgE('pgRefL').textContent=m==='Cheque'?'N.º de cheque':'Confirmación Zelle (opcional)';
 pgE('pgConcL').textContent=otro?'Concepto (obligatorio)':'Nota (opcional)';
 pgE('pgPagador').readOnly=ap;}
function pgAbrir(tipo,pagador){pgModo='nuevo';pgIdPago='';pgTipo=tipo;pgReset();pgE('pgPagador').value=pagador||'';pgMetodoCambio();pgListar();pgE('pgDlg').showModal();}
function pgAplicarSaldo(id){var p=null;for(var i=0;i<PGD.libres.length;i++){if(PGD.libres[i].id===id)p=PGD.libres[i];}
 if(!p)return;pgModo='aplicar';pgIdPago=id;pgTipo='Servicios';pgReset();pgLibre=p.libre;pgE('pgPagador').value=p.pagador;
 pgE('pgSub').textContent='Pago '+id+' · saldo disponible '+pgUsd(p.libre);pgMostrar();pgListar();pgE('pgDlg').showModal();}
function pgListar(){
 var pag=pgE('pgPagador').value.trim().toLowerCase(),todos=pgE('pgTodos').checked,h='';pgRows=[];
 for(var i=0;i<PGD.pend.length;i++){var c=PGD.pend[i];if(todos||!pag||c.pagador.toLowerCase()===pag)pgRows.push(c);}
 for(var j=0;j<pgRows.length;j++){var r=pgRows[j];
  h+='<tr><td><input type="checkbox" id="pgC'+j+'" onchange="pgMarca('+j+')"></td><td>'+pgEsc(r.fecha)+'</td><td>'+pgEsc(r.cliente)+(r.pagador!==r.cliente?'<br><small>Paga: '+pgEsc(r.pagador)+'</small>':'')+'</td><td class="num">'+pgUsd(r.total)+'</td><td class="num">'+pgUsd(r.saldo)+'</td><td><input type="number" min="0" step="0.01" id="pgA'+j+'" oninput="pgTot()"></td></tr>';}
 pgE('pgLista').innerHTML=h||'<tr><td colspan="6" style="text-align:center;color:#888;padding:12px;">No hay servicios pendientes para este pagador. Lo que no se aplique queda como saldo a favor.</td></tr>';
 pgRepartir();}
function pgRepartir(){var rest=pgValorActual();
 for(var j=0;j<pgRows.length;j++){var a=Math.max(0,Math.round(Math.min(pgRows[j].saldo,rest)*100)/100);
  pgE('pgA'+j).value=a>0?a.toFixed(2):'';pgE('pgC'+j).checked=a>0;rest=Math.round((rest-a)*100)/100;}
 pgTot();}
function pgMarca(j){
 if(!pgE('pgC'+j).checked){pgE('pgA'+j).value='';pgTot();return;}
 var otros=0;for(var k=0;k<pgRows.length;k++){if(k!==j)otros+=pgN(pgE('pgA'+k).value);}
 var rest=Math.round((pgValorActual()-otros)*100)/100,a=Math.round(Math.min(pgRows[j].saldo,rest)*100)/100;
 pgE('pgA'+j).value=(a>0?a:pgRows[j].saldo).toFixed(2);pgTot();}
function pgTot(){var s=0;
 for(var j=0;j<pgRows.length;j++){var x=pgN(pgE('pgA'+j).value);pgE('pgC'+j).checked=x>0;s+=x;}
 s=Math.round(s*100)/100;var v=pgValorActual(),libre=Math.round((v-s)*100)/100,t=pgE('pgTot');
 t.textContent='Aplicado '+pgUsd(s)+' de '+pgUsd(v)+(libre>0?' · quedarán '+pgUsd(libre)+' como saldo a favor':'')+(libre<0?' · te pasas por '+pgUsd(-libre):'');
 t.style.color=libre<0?'#b91c1c':'#444';return s;}
function pgGuardar(){
 var e=pgE('pgErr');e.textContent='';var ap=[];
 for(var j=0;j<pgRows.length;j++){var a=pgN(pgE('pgA'+j).value);if(a>0)ap.push({idCobro:pgRows[j].id,valor:a});}
 var s=pgTot(),v=pgValorActual();
 if(pgTipo==='Servicios'&&s>v+0.004){e.textContent='Lo aplicado supera el valor del pago.';return;}
 if(pgModo==='aplicar'){if(!ap.length){e.textContent='Elige al menos un servicio.';return;}pgPost('/cartera/pagos/aplicar',{idPago:pgIdPago,aplicaciones:ap},'pgErr');return;}
 pgPost('/cartera/pagos/registrar',{tipo:pgTipo,pagador:pgE('pgPagador').value,valor:pgE('pgValor').value,fechaRecibido:pgE('pgRecibido').value,fechaBanco:pgE('pgBanco').value,
  metodo:pgE('pgMetodo').value,cuenta:pgE('pgCuenta').value,venmoId:pgE('pgVenmoId').value,venmoFecha:pgE('pgVenmoF').value,referencia:pgE('pgRef').value,
  concepto:pgE('pgConc').value,categoria:pgE('pgCat').value,cliente:pgE('pgCli').value,aplicaciones:pgTipo==='Servicios'?ap:[]},'pgErr');}
function pgAccion(b){pgAcc=b.dataset.acc;pgAccId=b.dataset.id;pgE('acT').textContent=b.dataset.t;pgE('acMotivo').value='';pgE('acFecha').value=PGD.hoy;
 pgE('acCuenta').value=b.dataset.cuenta||'';pgE('acErr').textContent='';var dep=pgAcc==='deposito';
 pgE('acMW').style.display=dep?'none':'block';pgE('acFW').style.display=dep?'block':'none';pgE('acCW').style.display=dep?'block':'none';pgE('acDlg').showModal();}
function pgAccionOk(){
 if(pgAcc==='anular'){var m=pgE('acMotivo').value.trim();if(m.length<3){pgE('acErr').textContent='El motivo es obligatorio.';return;}pgPost('/cartera/pagos/anular',{id:pgAccId,motivo:m},'acErr');return;}
 if(!pgE('acFecha').value){pgE('acErr').textContent='Escribe la fecha en que entró al banco.';return;}
 pgPost('/cartera/pagos/deposito',{id:pgAccId,fechaBanco:pgE('acFecha').value,cuenta:pgE('acCuenta').value},'acErr');}
`;

// Diálogos de pago (registrar / aplicar saldo / anular / depositado) con los datos que necesitan
function dialogoPago(todos, d, tar) {
  const pagadores = [...new Set([...Object.entries(tar.mapa).map(([c, t]) => t.pagador || c), ...d.pagos.map(p => p.Pagador).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
  const data = {
    hoy: hoyFlorida(), pend: pendientes(todos, d, tar),
    libres: d.libres.map(p => ({ id: p.ID_Pago, pagador: p.Pagador, libre: p._libre })),
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<datalist id="pgLstPag">${pagadores.map(p => `<option value="${esc(p)}">`).join('')}</datalist>
<datalist id="pgLstCli">${Object.keys(tar.mapa).sort().map(c => `<option value="${esc(c)}">`).join('')}</datalist>
<dialog id="pgDlg"><h3 id="pgTit" style="margin-top:0;">Registrar pago</h3><p id="pgSub" class="pgNota"></p>
  <label>Pagador (quien entrega el dinero)<input type="text" id="pgPagador" list="pgLstPag" autocomplete="off" oninput="pgListar()"></label>
  <div id="pgCampos">
    <div class="pgGrid">
      <label>Valor recibido, neto (USD)<input type="number" id="pgValor" min="0" step="0.01" oninput="pgRepartir()"></label>
      <label>Fecha recibido<input type="date" id="pgRecibido"></label>
      <label>Método<select id="pgMetodo" onchange="pgMetodoCambio()">${opt(METODOS)}</select></label>
      <label>Cuenta destino<select id="pgCuenta"><option value="">— elegir —</option>${opt(CUENTAS)}</select></label>
      <label>Fecha en banco (vacía = por depositar)<input type="date" id="pgBanco"></label>
      <label id="pgRefW"><span id="pgRefL">N.º de cheque</span><input type="text" id="pgRef" maxlength="60"></label>
    </div>
    <div id="pgVenmo" class="pgGrid"><label>Código de transacción de Venmo<input type="text" id="pgVenmoId" maxlength="60"></label><label>Fecha del Venmo<input type="date" id="pgVenmoF"></label></div>
    <div id="pgOtro"><div class="pgGrid"><label>Categoría<select id="pgCat">${opt(CATEGORIAS)}</select></label><label>Cliente relacionado (opcional)<input type="text" id="pgCli" list="pgLstCli" autocomplete="off"></label></div></div>
    <label><span id="pgConcL">Nota (opcional)</span><input type="text" id="pgConc" maxlength="200"></label>
  </div>
  <div id="pgServ"><label style="display:block;"><input type="checkbox" id="pgTodos" onchange="pgListar()"> Mostrar servicios de todos los pagadores</label>
    <div class="scroll" style="max-height:230px;"><table><tr><th></th><th>Fecha</th><th>Servicio</th><th class="num">Total</th><th class="num">Saldo</th><th>Aplicar</th></tr><tbody id="pgLista"></tbody></table></div>
    <p id="pgTot" style="font-size:13px;margin:6px 0;"></p><button class="btn mini" onclick="pgRepartir()">Repartir automático</button>
    <p class="pgNota">Lo que no se aplique queda como saldo a favor del pagador y se puede aplicar después a servicios nuevos.</p></div>
  <p id="pgErr" style="color:#b91c1c;font-size:13px;"></p>
  <button class="btn hoy" onclick="pgGuardar()">Guardar</button> <button class="btn" onclick="pgE('pgDlg').close()">Cancelar</button></dialog>
<dialog id="acDlg"><h3 id="acT" style="margin-top:0;"></h3>
  <label id="acMW">Motivo (obligatorio)<input type="text" id="acMotivo" maxlength="200"></label>
  <label id="acFW">Fecha en que entró al banco<input type="date" id="acFecha"></label>
  <label id="acCW">Cuenta donde entró<select id="acCuenta"><option value="">— elegir —</option>${opt(CUENTAS.filter(c => c !== EFECTIVO_MANO))}</select></label>
  <p id="acErr" style="color:#b91c1c;font-size:13px;"></p>
  <button class="btn hoy" onclick="pgAccionOk()">Guardar</button> <button class="btn" onclick="pgE('acDlg').close()">Cancelar</button></dialog>
<script>var PGD=${json};${SCRIPT_PAGOS}</script>`;
}

const botonesPago = (cliente, tar) => `<button class="btn hoy" data-p="${esc(pagadorDeCliente(cliente, tar))}" onclick="pgAbrir('Servicios',this.dataset.p)">Registrar pago</button>`;

function tablaPagos(lista, d, cobMap) {
  const filas = lista.map(p => {
    const act = p.Estado === 'Activo', v = numero(p.Valor) || 0;
    const aplicado = act ? (d.porPago[p.ID_Pago] || 0) : 0;
    const libre = act && p.Tipo === TIPO_SERV ? r2(v - aplicado) : 0;
    const quien = p.Tipo === TIPO_OTRO
      ? `<b>${esc(p.Categoria)}</b>: ${esc(p.Concepto)}<br><small>De: ${esc(p.Pagador)}${p.Cliente ? ' · Cliente: ' + esc(p.Cliente) : ''}</small>`
      : `<b>${esc(p.Pagador)}</b>${p.Concepto ? `<br><small>${esc(p.Concepto)}</small>` : ''}`;
    const metodo = `<span class="mp ${esc(kp(p.Metodo))}" style="margin-left:0;">${esc(p.Metodo)}</span><br><small>${esc(p.Cuenta_Destino)}${p.Venmo_ID ? `<br>Venmo ${esc(p.Venmo_ID)} · ${esc(normalizarFecha(p.Venmo_Fecha))}` : ''}${p.Referencia ? `<br>Ref. ${esc(p.Referencia)}` : ''}</small>`;
    const banco = normalizarFecha(p.Fecha_Banco);
    const bancoTxt = banco ? esc(banco) : (act ? '<span class="est rev">Por depositar</span>' : '<small>—</small>');
    const apps = d.apl.filter(a => a.ID_Pago === p.ID_Pago).map(a => {
      const c = cobMap.get(a.ID_Cobro);
      return `<div><small>${c ? esc(c._fecha + ' · ' + c.Cliente) : esc(a.ID_Cobro)}: ${usd(numero(a.Valor_Aplicado) || 0)}</small></div>`;
    }).join('');
    const aplTxt = p.Tipo === TIPO_OTRO ? '<small>No ligado a servicios</small>' : (apps || '<small>Sin aplicar</small>') + (libre > EPS ? `<div><small class="neg">Saldo a favor ${usd(libre)}</small></div>` : '');
    const b = (accion, txt) => `<button class="btn mini" data-acc="${accion}" data-id="${esc(p.ID_Pago)}" data-cuenta="${esc(p.Cuenta_Destino)}" data-t="${esc((accion === 'anular' ? 'Anular pago ' : 'Pago ') + p.ID_Pago + ' · ' + p.Pagador)}" onclick="pgAccion(this)">${txt}</button>`;
    let acc = '';
    if (act) {
      if (libre > EPS) acc += `<button class="btn mini" onclick="pgAplicarSaldo('${esc(p.ID_Pago)}')">Aplicar saldo</button>`;
      if (!banco) acc += b('deposito', 'Depositado');
      acc += b('anular', 'Anular');
    } else acc = `<small>Anulado por ${esc(p.Anulado_Por)}: ${esc(p.Motivo_Anulacion)}</small>`;
    return `<tr${act ? '' : ' class="anu"'}><td>${esc(normalizarFecha(p.Fecha_Recibido))}<br><small>${esc(p.ID_Pago)}</small></td><td>${quien}</td><td>${metodo}</td>
      <td class="num"><b>${usd(v)}</b></td><td>${bancoTxt}</td><td>${aplTxt}</td><td><span class="est ${act ? 'ok' : 'cn'}">${esc(p.Estado)}</span><br>${acc}</td></tr>`;
  }).join('') || '<tr><td colspan="7" style="text-align:center;color:#888;padding:20px;">No hay pagos para este filtro.</td></tr>';
  return `<div class="scroll g"><table><tr><th>Recibido</th><th>Pagador / concepto</th><th>Método y cuenta</th><th class="num">Valor</th><th>Banco</th><th>Aplicado a</th><th>Estado</th></tr>${filas}</table></div>`;
}

// Bloque para la página del cliente: saldo a favor, historial de pagos y diálogos
function seccionCliente(cliente, todos, d, tar) {
  const pagador = pagadorDeCliente(cliente, tar);
  const ids = new Set(todos.filter(c => c.Cliente === cliente).map(c => c.ID_Cobro));
  const cobMap = new Map(todos.map(c => [c.ID_Cobro, c]));
  const lista = d.pagos.filter(p => p.ID_Pago && (kp(p.Pagador) === kp(pagador) || kp(p.Cliente) === kp(cliente) || d.apl.some(a => a.ID_Pago === p.ID_Pago && ids.has(a.ID_Cobro))))
    .sort((a, b) => normalizarFecha(b.Fecha_Recibido).localeCompare(normalizarFecha(a.Fecha_Recibido)) || String(b.ID_Pago).localeCompare(String(a.ID_Pago))).slice(0, 100);
  const libres = d.libres.filter(p => kp(p.Pagador) === kp(pagador));
  const pend = pendientes(todos, d, tar).filter(x => kp(x.pagador) === kp(pagador));
  const aviso = libres.length ? `<div class="aviso y">Saldo a favor de <b>${esc(pagador)}</b>: <b>${usd(r2(libres.reduce((a, p) => a + p._libre, 0)))}</b>${pend.length
    ? ` · tiene ${pend.length} servicio(s) pendientes. ${libres.map(p => `<button class="btn mini" onclick="pgAplicarSaldo('${esc(p.ID_Pago)}')">Aplicar ${usd(p._libre)} (${esc(p.ID_Pago)})</button>`).join(' ')}` : ''}</div>` : '';
  return `${aviso}<h3 style="margin:18px 0 8px;">Pagos de ${esc(pagador)}</h3>${tablaPagos(lista, d, cobMap)}${dialogoPago(todos, d, tar)}`;
}

async function paginaPagos(query, admin) {
  const hoy = hoyFlorida();
  const mes = query.mes === 'todo' ? 'todo' : (mesValido(query.mes) ? query.mes : hoy.slice(0, 7));
  const [d, ctx] = await Promise.all([datos(), contextoCobros()]);
  const cobMap = new Map(ctx.todos.map(c => [c.ID_Cobro, c]));
  const fMet = METODOS.includes(query.metodo) ? query.metodo : '';
  const fCta = CUENTAS.includes(query.cuenta) ? query.cuenta : '';
  const fTipo = [TIPO_SERV, TIPO_OTRO].includes(query.tipo) ? query.tipo : '';
  const fEst = ['Activo', 'Anulado', 'Por depositar'].includes(query.estado) ? query.estado : '';
  const vis = d.pagos.filter(p => p.ID_Pago).filter(p => {
    const f = normalizarFecha(p.Fecha_Recibido);
    return (mes === 'todo' || f.startsWith(mes)) && (!fMet || p.Metodo === fMet) && (!fCta || p.Cuenta_Destino === fCta) && (!fTipo || p.Tipo === fTipo)
      && (!fEst || (fEst === 'Por depositar' ? (p.Estado === 'Activo' && !normalizarFecha(p.Fecha_Banco)) : p.Estado === fEst));
  }).sort((a, b) => normalizarFecha(b.Fecha_Recibido).localeCompare(normalizarFecha(a.Fecha_Recibido)) || String(b.ID_Pago).localeCompare(String(a.ID_Pago)));
  const act = vis.filter(p => p.Estado === 'Activo');
  const suma = l => r2(l.reduce((a, p) => a + (numero(p.Valor) || 0), 0));
  const porDep = act.filter(p => !normalizarFecha(p.Fecha_Banco));
  const serv = act.filter(p => p.Tipo === TIPO_SERV), otros = act.filter(p => p.Tipo === TIPO_OTRO);
  const libreTot = r2(serv.reduce((a, p) => a + Math.max(0, (numero(p.Valor) || 0) - (d.porPago[p.ID_Pago] || 0)), 0));
  const u = o => '/cartera/pagos?' + Object.entries({ mes, metodo: fMet, cuenta: fCta, estado: fEst, tipo: fTipo, ...o }).filter(([, v]) => v).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const sel = (n, et, ops, act2) => `<select name="${n}"><option value="">${et}</option>${ops.map(o => `<option value="${esc(o)}"${act2 === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  const etiqueta = mes === 'todo' ? 'Todo el histórico' : mes;
  const nav = mes === 'todo' ? '' : `<a class="btn" href="${esc(u({ mes: sumarMes(mes, -1) }))}">←</a><a class="btn hoy" href="${esc(u({ mes: hoy.slice(0, 7) }))}">Este mes</a><a class="btn" href="${esc(u({ mes: sumarMes(mes, 1) }))}">→</a>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pagos ${esc(etiqueta)}</title><style>${CSS}${CSS_PAGOS}${menu.MENU_CSS}</style></head><body>
<div class="top"><h2 style="margin:0;">Pagos e ingresos — ${esc(etiqueta)}</h2>${menu.menuHtml('/cartera', admin)}</div>
<div class="nav"><a class="btn" href="/cartera">← Cartera</a>${nav}
  <a class="btn" href="${esc(u({ mes: mes === 'todo' ? hoy.slice(0, 7) : 'todo' }))}">${mes === 'todo' ? 'Ver por mes' : 'Ver todo el histórico'}</a>
  <button class="btn hoy" onclick="pgAbrir('Servicios','')">Registrar pago</button><button class="btn hoy" onclick="pgAbrir('Otro ingreso','')">Otro ingreso</button></div>
<div class="aviso" style="background:#f0fdf4;">Activos en el filtro: <b>${act.length}</b> · <b>${usd(suma(act))}</b> (servicios ${usd(suma(serv))} · otros ingresos ${usd(suma(otros))}) · por depositar <b>${usd(suma(porDep))}</b> (${porDep.length}) · saldo a favor sin aplicar <b>${usd(libreTot)}</b></div>
<form class="filtros" method="GET" action="/cartera/pagos"><input type="hidden" name="mes" value="${esc(mes)}">
  ${sel('tipo', 'Todos los tipos', [TIPO_SERV, TIPO_OTRO], fTipo)}${sel('metodo', 'Todos los métodos', METODOS, fMet)}${sel('cuenta', 'Todas las cuentas', CUENTAS, fCta)}${sel('estado', 'Todos los estados', ['Activo', 'Anulado', 'Por depositar'], fEst)}
  <button class="btn">Filtrar</button> <a class="btn" href="${esc(u({ metodo: '', cuenta: '', estado: '', tipo: '' }))}">Limpiar</a></form>
${tablaPagos(vis, d, cobMap)}
${dialogoPago(ctx.todos, d, ctx.tar)}
</body></html>`;
}

// ---------- rutas ----------
function rutas(app, auth) {
  const api = (ruta, fn) => app.post(ruta, auth.requiereAdmin, async (req, res) => {
    try { res.json(await fn(req.body || {}, req.admin)); }
    catch (e) { console.error('Error en POST ' + ruta, e); res.status(500).json({ ok: false, general: 'Error: ' + e.message }); }
  });
  app.get('/cartera/pagos', auth.requiereAdmin, async (req, res) => {
    try { res.set('Content-Type', 'text/html; charset=utf-8'); res.send(await paginaPagos(req.query, req.admin)); }
    catch (e) { console.error('Error en GET /cartera/pagos:', e); res.status(500).send('Error cargando los pagos: ' + e.message); }
  });
  api('/cartera/pagos/registrar', (b, a) => registrarPago(b, a));
  api('/cartera/pagos/aplicar', (b, a) => aplicarSaldo(b, a));
  api('/cartera/pagos/anular', (b, a) => anularPago(b, a));
  api('/cartera/pagos/deposito', (b, a) => marcarDeposito(b, a));
}

module.exports = { rutas, aplicadoServicio,datos, estadoCobro, badgePago, aplicadoDe, aplicadoMapa, seccionCliente, botonesPago, pagadorDeCliente, CSS_PAGOS, paginaPagos,
  registrarPago, aplicarSaldo, anularPago, marcarDeposito };
