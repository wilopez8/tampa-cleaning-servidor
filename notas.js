const { leerHoja, agregarFila } = require('./sheets');
const { normalizarFecha, fechaValida, hoyFlorida } = require('./agenda');
const K = require('./cartera').helpers; // cartera.js solo carga notas.js de forma diferida, así que no hay ciclo
const { cargarTabla, cargarTarifas, enCola, aFila, poner, numero, r2, esc, err, motivoOk, ahora } = K;

// NOTAS_SERVICIO: solo retroalimentación (calidad y comentarios del cliente). Las instrucciones van en
// CLIENTES.Instrucciones (permanentes) o en Observaciones del día de la agenda (puntuales). Solo se agregan filas; se anulan con motivo.
const NT_H = ['ID_Nota', 'Cliente', 'ID_Programacion', 'Fecha', 'Fuente', 'Categoria', 'Calificacion', 'Detalle', 'Estado',
  'Registrado_Por', 'Fecha_Registro', 'Anulado_Por', 'Motivo_Anulacion', 'Fecha_Anulacion'];
const FUENTES = ['Cliente', 'Interna'];
const CATEGORIAS = ['Calidad del servicio', 'Comentario del cliente', 'Otro'];
const CAL_OBLIGATORIA = 'Calidad del servicio';
const CALIFICACIONES = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

const leerNotas = directo => cargarTabla('NOTAS_SERVICIO', NT_H, directo).then(l => { const r = l.filter(n => n.ID_Nota); r.h = l.h; r._todas = l; return r; });

// ---------- acciones ----------
function registrarNota(b, admin) {
  return enCola(async () => {
    const hoy = hoyFlorida();
    const cliente = String(b.cliente || '').trim();
    if (!cliente) return err('Falta el cliente.');
    const tar = await cargarTarifas();
    if (!tar.mapa[cliente]) return err('Cliente no encontrado en SITIOS.');
    const fuente = String(b.fuente || '').trim();
    if (!FUENTES.includes(fuente)) return err('Indica si la nota viene del cliente o es interna.');
    const categoria = String(b.categoria || '').trim();
    if (!CATEGORIAS.includes(categoria)) return err('Elige la categoría.');

    let fecha = '', idProg = String(b.idProgramacion || '').trim();
    if (idProg) {
      const d = await leerHoja('PROGRAMACION_DIARIA');
      const h = d[0] || [], ix = n => h.indexOf(n);
      const f = d.slice(1).find(x => x[ix('ID_Programacion')] === idProg);
      if (!f) return err('Servicio no encontrado.');
      if (String(f[ix('Cliente')] || '').trim() !== cliente) return err('Ese servicio no es de este cliente.');
      fecha = normalizarFecha(f[ix('Fecha_Servicio')]);
      if (fecha > hoy) return err('Ese servicio aún no ha ocurrido.');
    } else {
      fecha = String(b.fecha || '').trim();
      if (!fechaValida(fecha) || fecha > hoy) return err('La fecha no es válida (no puede ser futura).');
    }

    const calTxt = String(b.calificacion ?? '').trim();
    let cal = '';
    if (calTxt !== '') {
      const n = numero(calTxt);
      if (!(n >= 1 && n <= 5) || Math.round(n * 2) / 2 !== n) return err('La calificación va de 1 a 5, en medios puntos (4, 4.5).');
      cal = n;
    }
    if (categoria === CAL_OBLIGATORIA && cal === '') return err('En "Calidad del servicio" la calificación es obligatoria.');
    const detalle = String(b.detalle || '').trim();
    if (detalle.length < 3) return err('El detalle es obligatorio (mínimo 3 caracteres).');

    const lista = await leerNotas(true);
    const pref = 'NOT-' + hoy.replace(/-/g, '') + '-';
    let mx = 0;
    lista.forEach(n => { const m = String(n.ID_Nota).match(/^NOT-\d{8}-(\d+)$/); if (m && n.ID_Nota.startsWith(pref)) mx = Math.max(mx, +m[1]); });
    const id = pref + String(mx + 1).padStart(2, '0');
    await agregarFila('NOTAS_SERVICIO', aFila(lista.h, {
      ID_Nota: id, Cliente: cliente, ID_Programacion: idProg, Fecha: fecha, Fuente: fuente, Categoria: categoria, Calificacion: cal,
      Detalle: detalle.slice(0, 500), Estado: 'Activa', Registrado_Por: admin, Fecha_Registro: ahora(),
    }));
    return { ok: true, id };
  });
}

function anularNota({ id, motivo }, admin) {
  return enCola(async () => {
    if (!motivoOk(motivo)) return err('El motivo es obligatorio (mínimo 3 caracteres).');
    const lista = await leerNotas(true);
    const n = lista.find(x => x.ID_Nota === String(id || '').trim());
    if (!n) return err('Nota no encontrada.');
    if (n.Estado !== 'Activa') return err('La nota ya estaba anulada.');
    await poner('NOTAS_SERVICIO', lista._todas, n, { Estado: 'Anulada', Anulado_Por: admin, Motivo_Anulacion: String(motivo).trim(), Fecha_Anulacion: ahora() });
    return { ok: true };
  });
}

// ---------- lectura para la línea de vida de la agenda ----------
async function porServicio(ids) {
  const out = {};
  const lista = await leerNotas();
  lista.filter(n => n.Estado === 'Activa' && n.ID_Programacion && ids.has(n.ID_Programacion)).forEach(n => { (out[n.ID_Programacion] = out[n.ID_Programacion] || []).push(n); });
  return out;
}
const estrellas = n => (n.Calificacion !== '' && numero(n.Calificacion) > 0) ? `★ ${numero(n.Calificacion)}` : '';
function textoBloque(notas) {
  return (notas || []).map(n => `${n.Fecha_Registro} · ${n.Registrado_Por} · ${n.Fuente} · ${n.Categoria}${estrellas(n) ? ' · ' + estrellas(n) : ''}\n${n.Detalle}`).join('\n\n');
}

// Servicios por cliente para elegir en el formulario (sin cancelados)
function mapaServicios(filas) {
  const m = {};
  filas.filter(r => r.Cliente && r.ID_Programacion && r._estado !== 'Cancelado').forEach(r => {
    const c = r.Cliente.trim();
    const hp = (r.Hora_Inicio && r.Hora_Fin) ? `${r.Hora_Inicio}–${r.Hora_Fin}` : (r.Horario || '');
    (m[c] = m[c] || []).push({ id: r.ID_Programacion, fecha: r._fecha, label: `${r._fecha} · ${r.Empleado || '—'}${hp ? ' · ' + hp : ''}${(r.Tipo_Servicio || 'Limpieza') === 'Inspeccion' ? ' (inspección)' : ''}` });
  });
  Object.values(m).forEach(l => l.sort((a, b) => b.fecha.localeCompare(a.fecha) || a.label.localeCompare(b.label)));
  return m;
}

// ---------- pantalla ----------
const botonNota = r => r.Cliente ? `<button class="btn" data-c="${esc(r.Cliente.trim())}" data-id="${esc(r.ID_Programacion)}" onclick="ntAbrir(this.dataset.c,this.dataset.id)">Nota</button>` : '';
const botonNuevaNota = cliente => `<button class="btn hoy" data-c="${esc(cliente)}" onclick="ntAbrir(this.dataset.c,'')">Nueva nota</button>`;

const SCRIPT_NOTAS = String.raw`
var ntCliente='',ntAnId='';
function ntE(i){return document.getElementById(i);}
function ntEsc(t){return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function ntPost(url,data,errId){fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(function(r){return r.json();}).then(function(j){if(j.ok){location.reload();}else{ntE(errId).textContent=j.general||'Error';}}).catch(function(){ntE(errId).textContent='Error de conexión';});}
function ntFecha(){ntE('ntFW').style.display=ntE('ntServ').value?'none':'block';}
function ntCal(){ntE('ntCalO').textContent=ntE('ntCat').value==='Calidad del servicio'?'(obligatoria)':'(opcional)';}
function ntAbrir(cli,idProg){
 ntCliente=cli;ntE('ntCli').textContent=cli;
 var l=(NTD.servs[cli]||[]),h='<option value="">Nota general del cliente (sin servicio)</option>';
 for(var i=0;i<l.length;i++){h+='<option value="'+ntEsc(l[i].id)+'">'+ntEsc(l[i].label)+'</option>';}
 ntE('ntServ').innerHTML=h;ntE('ntServ').value=idProg||'';
 if(ntE('ntServ').value!==(idProg||''))ntE('ntServ').value='';
 ntE('ntFuente').selectedIndex=0;ntE('ntCat').selectedIndex=0;ntE('ntCalif').value='';ntE('ntDet').value='';
 ntE('ntFechaIn').value=NTD.hoy;ntE('ntErr').textContent='';ntFecha();ntCal();ntE('ntDlg').showModal();}
function ntGuardar(){
 var d=ntE('ntDet').value.trim();
 if(d.length<3){ntE('ntErr').textContent='El detalle es obligatorio.';return;}
 ntPost('/cartera/notas/registrar',{cliente:ntCliente,idProgramacion:ntE('ntServ').value,fecha:ntE('ntFechaIn').value,fuente:ntE('ntFuente').value,
  categoria:ntE('ntCat').value,calificacion:ntE('ntCalif').value,detalle:d},'ntErr');}
function ntAnular(b){ntAnId=b.dataset.id;ntE('ntAnT').textContent='Anular nota '+b.dataset.id;ntE('ntMotivo').value='';ntE('ntAnErr').textContent='';ntE('ntAnDlg').showModal();}
function ntAnularOk(){var m=ntE('ntMotivo').value.trim();if(m.length<3){ntE('ntAnErr').textContent='El motivo es obligatorio.';return;}ntPost('/cartera/notas/anular',{id:ntAnId,motivo:m},'ntAnErr');}
function ntFiltrar(){var f=ntE('ntFiltroF').value,c=ntE('ntFiltroC').value,rows=document.querySelectorAll('tr[data-nf]');
 for(var i=0;i<rows.length;i++){rows[i].style.display=((!f||rows[i].dataset.nf===f)&&(!c||rows[i].dataset.nc===c))?'':'none';}}
`;

const opt = arr => arr.map(o => `<option>${esc(o)}</option>`).join('');

function dialogoNota(mapa) {
  const json = JSON.stringify({ hoy: hoyFlorida(), servs: mapa }).replace(/</g, '\\u003c');
  return `<style>#ntDlg,#ntAnDlg{border:1px solid #ccc;border-radius:10px;padding:18px;max-width:440px;width:92%;}
#ntDlg label,#ntAnDlg label{display:block;margin:10px 0;font-size:14px;}
#ntDlg input,#ntDlg select,#ntDlg textarea,#ntAnDlg input{width:100%;padding:8px;font-size:15px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;font-family:inherit;}
.ntAv{background:#fff7ed;border-radius:6px;padding:6px 10px;font-size:12px;color:#92400e;margin:6px 0;}</style>
<dialog id="ntDlg"><h3 style="margin:0 0 4px;">Nueva nota</h3><p id="ntCli" style="margin:0;color:#555;font-size:14px;"></p>
  <p class="ntAv">Las notas son solo retroalimentación (calidad, comentarios del cliente). Las instrucciones para el equipo van en <b>Observaciones del día</b> de la agenda o en las instrucciones del cliente.</p>
  <label>Servicio<select id="ntServ" onchange="ntFecha()"></select></label>
  <label id="ntFW">Fecha<input type="date" id="ntFechaIn"></label>
  <label>Fuente<select id="ntFuente">${opt(FUENTES)}</select></label>
  <label>Categoría<select id="ntCat" onchange="ntCal()">${opt(CATEGORIAS)}</select></label>
  <label>Calificación <span id="ntCalO">(opcional)</span><select id="ntCalif"><option value="">Sin calificación</option>${CALIFICACIONES.map(c => `<option value="${c}">${c}</option>`).join('')}</select></label>
  <label>Detalle (obligatorio)<textarea id="ntDet" rows="4" maxlength="500"></textarea></label>
  <p id="ntErr" style="color:#b91c1c;font-size:13px;"></p>
  <button class="btn hoy" onclick="ntGuardar()">Guardar</button> <button class="btn" onclick="ntE('ntDlg').close()">Cancelar</button></dialog>
<dialog id="ntAnDlg"><h3 id="ntAnT" style="margin-top:0;"></h3><label>Motivo (obligatorio)<input type="text" id="ntMotivo" maxlength="200"></label>
  <p id="ntAnErr" style="color:#b91c1c;font-size:13px;"></p>
  <button class="btn hoy" onclick="ntAnularOk()">Anular</button> <button class="btn" onclick="ntE('ntAnDlg').close()">Cancelar</button></dialog>
<script>var NTD=${json};${SCRIPT_NOTAS}</script>`;
}

// Historial de notas en la página del cliente (filas = servicios del período que muestra la página)
async function seccionCliente(cliente, filas) {
  const lista = (await leerNotas()).filter(n => n.Cliente === cliente);
  const ids = new Set(lista.map(n => n.ID_Programacion).filter(Boolean));
  const srv = {};
  if (ids.size) {
    const d = await leerHoja('PROGRAMACION_DIARIA', { cache: true });
    const h = d[0] || [], ix = n => h.indexOf(n);
    d.slice(1).forEach(f => { const id = f[ix('ID_Programacion')]; if (ids.has(id)) srv[id] = { fecha: normalizarFecha(f[ix('Fecha_Servicio')]), emp: String(f[ix('Empleado')] || '').trim() }; });
  }
  const activas = lista.filter(n => n.Estado === 'Activa');
  const conCal = activas.filter(n => numero(n.Calificacion) > 0);
  const prom = conCal.length ? Math.round(conCal.reduce((a, n) => a + numero(n.Calificacion), 0) / conCal.length * 10) / 10 : null;
  const ordenadas = [...lista].sort((a, b) => normalizarFecha(b.Fecha).localeCompare(normalizarFecha(a.Fecha)) || String(b.ID_Nota).localeCompare(String(a.ID_Nota))).slice(0, 200);
  const filasHtml = ordenadas.map(n => {
    const act = n.Estado === 'Activa', s = srv[n.ID_Programacion];
    return `<tr data-nf="${esc(n.Fuente)}" data-nc="${esc(n.Categoria)}"${act ? '' : ' class="anu"'}><td>${esc(normalizarFecha(n.Fecha))}<br><small>${esc(n.ID_Nota)}</small></td><td>${esc(n.Fuente)}</td><td>${esc(n.Categoria)}</td>
      <td class="num">${estrellas(n) ? esc(estrellas(n)) : '—'}</td><td style="white-space:pre-wrap;">${esc(n.Detalle)}</td>
      <td>${n.ID_Programacion ? (s ? `${esc(s.fecha)}<br><small>${esc(s.emp)}</small>` : `<small>${esc(n.ID_Programacion)}</small>`) : '<small>General del cliente</small>'}</td>
      <td><small>${esc(n.Registrado_Por)}<br>${esc(n.Fecha_Registro)}</small></td>
      <td>${act ? `<button class="btn mini" data-id="${esc(n.ID_Nota)}" onclick="ntAnular(this)">Anular</button>` : `<small>Anulada por ${esc(n.Anulado_Por)}: ${esc(n.Motivo_Anulacion)}</small>`}</td></tr>`;
  }).join('') || '<tr><td colspan="8" style="text-align:center;color:#888;padding:20px;">Este cliente aún no tiene notas.</td></tr>';
  const sel = (id, et, ops) => `<select id="${id}" onchange="ntFiltrar()" style="padding:6px;border:1px solid #ccc;border-radius:6px;"><option value="">${et}</option>${ops.map(o => `<option>${esc(o)}</option>`).join('')}</select>`;
  return `<h3 style="margin:18px 0 8px;">Notas y retroalimentación</h3>
<div class="aviso" style="background:#f0fdf4;">${activas.length} nota(s) activa(s)${prom !== null ? ` · calificación promedio <b>★ ${prom}</b> (${conCal.length} con calificación)` : ' · sin calificaciones todavía'}</div>
<div class="filtros">${sel('ntFiltroF', 'Todas las fuentes', FUENTES)}${sel('ntFiltroC', 'Todas las categorías', CATEGORIAS)} ${botonNuevaNota(cliente)}</div>
<div class="scroll"><table><tr><th>Fecha</th><th>Fuente</th><th>Categoría</th><th class="num">Calif.</th><th>Detalle</th><th>Servicio</th><th>Registrada por</th><th></th></tr>${filasHtml}</table></div>
${dialogoNota(mapaServicios(filas))}`;
}

// ---------- rutas ----------
function rutas(app, auth) {
  const api = (ruta, fn) => app.post(ruta, auth.requiereAdmin, async (req, res) => {
    try { res.json(await fn(req.body || {}, req.admin)); }
    catch (e) { console.error('Error en POST ' + ruta, e); res.status(500).json({ ok: false, general: 'Error: ' + e.message }); }
  });
  api('/cartera/notas/registrar', (b, a) => registrarNota(b, a));
  api('/cartera/notas/anular', (b, a) => anularNota(b, a));
}

module.exports = { rutas, registrarNota, anularNota, porServicio, textoBloque, mapaServicios, botonNota, botonNuevaNota, dialogoNota, seccionCliente };
