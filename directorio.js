// Directorio: alta y edición de Clientes (CLIENTES + SITIOS) y Empleados (EMPLEADOS).
// Nunca se borran filas: un registro se desactiva. El nombre queda bloqueado una vez creado.
const { leerHoja, agregarFila, actualizarCeldas } = require('./sheets');
const empresa = require('./empresa');
const { normalizarFecha, fechaValida } = require('./agenda');
const layout = require('./layout');

const esc = layout.esc;
const limpio = t => String(t ?? '').trim();
const unaLinea = t => limpio(t).replace(/\s*[\r\n]+\s*/g, ' ');
const dig = t => String(t || '').replace(/\D/g, '');
const num = t => { const x = parseFloat(String(t ?? '').replace(/[$,\s]/g, '')); return isFinite(x) ? x : NaN; };
// Coordenadas: acepta "27.88" y "27,88" (Sheets con coma decimal)
const numGeo = t => { let x = String(t ?? '').trim().replace(/^'/, ''); if (/^-?\d+,\d+$/.test(x)) x = x.replace(',', '.'); const n = parseFloat(x); return isFinite(n) ? n : NaN; };
const corto = (t, n) => { t = limpio(t); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const fechaLeg = f => String(f).split('-').reverse().join('/');
const FRECS = ['Semanal', 'Quincenal', 'Mensual'];

const CL = ['clientes', 'Direccion', 'Google Maps', 'Descripcion_Servicio', 'Instrucciones', 'Ciudad', 'Cliente Vigente/Vencido'];
const SI = ['ID_Sitio', 'Nombre_Cliente', 'Direccion', 'Google_Maps_Link', 'Latitud', 'Longitud', 'Radio_Tolerancia_m', 'Checklist_Tareas', 'Tipo_Cliente', 'Estatus',
  'Tarifa_Servicio', 'Pagador', 'Metodo_Pago', 'Nota_Pago', 'Frecuencia_Cobro', 'Fecha_Referencia_Cobro'];
const EM = ['ID_Telegram', 'Nombre', 'Rol', 'Estatus', 'Tarifa_Hora', 'Direccion_Residencia'];

// Escrituras una tras otra (evita IDs repetidos y filas duplicadas)
let cola = Promise.resolve();
function enSerie(fn) { const p = cola.then(fn); cola = p.catch(() => {}); return p; }

// Un texto que empieza con = + - @ se guardaría como fórmula
const aTexto = v => (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v;

async function tabla(hoja, req, vivo) {
  const d = await leerHoja(hoja, { cache: !vivo });
  if (!d.length) throw new Error('La hoja ' + hoja + ' está vacía');
  const h = d[0].map(limpio);
  const falta = req.filter(c => h.indexOf(c) < 0);
  if (falta.length) throw new Error('Faltan columnas en ' + hoja + ': ' + falta.join(', '));
  return { d, h };
}
const val = (t, r, c) => limpio(r[t.h.indexOf(c)]);

// ---------------------------------------------------------------- coordenadas desde Google Maps
function coordsDeTexto(t) {
  t = String(t || '');
  try { t = decodeURIComponent(t); } catch (e) { /* texto con % suelto: se usa tal cual */ }
  let m = t.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (!m) m = t.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (!m) m = t.match(/[?&](?:q|ll|query|center|destination)=(-?\d{1,3}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i);
  if (!m) m = t.match(/\/place\/(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (!m) m = t.match(/^\s*(-?\d{1,3}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)\s*$/);
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
}
const HOST_OK = /(^|\.)(google\.[a-z.]{2,6}|goo\.gl|g\.co)$/i;
const MSG_MANUAL = 'No se pudieron leer las coordenadas de ese enlace. Abre el enlace en el navegador, copia la dirección larga (contiene "@27.95,-82.45") o escribe latitud y longitud a mano.';

async function resolverEnlace(texto) {
  const u0 = limpio(texto);
  if (!u0) return { ok: false, error: 'Pega el enlace de Google Maps.' };
  const directo = coordsDeTexto(u0);
  if (directo) return { ok: true, ...directo };
  if (!/^https?:\/\//i.test(u0)) return { ok: false, error: 'Pega el enlace completo de Google Maps o escribe "latitud, longitud".' };
  if (typeof fetch !== 'function') return { ok: false, error: MSG_MANUAL };
  let url = u0;
  try {
    for (let i = 0; i < 6; i++) {
      const p = new URL(url);
      if (!/^https?:$/.test(p.protocol) || !HOST_OK.test(p.hostname)) return { ok: false, error: 'Solo se aceptan enlaces de Google Maps.' };
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), 8000);
      let r;
      try { r = await fetch(url, { redirect: 'manual', signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TampaCleaning/1.0)', 'Accept-Language': 'es,en;q=0.8' } }); }
      finally { clearTimeout(to); }
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        url = new URL(loc, url).toString();
        const c = coordsDeTexto(url);
        if (c) return { ok: true, ...c };
        continue;
      }
      const c = coordsDeTexto(url) || coordsDeTexto((await r.text()).slice(0, 400000));
      return c ? { ok: true, ...c } : { ok: false, error: MSG_MANUAL };
    }
  } catch (e) {
    console.error('Directorio: no se pudo abrir el enlace de Maps:', e.message);
  }
  return { ok: false, error: MSG_MANUAL };
}

// ---------------------------------------------------------------- lectura
async function leerClientes(vivo) {
  const [c, s] = await Promise.all([tabla('CLIENTES', CL, vivo), tabla('SITIOS', SI, vivo)]);
  const filasC = {}, filasS = {};
  for (let i = 1; i < c.d.length; i++) { const n = val(c, c.d[i], 'clientes'); if (n && !filasC[n]) filasC[n] = i; }
  for (let i = 1; i < s.d.length; i++) {
    const n = val(s, s.d[i], 'Nombre_Cliente');
    if (!n) continue;
    const act = val(s, s.d[i], 'Estatus') === 'Activo';
    if (!filasS[n] || (act && val(s, s.d[filasS[n]], 'Estatus') !== 'Activo')) filasS[n] = i;
  }
  const nombres = [...new Set([...Object.keys(filasC), ...Object.keys(filasS)])];
  const lista = nombres.map(n => {
    const rc = filasC[n] ? c.d[filasC[n]] : null, rs = filasS[n] ? s.d[filasS[n]] : null;
    const aC = rc ? val(c, rc, 'Cliente Vigente/Vencido') === 'Cliente Vigente' : true;
    const aS = rs ? val(s, rs, 'Estatus') === 'Activo' : true;
    const g = (col, alt) => (rs ? val(s, rs, col) : '') || (rc && alt ? val(c, rc, alt) : '');
    const lat = rs ? numGeo(rs[s.h.indexOf('Latitud')]) : NaN, lon = rs ? numGeo(rs[s.h.indexOf('Longitud')]) : NaN;
    const tar = rs ? num(rs[s.h.indexOf('Tarifa_Servicio')]) : NaN;
    const ref = rs ? normalizarFecha(rs[s.h.indexOf('Fecha_Referencia_Cobro')]) : '';
    return {
      nombre: n, act: aC && aS, incompleto: !rc || !rs,
      estado: aC && aS ? 'Activo' : 'Inactivo',
      ciudad: rc ? val(c, rc, 'Ciudad') : '', tipo: g('Tipo_Cliente'), dir: g('Direccion', 'Direccion'), maps: g('Google_Maps_Link', 'Google Maps'),
      lat: isFinite(lat) ? lat : '', lon: isFinite(lon) ? lon : '', radio: rs ? val(s, rs, 'Radio_Tolerancia_m') : '',
      desc: rc ? val(c, rc, 'Descripcion_Servicio') : '', ins: rc ? val(c, rc, 'Instrucciones') : '', chk: g('Checklist_Tareas'),
      pagador: g('Pagador'), tarifa: isFinite(tar) ? tar : '', metodo: g('Metodo_Pago'), nota: g('Nota_Pago'),
      frec: g('Frecuencia_Cobro'), ref: fechaValida(ref) ? ref : '',
    };
  }).sort((a, b) => a.nombre.localeCompare(b.nombre));
  const unicos = k => [...new Set(lista.map(x => x[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return { lista, listas: { ciudad: unicos('ciudad'), tipo: unicos('tipo'), metodo: unicos('metodo'), pagador: unicos('pagador') }, c, s, filasC, filasS };
}

async function leerEmpleados(vivo) {
  const e = await tabla('EMPLEADOS', EM, vivo);
  const lista = [];
  for (let i = 1; i < e.d.length; i++) {
    const r = e.d[i], n = val(e, r, 'Nombre');
    if (!n) continue;
    const t = num(r[e.h.indexOf('Tarifa_Hora')]), act = val(e, r, 'Estatus') === 'Activo';
    lista.push({ nombre: n, act, estado: act ? 'Activo' : 'Inactivo', wa: dig(r[e.h.indexOf('ID_Telegram')]), rol: val(e, r, 'Rol'), tarifa: isFinite(t) ? t : '', dir: val(e, r, 'Direccion_Residencia'), _fila: i });
  }
  lista.sort((a, b) => a.nombre.localeCompare(b.nombre));
  return { lista, listas: { rol: [...new Set(lista.map(x => x.rol).filter(Boolean))].sort((a, b) => a.localeCompare(b)) }, e };
}

// ---------------------------------------------------------------- escritura
function igual(col, actual, nuevo) {
  
  if (col === 'Latitud' || col === 'Longitud') { const a = numGeo(actual), b = numGeo(nuevo); return (isNaN(a) && isNaN(b)) || a === b; }
  if (['Radio_Tolerancia_m', 'Tarifa_Servicio', 'Tarifa_Hora'].indexOf(col) >= 0) {
    const a = num(actual), b = typeof nuevo === 'number' ? nuevo : num(nuevo);
    return (isNaN(a) && isNaN(b)) || a === b;
  }
  if (col === 'Fecha_Referencia_Cobro') return normalizarFecha(actual) === limpio(nuevo);
  if (col === 'ID_Telegram') return dig(actual) === dig(nuevo);
  return limpio(actual) === limpio(nuevo);
}
// Actualiza solo las celdas que cambiaron. Devuelve cuántas cambió.
async function actualizar(hoja, t, fila, valores) {
  const r = t.d[fila], cambios = [];
  Object.keys(valores).forEach(col => {
    const i = t.h.indexOf(col);
    if (i >= 0 && !igual(col, r[i], valores[col])) cambios.push({ fila: fila + 1, columna: i + 1, valor: aTexto(valores[col]) });
  });
  if (cambios.length) await actualizarCeldas(hoja, cambios);
  return cambios.length;
}
async function crear(hoja, t, valores) {
  const fila = t.h.map(() => '');
  Object.keys(valores).forEach(col => { const i = t.h.indexOf(col); if (i >= 0) fila[i] = aTexto(valores[col]); });
  await agregarFila(hoja, fila);
}
function siguienteIdSitio(s) {
  let max = 0, pref = 'SIT-', ancho = 3;
  const i = s.h.indexOf('ID_Sitio');
  for (let k = 1; k < s.d.length; k++) {
    const m = limpio(s.d[k][i]).match(/^(.*?)(\d+)$/);
    if (m && +m[2] >= max) { max = +m[2]; pref = m[1]; ancho = m[2].length; }
  }
  return pref + String(max + 1).padStart(ancho, '0');
}

function revisarCliente(p) {
  const f = {
    nombre: unaLinea(p.nombre), estado: p.estado === 'Inactivo' ? 'Inactivo' : 'Activo', ciudad: unaLinea(p.ciudad), tipo: unaLinea(p.tipo), dir: unaLinea(p.dir), maps: unaLinea(p.maps),
    lat: limpio(p.lat), lon: limpio(p.lon), radio: limpio(p.radio), desc: limpio(p.desc), ins: limpio(p.ins),
    chk: limpio(p.chk).split(/[\r\n,;]+/).map(x => x.trim()).filter(Boolean).join(', '),
    pagador: unaLinea(p.pagador), tarifa: limpio(p.tarifa), metodo: unaLinea(p.metodo), nota: unaLinea(p.nota), frec: limpio(p.frec), ref: limpio(p.ref),
  };
  const mal = t => ({ error: t });
  if (!f.nombre || f.nombre.length < 2) return mal('Escribe el nombre del cliente.');
  if (f.nombre.length > 120) return mal('El nombre es demasiado largo (máximo 120).');
  if (f.nombre.indexOf('|') >= 0) return mal('El nombre no puede llevar el símbolo "|".');
  if (!f.dir) return mal('Escribe la dirección del servicio.');
  if ((f.lat === '') !== (f.lon === '')) return mal('Escribe latitud y longitud juntas, o deja ambas vacías.');
  if (f.lat !== '') {
    const la = numGeo(f.lat), lo = numGeo(f.lon);
    if (!(Math.abs(la) <= 90) || !(Math.abs(lo) <= 180)) return mal('Latitud o longitud no válidas (ejemplo: 27.9506 y -82.4572).');
    f.lat = +la.toFixed(6); f.lon = +lo.toFixed(6);
  }
  if (f.radio !== '') { const r = num(f.radio); if (!(r >= 10 && r <= 5000)) return mal('El radio de tolerancia debe estar entre 10 y 5000 metros.'); f.radio = r; }
  if (f.tarifa !== '') { const t = num(f.tarifa); if (!(t >= 0)) return mal('La tarifa debe ser un número mayor o igual a 0.'); f.tarifa = Math.round(t * 100) / 100; }
  if (f.frec && FRECS.indexOf(f.frec) < 0) return mal('Frecuencia de cobro no válida.');
  if (f.ref && !fechaValida(f.ref)) return mal('La fecha de referencia del cobro no es válida.');
  if (!!f.frec !== !!f.ref) return mal('La frecuencia y la fecha de referencia del cobro van juntas: llena ambas o deja ambas vacías.');
  if (!f.pagador) f.pagador = f.nombre;
  return f;
}

async function guardarCliente(p, admin) {
  p = p || {};
  if (p.modo === 'editar') p = { ...p, nombre: p.original }; // el nombre no se puede cambiar
  const f = revisarCliente(p);
  if (f.error) return { ok: false, error: f.error };
  const editar = p.modo === 'editar';
  return enSerie(async () => {
    const d = await leerClientes(true), { c, s } = d;
    const nombre = editar ? unaLinea(p.original) : f.nombre;
    const iC = d.filasC[nombre], iS = d.filasS[nombre];
    if (editar && iC === undefined && iS === undefined) return { ok: false, error: 'No se encontró el cliente "' + nombre + '". Recarga la página.' };
    if (!editar) {
      const k = nombre.toLowerCase();
      if (d.lista.some(x => x.nombre.toLowerCase() === k)) return { ok: false, error: 'Ya existe un cliente con ese nombre. Usa un nombre distinto (ejemplo: "Cliente – Sitio").' };
    }
    let aviso = '';
    if (f.lat === '' && f.maps) {
      const r = await resolverEnlace(f.maps);
      if (r.ok) { f.lat = r.lat; f.lon = r.lon; }
    }
    if (f.lat === '') aviso = 'Guardado sin coordenadas: los check-ins de este cliente saldrán "fuera de rango" hasta que las agregues.';
    const vc = { clientes: nombre, Direccion: f.dir, 'Google Maps': f.maps, Descripcion_Servicio: f.desc, Instrucciones: f.ins, Ciudad: f.ciudad, 'Cliente Vigente/Vencido': f.estado === 'Activo' ? 'Cliente Vigente' : 'Cliente Vencido' };
    const vs = {
      Nombre_Cliente: nombre, Direccion: f.dir, Google_Maps_Link: f.maps, Latitud: f.lat === '' ? '' : "'" + f.lat, Longitud: f.lon === '' ? '' : "'" + f.lon, Radio_Tolerancia_m: f.radio, Checklist_Tareas: f.chk, Tipo_Cliente: f.tipo,
      Estatus: f.estado, Tarifa_Servicio: f.tarifa, Pagador: f.pagador, Metodo_Pago: f.metodo, Nota_Pago: f.nota, Frecuencia_Cobro: f.frec, Fecha_Referencia_Cobro: f.ref,
    };
    if (iC !== undefined) await actualizar('CLIENTES', c, iC, vc); else await crear('CLIENTES', c, vc);
    if (iS !== undefined) await actualizar('SITIOS', s, iS, vs); else await crear('SITIOS', s, { ID_Sitio: siguienteIdSitio(s), ...vs });
    console.log(`Directorio: ${admin} ${editar ? 'editó' : 'creó'} el cliente "${nombre}"`);
    return { ok: true, aviso };
  });
}

function revisarEmpleado(p) {
  const f = { nombre: unaLinea(p.nombre), wa: dig(p.wa), rol: unaLinea(p.rol), estado: p.estado === 'Inactivo' ? 'Inactivo' : 'Activo', tarifa: limpio(p.tarifa), dir: unaLinea(p.dir) };
  const mal = t => ({ error: t });
  if (!f.nombre || f.nombre.length < 2) return mal('Escribe el nombre del empleado.');
  if (f.nombre.length > 80) return mal('El nombre es demasiado largo (máximo 80).');
  if (f.wa.length === 10) f.wa = empresa.prefijoPais + f.wa;
  if (f.wa.length < 11 || f.wa.length > 15) return mal('Escribe el número de WhatsApp con código de país (ejemplo: 18135551234).');
  if (!f.rol) return mal('Escribe el rol del empleado.');
  if (f.tarifa !== '') { const t = num(f.tarifa); if (!(t >= 0)) return mal('La tarifa por hora debe ser un número mayor o igual a 0.'); f.tarifa = Math.round(t * 100) / 100; }
  return f;
}

async function guardarEmpleado(p, admin) {
  p = p || {};
  if (p.modo === 'editar') p = { ...p, nombre: p.original }; // el nombre no se puede cambiar
  const f = revisarEmpleado(p);
  if (f.error) return { ok: false, error: f.error };
  const editar = p.modo === 'editar';
  return enSerie(async () => {
    const d = await leerEmpleados(true), nombre = editar ? unaLinea(p.original) : f.nombre;
    const ex = d.lista.find(x => x.nombre === nombre);
    if (editar && !ex) return { ok: false, error: 'No se encontró al empleado "' + nombre + '". Recarga la página.' };
    if (!editar && d.lista.some(x => x.nombre.toLowerCase() === nombre.toLowerCase())) return { ok: false, error: 'Ya existe un empleado con ese nombre.' };
    const otro = d.lista.find(x => x.nombre !== nombre && x.wa && x.wa.slice(-10) === f.wa.slice(-10));
    if (otro) return { ok: false, error: 'Ese número de WhatsApp ya lo usa ' + otro.nombre + '.' };
    const v = { ID_Telegram: f.wa, Nombre: nombre, Rol: f.rol, Estatus: f.estado, Tarifa_Hora: f.tarifa, Direccion_Residencia: f.dir };
    if (editar) await actualizar('EMPLEADOS', d.e, ex._fila, v); else await crear('EMPLEADOS', d.e, v);
    console.log(`Directorio: ${admin} ${editar ? 'editó' : 'creó'} al empleado "${nombre}"`);
    return { ok: true, aviso: f.dir ? '' : 'Guardado sin dirección de residencia: no se calcularán las millas de casa de este empleado.' };
  });
}

async function cambiarEstado({ tipo, nombre, activo }, admin) {
  nombre = unaLinea(nombre);
  return enSerie(async () => {
    if (tipo === 'empleados') {
      const d = await leerEmpleados(true), ex = d.lista.find(x => x.nombre === nombre);
      if (!ex) return { ok: false, error: 'No se encontró al empleado.' };
      await actualizar('EMPLEADOS', d.e, ex._fila, { Estatus: activo ? 'Activo' : 'Inactivo' });
    } else {
      const d = await leerClientes(true), iC = d.filasC[nombre], iS = d.filasS[nombre];
      if (iC === undefined && iS === undefined) return { ok: false, error: 'No se encontró el cliente.' };
      if (iC !== undefined) await actualizar('CLIENTES', d.c, iC, { 'Cliente Vigente/Vencido': activo ? 'Cliente Vigente' : 'Cliente Vencido' });
      if (iS !== undefined) await actualizar('SITIOS', d.s, iS, { Estatus: activo ? 'Activo' : 'Inactivo' });
    }
    console.log(`Directorio: ${admin} ${activo ? 'activó' : 'desactivó'} a "${nombre}" (${tipo})`);
    return { ok: true };
  });
}

// ---------------------------------------------------------------- pantalla
const CSS = `
#dlg{width:min(760px,94vw);max-height:92vh;overflow:auto;}
.fg{display:grid;grid-template-columns:1fr 1fr;gap:0 14px;} .fg .w{grid-column:1/-1;}
.fg h4{margin:14px 0 2px;font-size:14px;color:var(--navy);border-bottom:1px solid var(--line);padding-bottom:4px;}
.fg textarea{min-height:64px;resize:vertical;}
#dlg input[readonly]{background:#f3f5f7;color:var(--gray-d);}
.cs{font-size:12.5px;color:var(--gray-d);} .cs.ok{color:#14612f;} .cs.mal{color:#b91c1c;}
.cr{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:2px 0 6px;}
td.ac{white-space:nowrap;text-align:right;} td.ac .mnu{vertical-align:middle;}
.filtros input[type=search]{min-width:220px;}
@media(max-width:800px){.fg{grid-template-columns:1fr;}.hm{display:none;}.filtros input[type=search]{min-width:0;flex:1;}}
`;

const CLIENTE_JS = String.raw`
(function(){
  'use strict';
  var D=__DATA__, EMP=D.tipo==='empleados';
  var dlg=document.getElementById('dlg'), err=document.getElementById('derr'), ORIG='', MODO='crear';
  function $(id){return document.getElementById(id);}
  var CAMPOS=EMP?['nombre','wa','rol','estado','tarifa','dir']:['nombre','estado','ciudad','tipo','dir','maps','lat','lon','radio','desc','ins','chk','pagador','tarifa','metodo','nota','frec','ref'];
  function poner(o){CAMPOS.forEach(function(c){var e=$('f_'+c);if(e){e.value=(o&&o[c]!==undefined&&o[c]!==null)?o[c]:'';}});}
  function leer(){var r={};CAMPOS.forEach(function(c){var e=$('f_'+c);r[c]=e?e.value:'';});r.modo=MODO;r.original=ORIG;return r;}
  function estadoCoord(){
    if(EMP){return;}
    var la=$('f_lat').value.trim(),lo=$('f_lon').value.trim(),a=$('verif');
    if(la&&lo){a.href='https://www.google.com/maps?q='+encodeURIComponent(la+','+lo);a.style.display='';}else{a.style.display='none';}
  }
  function abrir(o,modo,titulo,sinFoco){
    MODO=modo;ORIG=(modo==='editar')?o.nombre:'';
    poner(o);$('f_nombre').readOnly=(modo==='editar');
    $('dtit').textContent=titulo;err.textContent='';
    if(!EMP){$('cst').textContent='';$('cst').className='cs';estadoCoord();}
    dlg.showModal();
    if(modo!=='editar'){var n=$('f_nombre');n.focus();var l=n.value.length;try{n.setSelectionRange(l,l);}catch(e){}}
  }
  function buscarCoord(){
    var t=$('f_maps').value.trim(),cst=$('cst');
    if(!t){cst.textContent='Pega primero el enlace de Google Maps.';cst.className='cs mal';return;}
    cst.textContent='Buscando coordenadas…';cst.className='cs';
    TC.post('/directorio/coordenadas',{texto:t}).then(function(r){
      if(!r){return;}
      if(r.ok){$('f_lat').value=r.lat;$('f_lon').value=r.lon;cst.textContent='Coordenadas: '+r.lat+', '+r.lon+'. Verifícalas en el mapa antes de guardar.';cst.className='cs ok';}
      else{cst.textContent=r.error||'No se pudieron obtener las coordenadas.';cst.className='cs mal';}
      estadoCoord();
    }).catch(function(){cst.textContent='Error de conexión.';cst.className='cs mal';});
  }
  if(!EMP){
    $('f_maps').addEventListener('change',function(){if(this.value.trim()){buscarCoord();}});
    $('bcoord').onclick=buscarCoord;
    $('f_lat').addEventListener('input',estadoCoord);$('f_lon').addEventListener('input',estadoCoord);
  }
  $('dcancel').onclick=function(){dlg.close();};
  $('dsave').onclick=function(){
    var b=this;err.textContent='';b.disabled=true;
    TC.post(EMP?'/directorio/empleado/guardar':'/directorio/cliente/guardar',leer()).then(function(r){
      b.disabled=false;if(!r){return;}
      if(!r.ok){err.textContent=r.error||'No se guardó.';return;}
      dlg.close();
      if(r.aviso){TC.alerta(r.aviso,{titulo:'Guardado'}).then(function(){location.reload();});return;}
      TC.toast('Guardado.');setTimeout(function(){location.reload();},700);
    }).catch(function(){b.disabled=false;err.textContent='Error de conexión.';});
  };
  $('nuevo').onclick=function(){abrir({estado:'Activo'},'crear',EMP?'Nuevo empleado':'Nuevo cliente');};
  document.addEventListener('click',function(e){
    var b=e.target.closest&&e.target.closest('[data-a]');if(!b){return;}
    var tr=b.closest('tr'),o=tr?D.filas[+tr.getAttribute('data-i')]:null,a=b.getAttribute('data-a');
    if(!o){return;}
    if(a==='ed'){abrir(o,'editar','Editar: '+o.nombre);return;}
    if(a==='sitio'){
      var base=o.pagador||o.nombre;
      abrir({estado:'Activo',nombre:base+' – ',pagador:base,tarifa:o.tarifa,metodo:o.metodo,nota:o.nota,frec:o.frec,ref:o.ref,tipo:o.tipo,ciudad:o.ciudad},'crear','Nuevo sitio (mismo pagador)');
      return;
    }
    if(a==='est'){
      var activar=!o.act;
      var txt=activar?o.nombre+' volverá a estar activo.':(EMP?o.nombre+' dejará de aparecer para programar servicios y no recibirá mensajes.':o.nombre+' dejará de aparecer en la agenda, en Calidad y en el Resumen. El historial y los cobros se conservan.');
      TC.confirmar(txt,{titulo:activar?'Activar':'Desactivar',si:activar?'Activar':'Desactivar'}).then(function(ok){
        if(!ok){return;}
        TC.post('/directorio/estado',{tipo:D.tipo,nombre:o.nombre,activo:activar}).then(function(r){
          if(!r){return;}
          if(!r.ok){TC.alerta(r.error||'No se pudo cambiar el estado.');return;}
          TC.toast(activar?'Activado.':'Desactivado.');setTimeout(function(){location.reload();},700);
        }).catch(function(){TC.alerta('Error de conexión.');});
      });
    }
  });
  function filtrar(){
    var q=$('q').value.trim().toLowerCase(),fe=$('fe').value,rows=document.querySelectorAll('#tb tr'),n=0,i,o,ok;
    for(i=0;i<rows.length;i++){
      o=D.filas[+rows[i].getAttribute('data-i')];
      ok=(fe==='todos'||(fe==='act'&&o.act)||(fe==='ina'&&!o.act))&&(!q||rows[i].getAttribute('data-q').indexOf(q)>=0);
      rows[i].style.display=ok?'':'none';
      if(ok){n++;}
    }
    $('cnt').textContent=n+' de '+rows.length;
  }
  $('q').addEventListener('input',filtrar);$('fe').addEventListener('change',filtrar);
  filtrar();
})();
`;

const opciones = a => a.map(x => `<option value="${esc(x)}">`).join('');
const dl = (id, a) => `<datalist id="${id}">${opciones(a)}</datalist>`;
const json = o => JSON.stringify(o).replace(/</g, '\\u003c');

function dialogoCliente(L) {
  return `<dialog id="dlg" class="tc-dlg ancho"><h3 id="dtit"></h3>
<div class="fg">
<label>Nombre del cliente o sitio *<input type="text" id="f_nombre" maxlength="120" autocomplete="off"><small>Una vez creado no se puede cambiar. Para varios sitios usa "Cliente – Sitio".</small></label>
<label>Estado<select id="f_estado"><option>Activo</option><option>Inactivo</option></select></label>
<label class="w">Dirección del servicio *<input type="text" id="f_dir" maxlength="200" autocomplete="off"></label>
<label>Ciudad<input type="text" id="f_ciudad" list="dl_ciudad" maxlength="60" autocomplete="off"></label>
<label>Tipo de cliente<input type="text" id="f_tipo" list="dl_tipo" maxlength="60" autocomplete="off"></label>
<h4 class="w">Ubicación</h4>
<label class="w">Enlace de Google Maps<input type="text" id="f_maps" maxlength="500" autocomplete="off" placeholder="Pega aquí el enlace; las coordenadas se obtienen solas"></label>
<div class="w cr"><button type="button" class="btn mini" id="bcoord">Obtener coordenadas</button><a id="verif" class="btn mini" target="_blank" rel="noopener" style="display:none">Verificar en el mapa</a><span id="cst" class="cs"></span></div>
<label>Latitud<input type="text" id="f_lat" inputmode="decimal" autocomplete="off"></label>
<label>Longitud<input type="text" id="f_lon" inputmode="decimal" autocomplete="off"></label>
<label class="w">Radio de tolerancia del check-in (metros)<input type="text" id="f_radio" inputmode="numeric" autocomplete="off" placeholder="Vacío = 150"></label>
<h4 class="w">Servicio</h4>
<label class="w">Descripción del servicio<textarea id="f_desc"></textarea></label>
<label class="w">Instrucciones<textarea id="f_ins"></textarea></label>
<label class="w">Checklist de tareas<textarea id="f_chk" placeholder="Una tarea por línea o separadas por coma"></textarea></label>
<h4 class="w">Cobro</h4>
<label>Pagador<input type="text" id="f_pagador" list="dl_pagador" maxlength="120" autocomplete="off" placeholder="Vacío = el mismo cliente"></label>
<label>Tarifa por servicio (USD)<input type="text" id="f_tarifa" inputmode="decimal" autocomplete="off"></label>
<label>Método de pago<input type="text" id="f_metodo" list="dl_metodo" maxlength="60" autocomplete="off"></label>
<label>Nota de pago<input type="text" id="f_nota" maxlength="200" autocomplete="off"></label>
<label>Frecuencia de cobro<select id="f_frec"><option value=""></option>${FRECS.map(x => `<option>${x}</option>`).join('')}</select></label>
<label>Fecha de referencia del cobro<input type="date" id="f_ref"></label>
</div>
${dl('dl_ciudad', L.ciudad)}${dl('dl_tipo', L.tipo)}${dl('dl_pagador', L.pagador)}${dl('dl_metodo', L.metodo)}
<p class="tc-err" id="derr"></p>
<div class="tc-acc"><button type="button" class="btn" id="dcancel">Cancelar</button><button type="button" class="btn hoy" id="dsave">Guardar</button></div></dialog>`;
}
function dialogoEmpleado(L) {
  return `<dialog id="dlg" class="tc-dlg ancho"><h3 id="dtit"></h3>
<div class="fg">
<label>Nombre del empleado *<input type="text" id="f_nombre" maxlength="80" autocomplete="off"><small>Una vez creado no se puede cambiar.</small></label>
<label>Estado<select id="f_estado"><option>Activo</option><option>Inactivo</option></select></label>
<label>WhatsApp *<input type="text" id="f_wa" inputmode="tel" autocomplete="off" placeholder="18135551234"><small>Con código de país. Es el número al que se envía la programación.</small></label>
<label>Rol *<input type="text" id="f_rol" list="dl_rol" maxlength="60" autocomplete="off"></label>
<label>Tarifa por hora (USD)<input type="text" id="f_tarifa" inputmode="decimal" autocomplete="off"></label>
<label class="w">Dirección de residencia<input type="text" id="f_dir" maxlength="200" autocomplete="off"><small>Se usa para calcular las millas desde casa.</small></label>
</div>
${dl('dl_rol', L.rol)}
<p class="tc-err" id="derr"></p>
<div class="tc-acc"><button type="button" class="btn" id="dcancel">Cancelar</button><button type="button" class="btn hoy" id="dsave">Guardar</button></div></dialog>`;
}

function marco(tipo, admin, kpis, nuevoTxt, filasHtml, cabeceraTabla, dialogo, datos) {
  const js = CLIENTE_JS.replace('__DATA__', () => json(datos));
  return `${layout.head('Directorio', CSS)}
${layout.cabecera({ titulo: 'Directorio — ' + (tipo === 'clientes' ? 'Clientes' : 'Empleados'), seccion: '/directorio', admin, sub: 'directorio', activa: tipo })}
${kpis}
<div class="filtros"><button type="button" class="btn hoy" id="nuevo">${esc(nuevoTxt)}</button><input type="search" id="q" placeholder="Buscar…" autocomplete="off">
<select id="fe"><option value="act">Activos</option><option value="ina">Inactivos</option><option value="todos">Todos</option></select><small id="cnt"></small></div>
<div class="scroll"><table><thead><tr>${cabeceraTabla}</tr></thead><tbody id="tb">${filasHtml}</tbody></table></div>
${dialogo}
<script>${js}</script>
</body></html>`;
}
const menu = (act, extra) => `<button type="button" class="btn mini" data-a="ed">Editar</button> <details class="mnu"><summary class="btn mini">⋯</summary><div class="mnu-l">${extra || ''}<button type="button" class="mnu-i${act ? ' pel' : ''}" data-a="est">${act ? 'Desactivar' : 'Activar'}</button></div></details>`;
const usd = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function paginaClientes(admin) {
  const d = await leerClientes(false), L = d.lista, act = L.filter(x => x.act);
  const kpis = layout.kpis([
    ['Clientes activos', act.length], ['Inactivos', L.length - act.length],
    ['Activos sin coordenadas', act.filter(x => x.lat === '').length, act.some(x => x.lat === '') ? 'neg' : ''],
    ['Activos sin datos de cobro', act.filter(x => x.tarifa === '' || !x.frec).length, act.some(x => x.tarifa === '' || !x.frec) ? 'neg' : ''],
  ]);
  const filas = L.map((x, i) => `<tr data-i="${i}" data-q="${esc([x.nombre, x.pagador, x.ciudad, x.dir, x.tipo].join(' ').toLowerCase())}">
<td><b>${esc(x.nombre)}</b>${x.incompleto ? ' <span class="est rev">Incompleto</span>' : ''}<br><small>${esc(x.ciudad)}${x.ciudad && x.dir ? ' · ' : ''}${esc(corto(x.dir, 60))}</small></td>
<td class="hm">${esc(x.pagador)}</td><td>${x.tarifa === '' ? '<small>—</small>' : usd(x.tarifa)}</td>
<td class="hm">${x.frec ? esc(x.frec) + '<br><small>desde ' + esc(fechaLeg(x.ref)) + '</small>' : '<small>—</small>'}</td>
<td>${x.lat === '' ? '<span class="est par">Falta</span>' : '<span class="est ok">Sí</span>'}</td>
<td><span class="est ${x.act ? 'ok' : 'cn'}">${x.estado}</span></td>
<td class="ac">${menu(x.act, '<button type="button" class="mnu-i" data-a="sitio">Agregar otro sitio (mismo pagador)</button>')}</td></tr>`).join('');
  return marco('clientes', admin, kpis, '+ Nuevo cliente', filas,
    '<th>Cliente</th><th class="hm">Pagador</th><th>Tarifa</th><th class="hm">Cobro</th><th>Coord.</th><th>Estado</th><th></th>',
    dialogoCliente(d.listas), { tipo: 'clientes', filas: L });
}

async function paginaEmpleados(admin) {
  const d = await leerEmpleados(false), L = d.lista, act = L.filter(x => x.act);
  const kpis = layout.kpis([
    ['Empleados activos', act.length], ['Inactivos', L.length - act.length],
    ['Activos sin WhatsApp válido', act.filter(x => x.wa.length < 10).length, act.some(x => x.wa.length < 10) ? 'neg' : ''],
    ['Activos sin dirección', act.filter(x => !x.dir).length, act.some(x => !x.dir) ? 'neg' : ''],
  ]);
  const filas = L.map((x, i) => `<tr data-i="${i}" data-q="${esc([x.nombre, x.rol, x.wa, x.dir].join(' ').toLowerCase())}">
<td><b>${esc(x.nombre)}</b></td><td>${x.wa.length >= 10 ? '+' + esc(x.wa) : '<span class="est par">Falta</span>'}</td><td>${esc(x.rol)}</td>
<td>${x.tarifa === '' ? '<small>—</small>' : usd(x.tarifa)}</td><td class="hm"><small>${esc(corto(x.dir, 60))}</small></td>
<td><span class="est ${x.act ? 'ok' : 'cn'}">${x.estado}</span></td><td class="ac">${menu(x.act)}</td></tr>`).join('');
  return marco('empleados', admin, kpis, '+ Nuevo empleado', filas,
    '<th>Empleado</th><th>WhatsApp</th><th>Rol</th><th>Tarifa/h</th><th class="hm">Residencia</th><th>Estado</th><th></th>',
    dialogoEmpleado(d.listas), { tipo: 'empleados', filas: L.map(({ _fila, ...r }) => r) });
}

function rutas(app, auth) {
  const html = (fn) => async (req, res) => {
    try { res.set('Content-Type', 'text/html; charset=utf-8'); res.send(await fn(req.admin)); }
    catch (e) { console.error('Error en ' + req.path + ':', e); res.status(500).send('Error cargando el directorio: ' + e.message); }
  };
  const api = (fn) => async (req, res) => {
    try { res.json(await fn(req.body || {}, req.admin)); }
    catch (e) { console.error('Error en POST ' + req.path + ':', e); res.status(500).json({ ok: false, error: 'Error: ' + e.message }); }
  };
  app.get('/directorio', auth.requiereAdmin, (req, res) => res.redirect('/directorio/clientes'));
  app.get('/directorio/clientes', auth.requiereAdmin, html(paginaClientes));
  app.get('/directorio/empleados', auth.requiereAdmin, html(paginaEmpleados));
  app.post('/directorio/coordenadas', auth.requiereAdmin, api(b => resolverEnlace(b.texto)));
  app.post('/directorio/cliente/guardar', auth.requiereAdmin, api(guardarCliente));
  app.post('/directorio/empleado/guardar', auth.requiereAdmin, api(guardarEmpleado));
  app.post('/directorio/estado', auth.requiereAdmin, api(cambiarEstado));
}

module.exports = { rutas, paginaClientes, paginaEmpleados, guardarCliente, guardarEmpleado, cambiarEstado, resolverEnlace, _t: { coordsDeTexto, revisarCliente, revisarEmpleado, CLIENTE_JS } };