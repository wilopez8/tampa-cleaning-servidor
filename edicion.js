const { leerHoja, agregarFilas, actualizarCeldas } = require('./sheets');
const { normalizarFecha, fechaValida, hoyFlorida } = require('./agenda');

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const REQUERIDAS = ['ID_Programacion', 'Fecha_Servicio', 'Tipo_Servicio', 'Cliente', 'Empleado', 'Horario', 'Hora_Inicio', 'Hora_Fin',
  'Observaciones_Puntuales', 'Estado_Envio', 'Estado_Confirmacion', 'Creado_Por', 'Fecha_Creacion', 'Modificado_Por',
  'Fecha_Modificacion', 'Cancelado', 'Motivo_Cancelacion'];

const limpio = t => String(t ?? '').trim();
const soloDigitos = t => String(t || '').replace(/\D/g, '');
function normalizarHora(t) { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? m[1].padStart(2, '0') + ':' + m[2] : ''; }
function horarioTexto(i, f) { const q = h => String(parseInt(h.slice(0, 2), 10)) + h.slice(2); return `${q(i)}-${q(f)}`; } // "8:00-12:00"
function ahoraTexto() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

// Escrituras una tras otra: evita que dos guardados simultáneos generen el mismo ID
let cola = Promise.resolve();
function enSerie(fn) { const p = cola.then(fn); cola = p.catch(() => {}); return p; }

// ---------- Datos de apoyo (se leen en vivo de las hojas fuente) ----------
async function maestros(vivo) {
  const o = { cache: !vivo };
  const [cl, si, em] = await Promise.all([leerHoja('CLIENTES', o), leerHoja('SITIOS', o), leerHoja('EMPLEADOS', o)]);
  const clientes = [];
  if (cl.length > 1 && si.length > 1) {
    const hc = cl[0], hs = si[0];
    const g = (h, r, c) => limpio(r[h.indexOf(c)]);
    const sitios = {};
    for (let i = 1; i < si.length; i++) {
      const n = g(hs, si[i], 'Nombre_Cliente');
      if (n && g(hs, si[i], 'Estatus') === 'Activo') sitios[n] = si[i];
    }
    for (let i = 1; i < cl.length; i++) {
      const r = cl[i];
      const n = g(hc, r, 'clientes');
      if (!n || g(hc, r, 'Cliente Vigente/Vencido') !== 'Cliente Vigente' || !sitios[n]) continue;
      const s = sitios[n];
      clientes.push({
        n, dir: g(hc, r, 'Direccion'), maps: g(hc, r, 'Google Maps'), desc: g(hc, r, 'Descripcion_Servicio'), ins: g(hc, r, 'Instrucciones'),
        chk: g(hs, s, 'Checklist_Tareas').split(',').map(t => t.trim()).filter(Boolean),
        coord: isFinite(parseFloat(s[hs.indexOf('Latitud')])) && isFinite(parseFloat(s[hs.indexOf('Longitud')])),
      });
    }
  }
  const empleados = [];
  const he = em[0] || [];
  for (let i = 1; i < em.length; i++) {
    const n = limpio(em[i][he.indexOf('Nombre')]);
    if (!n || limpio(em[i][he.indexOf('Estatus')]) !== 'Activo') continue;
    empleados.push({ n, rol: limpio(em[i][he.indexOf('Rol')]), wa: soloDigitos(em[i][he.indexOf('ID_Telegram')]).length >= 10 });
  }
  clientes.sort((a, b) => a.n.localeCompare(b.n));
  empleados.sort((a, b) => a.n.localeCompare(b.n));
  return { clientes, empleados };
}

async function cargarSheet(vivo) {
  const datos = await leerHoja('PROGRAMACION_DIARIA', { cache: !vivo });
  if (!datos.length) throw new Error('PROGRAMACION_DIARIA está vacía');
  const h = datos[0];
  const falta = REQUERIDAS.filter(n => h.indexOf(n) === -1);
  if (falta.length) throw new Error('Faltan columnas en PROGRAMACION_DIARIA: ' + falta.join(', ') + ' (ejecuta el script de la etapa 1)');
  return { datos, h };
}

function filasDe(datos, h, fecha) {
  const ix = n => h.indexOf(n);
  const g = (r, n) => limpio(r[ix(n)]);
  const out = [];
  for (let i = 1; i < datos.length; i++) {
    const r = datos[i];
    if (normalizarFecha(r[ix('Fecha_Servicio')]) !== fecha) continue;
    out.push({
      _fila: i + 1, id: g(r, 'ID_Programacion'), tipo: g(r, 'Tipo_Servicio') || 'Limpieza', cliente: g(r, 'Cliente'), empleado: g(r, 'Empleado'),
      inicio: normalizarHora(r[ix('Hora_Inicio')]), fin: normalizarHora(r[ix('Hora_Fin')]), obs: g(r, 'Observaciones_Puntuales'),
      envio: g(r, 'Estado_Envio'), cancelado: g(r, 'Cancelado') === 'Sí',
    });
  }
  return out;
}

function maxConsecutivo(datos, h, fecha) {
  const pref = `PRG-${fecha.replace(/-/g, '')}-`;
  const iId = h.indexOf('ID_Programacion');
  let max = 0;
  for (let i = 1; i < datos.length; i++) {
    const id = String(datos[i][iId] || '');
    if (id.startsWith(pref)) max = Math.max(max, parseInt(id.slice(pref.length), 10) || 0);
  }
  return max;
}

// ---------- Validaciones por fila ----------
function validarLote(normal, m, existentes) {
  const editando = new Set(normal.filter(f => f.id).map(f => f.id));
  const otros = existentes.filter(r => !r.cancelado && !editando.has(r.id));
  const cruza = (a, b) => a.inicio && a.fin && b.inicio && b.fin && a.inicio < b.fin && b.inicio < a.fin;

  return normal.map((f, i) => {
    const e = [];
    if (f.id) {
      const ex = existentes.find(r => r.id === f.id);
      if (!ex) e.push('Servicio no encontrado en esta fecha');
      else if (ex.cancelado) e.push('Servicio cancelado: no se puede editar');
      else if (ex.envio === 'Enviado') e.push('Ya fue enviado: los cambios posteriores se habilitan en la etapa 5');
    }
    if (!['Limpieza', 'Inspeccion'].includes(f.tipo)) e.push('Tipo de servicio no válido');

    const cli = m.clientes.find(c => c.n === f.cliente);
    if (!f.cliente) e.push('Falta el cliente');
    else if (!cli) e.push('Cliente no activo (debe ser Vigente en CLIENTES y Activo en SITIOS)');
    else if (!cli.coord) e.push('El cliente no tiene coordenadas en SITIOS');

    const emp = m.empleados.find(x => x.n === f.empleado);
    if (!f.empleado) e.push('Falta el empleado');
    else if (!emp) e.push('Empleado inexistente o inactivo');
    else if (!emp.wa) e.push('El empleado no tiene número de WhatsApp');

    const horasOk = HORA.test(f.inicio) && HORA.test(f.fin);
    if (!horasOk) e.push('Falta la hora de inicio o de fin');
    else if (f.fin <= f.inicio) e.push('La hora de fin debe ser posterior a la de inicio');

    const comparables = otros.concat(normal.slice(0, i));
    if (f.cliente && comparables.some(r => r.cliente === f.cliente && r.tipo === f.tipo)) {
      e.push('Este cliente ya está programado ese día (mismo tipo de servicio)');
    }
    if (f.empleado && horasOk && f.fin > f.inicio) {
      const choque = comparables.find(r => r.empleado === f.empleado && cruza(f, r));
      if (choque) e.push(`Horario cruzado: ${f.empleado} ya tiene ${choque.inicio}–${choque.fin} en ${choque.cliente}`);
    }
    return e;
  });
}

// ---------- Guardar (crear + editar + reasignar) ----------
async function procesarGuardado({ fecha, filas, admin, soloValidar }) {
  if (!fechaValida(fecha)) return { ok: false, general: 'Fecha no válida.' };
  if (fecha < hoyFlorida()) return { ok: false, general: 'Fecha pasada: solo lectura.' };
  if (!Array.isArray(filas) || !filas.length) return { ok: false, general: 'No hay filas para guardar.' };
  if (filas.length > 60) return { ok: false, general: 'Demasiadas filas en una sola operación (máximo 60).' };

  const normal = filas.map(f => ({
    id: limpio(f.id), tipo: limpio(f.tipo) || 'Limpieza', cliente: limpio(f.cliente), empleado: limpio(f.empleado),
    inicio: limpio(f.inicio), fin: limpio(f.fin), obs: limpio(f.obs).slice(0, 500),
  }));

  const trabajo = async () => {
    const vivo = !soloValidar; // al guardar siempre se revalida con datos en vivo
    const m = await maestros(vivo);
    const { datos, h } = await cargarSheet(vivo);
    const existentes = filasDe(datos, h, fecha);
    const errores = validarLote(normal, m, existentes);
    const hay = errores.some(e => e.length);
    if (soloValidar || hay) return { ok: !hay, errores };

    const col = n => h.indexOf(n) + 1;
    const ahora = ahoraTexto();
    const cambios = [], nuevas = [];
    let consecutivo = maxConsecutivo(datos, h, fecha);
    let creados = 0, modificados = 0;

    normal.forEach(f => {
      const horario = horarioTexto(f.inicio, f.fin);
      if (f.id) {
        const ex = existentes.find(r => r.id === f.id);
        const igual = ex.tipo === f.tipo && ex.cliente === f.cliente && ex.empleado === f.empleado &&
                      ex.inicio === f.inicio && ex.fin === f.fin && ex.obs === f.obs;
        if (igual) return;
        const valores = { Tipo_Servicio: f.tipo, Cliente: f.cliente, Empleado: f.empleado, Horario: horario,
                          Hora_Inicio: f.inicio, Hora_Fin: f.fin, Observaciones_Puntuales: f.obs,
                          Modificado_Por: admin, Fecha_Modificacion: ahora };
        Object.keys(valores).forEach(k => cambios.push({ fila: ex._fila, columna: col(k), valor: valores[k] }));
        modificados++;
      } else {
        const id = `PRG-${fecha.replace(/-/g, '')}-${String(++consecutivo).padStart(2, '0')}`;
        const obj = { ID_Programacion: id, Fecha_Servicio: fecha, Tipo_Servicio: f.tipo, Cliente: f.cliente, Empleado: f.empleado,
                      Horario: horario, Hora_Inicio: f.inicio, Hora_Fin: f.fin, Observaciones_Puntuales: f.obs,
                      Estado_Envio: 'Borrador', Estado_Confirmacion: 'Pendiente', Creado_Por: admin, Fecha_Creacion: ahora };
        nuevas.push(h.map(n => (obj[n] === undefined ? '' : obj[n])));
        creados++;
      }
    });

    await agregarFilas('PROGRAMACION_DIARIA', nuevas);
    await actualizarCeldas('PROGRAMACION_DIARIA', cambios);
    return { ok: true, creados, modificados };
  };
  return soloValidar ? trabajo() : enSerie(trabajo);
}

// ---------- Cancelar (nunca se borra la fila) ----------
async function cancelarServicio({ id, motivo, admin }) {
  id = limpio(id); motivo = limpio(motivo);
  if (!id) return { ok: false, general: 'Falta el servicio.' };
  if (motivo.length < 3) return { ok: false, general: 'El motivo de la cancelación es obligatorio.' };
  return enSerie(async () => {
    const { datos, h } = await cargarSheet(true);
    const ix = n => h.indexOf(n);
    for (let i = 1; i < datos.length; i++) {
      const r = datos[i];
      if (limpio(r[ix('ID_Programacion')]) !== id) continue;
      if (normalizarFecha(r[ix('Fecha_Servicio')]) < hoyFlorida()) return { ok: false, general: 'Fecha pasada: solo lectura.' };
      if (limpio(r[ix('Cancelado')]) === 'Sí') return { ok: false, general: 'Este servicio ya estaba cancelado.' };
      if (limpio(r[ix('Estado_Envio')]) === 'Enviado') return { ok: false, general: 'Ya fue enviado: la cancelación con aviso al empleado se habilita en la etapa 5.' };
      const v = { Cancelado: 'Sí', Motivo_Cancelacion: motivo, Modificado_Por: admin, Fecha_Modificacion: ahoraTexto() };
      await actualizarCeldas('PROGRAMACION_DIARIA', Object.keys(v).map(k => ({ fila: i + 1, columna: ix(k) + 1, valor: v[k] })));
      return { ok: true };
    }
    return { ok: false, general: 'Servicio no encontrado.' };
  });
}

// ---------- HTML del editor ----------
const js = o => JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const CSS_EDITOR = `
.editor{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:14px;}
.editor h3{margin:0 0 10px;font-size:16px;} .editor td{padding:6px;vertical-align:top;border-bottom:none;}
.editor select,.editor input[type=text],.editor input[type=time]{padding:6px;border:1px solid #ccc;border-radius:6px;font-size:14px;}
.editor .val{font-size:12px;color:#b91c1c;max-width:280px;} .editor .acc{margin-top:10px;display:flex;gap:10px;align-items:center;}
.guardar{background:#2e7d32;color:#fff;border-color:#2e7d32;} .mal{color:#b91c1c;font-size:13px;} .bien{color:#15803d;font-size:13px;}
.nota{font-size:12px;color:#92400e;}`;

function editorHtml(fecha, m, delDia) {
  const serv = {};
  delDia.filter(r => r._estado !== 'Cancelado' && r.Estado_Envio !== 'Enviado').forEach(r => {
    serv[r.ID_Programacion] = { id: r.ID_Programacion, tipo: r.Tipo_Servicio || 'Limpieza', cliente: r.Cliente, empleado: r.Empleado,
      inicio: normalizarHora(r.Hora_Inicio), fin: normalizarHora(r.Hora_Fin), obs: r.Observaciones_Puntuales };
  });
  return `<section class="editor">
<h3>Programar servicios <small style="font-weight:normal;color:#777;">(se guardan como Borrador)</small></h3>
<table><thead><tr><th>Tipo</th><th>Cliente</th><th>Empleado</th><th>Horario</th><th>Observaciones</th><th>Validación</th><th></th></tr></thead><tbody id="gcuerpo"></tbody></table>
<div class="acc"><button type="button" class="btn" id="gmas">+ Fila</button><button type="button" class="btn guardar" id="gguardar">Guardar borrador</button><span id="gmsg"></span></div>
<div class="bloque" id="gpanel" style="margin-top:10px;"></div>
<script>
(function(){
  var FECHA=${js(fecha)}, M=${js(m)}, SERV=${js(serv)};
  var cuerpo=document.getElementById('gcuerpo'), msg=document.getElementById('gmsg'), panel=document.getElementById('gpanel'), timer=null;
  function el(tag,props){var e=document.createElement(tag);for(var k in props)e[k]=props[k];return e;}
  function selectDe(clase,lista,valor,vacio,etiqueta){
    var s=el('select',{className:clase});
    s.appendChild(el('option',{value:'',textContent:vacio}));
    var hallado=false;
    lista.forEach(function(v){ if(v.n===valor)hallado=true; s.appendChild(el('option',{value:v.n,textContent:etiqueta?etiqueta(v):v.n})); });
    if(valor&&!hallado) s.appendChild(el('option',{value:valor,textContent:valor+' (no activo)'}));
    s.value=valor||''; return s;
  }
  function agregar(d,soloEmp){
    d=d||{};
    var tr=el('tr'); tr.dataset.id=d.id||'';
    function td(hijo){var c=el('td');c.appendChild(hijo);tr.appendChild(c);}
    td(selectDe('t',[{n:'Limpieza'},{n:'Inspeccion'}],d.tipo||'Limpieza','Tipo'));
    td(selectDe('c',M.clientes,d.cliente,'Cliente…',function(v){return v.n+(v.coord?'':' ⚠ sin coordenadas');}));
    td(selectDe('e',M.empleados,d.empleado,'Empleado…',function(v){return v.n+(v.wa?'':' ⚠ sin WhatsApp');}));
    var h=el('td'); h.appendChild(el('input',{type:'time',className:'i',value:d.inicio||''}));
    h.appendChild(document.createTextNode(' – ')); h.appendChild(el('input',{type:'time',className:'f',value:d.fin||''})); tr.appendChild(h);
    td(el('input',{type:'text',className:'o',value:d.obs||'',placeholder:'Observaciones del día',maxLength:500}));
    tr.appendChild(el('td',{className:'val'}));
    var x=el('button',{type:'button',className:'btn',textContent:'✕',title:'Quitar de la grilla (no borra ningún servicio guardado)'});
    x.onclick=function(){tr.remove();programar();}; td(x);
    if(soloEmp){['t','c','i','f','o'].forEach(function(c){tr.querySelector('.'+c).disabled=true;});}
    cuerpo.appendChild(tr); return tr;
  }
  function leer(){
    return Array.prototype.map.call(cuerpo.rows,function(tr){
      var q=function(c){return tr.querySelector('.'+c).value;};
      return {id:tr.dataset.id,tipo:q('t'),cliente:q('c'),empleado:q('e'),inicio:q('i'),fin:q('f'),obs:q('o')};
    });
  }
  function llamar(url,datos){
    return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(datos)})
      .then(function(r){ if(r.status===401){location.href='/login?volver='+encodeURIComponent(location.pathname+location.search);return null;} return r.json(); });
  }
  function pintar(errores){
    Array.prototype.forEach.call(cuerpo.rows,function(tr,i){
      var e=(errores&&errores[i])||[]; tr.querySelector('.val').textContent=e.length?e.join(' · '):'✓';
    });
  }
  function estado(texto,bien){msg.textContent=texto;msg.className=bien?'bien':'mal';}
  function validar(){
    var f=leer(); if(!f.length){estado('',true);return;}
    llamar('/agenda/guardar',{fecha:FECHA,filas:f,soloValidar:true}).then(function(r){
      if(!r)return; if(r.general){estado(r.general,false);return;}
      pintar(r.errores); estado(r.ok?'Todo válido.':'Revisa las filas marcadas.',r.ok);
    }).catch(function(){estado('Error de conexión.',false);});
  }
  function programar(){clearTimeout(timer);timer=setTimeout(validar,600);}
  function mostrarCliente(nombre){
    var c=M.clientes.filter(function(x){return x.n===nombre;})[0];
    panel.textContent='';
    if(!c){panel.textContent='Selecciona un cliente para ver su dirección, instrucciones y checklist.';return;}
    [['Cliente',c.n],['Dirección',c.dir],['Descripción',c.desc],['Instrucciones',c.ins],['Checklist',c.chk.join(', ')],['Coordenadas',c.coord?'Sí':'Faltan en SITIOS']].forEach(function(p){
      var d=el('div',{className:'par'}); d.appendChild(el('span',{textContent:p[0]})); d.appendChild(el('b',{textContent:p[1]||'—'})); panel.appendChild(d);
    });
  }
  cuerpo.addEventListener('input',programar);
  cuerpo.addEventListener('change',function(e){programar();if(e.target.classList.contains('c'))mostrarCliente(e.target.value);});
  cuerpo.addEventListener('focusin',function(e){var tr=e.target.closest&&e.target.closest('tr');if(tr)mostrarCliente(tr.querySelector('.c').value);});
  document.getElementById('gmas').onclick=function(){agregar();};
  document.getElementById('gguardar').onclick=function(){
    var f=leer(); if(!f.length){estado('No hay filas.',false);return;}
    var b=this; b.disabled=true;
    llamar('/agenda/guardar',{fecha:FECHA,filas:f}).then(function(r){
      b.disabled=false; if(!r)return;
      if(r.general){estado(r.general,false);return;}
      if(!r.ok){pintar(r.errores);estado('No se guardó: revisa las filas marcadas.',false);return;}
      location.reload();
    }).catch(function(){b.disabled=false;estado('Error de conexión.',false);});
  };
  window.tcEditar=function(id,solo){
    var s=SERV[id]; if(!s)return;
    var ya=Array.prototype.filter.call(cuerpo.rows,function(tr){return tr.dataset.id===id;})[0];
    var tr=ya||agregar(s,solo); tr.scrollIntoView({behavior:'smooth',block:'center'}); mostrarCliente(s.cliente); programar();
  };
  window.tcCancelar=function(id){
    var motivo=prompt('Motivo de la cancelación (obligatorio):'); if(motivo===null)return;
    if(motivo.trim().length<3){alert('Escribe un motivo.');return;}
    if(!confirm('¿Cancelar este servicio? Quedará registrado; la fila no se borra.'))return;
    llamar('/agenda/cancelar',{id:id,motivo:motivo}).then(function(r){
      if(!r)return; if(!r.ok){alert(r.general||'No se pudo cancelar.');return;} location.reload();
    }).catch(function(){alert('Error de conexión.');});
  };
  agregar(); mostrarCliente('');
})();
</script></section>`;
}

module.exports = { maestros, procesarGuardado, cancelarServicio, editorHtml, CSS_EDITOR };