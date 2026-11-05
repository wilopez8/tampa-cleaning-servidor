const { leerHoja, agregarFila, agregarFilas, actualizarCeldas, asegurarHoja } = require('./sheets');
const { enviarWhatsApp, notificarGerencia, buscarTelefonoPorNombre, buscarEmpleadoPorTelefono, BASE_URL } = require('./logica');
const { fechaValida, hoyFlorida, normalizarFecha } = require('./agenda');
const edicion = require('./edicion');

const HOJA = 'PENDIENTES', HOJA_MSG = 'PENDIENTES_MENSAJES', HOJA_HIST = 'PENDIENTES_HISTORIAL';
const ENC = ['ID_Pendiente', 'Tipo', 'Titulo', 'Observaciones', 'Cliente', 'ID_Programacion', 'Responsable', 'Fecha_Limite', 'Hora_Inicio', 'Hora_Fin',
  'Prioridad', 'Estado', 'Estado_Envio', 'Creado_Por', 'Fecha_Creacion', 'Notas_Seguimiento', 'Fecha_Cierre', 'Cerrado_Por', 'Nota_Cierre', 'Ultimo_Recordatorio'];
const ENC_MSG = ['SID', 'ID_Pendiente', 'Fecha_Hora', 'Tipo_Envio'];
const ENC_HIST = ['Fecha_Hora', 'ID_Pendiente', 'Evento', 'Detalle', 'Realizado_Por'];
const TIPOS = ['Acción correctiva', 'Diligencia', 'Revisión de servicio', 'Otro'];
const PRIOS = ['Baja', 'Normal', 'Alta'];
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

const limpio = t => String(t ?? '').trim();
const digitos = t => String(t || '').replace(/\D/g, '');
const ahora = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const js = o => JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
function hora(t) { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? m[1].padStart(2, '0') + ':' + m[2] : ''; }
function fechaLeg(f) { const n = normalizarFecha(f); return fechaValida(n) ? n.split('-').reverse().join('/') : f; }

let cola = Promise.resolve();
function enSerie(fn) { const p = cola.then(fn); cola = p.catch(() => {}); return p; }

// ---------- Datos ----------
async function cargar() {
  await asegurarHoja(HOJA, ENC);
  const datos = await leerHoja(HOJA);
  const h = datos[0] || ENC;
  const filas = [];
  for (let i = 1; i < datos.length; i++) {
    const r = { _fila: i + 1 };
    h.forEach((n, j) => { r[n] = String(datos[i][j] ?? ''); });
    if (r.ID_Pendiente) filas.push(r);
  }
  return { h, filas };
}
async function obtener(id) { const { h, filas } = await cargar(); const p = filas.find(x => x.ID_Pendiente === id); return p ? { h, p } : null; }
async function poner(h, fila, vals) {
  const c = [];
  Object.keys(vals).forEach(k => { const i = h.indexOf(k); if (i >= 0) c.push({ fila, columna: i + 1, valor: vals[k] }); });
  await actualizarCeldas(HOJA, c);
}
async function hist(id, evento, detalle, por) {
  try { await asegurarHoja(HOJA_HIST, ENC_HIST); await agregarFila(HOJA_HIST, [ahora(), id, evento, detalle, por || '']); }
  catch (e) { console.error('Historial de pendientes:', e); }
}
const vencido = (p, hoy) => p.Estado === 'Abierto' && fechaValida(normalizarFecha(p.Fecha_Limite)) && normalizarFecha(p.Fecha_Limite) < hoy;

// ---------- Crear ----------
const vacia = f => !f.titulo && !f.responsable && !f.obs && !f.cliente;

function validar(normal, m) {
  return normal.map(f => {
    if (vacia(f)) return [];
    const e = [];
    if (!f.titulo) e.push('Falta el título');
    if (!TIPOS.includes(f.tipo)) e.push('Tipo no válido');
    if (!PRIOS.includes(f.prioridad)) e.push('Prioridad no válida');
    const emp = m.empleados.find(x => x.n === f.responsable);
    if (!f.responsable) e.push('Falta el responsable');
    else if (!emp) e.push('Responsable inexistente o inactivo');
    else if (!emp.wa) e.push('El responsable no tiene número de WhatsApp');
    if (f.cliente && !m.clientes.some(c => c.n === f.cliente)) e.push('Cliente no activo');
    if (f.fecha && !fechaValida(f.fecha)) e.push('Fecha límite no válida');
    if ((f.inicio || f.fin)) {
      if (!f.fecha) e.push('Para un horario hace falta la fecha');
      if (!HORA.test(f.inicio) || !HORA.test(f.fin)) e.push('Horario incompleto');
      else if (f.fin <= f.inicio) e.push('La hora de fin debe ser posterior a la de inicio');
    }
    if (f.idServ && !m.idsServicios.has(f.idServ)) e.push('El ID de servicio no existe');
    return e;
  });
}

async function _crear(filas, admin) {
  if (!Array.isArray(filas) || !filas.length) return { ok: false, general: 'No hay filas para guardar.' };
  if (filas.length > 60) return { ok: false, general: 'Máximo 60 filas por operación.' };
  const normal = filas.map(f => ({
    tipo: limpio(f.tipo) || 'Otro', titulo: limpio(f.titulo).slice(0, 150), cliente: limpio(f.cliente), responsable: limpio(f.responsable),
    fecha: limpio(f.fecha), inicio: limpio(f.inicio), fin: limpio(f.fin), prioridad: limpio(f.prioridad) || 'Normal', obs: limpio(f.obs).slice(0, 800),
    idServ: limpio(f.idServ),
  }));
  if (normal.every(vacia)) return { ok: false, general: 'No hay filas para guardar.' };

  const maestro = await edicion.maestros(true);
  const prog = await leerHoja('PROGRAMACION_DIARIA');
  maestro.idsServicios = new Set(prog.slice(1).map(r => String(r[prog[0].indexOf('ID_Programacion')] || '')).filter(Boolean));
  const errores = validar(normal, maestro);

  if (errores.some(e => e.length)) return { ok: false, errores };

  await asegurarHoja(HOJA, ENC);
  const { filas: existentes } = await cargar();
  const hoy = hoyFlorida().replace(/-/g, '');
  const pref = `PND-${hoy}-`;
  let max = 0;
  existentes.forEach(p => { if (p.ID_Pendiente.startsWith(pref)) max = Math.max(max, parseInt(p.ID_Pendiente.slice(pref.length), 10) || 0); });

  const nuevas = [], ids = [];
  normal.forEach(f => {
    if (vacia(f)) return;
    const id = pref + String(++max).padStart(2, '0');
    const o = { ID_Programacion: f.idServ, ID_Pendiente: id, Tipo: f.tipo, Titulo: f.titulo, Observaciones: f.obs, Cliente: f.cliente, Responsable: f.responsable,
      Fecha_Limite: f.fecha, Hora_Inicio: f.inicio, Hora_Fin: f.fin, Prioridad: f.prioridad, Estado: 'Abierto', Estado_Envio: 'Borrador',
      Creado_Por: admin, Fecha_Creacion: ahora() };
    nuevas.push(ENC.map(n => o[n] ?? '')); ids.push(id);
  });
  await agregarFilas(HOJA, nuevas);
  for (const id of ids) await hist(id, 'Creado', 'Borrador', admin);
  return { ok: true, creados: ids.length };
}

// ---------- Envío (un WhatsApp independiente por pendiente) ----------
function texto(p, titulo) {
  let t = `📌 ${titulo}\n\n${p.Titulo} (${p.ID_Pendiente})\nTipo: ${p.Tipo}`;
  if (p.Cliente) t += `\n🏠 Cliente: ${p.Cliente}`;
  if (p.Fecha_Limite) t += `\n📅 Fecha: ${fechaLeg(p.Fecha_Limite)}${p.Hora_Inicio && p.Hora_Fin ? ` (${hora(p.Hora_Inicio)}–${hora(p.Hora_Fin)})` : ''}`;
  if (p.Prioridad === 'Alta') t += '\n❗ Prioridad alta';
  if (p.Observaciones) t += `\n\n📝 ${p.Observaciones}`;
  t += `\n\nResponde con Reply (Responder) a ESTE mensaje:\n"Ok" cuando esté terminado\n"Pendiente" si sigue abierto (puedes añadir un comentario)\n\nTambién puedes abrirlo aquí:\n${BASE_URL}/pendiente?id=${encodeURIComponent(p.ID_Pendiente)}`;
  return t;
}

async function enviarUno(h, p, titulo) {
  const tel = await buscarTelefonoPorNombre(p.Responsable);
  if (!tel) return 'sinNumero';
  try {
    const sid = await enviarWhatsApp(`whatsapp:+${digitos(tel)}`, texto(p, titulo));
    await asegurarHoja(HOJA_MSG, ENC_MSG);
    await agregarFila(HOJA_MSG, [sid, p.ID_Pendiente, ahora(), titulo]);
  } catch (err) { console.error('Error enviando pendiente', p.ID_Pendiente, err); return 'fallo'; }
  await poner(h, p._fila, { Estado_Envio: 'Enviado', Ultimo_Recordatorio: ahora() });
  return 'ok';
}

async function _enviarLote(lista, h, titulo, admin) {
  let enviados = 0; const sinNumero = [], fallidos = [];
  for (const p of lista) {
    const r = await enviarUno(h, p, titulo);
    if (r === 'ok') { enviados++; await hist(p.ID_Pendiente, titulo === 'Recordatorio' ? 'Recordatorio' : 'Enviado', p.Responsable, admin); }
    else if (r === 'sinNumero') sinNumero.push(p.Responsable);
    else fallidos.push(`${p.Responsable} (${p.ID_Pendiente})`);
  }
  if (enviados) await notificarGerencia(`${titulo === 'Recordatorio' ? 'Recordatorios' : 'Pendientes'} enviados${admin ? ' por ' + admin : ''} — ${enviados} mensaje(s).`, 'rutina');
  if (sinNumero.length) await notificarGerencia(`Pendientes sin enviar, sin WhatsApp: ${[...new Set(sinNumero)].join(', ')}.`, 'atencion');
  if (fallidos.length) await notificarGerencia(`No se pudo enviar el pendiente a: ${fallidos.join('; ')}. Siguen en Borrador.`, 'atencion');
  return { enviados, sinNumero: [...new Set(sinNumero)], fallidos };
}

async function _enviarBorradores(admin) {
  const { h, filas } = await cargar();
  return _enviarLote(filas.filter(p => p.Estado === 'Abierto' && p.Estado_Envio !== 'Enviado' && p.Responsable), h, 'Nuevo pendiente', admin);
}
async function _recordar({ id, responsable }, admin) {
  const { h, filas } = await cargar();
  const lista = filas.filter(p => p.Estado === 'Abierto' && p.Estado_Envio === 'Enviado' && (id ? p.ID_Pendiente === id : p.Responsable === responsable));
  if (!lista.length) return { ok: false, general: 'No hay pendientes abiertos y enviados para recordar.' };
  return { ok: true, ...(await _enviarLote(lista, h, 'Recordatorio', admin)) };
}

// ---------- Editar ----------
const CAMPO_HOJA = { tipo: 'Tipo', titulo: 'Titulo', obs: 'Observaciones', cliente: 'Cliente', idServ: 'ID_Programacion', responsable: 'Responsable', fecha: 'Fecha_Limite', inicio: 'Hora_Inicio', fin: 'Hora_Fin', prioridad: 'Prioridad' };
const CAMPO_ETQ = { tipo: 'Tipo', titulo: 'Título', obs: 'Observaciones', cliente: 'Cliente', idServ: 'Servicio', responsable: 'Responsable', fecha: 'Fecha', inicio: 'Hora de inicio', fin: 'Hora de fin', prioridad: 'Prioridad' };

function aHora24(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?/i);
  if (!m) return '';
  let h = parseInt(m[1], 10);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return String(h).padStart(2, '0') + ':' + m[2];
}
const valoresDe = p => ({
  tipo: limpio(p.Tipo) || 'Otro', titulo: limpio(p.Titulo), obs: limpio(p.Observaciones), cliente: limpio(p.Cliente), idServ: limpio(p.ID_Programacion),
  responsable: limpio(p.Responsable), fecha: normalizarFecha(limpio(p.Fecha_Limite)), inicio: aHora24(p.Hora_Inicio), fin: aHora24(p.Hora_Fin), prioridad: limpio(p.Prioridad) || 'Normal',
});
function datosEdicion(filas) {
  const o = {};
  filas.filter(p => p.Estado === 'Abierto').forEach(p => { o[p.ID_Pendiente] = { ...valoresDe(p), env: p.Estado_Envio === 'Enviado' }; });
  return o;
}

async function avisar(nombre, cuerpo, id, tipoEnvio) {
  try {
    const tel = await buscarTelefonoPorNombre(nombre);
    if (!tel) throw new Error('sin número de WhatsApp');
    const sid = await enviarWhatsApp(`whatsapp:+${digitos(tel)}`, cuerpo);
    if (tipoEnvio) { await asegurarHoja(HOJA_MSG, ENC_MSG); await agregarFila(HOJA_MSG, [sid, id, ahora(), tipoEnvio]); }
    return true;
  } catch (err) { console.error('Aviso de cambio en pendiente', id, err); return false; }
}

async function _editar({ id, datos, admin }) {
  id = limpio(id);
  const r = await obtener(id);
  if (!r) return { ok: false, general: 'Pendiente no encontrado.' };
  const p = r.p;
  if (p.Estado !== 'Abierto') return { ok: false, general: `Este pendiente ya está ${p.Estado.toLowerCase()}: no se puede editar.` };
  datos = datos || {};
  const antes = valoresDe(p);
  const f = {
    tipo: limpio(datos.tipo) || 'Otro', titulo: limpio(datos.titulo).slice(0, 150), cliente: limpio(datos.cliente), responsable: limpio(datos.responsable),
    fecha: limpio(datos.fecha), inicio: limpio(datos.inicio), fin: limpio(datos.fin), prioridad: limpio(datos.prioridad) || 'Normal',
    obs: limpio(datos.obs).slice(0, 800), idServ: limpio(datos.idServ),
  };
  if (vacia(f)) return { ok: false, general: 'El pendiente no puede quedar vacío.' };
  const dif = Object.keys(CAMPO_HOJA).filter(k => antes[k] !== f[k]);
  if (!dif.length) return { ok: false, general: 'No hay cambios para guardar.' };

  const m = await edicion.maestros(true);
  const prog = await leerHoja('PROGRAMACION_DIARIA');
  m.idsServicios = new Set(prog.slice(1).map(x => String(x[prog[0].indexOf('ID_Programacion')] || '')).filter(Boolean));
  // lo que no se cambió se acepta aunque ya no esté activo
  if (f.cliente && f.cliente === antes.cliente) m.clientes = m.clientes.filter(c => c.n !== f.cliente).concat([{ n: f.cliente }]);
  if (f.responsable && f.responsable === antes.responsable) m.empleados = m.empleados.filter(x => x.n !== f.responsable).concat([{ n: f.responsable, wa: true }]);
  const errores = validar([f], m);
  if (errores[0].length) return { ok: false, errores };

  const vals = {};
  dif.forEach(k => { vals[CAMPO_HOJA[k]] = f[k]; });
  await poner(r.h, p._fila, vals);
  const p2 = { ...p, ...vals };

  // Avisos (solo si ya estaba enviado; solo observaciones = silencioso)
  const avisos = [];
  if (p.Estado_Envio === 'Enviado') {
    if (dif.includes('responsable')) {
      const sale = await avisar(antes.responsable, `🔄 Cambio de asignación\n\nYa no estás asignado/a al pendiente "${antes.titulo}" (${id}).`);
      avisos.push({ empleado: antes.responsable, ok: sale });
      const e = await enviarUno(r.h, p2, 'Nuevo pendiente');
      if (e !== 'ok') await poner(r.h, p._fila, { Estado_Envio: 'Borrador' }); // queda para reenviar con "Guardar y enviar"
      avisos.push({ empleado: f.responsable, ok: e === 'ok' });
    } else if (dif.some(k => k !== 'obs')) {
      const lineas = dif.map(k => `${CAMPO_ETQ[k]}: ${antes[k] || '(vacío)'} → ${f[k] || '(vacío)'}`).join('\n');
      const ok = await avisar(f.responsable, `🔄 Cambios en tu pendiente (${id})\n\n${lineas}\n\n${texto(p2, 'Pendiente actualizado')}`, id, 'Pendiente actualizado');
      avisos.push({ empleado: f.responsable, ok });
    }
  }
  const malos = avisos.filter(a => !a.ok).map(a => a.empleado);
  if (malos.length) {
    const reenvio = dif.includes('responsable') && avisos.some(a => a.empleado === f.responsable && !a.ok) ? ' El pendiente volvió a Borrador para reenviarlo.' : '';
    await notificarGerencia(`No se pudo avisar a ${malos.join(', ')} del cambio en el pendiente ${id} (${f.titulo}). Avísale directamente.${reenvio}`, 'urgente');
  }
  await hist(id, 'Editado', dif.map(k => `${CAMPO_ETQ[k]}: ${antes[k] || '(vacío)'} → ${f[k] || '(vacío)'}`).join(' | ')
    + (avisos.length ? ` · Avisos: ${avisos.map(a => `${a.empleado} ${a.ok ? 'Sí' : 'Error'}`).join(', ')}` : ''), admin);
  return { ok: true, avisos };
}

// ---------- Cierre / notas / cancelación ----------
async function _cerrar({ id, nota, por, via }) {
  const r = await obtener(id);
  if (!r) return { ok: false, general: 'Pendiente no encontrado.' };
  if (r.p.Estado !== 'Abierto') return { ok: false, general: `Este pendiente ya está ${r.p.Estado.toLowerCase()}.` };
  nota = limpio(nota).slice(0, 800);
  await poner(r.h, r.p._fila, { Estado: 'Resuelto', Fecha_Cierre: ahora(), Cerrado_Por: `${por} (${via})`, Nota_Cierre: nota });
  await hist(id, 'Resuelto', `${via}. ${nota || '(sin nota)'}`, por);
  await notificarGerencia(`Pendiente resuelto — ${r.p.Titulo} (${r.p.Responsable}) vía ${via}${nota ? `\nNota: ${nota}` : ''}`, 'rutina');
  return { ok: true, p: r.p };
}
async function _nota({ id, nota, por, via }) {
  const r = await obtener(id);
  if (!r) return { ok: false, general: 'Pendiente no encontrado.' };
  if (r.p.Estado !== 'Abierto') return { ok: false, general: `Este pendiente ya está ${r.p.Estado.toLowerCase()}.` };
  nota = limpio(nota).slice(0, 800);
  if (nota) {
    const linea = `[${ahora()}] ${por}: ${nota}`;
    await poner(r.h, r.p._fila, { Notas_Seguimiento: r.p.Notas_Seguimiento ? r.p.Notas_Seguimiento + '\n' + linea : linea });
  }
  await hist(id, 'Sigue abierto', `${via}. ${nota || '(sin nota)'}`, por);
  await notificarGerencia(`Pendiente sigue abierto — ${r.p.Titulo} (${r.p.Responsable})${nota ? `\nNota: ${nota}` : ''}`, 'rutina');
  return { ok: true, p: r.p };
}
async function _cancelar({ id, motivo, admin }) {
  motivo = limpio(motivo);
  if (motivo.length < 3) return { ok: false, general: 'El motivo es obligatorio.' };
  const r = await obtener(id);
  if (!r) return { ok: false, general: 'Pendiente no encontrado.' };
  if (r.p.Estado !== 'Abierto') return { ok: false, general: `Este pendiente ya está ${r.p.Estado.toLowerCase()}.` };
  await poner(r.h, r.p._fila, { Estado: 'Cancelado', Fecha_Cierre: ahora(), Cerrado_Por: `${admin} (Agenda web)`, Nota_Cierre: motivo });
  await hist(id, 'Cancelado', motivo, admin);
  return { ok: true };
}

// ---------- WhatsApp entrante ----------
const RE_OK = /^(ok|listo)\b[\s,.:;-]*([\s\S]*)$/i;
const RE_PEND = /^pendiente\b[\s,.:;-]*([\s\S]*)$/i;

async function procesarReply(telefono, texto, sid) {
  await asegurarHoja(HOJA_MSG, ENC_MSG);
  const datos = await leerHoja(HOJA_MSG);
  const fila = datos.slice(1).find(r => r[0] === sid);
  if (!fila) return null; // no es respuesta a un pendiente: siguen los otros flujos
  const id = fila[1];
  const emp = await buscarEmpleadoPorTelefono(telefono);
  const r = await obtener(id);
  if (!r || emp !== r.p.Responsable) return null;
  if (r.p.Estado !== 'Abierto') return `El pendiente ${id} ya está ${r.p.Estado.toLowerCase()}.`;
  const t = texto.trim();
  let m;
  if ((m = t.match(RE_OK))) {
    const x = await enSerie(() => _cerrar({ id, nota: m[2], por: emp, via: 'WhatsApp' }));
    return x.ok ? `✅ Pendiente resuelto: ${r.p.Titulo}. ¡Gracias!` : x.general;
  }
  if ((m = t.match(RE_PEND))) {
    const x = await enSerie(() => _nota({ id, nota: m[1], por: emp, via: 'WhatsApp' }));
    return x.ok ? `👍 Quedó abierto: ${r.p.Titulo}.` : x.general;
  }
  return 'Para este pendiente responde "Ok" si está terminado o "Pendiente" si sigue abierto (puedes añadir un comentario).';
}

// "Ok" sin Reply: solo si el empleado tiene un único pendiente abierto y enviado
async function procesarOkSinReply(telefono, texto) {
  const m = texto.trim().match(RE_OK);
  if (!m) return null;
  const emp = await buscarEmpleadoPorTelefono(telefono);
  if (!emp) return null;
  const { filas } = await cargar();
  const ab = filas.filter(p => p.Responsable === emp && p.Estado === 'Abierto' && p.Estado_Envio === 'Enviado');
  if (!ab.length) return null;
  if (ab.length > 1) return `Tienes ${ab.length} pendientes abiertos. Responde con Reply (Responder) directamente al mensaje del pendiente que terminaste.`;
  const x = await enSerie(() => _cerrar({ id: ab[0].ID_Pendiente, nota: m[2], por: emp, via: 'WhatsApp' }));
  return x.ok ? `✅ Pendiente resuelto: ${ab[0].Titulo}. ¡Gracias!` : x.general;
}

// ---------- Páginas ----------
const CSS = `
body{font-family:-apple-system,Arial,sans-serif;margin:0;padding:20px 28px;color:#222;background:#f6f7f9;}
a{color:#1d4ed8;text-decoration:none;} .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;}
.btn{background:#fff;border:1px solid #ccc;border-radius:6px;padding:7px 12px;font-size:14px;cursor:pointer;color:#222;display:inline-block;}
.ok{background:#2e7d32;color:#fff;border-color:#2e7d32;}
.box{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:14px;}
table{width:100%;border-collapse:collapse;background:#fff;} th,td{padding:8px;text-align:left;font-size:14px;border-bottom:1px solid #eee;vertical-align:top;}
th{background:#f1f3f5;} select,input[type=text],input[type=date],input[type=time]{padding:6px;border:1px solid #ccc;border-radius:6px;font-size:14px;}
.est{padding:2px 8px;border-radius:10px;font-size:12px;background:#e5e7eb;} .Resuelto{background:#bbf7d0;} .venc{background:#fecaca;} .alta{color:#b91c1c;font-weight:600;}
.mal{color:#b91c1c;font-size:12px;} small{color:#777;} .filtros{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center;}`;

async function paginaPendientes(query, admin) {
  const { filas } = await cargar();
  const m = await edicion.maestros(false);
  const hoy = hoyFlorida();
  const f = { responsable: query.responsable || '', estado: query.estado === undefined ? 'Abierto' : query.estado, tipo: query.tipo || '', venc: query.vencidos === '1' };
  const vis = filas.filter(p => (!f.responsable || p.Responsable === f.responsable) && (!f.estado || p.Estado === f.estado) &&
    (!f.tipo || p.Tipo === f.tipo) && (!f.venc || vencido(p, hoy)))
    .sort((a, b) => (vencido(b, hoy) - vencido(a, hoy)) || (normalizarFecha(a.Fecha_Limite) || '9').localeCompare(normalizarFecha(b.Fecha_Limite) || '9'));
  const sel = (n, et, ops, v) => `<select name="${n}"><option value="">${et}</option>${ops.map(o => `<option value="${esc(o)}"${v === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  const resp = [...new Set(filas.map(p => p.Responsable).filter(Boolean))].sort();

  const rows = vis.length ? vis.map(p => {
    const v = vencido(p, hoy);
    const id = esc(p.ID_Pendiente);
    const acc = p.Estado === 'Abierto' ? `<button class="btn" data-id="${id}" onclick="tpEditar(this.dataset.id)">Editar</button>
      <button class="btn" data-id="${id}" onclick="tpCerrar(this.dataset.id)">Resolver</button>
      ${p.Estado_Envio === 'Enviado' ? `<button class="btn" data-id="${id}" onclick="tpRecordar(this.dataset.id)">Recordar</button>` : ''}
      <button class="btn" data-id="${id}" onclick="tpCancelar(this.dataset.id)">Cancelar</button>` : '';
    const det = [['Observaciones', p.Observaciones], ['Seguimiento', p.Notas_Seguimiento], ['Cierre', p.Nota_Cierre && `${p.Nota_Cierre} — ${p.Cerrado_Por} ${p.Fecha_Cierre}`], ['Creado', `${p.Creado_Por} ${p.Fecha_Creacion}`], ['Último recordatorio', p.Ultimo_Recordatorio]]
      .filter(x => x[1]).map(x => `<div><small>${esc(x[0])}</small><br><span style="white-space:pre-wrap">${esc(x[1])}</span></div>`).join('');
        return `<tr><td>${id}</td><td>${esc(p.Tipo)}</td><td>${p.Prioridad === 'Alta' ? '<span class="alta">❗</span> ' : ''}${esc(p.Titulo)}${p.ID_Programacion ? `<br><small>Servicio: ${esc(p.ID_Programacion)}</small>` : ''}<details><summary><small>Detalle</small></summary>${det}</details></td>
      <td>${esc(p.Cliente)}</td><td>${esc(p.Responsable)}</td><td>${esc(fechaLeg(p.Fecha_Limite))}${p.Hora_Inicio ? `<br><small>${esc(hora(p.Hora_Inicio))}–${esc(hora(p.Hora_Fin))}</small>` : ''}</td>
      <td><span class="est ${esc(p.Estado)}">${esc(p.Estado)}</span>${v ? ' <span class="est venc">Vencido</span>' : ''}<br><small>${esc(p.Estado_Envio)}</small></td><td>${acc}</td></tr>`;
  }).join('') : '<tr><td colspan="8" style="text-align:center;color:#888;padding:24px;">No hay pendientes con este filtro.</td></tr>';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pendientes</title><style>${CSS}${require('./menu').MENU_CSS}</style></head><body>
<div class="top"><h2 style="margin:0;">Pendientes</h2>${require('./menu').menuHtml('/pendientes', admin)} </div>
<section class="box"><h3 style="margin:0 0 10px;">Nuevos pendientes <small>(se guardan como Borrador)</small></h3>
<table><thead><tr><th>Tipo</th><th>Título</th><th>Cliente</th><th>ID servicio</th><th>Responsable</th><th>Fecha</th><th>Horario</th><th>Prioridad</th><th>Observaciones</th><th>Validación</th><th></th></tr></thead><tbody id="gc"></tbody></table>
<div style="margin-top:10px;display:flex;gap:10px;align-items:center;"><button class="btn" id="mas">+ Fila</button><button class="btn ok" id="gu">Guardar borrador</button><button class="btn ok" id="en">Guardar y enviar al equipo</button><span id="msg" class="mal"></span></div></section>
<form class="filtros" method="GET" action="/pendientes">${sel('responsable', 'Todos los responsables', resp, f.responsable)}${sel('estado', 'Todos los estados', ['Abierto', 'Resuelto', 'Cancelado'], f.estado)}
${sel('tipo', 'Todos los tipos', TIPOS, f.tipo)}<label><input type="checkbox" name="vencidos" value="1"${f.venc ? ' checked' : ''}> Solo vencidos</label>
<button class="btn">Filtrar</button> <a class="btn" href="/pendientes?estado=">Todos</a> <a class="btn" href="/pendientes">Limpiar</a>
${f.responsable ? `<button type="button" class="btn" onclick="tpRecordarEmp(${esc(js(f.responsable))})">Recordar los abiertos de ${esc(f.responsable)}</button>` : ''}</form>
<table><tr><th>ID</th><th>Tipo</th><th>Pendiente</th><th>Cliente</th><th>ID servicio</th><th>Responsable</th><th>Fecha</th><th>Estado</th><th>Acciones</th></tr>${rows}</table>
<script>
(function(){
  var M=${js({ clientes: m.clientes.map(c => c.n), empleados: m.empleados.map(e => ({ n: e.n, wa: e.wa })) })}, TIPOS=${js(TIPOS)}, PRIOS=${js(PRIOS)}, EDIT=${js(datosEdicion(filas))};
  var cuerpo=document.getElementById('gc'), msg=document.getElementById('msg');
  function el(t,p){var e=document.createElement(t);for(var k in p)e[k]=p[k];return e;}
  function sel(c,ops,v,vacio){var s=el('select',{className:c});if(vacio)s.appendChild(el('option',{value:'',textContent:vacio}));ops.forEach(function(o){var n=o.n||o;s.appendChild(el('option',{value:n,textContent:n+(o.wa===false?' ⚠ sin WhatsApp':'')}));});s.value=v||'';return s;}
  function td(h){var c=el('td');c.appendChild(h);return c;}
  function agregar(){
    var tr=el('tr');
    tr.appendChild(td(sel('t',TIPOS,'Otro')));
    tr.appendChild(td(el('input',{type:'text',className:'ti',placeholder:'Título',maxLength:150})));
    tr.appendChild(td(sel('c',M.clientes,'','(sin cliente)')));
    tr.appendChild(td(el('input',{type:'text',className:'sv',placeholder:'PRG-AAAAMMDD-NN',size:16})));
    tr.appendChild(td(sel('r',M.empleados,'','Responsable…')));
    tr.appendChild(td(el('input',{type:'date',className:'fe'})));
    var h=el('td');h.appendChild(el('input',{type:'time',className:'i'}));h.appendChild(document.createTextNode(' – '));h.appendChild(el('input',{type:'time',className:'f'}));tr.appendChild(h);
    tr.appendChild(td(sel('p',PRIOS,'Normal')));
    tr.appendChild(td(el('input',{type:'text',className:'o',placeholder:'Observaciones',maxLength:800})));
    tr.appendChild(el('td',{className:'mal'}));
    tr.appendChild(td(el('button',{type:'button',className:'btn',textContent:'✕',onclick:function(){tr.remove();}})));
    cuerpo.appendChild(tr);
  }
  function leer(){return Array.prototype.map.call(cuerpo.rows, function(tr){var q=function(c){return tr.querySelector('.'+c).value;};
    return {tipo:q('t'),titulo:q('ti'),cliente:q('c'),idServ:q('sv'),responsable:q('r'),fecha:q('fe'),inicio:q('i'),fin:q('f'),prioridad:q('p'),obs:q('o')};});}
  function post(u,d){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(d)})
    .then(function(r){if(r.status===401){location.href='/login?volver='+encodeURIComponent(location.pathname+location.search);return null;}return r.json();});}
  function guardar(enviar,b){
    var f=leer();
    if(enviar&&!confirm('¿Guardar y enviar? Cada responsable recibirá un mensaje por cada pendiente en Borrador.'))return;
    b.disabled=true;msg.textContent=enviar?'Enviando…':'';
    post('/pendientes/guardar',{filas:f,enviar:enviar,soloEnviar:false}).then(function(r){
      b.disabled=false;if(!r)return;
      if(r.general){msg.textContent=r.general;return;}
      if(!r.ok){Array.prototype.forEach.call(cuerpo.rows,function(tr,i){tr.cells[9].textContent=((r.errores&&r.errores[i])||[]).join(' · ');});msg.textContent='No se guardó: revisa las filas marcadas.';return;}
      var t='Creados: '+r.creados;
      if(enviar){t+='\\nEnviados: '+r.enviados;if(r.sinNumero&&r.sinNumero.length)t+='\\nSin WhatsApp: '+r.sinNumero.join(', ');if(r.fallidos&&r.fallidos.length)t+='\\nFallaron: '+r.fallidos.join(', ')+' (siguen en Borrador)';}
      alert(t);location.reload();
    }).catch(function(){b.disabled=false;msg.textContent='Error de conexión.';});
  }
  document.getElementById('mas').onclick=agregar;
  document.getElementById('gu').onclick=function(){guardar(false,this);};
  document.getElementById('en').onclick=function(){
    var f=leer().filter(function(x){return x.titulo||x.responsable||x.obs||x.cliente;});
    if(!f.length){ // sin filas nuevas: solo envía los Borrador existentes
      if(!confirm('¿Enviar los pendientes en Borrador?'))return;var b=this;b.disabled=true;
      post('/pendientes/guardar',{filas:[],enviar:true,soloEnviar:true}).then(function(r){b.disabled=false;if(!r)return;if(r.general){alert(r.general);return;}
        var t='Enviados: '+r.enviados;if(r.sinNumero&&r.sinNumero.length)t+='\\nSin WhatsApp: '+r.sinNumero.join(', ');if(r.fallidos&&r.fallidos.length)t+='\\nFallaron: '+r.fallidos.join(', ');alert(t);location.reload();});
      return;}
    guardar(true,this);
  };
  window.tpCerrar=function(id){var n=prompt('Nota de cierre (opcional):');if(n===null)return;post('/pendientes/cerrar',{id:id,nota:n}).then(function(r){if(!r)return;if(!r.ok){alert(r.general);return;}location.reload();});};
  window.tpCancelar=function(id){var n=prompt('Motivo de la cancelación (obligatorio):');if(n===null)return;post('/pendientes/cancelar',{id:id,motivo:n}).then(function(r){if(!r)return;if(!r.ok){alert(r.general);return;}location.reload();});};
  window.tpRecordar=function(id){post('/pendientes/recordar',{id:id}).then(function(r){if(!r)return;alert(r.ok?'Recordatorio enviado: '+r.enviados:r.general);location.reload();});};
  window.tpRecordarEmp=function(n){if(!confirm('¿Enviar un recordatorio por cada pendiente abierto de '+n+'?'))return;post('/pendientes/recordar',{responsable:n}).then(function(r){if(!r)return;alert(r.ok?'Recordatorios enviados: '+r.enviados:r.general);location.reload();});};

  var ED=null, dlg=null, F={};
  function opcionesSel(s,lista,v,vacio){
    if(vacio)s.appendChild(el('option',{value:'',textContent:vacio}));
    var hay=false;
    lista.forEach(function(o){var n=o.n||o;if(n===v)hay=true;s.appendChild(el('option',{value:n,textContent:n+(o.wa===false?' ⚠ sin WhatsApp':'')}));});
    if(v&&!hay)s.appendChild(el('option',{value:v,textContent:v+' (no activo)'}));
    s.value=v||'';
  }
  function campoEd(k,et,nodo){
    F[k]=nodo;var l=el('label',{});l.style.display='block';l.style.margin='8px 0';
    l.appendChild(document.createTextNode(et));l.appendChild(el('br',{}));
    nodo.style.width='100%';nodo.style.boxSizing='border-box';l.appendChild(nodo);dlg.appendChild(l);
  }
  function construirDlg(){
    dlg=el('dialog',{});
    dlg.style.cssText='max-width:440px;width:92%;border:1px solid #ccc;border-radius:10px;padding:18px;';
    var h=el('h3',{textContent:'Editar pendiente'});h.style.marginTop='0';dlg.appendChild(h);
    var sT=el('select',{});TIPOS.forEach(function(t){sT.appendChild(el('option',{value:t,textContent:t}));});
    var sP=el('select',{});PRIOS.forEach(function(t){sP.appendChild(el('option',{value:t,textContent:t}));});
    campoEd('tipo','Tipo',sT);
    campoEd('titulo','Título',el('input',{type:'text',maxLength:150}));
    campoEd('cliente','Cliente',el('select',{}));
    campoEd('idServ','ID de servicio (opcional)',el('input',{type:'text',placeholder:'PRG-AAAAMMDD-NN'}));
    campoEd('responsable','Responsable',el('select',{}));
    campoEd('fecha','Fecha límite',el('input',{type:'date'}));
    var hi=el('input',{type:'time'}),hf=el('input',{type:'time'});F.inicio=hi;F.fin=hf;
    var lh=el('label',{});lh.style.display='block';lh.style.margin='8px 0';
    lh.appendChild(document.createTextNode('Horario'));lh.appendChild(el('br',{}));lh.appendChild(hi);lh.appendChild(document.createTextNode(' – '));lh.appendChild(hf);dlg.appendChild(lh);
    campoEd('prioridad','Prioridad',sP);
    campoEd('obs','Observaciones',el('input',{type:'text',maxLength:800}));
    F.nota=el('p',{});F.nota.style.cssText='font-size:12px;color:#777;';dlg.appendChild(F.nota);
    F.err=el('p',{className:'mal'});dlg.appendChild(F.err);
    var bo=el('button',{type:'button',className:'btn ok',textContent:'Guardar'});bo.onclick=guardarEd;F.btn=bo;
    var bc=el('button',{type:'button',className:'btn',textContent:'Cancelar'});bc.onclick=function(){dlg.close();};
    var bx=el('div',{});bx.appendChild(bo);bx.appendChild(document.createTextNode(' '));bx.appendChild(bc);dlg.appendChild(bx);
    document.body.appendChild(dlg);
  }
  function guardarEd(){
    var d={tipo:F.tipo.value,titulo:F.titulo.value,cliente:F.cliente.value,idServ:F.idServ.value,responsable:F.responsable.value,fecha:F.fecha.value,inicio:F.inicio.value,fin:F.fin.value,prioridad:F.prioridad.value,obs:F.obs.value};
    F.btn.disabled=true;F.err.textContent='';
    post('/pendientes/editar',{id:ED,datos:d}).then(function(r){
      F.btn.disabled=false;if(!r)return;
      if(r.general){F.err.textContent=r.general;return;}
      if(!r.ok){F.err.textContent=((r.errores&&r.errores[0])||[]).join(' · ')||'No se guardó.';return;}
      var malos=(r.avisos||[]).filter(function(a){return !a.ok;}).map(function(a){return a.empleado;});
      if(malos.length)alert('Guardado, pero no se pudo avisar por WhatsApp a: '+malos.join(', ')+'. Avísale directamente.');
      location.reload();
    }).catch(function(){F.btn.disabled=false;F.err.textContent='Error de conexión.';});
  }
  window.tpEditar=function(id){
    var d=EDIT[id];if(!d)return;
    if(!dlg)construirDlg();
    ED=id;
    F.tipo.value=d.tipo;F.titulo.value=d.titulo;F.obs.value=d.obs;F.idServ.value=d.idServ;F.fecha.value=d.fecha;
    F.inicio.value=d.inicio;F.fin.value=d.fin;F.prioridad.value=d.prioridad;
    F.cliente.innerHTML='';opcionesSel(F.cliente,M.clientes,d.cliente,'(sin cliente)');
    F.responsable.innerHTML='';opcionesSel(F.responsable,M.empleados,d.responsable,'Responsable…');
    F.nota.textContent=d.env?'Ya enviado: cualquier cambio, salvo observaciones, avisa al empleado por WhatsApp. Si cambias el responsable, avisa al anterior y al nuevo.':'Borrador: no se avisa a nadie.';
    F.err.textContent='';dlg.showModal();
  };

  agregar();
})();
</script></body></html>`;
}

function paginaPendienteEmpleado(p, mensaje) {
  const cab = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pendiente</title></head><body style="font-family:-apple-system,Arial,sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#222;">';
  if (!p) return cab + '<h2>Pendiente no encontrado.</h2></body></html>';
  const info = `<h2 style="color:#1d4ed8;margin-bottom:4px;">${esc(p.Titulo)}</h2><p style="color:#555;">${esc(p.Tipo)} · ${esc(p.ID_Pendiente)}${p.Cliente ? '<br>🏠 ' + esc(p.Cliente) : ''}${p.Fecha_Limite ? '<br>📅 ' + esc(fechaLeg(p.Fecha_Limite)) : ''}</p>${p.Observaciones ? `<p style="white-space:pre-wrap;">📝 ${esc(p.Observaciones)}</p>` : ''}`;
  if (mensaje) return cab + info + `<p style="font-size:17px;">${esc(mensaje)}</p></body></html>`;
  if (p.Estado !== 'Abierto') return cab + info + `<p style="color:#b45309;font-size:17px;">⚠️ Este pendiente ya está ${esc(p.Estado.toLowerCase())}.</p></body></html>`;
  return cab + info + `<form method="POST" action="/pendiente"><input type="hidden" name="id" value="${esc(p.ID_Pendiente)}">
<textarea name="nota" placeholder="Comentario (opcional)" style="width:100%;min-height:90px;padding:10px;font-size:15px;box-sizing:border-box;border:1px solid #ccc;border-radius:6px;"></textarea>
<button name="accion" value="ok" style="background:#2e7d32;color:#fff;padding:14px;border:none;border-radius:8px;font-size:17px;width:100%;margin-top:14px;">✅ Marcar como resuelto</button>
<button name="accion" value="pendiente" style="background:#fff;color:#222;padding:14px;border:1px solid #ccc;border-radius:8px;font-size:17px;width:100%;margin-top:10px;">Sigue pendiente</button></form></body></html>`;
}

async function procesarPendienteWeb(body) {
  const r = await obtener(limpio(body.id));
  if (!r) return paginaPendienteEmpleado(null);
  const por = r.p.Responsable;
  const x = body.accion === 'ok'
    ? await enSerie(() => _cerrar({ id: r.p.ID_Pendiente, nota: body.nota, por, via: 'Enlace' }))
    : await enSerie(() => _nota({ id: r.p.ID_Pendiente, nota: body.nota, por, via: 'Enlace' }));
  return paginaPendienteEmpleado(r.p, x.ok ? (body.accion === 'ok' ? '✅ Pendiente resuelto. ¡Gracias!' : '👍 Quedó abierto.') : x.general);
}

// ---------- API pública del módulo ----------
const guardar = ({ filas, admin, enviar, soloEnviar }) => enSerie(async () => {
  if (!soloEnviar) { const c = await _crear(filas, admin); if (!c.ok) return c; var creados = c.creados; }
  if (!enviar) return { ok: true, creados };
  return { ok: true, creados: creados || 0, ...(await _enviarBorradores(admin)) };
});

module.exports = {
  paginaPendientes, paginaPendienteEmpleado, procesarPendienteWeb, procesarReply, procesarOkSinReply, obtener,
  guardar,
  cerrar: a => enSerie(() => _cerrar(a)),
  cancelar: a => enSerie(() => _cancelar(a)),
  editar: a => enSerie(() => _editar(a)),
  recordar: (a, admin) => enSerie(() => _recordar(a, admin)),
};