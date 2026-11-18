// Ficha de servicio (/servicio?id=PRG-…): todo lo que se sabe de un servicio en una sola página.
// Solo lectura, salvo los diálogos que ya existen (Nota y Novedad de cobro). Editar, reasignar, cancelar y enviar
// se hacen en la agenda ("Editar en la agenda →" abre ese día con el servicio resaltado).
const layout = require('./layout');
const E = require('./enlaces');
const { filasDelRango, cargarPendientes, quejasPorServicio, cambiosPorServicio, tipoDe, diaSemana, hoyFlorida } = require('./agenda');
const esc = layout.esc;
const C = () => require('./cartera'); // carga diferida: cartera.js usa agenda.js
const N = () => require('./notas');

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const usd = n => '$' + (Number(n) || 0).toFixed(2);
const p2 = n => String(n).padStart(2, '0');

// Fechas/horas de las hojas → { k: "AAAA-MM-DD HH:MM:SS" (para ordenar), hora: si traía hora }. k = '' si no se entiende.
// Formatos que aparecen: "M/D/AAAA, h:mm:ss AM/PM" (tiempo.ahora), "AAAA-MM-DD HH:MM" (edicion), "M/D/AAAA HH:MM:SS" (Sheets).
function tiempo(t) {
  const s = String(t || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  let a, mes, d, h, mi, se;
  if (m) { [, a, mes, d, h, mi, se] = m; }
  else {
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/);
    if (!m) return { k: '', hora: false };
    [, mes, d, a, h, mi, se] = m;
    const ap = (m[7] || '').toUpperCase();
    if (h !== undefined && ap) { h = +h; if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0; }
  }
  const hora = h !== undefined;
  return { k: `${a}-${p2(mes)}-${p2(d)} ${p2(h || 0)}:${p2(mi || 0)}:${p2(se || 0)}`, hora };
}
const fechaLarga = f => `${diaSemana(f)} ${+f.slice(8)} ${MESES[+f.slice(5, 7) - 1]} ${f.slice(0, 4)}`;
const horaCorta = k => { const h = +k.slice(11, 13), m = k.slice(14, 16); return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`; };
const cuando = ({ k, hora }) => k ? `${diaSemana(k.slice(0, 10)).toLowerCase()} ${+k.slice(8, 10)} ${MESES[+k.slice(5, 7) - 1]}${hora ? ' · ' + horaCorta(k) : ''}` : '';
const soloHora = t => { const x = tiempo(t); return x.k && x.hora ? horaCorta(x.k) : String(t || ''); };
const horarioDe = r => (r.Hora_Inicio && r.Hora_Fin) ? `${r.Hora_Inicio} – ${r.Hora_Fin}` : (r.Horario || '');

const CSS = `
.tc-titulo .chip{font-size:12.5px;}
.chip{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;background:#eef1f4;color:var(--navy);white-space:nowrap;}
.chip.az{background:#e8eefd;color:#1e3a8a;} .chip.ok{background:#dcfce7;color:#166534;} .chip.am{background:#fef3c7;color:#854d0e;} .chip.mal{background:#fee2e2;color:#991b1b;}
.fs-sub{margin:-6px 0 14px;color:var(--gray-d);}
.fs-acc{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px;}
.fs-pasos{display:flex;align-items:flex-start;background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 10px;margin:0 0 14px;overflow-x:auto;}
.fs-paso{flex:0 0 100px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:3px;}
.fs-paso i{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:12px;font-weight:700;border:2px solid #cfd6dd;background:#fff;color:var(--gray-d);}
.fs-paso b{font-size:12.5px;} .fs-paso small{font-size:11.5px;line-height:1.3;}
.fs-paso.hecho i{background:#1d4ed8;border-color:#1d4ed8;color:#fff;}
.fs-paso.actual i{border-color:#1d4ed8;color:#1d4ed8;}
.fs-paso.mal i{background:#dc2626;border-color:#dc2626;color:#fff;}
.fs-paso.na i{border-style:dashed;}
.fs-raya{flex:1 1 16px;min-width:12px;height:3px;background:#dde1e6;margin-top:12px;} .fs-raya.hecho{background:#1d4ed8;}
.fs-sig{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:14px 16px;border-radius:10px;background:#e8eefd;border:1.5px solid #1d4ed8;margin:0 0 14px;}
.fs-sig.ok{background:#f0fdf4;border-color:#86efac;} .fs-sig.mal{background:#fef2f2;border-color:#fca5a5;}
.fs-sig .t{display:block;font-size:11.5px;font-weight:700;letter-spacing:.06em;color:#1e3a8a;} .fs-sig.ok .t{color:#166534;} .fs-sig.mal .t{color:#991b1b;}
.fs-sig .btn{margin-left:auto;}
.fs-cols{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start;}
@media(max-width:900px){.fs-cols{grid-template-columns:1fr;}}
.fs-card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 14px;}
.fs-card h3{margin:0 0 8px;font-size:15px;}
.fs-ev{display:flex;gap:12px;padding:10px 0;border-top:1px solid #eef0f3;}
.fs-ev:first-of-type{border-top:0;}
.fs-ev .h{flex:0 0 150px;font-size:12.5px;color:var(--gray-d);white-space:nowrap;}
.fs-ev .p{flex:0 0 10px;height:10px;border-radius:50%;margin-top:6px;background:#9aa3ae;}
.fs-ev .p.ok{background:#16a34a;} .fs-ev .p.info{background:#1d4ed8;} .fs-ev .p.mal{background:#dc2626;} .fs-ev .p.am{background:#d97706;}
.fs-ev .c{min-width:0;flex:1;} .fs-ev .c b{display:block;} .fs-ev .c div{white-space:pre-wrap;font-size:13.5px;}
.fs-lst>div{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:4px 0;font-size:13.5px;border-top:1px solid #f1f3f5;} .fs-lst>div:first-child{border-top:0;}
.fs-par{font-size:13.5px;margin:4px 0;white-space:pre-wrap;} .fs-par span{display:block;font-size:11.5px;color:var(--gray-d);}`;

// ---------- pasos (stepper) ----------
function pasos(r, cobro, pends) {
  const retro = r.Registro_Retroactivo === 'Sí' || r.Estado_Envio === 'No aplica';
  const enviado = r.Estado_Envio === 'Enviado';
  const conf = r.Estado_Confirmacion;
  // aviso: true = problema que no detiene el flujo (se marca en rojo, pero el paso "actual" sigue más adelante)
  const pasoGps = (hora, rango) => !hora ? { e: 'pend', s: '' } : rango === 'NO' ? { e: 'mal', s: soloHora(hora) + ' · fuera de rango', aviso: true } : { e: 'hecho', s: soloHora(hora) };
  const l = [
    { n: 'Programado', e: 'hecho', s: r.Creado_Por || '' },
    retro ? { n: 'Enviado', e: 'na', s: 'no aplica' } : enviado ? { n: 'Enviado', e: 'hecho', s: '' } : { n: 'Enviado', e: 'pend', s: 'borrador' },
    retro ? { n: 'Confirmado', e: 'na', s: 'no aplica' } : conf === 'Confirmado' ? { n: 'Confirmado', e: 'hecho', s: soloHora(r.Fecha_Hora_Confirmacion) }
      : conf === 'No puede' ? { n: 'Confirmado', e: 'mal', s: 'no puede' } : { n: 'Confirmado', e: 'pend', s: enviado ? 'esperando' : '' },
    { n: 'Entrada', ...pasoGps(r.Hora_Entrada_Real, r.Dentro_Rango_Entrada) },
    { n: 'Salida', ...pasoGps(r.Hora_Salida_Real, r.Dentro_Rango_Salida) },
    r.Servicio_Finalizado === 'Sí' ? { n: 'Cierre', e: 'hecho', s: '' } : { n: 'Cierre', e: 'pend', s: r.Hora_Salida_Real ? 'falta' : '' },
  ];
  if (tipoDe(r) === 'Inspeccion') {
    const accion = r.Requiere_Accion_Correctiva === 'Sí';
    l.push(!r.Resultado_Inspeccion && !accion ? { n: 'Resultado', e: 'pend', s: '' } : accion ? { n: 'Resultado', e: 'mal', s: 'no cumple', aviso: true } : { n: 'Resultado', e: 'hecho', s: 'cumple' });
    if (accion) {
      const abiertos = pends.filter(p => p.Estado === 'Abierto').length;
      l.push(!pends.length ? { n: 'Corrección', e: 'mal', s: 'sin pendiente' } : abiertos ? { n: 'Corrección', e: 'pend', s: abiertos + ' abierto(s)' } : { n: 'Corrección', e: 'hecho', s: '' });
    }
  } else {
    const ec = cobro ? cobro.estado : '';
    l.push(ec === 'Ejecutado' ? { n: 'Cobro', e: 'hecho', s: usd(cobro.total) } : ec === 'Cancelado' ? { n: 'Cobro', e: 'na', s: 'cancelado' }
      : ec === 'Por confirmar' ? { n: 'Cobro', e: 'pend', s: 'por confirmar' } : { n: 'Cobro', e: 'pend', s: '' });
    const pg = cobro && cobro.pago;
    l.push(!pg ? { n: 'Pago', e: ec === 'Cancelado' ? 'na' : 'pend', s: '' }
      : ['pagado', 'cortesia'].includes(pg.clave) ? { n: 'Pago', e: 'hecho', s: pg.txt.toLowerCase() }
      : pg.clave === 'sin' ? { n: 'Pago', e: 'mal', s: 'sin tarifa' } : { n: 'Pago', e: 'pend', s: (pg.clave === 'parcial' ? 'parcial · ' : 'saldo ') + usd(pg.saldo) });
  }
  if (r._estado === 'Cancelado') return l.map(x => x.e === 'hecho' ? x : { ...x, e: 'na', s: '' });
  // el paso "actual" es el primero sin hacer, salvo que antes haya un problema (ese es el que hay que resolver)
  const i = l.findIndex(x => x.e === 'pend' || (x.e === 'mal' && !x.aviso));
  if (i >= 0 && l[i].e === 'pend') l[i].e = 'actual';
  return l;
}
function htmlPasos(l) {
  return `<div class="fs-pasos">${l.map((x, i) => `${i ? `<div class="fs-raya${x.e === 'hecho' || x.e === 'mal' ? ' hecho' : ''}"></div>` : ''}<div class="fs-paso ${x.e}" title="${esc(x.n + (x.s ? ': ' + x.s : ''))}"><i>${x.e === 'hecho' ? '✓' : x.e === 'mal' ? '!' : i + 1}</i><b>${esc(x.n)}</b><small>${esc(x.s)}</small></div>`).join('')}</div>`;
}

// ---------- siguiente paso ----------
function siguientePaso(r, cobro, pends, hoy) {
  const id = r.ID_Programacion, retro = r.Registro_Retroactivo === 'Sí' || r.Estado_Envio === 'No aplica';
  const enAgenda = '/agenda?fecha=' + r._fecha + '&id=' + encodeURIComponent(id);
  const caja = (cls, titulo, texto, href, boton) => `<div class="fs-sig${cls ? ' ' + cls : ''}"><div><span class="t">${esc(titulo)}</span>${texto}</div>${href ? `<a class="btn hoy" href="${esc(href)}">${esc(boton)}</a>` : ''}</div>`;
  const emp = `<b>${esc(r.Empleado || 'el empleado')}</b>`;
  if (r._estado === 'Cancelado') return caja('mal', 'CANCELADO', `Motivo: ${esc(r.Motivo_Cancelacion || '—')}${r.Modificado_Por ? ` · ${esc(r.Modificado_Por)}` : ''}`);
  if (r._estado === 'Borrador' && !retro) return caja('', 'SIGUIENTE PASO', 'El servicio está en <b>borrador</b>: todavía no se le envió al empleado.', enAgenda, 'Enviar desde la agenda →');
  if (r._estado === 'No puede') return caja('mal', 'SIGUIENTE PASO', `${emp} respondió que no puede${r.Motivo_No_Puede ? ': "' + esc(r.Motivo_No_Puede) + '"' : ''}. Hay que reasignarlo.`, enAgenda, 'Reasignar en la agenda →');
  if (r._estado === 'Enviado' && r._fecha >= hoy) return caja('', 'EN ESPERA', `Esperando que ${emp} confirme.`);
  if (r._fecha < hoy && !r.Hora_Entrada_Real && r.Servicio_Finalizado !== 'Sí') return caja('mal', 'SIGUIENTE PASO', 'El día ya pasó y no hay entrada registrada.', enAgenda, 'Registrar en la agenda (retroactivo) →');
  if (r.Hora_Salida_Real && r.Servicio_Finalizado !== 'Sí') return caja('', 'SIGUIENTE PASO', 'Ya hay salida, pero falta el <b>cierre</b> del servicio.', '/cierre?id=' + encodeURIComponent(id), 'Abrir formulario de cierre →');
  if (tipoDe(r) === 'Inspeccion' && r.Requiere_Accion_Correctiva === 'Sí' && !pends.length) return caja('mal', 'SIGUIENTE PASO', 'La inspección <b>no cumple</b> y todavía no tiene un pendiente para corregirlo.', E.url.nuevoPendiente(id), 'Crear pendiente →');
  const abiertos = pends.filter(p => p.Estado === 'Abierto');
  if (tipoDe(r) === 'Inspeccion' && r.Requiere_Accion_Correctiva === 'Sí' && abiertos.length) return caja('', 'EN CORRECCIÓN', `La corrección sigue abierta en ${abiertos.map(p => E.pendiente(p.ID_Pendiente)).join(', ')}.`, E.url.pendiente(abiertos[0].ID_Pendiente), 'Ver pendiente →');
  if (cobro && cobro.estado === 'Por confirmar') return caja('', 'SIGUIENTE PASO', 'El cobro de este servicio sigue <b>Por confirmar</b> en la cartera.', '/cartera?mes=' + r._fecha.slice(0, 7) + '&cliente=' + encodeURIComponent(r.Cliente.trim()), 'Confirmar en la cartera →');
  if (cobro && cobro.saldo) return caja('', 'SIGUIENTE PASO', `Saldo pendiente de <b>${usd(cobro.saldo)}</b>.`, E.url.registrarIngreso(cobro.cliente, cobro.fecha, cobro.idCobro), 'Registrar ingreso →');
  if (r._estado === 'Finalizado') return caja('ok', 'AL DÍA', 'No hay nada pendiente en este servicio.');
  return '';
}

// ---------- línea de vida en orden ----------
function eventos(r, { cambios, pends, quejas, notas, cobro }) {
  const ev = [];
  const add = (rango, t, titulo, detalle, tono) => ev.push({ rango, t: tiempo(t), titulo, detalle: detalle || '', tono: tono || '' });
  add(1, r.Fecha_Creacion, 'Programado', [r.Creado_Por && 'Creado por ' + esc(r.Creado_Por), r.Origen_Registro && 'Origen: ' + esc(r.Origen_Registro),
    r.Registro_Retroactivo === 'Sí' && 'Registro retroactivo: ' + esc(r.Motivo_Retroactivo)].filter(Boolean).join('\n'));
  if (r.Cancelado === 'Sí') add(1.5, r.Fecha_Modificacion, 'Cancelado', esc(r.Motivo_Cancelacion) + (r.Modificado_Por ? '\nPor ' + esc(r.Modificado_Por) : ''), 'mal');
  else if (r.Modificado_Por) add(1.5, r.Fecha_Modificacion, 'Última modificación', 'Por ' + esc(r.Modificado_Por));
  if (r.Estado_Envio === 'Enviado') add(2, '', 'Enviado por WhatsApp', '', 'info');
  if (r.Estado_Confirmacion === 'Confirmado') add(3, r.Fecha_Hora_Confirmacion, 'Confirmado', `${esc(r.Empleado)} confirmó.`, 'ok');
  if (r.Estado_Confirmacion === 'No puede') add(3, r.Fecha_Hora_Confirmacion, 'No puede', esc(r.Motivo_No_Puede), 'mal');
  (cambios || []).forEach(x => add(3.5, x.Fecha_Hora, 'Cambio después de enviar: ' + esc(x.Tipo_Cambio), [esc(x.Detalle), x.Realizado_Por && 'Por ' + esc(x.Realizado_Por),
    x.Empleado_Notificado ? `Aviso a ${esc(x.Empleado_Notificado)}: ${esc(x.Aviso_Enviado)}` : esc(x.Aviso_Enviado)].filter(Boolean).join('\n'), 'am'));
  const gps = (rango, tipo, hora, dentro, lat, lon) => { if (hora) add(rango, hora, tipo, dentro === 'NO' ? 'Fuera del radio del sitio' + (lat ? ` (${esc(lat)}, ${esc(lon)})` : '') : dentro === 'SI' ? 'Dentro del radio del sitio' : '', dentro === 'NO' ? 'mal' : 'ok'); };
  gps(4, 'Entrada', r.Hora_Entrada_Real, r.Dentro_Rango_Entrada, r.Lat_Entrada, r.Lon_Entrada);
  if (r.Avisos_Durante_Servicio) add(4.5, '', 'Avisos durante el servicio', esc(r.Avisos_Durante_Servicio) + (r.Aviso_Confirmado ? '\nConfirmado: ' + esc(r.Aviso_Confirmado) : ''), 'am');
  gps(5, 'Salida', r.Hora_Salida_Real, r.Dentro_Rango_Salida, r.Lat_Salida, r.Lon_Salida);
  if (r.Servicio_Finalizado === 'Sí') add(6, '', tipoDe(r) === 'Inspeccion' ? 'Cierre de la inspección' : 'Cierre', [r.Tareas_Pendientes && 'Tareas pendientes: ' + esc(r.Tareas_Pendientes),
    r.Insumos_Faltantes && 'Insumos faltantes: ' + esc(r.Insumos_Faltantes), r.Comentario_Empleado && 'Comentario: "' + esc(r.Comentario_Empleado) + '"',
    r.Fotos_Resultado && 'Fotos: ' + esc(r.Fotos_Resultado)].filter(Boolean).join('\n') || 'Sin observaciones.', 'ok');
  if (tipoDe(r) === 'Inspeccion' && (r.Resultado_Inspeccion || r.Requiere_Accion_Correctiva)) add(6.5, '', 'Resultado de la inspección',
    [esc(String(r.Resultado_Inspeccion || '').replace(/; /g, '\n')), r.Requiere_Accion_Correctiva && 'Requiere acción correctiva: ' + esc(r.Requiere_Accion_Correctiva),
      r.Estado_Correccion && 'Estado de la corrección: ' + esc(r.Estado_Correccion)].filter(Boolean).join('\n'), r.Requiere_Accion_Correctiva === 'Sí' ? 'mal' : 'ok');
  ((cobro && cobro.nvs) || []).forEach(n => add(7, n.Fecha_Registro, 'Novedad de cobro: ' + esc(n.Tipo), `${esc(n.Detalle)} (${usd(n.Monto)})${n.Registrado_Por ? '\nPor ' + esc(n.Registrado_Por) : ''}${n.Estado === 'Activa' ? '' : '\nANULADA: ' + esc(n.Motivo_Anulacion)}`, n.Estado === 'Activa' ? 'info' : ''));
  (notas || []).forEach(n => add(7.5, n.Fecha_Registro || n.Fecha, 'Nota' + (n.Categoria ? ' · ' + esc(n.Categoria) : '') + (Number(n.Calificacion) > 0 ? ' · ★ ' + esc(n.Calificacion) : ''),
    esc(n.Detalle) + (n.Registrado_Por ? '\nPor ' + esc(n.Registrado_Por) + (n.Fuente ? ' · ' + esc(n.Fuente) : '') : ''), 'info'));
  (pends || []).forEach(p => {
    add(7.6, p.Fecha_Creacion, 'Pendiente creado: ' + E.pendiente(p.ID_Pendiente), `${esc(p.Titulo)}${p.Responsable ? '\nResponsable: ' + esc(p.Responsable) : ''}`, 'am');
    if (p.Fecha_Cierre) add(7.7, p.Fecha_Cierre, `Pendiente ${esc(String(p.Estado || '').toLowerCase())}: ` + E.pendiente(p.ID_Pendiente), [p.Nota_Cierre && esc(p.Nota_Cierre), p.Cerrado_Por && 'Por ' + esc(p.Cerrado_Por)].filter(Boolean).join('\n'), p.Estado === 'Cancelado' ? '' : 'ok');
  });
  (quejas || []).forEach(q => add(7.8, q.Fecha_Recepcion, `${esc(q.Tipo || 'Queja')} (${esc(q.Estado || '—')})`, esc(q.Descripcion) + (q.Urgencia ? '\nUrgencia: ' + esc(q.Urgencia) : ''), 'mal'));
  // Los eventos sin hora (envío, cierre…) se ubican después del último evento con hora que va antes en el flujo.
  ev.forEach(x => {
    if (x.t.k) return;
    const previos = ev.filter(y => y.t.k && y.rango < x.rango).map(y => y.t.k).sort();
    x.orden = previos.length ? previos[previos.length - 1] : '';
  });
  return ev.sort((a, b) => (a.t.k || a.orden).localeCompare(b.t.k || b.orden) || a.rango - b.rango);
}
function htmlEventos(l) {
  return l.map(x => `<div class="fs-ev"><span class="h"${x.t.k ? '' : ' title="Sin hora registrada: se ubica por el orden del flujo"'}>${x.t.k ? esc(cuando(x.t)) : '—'}</span><span class="p ${x.tono}"></span>
<div class="c"><b>${x.titulo}</b>${x.detalle ? `<div>${x.detalle}</div>` : ''}</div></div>`).join('');
}

// ---------- página ----------
const chipEstado = e => `<span class="chip ${{ Finalizado: 'ok', Cancelado: 'mal', 'No puede': 'mal', Borrador: '', Enviado: 'am', 'Salida (falta cierre)': 'am' }[e] ?? 'az'}">${esc(e)}</span>`;

async function pagina(id, admin) {
  const hoy = hoyFlorida();
  const todas = await filasDelRango('2000-01-01', '2999-12-31');
  const r = todas.find(x => String(x.ID_Programacion || '').trim() === id);
  if (!r) return paginaNoEncontrado(id, admin);
  const inspeccion = tipoDe(r) === 'Inspeccion';
  const delDia = todas.filter(x => x._fecha === r._fecha);
  const equipo = delDia.filter(x => x.Cliente === r.Cliente && tipoDe(x) === tipoDe(r) && (x._estado !== 'Cancelado' || x.ID_Programacion === r.ID_Programacion));
  const inspecciones = inspeccion ? [] : todas.filter(x => tipoDe(x) === 'Inspeccion' && x._estado !== 'Cancelado' && String(x.ID_Servicio_Inspeccionado || '').trim() === id);
  const ids = new Set([r.ID_Programacion]);
  const [todosPend, quejas, cambios, notasSrv, cobros] = await Promise.all([cargarPendientes(), quejasPorServicio(ids), cambiosPorServicio(ids),
    N().porServicio(ids), inspeccion || !r.Cliente ? {} : C().datosCobroDia([r])]);
  const pends = todosPend.filter(p => String(p.ID_Programacion || '').trim() === id);
  const cobro = cobros[r.ID_Programacion] || null;
  const q = quejas[r.ID_Programacion] || [], notas = notasSrv[r.ID_Programacion] || [];
  const mes = r._fecha.slice(0, 7);
  const enAgenda = '/agenda?fecha=' + r._fecha + '&id=' + encodeURIComponent(r.ID_Programacion);
  const cancelado = r._estado === 'Cancelado';

  const otros = equipo.filter(x => x.ID_Programacion !== r.ID_Programacion);
  const sub = [esc(fechaLarga(r._fecha)), esc(horarioDe(r)), E.empleado(r.Empleado, { fecha: r._fecha }),
    otros.length ? `equipo de ${equipo.length}: ${otros.map(x => E.empleado(x.Empleado, { fecha: r._fecha })).join(', ')}` : ''].filter(Boolean).join(' · ');
  const chips = [`<span class="chip az">${esc(inspeccion ? 'Inspección' : tipoDe(r))}</span>`, chipEstado(r._estado),
    r.Registro_Retroactivo === 'Sí' ? '<span class="chip mal">Retroactivo</span>' : '',
    cobro && cobro.pago ? `<span class="chip ${['pagado', 'cortesia'].includes(cobro.pago.clave) ? 'ok' : 'am'}">Pago: ${esc(cobro.pago.txt)}</span>` : ''].join(' ');
  const acciones = [cancelado ? '' : N().botonNota(r), C().botonNovedad(r),
    cancelado ? '' : `<a class="btn" href="${esc(E.url.nuevoPendiente(r.ID_Programacion))}">Crear pendiente</a>`,
    `<a class="btn" href="${esc(enAgenda)}">Editar en la agenda →</a>`].filter(Boolean).join('');

  // columna lateral
  const par = (k, v) => v ? `<div class="fs-par"><span>${esc(k)}</span>${v}</div>` : '';
  const maps = /^https?:\/\//i.test(r.Google_Maps_Link) ? ` · <a href="${esc(r.Google_Maps_Link)}" target="_blank" rel="noopener">Abrir mapa</a>` : '';
  const cardCliente = `<div class="fs-card"><h3>Cliente</h3><div style="font-size:15px;font-weight:600;">${E.cliente(r.Cliente, { mes })}</div>
${par('Dirección', r.Direccion ? esc(r.Direccion) + maps : '')}<div class="fs-par"><a href="${esc(E.url.calidadCliente(r.Cliente))}">Ficha de calidad →</a></div></div>`;
  const cardEquipo = `<div class="fs-card"><h3>Equipo</h3><div class="fs-lst">${equipo.map(x => `<div><span>${E.empleado(x.Empleado, { fecha: r._fecha })}${x.ID_Programacion === r.ID_Programacion ? '' : ` <small>${E.servicio(x.ID_Programacion, { texto: 'ver' })}</small>`}<br><small>Prog. ${esc(horarioDe(x) || '—')} · Real ${esc(soloHora(x.Hora_Entrada_Real) || '—')} → ${esc(soloHora(x.Hora_Salida_Real) || '—')}</small></span>${chipEstado(x._estado)}</div>`).join('')}</div>
<div class="fs-par"><a href="${esc(E.url.empleado(r.Empleado, r._fecha))}">Semana en Nómina →</a></div></div>`;
  const cardCobro = cobro ? `<div class="fs-card"><h3>Cobro</h3>${par('Estado en cartera', esc(cobro.estado + (cobro.motivo ? ' — ' + cobro.motivo : '')))}
${cobro.ejecutado ? par('Total a cobrar', usd(cobro.total) + (cobro.nov ? ` <small>(incluye ${usd(cobro.nov)} de novedades)</small>` : '')) : ''}
${cobro.pago ? par('Pago', esc(cobro.pago.txt) + (cobro.pago.aplicado ? ` · cobrado ${usd(cobro.pago.aplicado)}` : '') + (cobro.saldo ? ` · saldo <b>${usd(cobro.saldo)}</b>` : '')) : ''}
<div class="fs-par"><a href="${esc(E.url.cliente(r.Cliente, mes))}">Cobros del cliente en ${esc(MESES[+mes.slice(5) - 1] + ' ' + mes.slice(0, 4))} →</a></div></div>` : '';
  const vinc = [
    ...pends.map(p => `<div><span>${E.pendiente(p.ID_Pendiente)} · ${esc(p.Titulo)}</span><span class="chip ${p.Estado === 'Abierto' ? 'am' : p.Estado === 'Cancelado' ? '' : 'ok'}">${esc(p.Estado)}</span></div>`),
    ...q.map(x => `<div><span>${esc(x.Tipo || 'Queja')}: ${esc(String(x.Descripcion || '').slice(0, 60))}</span><span class="chip ${/abiert/i.test(x.Estado) ? 'mal' : ''}">${esc(x.Estado || '—')}</span></div>`),
    ...inspecciones.map(x => `<div><span>Inspección ${E.servicio(x.ID_Programacion, { texto: fechaLarga(x._fecha) })}</span><span class="chip ${x.Requiere_Accion_Correctiva === 'Sí' ? 'mal' : x.Servicio_Finalizado === 'Sí' ? 'ok' : ''}">${x.Requiere_Accion_Correctiva === 'Sí' ? 'No cumple' : x.Servicio_Finalizado === 'Sí' ? 'Cumple' : esc(x._estado)}</span></div>`),
    inspeccion && r.ID_Servicio_Inspeccionado ? `<div><span>Servicio inspeccionado</span><span>${E.servicio(String(r.ID_Servicio_Inspeccionado).trim())}</span></div>` : '',
    notas.length ? `<div><span>Notas</span><span>${notas.length}</span></div>` : '',
  ].filter(Boolean);
  const cardVinc = `<div class="fs-card"><h3>Vinculado a este servicio</h3>${vinc.length ? `<div class="fs-lst">${vinc.join('')}</div>` : '<small>Sin pendientes, quejas ni notas.</small>'}</div>`;
  const cardProg = [par('Descripción', esc(r.Descripcion_Servicio)), par('Instrucciones', esc(r.Instrucciones)), par('Observaciones del día', esc(r.Observaciones_Puntuales))].join('');

  const ruta = [['Agenda', '/agenda'], [fechaLarga(r._fecha), '/agenda?fecha=' + r._fecha], [r.ID_Programacion]];
  return `${layout.head('Servicio ' + r.ID_Programacion, CSS)}
${layout.cabecera({ tituloHtml: `${E.cliente(r.Cliente, { mes })} ${chips}`, seccion: '/agenda', admin, ruta })}
<p class="fs-sub">${sub}</p>
<div class="fs-acc">${acciones}</div>
${htmlPasos(pasos(r, cobro, pends))}
${siguientePaso(r, cobro, pends, hoy)}
<div class="fs-cols"><div>
<div class="fs-card"><h3>Línea de vida (en orden)</h3>${htmlEventos(eventos(r, { cambios: cambios[r.ID_Programacion], pends, quejas: q, notas, cobro }))}</div>
${cardProg ? `<div class="fs-card"><h3>Programación</h3>${cardProg}</div>` : ''}
</div><div>${cardCliente}${cardEquipo}${cardCobro}${cardVinc}</div></div>
${C().dialogoNovedad()}${N().dialogoNota(N().mapaServicios(delDia))}
</body></html>`;
}

function paginaNoEncontrado(id, admin) {
  const m = id.match(/^PRG-(\d{4})(\d{2})(\d{2})-/);
  const f = m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  return `${layout.head('Servicio no encontrado', CSS)}
${layout.cabecera({ titulo: 'Servicio no encontrado', seccion: '/agenda', admin, ruta: [['Agenda', '/agenda'], [id]] })}
<div class="aviso r">No hay ningún servicio con el ID <b>${esc(id)}</b> en la programación.${f ? ` <a href="/agenda?fecha=${f}">Ver la agenda del ${esc(fechaLarga(f))}</a>` : ''}</div>
</body></html>`;
}

function rutas(app, auth) {
  app.get('/servicio', auth.requiereAdmin, async (req, res) => {
    const id = String(req.query.id || '').trim();
    if (!E.RE_SERVICIO.test(id)) return res.redirect('/agenda');
    try {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(await pagina(id, req.admin));
    } catch (e) {
      console.error('Error en GET /servicio:', e);
      res.status(500).send('Error cargando el servicio: ' + esc(e.message));
    }
  });
}

module.exports = { rutas, tiempo };
