const { leerHoja, edadCacheSegundos } = require('./sheets');

const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const ESTADOS = ['Borrador', 'Enviado', 'Confirmado', 'No puede', 'En curso', 'Salida (falta cierre)', 'Finalizado', 'Cancelado'];

const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function hoyFlorida() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
function fechaValida(t) {
  return /^\d{4}-\d{2}-\d{2}$/.test(t || '') && new Date(t + 'T00:00:00Z').toISOString().slice(0, 10) === t;
}
function sumarDias(f, n) { const d = new Date(f + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function inicioSemana(f) { return sumarDias(f, -((new Date(f + 'T00:00:00Z').getUTCDay() + 6) % 7)); }
function diaSemana(f) { return DIAS[new Date(f + 'T00:00:00Z').getUTCDay()]; }

function normalizarFecha(valor) {
  const texto = String(valor || '').trim();
  const iso = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const p = texto.split('/');
  if (p.length === 3) return `${p[2].slice(0, 4)}-${p[0].padStart(2, '0')}-${p[1].padStart(2, '0')}`;
  return texto;
}

function estadoDe(r) {
  if (r.Cancelado === 'Sí') return 'Cancelado';
  if (r.Servicio_Finalizado === 'Sí') return 'Finalizado';
  if (r.Hora_Salida_Real) return 'Salida (falta cierre)';
  if (r.Hora_Entrada_Real) return 'En curso';
  if (r.Estado_Confirmacion === 'No puede') return 'No puede';
  if (r.Estado_Confirmacion === 'Confirmado') return 'Confirmado';
  if (r.Estado_Envio === 'Enviado') return 'Enviado';
  return 'Borrador';
}
const tipoDe = r => r.Tipo_Servicio || 'Limpieza';
const accionPendiente = r => r.Requiere_Accion_Correctiva === 'Sí' && r.Estado_Correccion === 'Pendiente';

function estadoDia(regs, fecha, hoy) {
  const activos = regs.filter(r => r._estado !== 'Cancelado');
  if (!activos.length) return 'vacio';
  if (activos.some(r => r._estado === 'No puede' || accionPendiente(r))) return 'alerta';
  if (fecha < hoy && activos.some(r => r._estado !== 'Finalizado')) return 'alerta';
  if (activos.every(r => r._estado === 'Finalizado')) return 'ok';
  return 'pendiente';
}

// Una sola lectura (en caché) y se quedan solo las filas del rango pedido
async function filasDelRango(desde, hasta) {
  const datos = await leerHoja('PROGRAMACION_DIARIA', { cache: true });
  if (!datos.length) return [];
  const headers = datos[0];
  const filas = [];
  for (let i = 1; i < datos.length; i++) {
    const fecha = normalizarFecha(datos[i][headers.indexOf('Fecha_Servicio')]);
    if (!fechaValida(fecha) || fecha < desde || fecha > hasta) continue;
    const r = { _fecha: fecha, _filaSheet: i + 1 };
    headers.forEach((h, j) => { r[h] = datos[i][j] === undefined ? '' : String(datos[i][j]); });
    r._estado = estadoDe(r);
    filas.push(r);
  }
  return filas;
}

async function quejasPorServicio(ids) {
  const datos = await leerHoja('QUEJAS', { cache: true });
  const mapa = {};
  if (datos.length < 2) return mapa;
  const h = datos[0];
  const iId = h.indexOf('ID_Programacion');
  for (let i = 1; i < datos.length; i++) {
    const id = datos[i][iId];
    if (!id || !ids.has(id)) continue;
    const q = {};
    h.forEach((n, j) => { q[n] = datos[i][j] || ''; });
    (mapa[id] = mapa[id] || []).push(q);
  }
  return mapa;
}

async function cambiosPorServicio(ids) {
  const mapa = {};
  try {
    const datos = await leerHoja('CAMBIOS_PROGRAMACION', { cache: true });
    if (datos.length < 2) return mapa;
    const h = datos[0];
    const iId = h.indexOf('ID_Programacion');
    for (let i = 1; i < datos.length; i++) {
      const id = datos[i][iId];
      if (!id || !ids.has(id)) continue;
      const c = {};
      h.forEach((n, j) => { c[n] = datos[i][j] || ''; });
      (mapa[id] = mapa[id] || []).push(c);
    }
  } catch (e) { /* la hoja se crea con el primer cambio */ }
  return mapa;
}


function bloque(titulo, pares) {
  const llenos = pares.filter(([, v]) => v !== undefined && String(v).trim() !== '');
  const cuerpo = llenos.length
    ? llenos.map(([k, v]) => `<div class="par"><span>${esc(k)}</span><b>${v && v.__html ? v.__html : esc(v)}</b></div>`).join('')
    : '<div class="vacio">Sin registro</div>';
  return `<div class="bloque"><h4>${esc(titulo)}</h4>${cuerpo}</div>`;
}

function lineaDeVida(r, quejas, cambios) {
  const c = (cambios || []).map(x => `${x.Fecha_Hora} · ${x.Realizado_Por}: ${x.Tipo_Cambio} — ${x.Detalle}${x.Empleado_Notificado ? ` (avisó a ${x.Empleado_Notificado}: ${x.Aviso_Enviado})` : ` (${x.Aviso_Enviado})`}`).join('\n');
  const horario = (r.Hora_Inicio && r.Hora_Fin) ? `${r.Hora_Inicio} – ${r.Hora_Fin}` : r.Horario;
  const maps = /^https?:\/\//i.test(r.Google_Maps_Link) ? { __html: `<a href="${esc(r.Google_Maps_Link)}" target="_blank" rel="noopener">Abrir mapa</a>` } : r.Google_Maps_Link;
  const q = (quejas || []).map(x => `${x.Tipo} (${x.Estado}): ${x.Descripcion}`).join('\n');
  return '<div class="vida">' + [
    bloque('Programación', [['ID', r.ID_Programacion], ['Horario', horario], ['Dirección', r.Direccion], ['Mapa', maps],
      ['Descripción', r.Descripcion_Servicio], ['Instrucciones', r.Instrucciones], ['Observaciones del día', r.Observaciones_Puntuales],
      ['Creado por', r.Creado_Por && `${r.Creado_Por} (${r.Fecha_Creacion})`], ['Modificado por', r.Modificado_Por && `${r.Modificado_Por} (${r.Fecha_Modificacion})`],
      ['Cancelación', r.Cancelado === 'Sí' ? (r.Motivo_Cancelacion || 'Sí') : '']]),
    bloque('Envío y confirmación', [['Envío', r.Estado_Envio], ['Confirmación', r.Estado_Confirmacion], ['Motivo "No puedo"', r.Motivo_No_Puede], ['Fecha/hora', r.Fecha_Hora_Confirmacion]]),
    bloque('Entrada', [['Hora', r.Hora_Entrada_Real], ['Latitud', r.Lat_Entrada], ['Longitud', r.Lon_Entrada], ['Dentro de rango', r.Dentro_Rango_Entrada]]),
    bloque('Salida', [['Hora', r.Hora_Salida_Real], ['Latitud', r.Lat_Salida], ['Longitud', r.Lon_Salida], ['Dentro de rango', r.Dentro_Rango_Salida]]),
    bloque('Cierre', [['Tareas pendientes', r.Tareas_Pendientes], ['Insumos faltantes', r.Insumos_Faltantes], ['Comentario', r.Comentario_Empleado], ['Fotos', r.Fotos_Resultado], ['Finalizado', r.Servicio_Finalizado]]),
    bloque('Inspección', [['Servicio inspeccionado', r.ID_Servicio_Inspeccionado], ['Resultado', r.Resultado_Inspeccion], ['Requiere acción correctiva', r.Requiere_Accion_Correctiva], ['Estado corrección', r.Estado_Correccion]]),
    bloque('Avisos', [['Avisos durante el servicio', r.Avisos_Durante_Servicio], ['Aviso confirmado', r.Aviso_Confirmado]]),
    bloque('Cambios posteriores al envío', [['Registro', c]]),
    bloque('Quejas y dudas', [['Asociadas', q]]),
  ].join('') + '</div>';
}

const CSS = `
body{font-family:-apple-system,Arial,sans-serif;margin:0;padding:20px 28px;color:#222;background:#f6f7f9;}
a{color:#1d4ed8;text-decoration:none;}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;}
.nav{display:flex;gap:8px;align-items:center;margin-bottom:12px;}
.btn{background:#fff;border:1px solid #ccc;border-radius:6px;padding:7px 12px;font-size:14px;cursor:pointer;color:#222;}
.hoy{background:#2e7d32;color:#fff;border-color:#2e7d32;}
.semana{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;margin-bottom:14px;}
.dia{background:#fff;border:2px solid #e5e7eb;border-radius:8px;padding:8px;text-align:center;color:#222;font-size:13px;}
.dia.sel{border-color:#1d4ed8;} .dia b{display:block;font-size:18px;}
.punto{display:inline-block;width:10px;height:10px;border-radius:50%;margin-left:4px;}
.ok{background:#16a34a;} .pendiente{background:#eab308;} .alerta{background:#dc2626;} .vacio{background:#d1d5db;}
.aviso{background:#eef2ff;border-radius:6px;padding:8px 12px;font-size:14px;margin-bottom:12px;}
.filtros{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;}
.filtros select{padding:7px;border:1px solid #ccc;border-radius:6px;font-size:14px;}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;}
th,td{padding:9px 10px;text-align:left;font-size:14px;border-bottom:1px solid #eee;}
th{background:#f1f3f5;} .canc{text-decoration:line-through;color:#888;}
.est{padding:2px 8px;border-radius:10px;font-size:12px;background:#e5e7eb;}
.est.Finalizado{background:#bbf7d0;} .est.Cancelado{background:#e5e7eb;color:#666;} .est[class*="No"]{background:#fecaca;}
details{background:#fff;margin:0;} summary{cursor:pointer;color:#1d4ed8;font-size:13px;}
.vida{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;padding:10px 4px;}
.bloque{background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:8px 10px;}
.bloque h4{margin:0 0 6px;font-size:13px;color:#555;}
.par{font-size:13px;margin:3px 0;white-space:pre-wrap;} .par span{color:#777;display:block;font-size:11px;}
.vacio{font-size:12px;color:#999;}`;

async function paginaAgenda(query, admin) {
  const hoy = hoyFlorida();
  const fecha = fechaValida(query.fecha) ? query.fecha : hoy;
  const lunes = inicioSemana(fecha);
  const domingo = sumarDias(lunes, 6);

  const filasSemana = await filasDelRango(lunes, domingo);
  const delDia = filasSemana.filter(r => r._fecha === fecha);
  const quejas = await quejasPorServicio(new Set(delDia.map(r => r.ID_Programacion)));
  const cambios = await cambiosPorServicio(new Set(delDia.map(r => r.ID_Programacion)));

  // Filtros (las opciones salen de las filas del día)
  const f = { cliente: query.cliente || '', empleado: query.empleado || '', estado: query.estado || '', tipo: query.tipo || '' };
  const visibles = delDia.filter(r =>
    (!f.cliente || r.Cliente === f.cliente) && (!f.empleado || r.Empleado === f.empleado) &&
    (!f.estado || r._estado === f.estado) && (!f.tipo || tipoDe(r) === f.tipo))
    .sort((a, b) => (a.Hora_Inicio || a.Horario || '').localeCompare(b.Hora_Inicio || b.Horario || ''));

  const unicos = campo => [...new Set(delDia.map(r => r[campo]).filter(Boolean))].sort();
  const sel = (nombre, etiqueta, opciones) => `<select name="${nombre}"><option value="">${etiqueta}</option>` +
    opciones.map(o => `<option value="${esc(o)}"${f[nombre] === o ? ' selected' : ''}>${esc(o)}</option>`).join('') + '</select>';

  const tira = Array.from({ length: 7 }, (_, i) => {
    const d = sumarDias(lunes, i);
    const regs = filasSemana.filter(r => r._fecha === d);
    const n = regs.filter(r => r._estado !== 'Cancelado').length;
    const est = estadoDia(regs, d, hoy);
    return `<a class="dia${d === fecha ? ' sel' : ''}" href="/agenda?fecha=${d}">${diaSemana(d)}<b>${d.slice(8)}</b>${n} serv.<span class="punto ${est}" title="${est}"></span></a>`;
  }).join('');

  const pasada = fecha < hoy;
  const ed = pasada ? null : require('./edicion'); // carga diferida: evita dependencia circular
  const maestrosDatos = ed ? await ed.maestros(false) : null;
  const aviso = pasada ? 'Fecha pasada: solo lectura.' : 'Modo editable: los servicios nuevos se guardan como Borrador hasta enviarlos.';

  const acciones = r => {
    if (!ed || r._estado === 'Cancelado' || r.Hora_Entrada_Real) return '';
    const id = esc(r.ID_Programacion);
    return `<button class="btn" data-id="${id}" onclick="tcEditar(this.dataset.id,false)">Editar</button>
      <button class="btn" data-id="${id}" onclick="tcEditar(this.dataset.id,true)">Reasignar</button>
      <button class="btn" data-id="${id}" onclick="tcCancelar(this.dataset.id)">Cancelar</button>`;
  };


  const filasHtml = visibles.length ? visibles.map(r => {
    const horario = (r.Hora_Inicio && r.Hora_Fin) ? `${r.Hora_Inicio}–${r.Hora_Fin}` : r.Horario;
    const grupo = delDia.filter(x => x._estado !== 'Cancelado' && x.Cliente === r.Cliente && tipoDe(x) === tipoDe(r));
    const equipo = grupo.length > 1 ? ` <span title="${esc(grupo.map(x => x.Empleado).join(', '))}">👥${grupo.length}</span>` : '';
    return `<tr class="${r._estado === 'Cancelado' ? 'canc' : ''}">
      <td>${esc(horario)}</td><td>${esc(tipoDe(r))}</td><td>${esc(r.Cliente)}${equipo}</td><td>${esc(r.Empleado)}</td>
      <td><span class="est ${esc(r._estado)}">${esc(r._estado)}</span>${accionPendiente(r) ? ' ⚠️' : ''}</td>
      <td><details><summary>Detalle</summary>${lineaDeVida(r, quejas[r.ID_Programacion], cambios[r.ID_Programacion])}</details></td>
      <td>${acciones(r)}</td></tr>`;
    
  }).join('') : '<tr><td colspan="7" style="text-align:center;color:#888;padding:24px;">No hay servicios para esta fecha o filtro.</td></tr>';

  const edad = edadCacheSegundos('PROGRAMACION_DIARIA');
  const volver = esc('/agenda?' + new URLSearchParams({ fecha, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }).toString());

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agenda ${fecha}</title><style>${CSS}${ed ? ed.CSS_EDITOR : ''}</style></head><body>
<div class="top"><h2 style="margin:0;">Agenda — ${diaSemana(fecha)} ${fecha}</h2>
  <div>${esc(admin)} · <a href="/logout">Cerrar sesión</a></div></div>
<div class="nav">
  <a class="btn" href="/agenda?fecha=${sumarDias(fecha, -1)}">←</a>
  <a class="btn hoy" href="/agenda?fecha=${hoy}">Hoy</a>
  <a class="btn" href="/agenda?fecha=${sumarDias(fecha, 1)}">→</a>
  <input type="date" class="btn" value="${fecha}" onchange="if(this.value)location='/agenda?fecha='+this.value">
  <form method="POST" action="/actualizar-cache" style="margin:0 0 0 auto;display:flex;gap:8px;align-items:center;">
    <span style="font-size:12px;color:#777;">Datos de hace ${edad ?? 0} s</span>
    <input type="hidden" name="volver" value="${volver}"><button class="btn">Actualizar</button></form>
</div>
<div class="semana">${tira}</div>
<div class="aviso">${aviso}</div>
${ed ? ed.editorHtml(fecha, maestrosDatos, delDia) : ''}
<form class="filtros" method="GET" action="/agenda"><input type="hidden" name="fecha" value="${fecha}">
  ${sel('cliente', 'Todos los clientes', unicos('Cliente'))}${sel('empleado', 'Todos los empleados', unicos('Empleado'))}
  ${sel('estado', 'Todos los estados', ESTADOS)}${sel('tipo', 'Todos los tipos', ['Limpieza', 'Inspeccion'])}
  <button class="btn">Filtrar</button> <a class="btn" href="/agenda?fecha=${fecha}">Limpiar</a></form>
<table><tr><th>Horario</th><th>Tipo</th><th>Cliente</th><th>Empleado</th><th>Estado</th><th></th><th>Acciones</th></tr>${filasHtml}</table>
</body></html>`;
}

module.exports = { paginaAgenda, normalizarFecha, fechaValida, hoyFlorida };