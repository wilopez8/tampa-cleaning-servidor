const { leerHoja, agregarFila, agregarFilas, actualizarCeldas, asegurarHoja } = require('./sheets');
const { normalizarFecha, diaSemana } = require('./agenda');

const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r2 = x => Math.round(x * 100) / 100;
const usd = n => '$' + (n || 0).toFixed(2);
const ahora = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
function numero(t) {
  let s = String(t ?? '').replace(/[$\s]/g, '');
  if (!s) return NaN;
  const c = s.lastIndexOf(','), p = s.lastIndexOf('.');
  if (c >= 0 && p >= 0) s = c > p ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (c >= 0) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  return parseFloat(s);
}
const horaMin = t => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };

const DIST_HEADERS = ['Punto_A', 'Punto_B', 'Millas', 'Fuente', 'Huella', 'Fecha'];
const PARADAS_HEADERS = ['Fecha_Hora', 'ID_Programacion', 'Empleado', 'Fecha_Servicio', 'Cuenta', 'Motivo', 'Ajustado_Por'];
const MA_HEADERS = ['Fecha_Hora', 'Empleado', 'Fecha_Servicio', 'Monto', 'Motivo', 'Ajustado_Por'];
const TR_HEADERS = ['ID_Liquidacion', 'Semana_Inicio', 'Empleado', 'Fecha', 'Orden', 'Origen', 'Destino', 'Millas', 'Pagado', 'Fuente'];
const MD_HEADERS = ['ID_Liquidacion', 'Semana_Inicio', 'Empleado', 'Fecha', 'Paradas', 'Millas_Pagadas', 'Millas_Total', 'Monto_Millas', 'Estado', 'Motivo_Ajuste', 'Notas'];

async function cargarTabla(nombre, headers) {
  await asegurarHoja(nombre, headers);
  const d = await leerHoja(nombre);
  const lista = [];
  lista.h = (d[0] && d[0].length) ? d[0] : headers;
  for (let i = 1; i < d.length; i++) {
    const o = { _fila: i + 1 };
    lista.h.forEach((n, j) => { o[n] = d[i][j] === undefined ? '' : String(d[i][j]); });
    lista.push(o);
  }
  return lista;
}

// ---------- datos de apoyo ----------
async function cargarSitios() {
  const d = await leerHoja('SITIOS', { cache: true });
  const mapa = {};
  if (d.length < 2) return mapa;
  const h = d[0], iN = h.indexOf('Nombre_Cliente'), iLa = h.indexOf('Latitud'), iLo = h.indexOf('Longitud'), iE = h.indexOf('Estatus');
  for (let i = 1; i < d.length; i++) {
    const n = String(d[i][iN] || '').trim();
    if (!n) continue;
    const activo = String(d[i][iE] || '').trim() === 'Activo';
    if (mapa[n] && mapa[n].activo && !activo) continue;
    mapa[n] = { lat: numero(d[i][iLa]), lon: numero(d[i][iLo]), activo };
  }
  return mapa;
}

async function cargarResidencias() {
  const d = await leerHoja('EMPLEADOS', { cache: true });
  const out = { mapa: {}, hayColumna: false };
  if (d.length < 2) return out;
  const h = d[0], iN = h.indexOf('Nombre'), iD = h.indexOf('Direccion_Residencia');
  out.hayColumna = iD >= 0;
  if (iN < 0 || iD < 0) return out;
  d.slice(1).forEach(f => { const n = String(f[iN] || '').trim(), a = String(f[iD] || '').trim(); if (n && a) out.mapa[n] = a; });
  return out;
}

async function cargarParadas() {
  const mapa = {};
  (await cargarTabla('NOMINA_PARADAS', PARADAS_HEADERS)).forEach(o => {
    if (!o.ID_Programacion) return;
    const c = o.Cuenta.trim();
    if (c === 'Sí' || c === 'No') mapa[o.ID_Programacion] = { cuenta: c === 'Sí', motivo: o.Motivo, por: o.Ajustado_Por };
    else delete mapa[o.ID_Programacion];
  });
  return mapa;
}

async function cargarAjustesMillas() {
  const mapa = {};
  (await cargarTabla('NOMINA_MILLAS_AJUSTES', MA_HEADERS)).forEach(o => {
    if (!o.Empleado) return;
    const k = o.Empleado.trim() + '|' + normalizarFecha(o.Fecha_Servicio);
    const m = numero(o.Monto);
    if (o.Monto.trim() === '' || !(m >= 0)) delete mapa[k];
    else mapa[k] = { monto: r2(m), motivo: o.Motivo, por: o.Ajustado_Por };
  });
  return mapa;
}

async function cargarDistancias() {
  const l = await cargarTabla('DISTANCIAS', DIST_HEADERS);
  const cache = new Map();
  l.forEach(o => { if (o.Punto_A && o.Punto_B) cache.set(o.Punto_A + '||' + o.Punto_B, { millas: numero(o.Millas), fuente: o.Fuente.trim(), huella: o.Huella, _fila: o._fila }); });
  return { cache, h: l.h, nuevos: [], cambios: [] };
}

async function cargarContexto() {
  const [paradas, ajustesMillas, sitios, res, dist] = await Promise.all([cargarParadas(), cargarAjustesMillas(), cargarSitios(), cargarResidencias(), cargarDistancias()]);
  return { paradas, ajustesMillas, sitios, residencias: res.mapa, hayColResidencia: res.hayColumna, dist };
}

// ---------- distancias (Google Routes + caché en la hoja DISTANCIAS) ----------
const wp = p => p.direccion ? { address: p.direccion } : { location: { latLng: { latitude: p.lat, longitude: p.lon } } };
async function llamarRoutes(a, b) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('Falta GOOGLE_MAPS_API_KEY en Render');
  if (typeof fetch !== 'function') throw new Error('Este Node no tiene fetch (usa Node 18 o superior)');
  const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.distanceMeters' },
    body: JSON.stringify({ origin: wp(a), destination: wp(b), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Google respondió HTTP ' + r.status));
  if (!j.routes || !j.routes[0]) throw new Error('Google no encontró una ruta');
  return r2((j.routes[0].distanceMeters || 0) / 1609.344);
}

const casaPunto = (emp, dir) => ({ label: 'CASA: ' + emp, direccion: dir, huella: 'dir:' + dir });
const sitioPunto = (cli, s) => ({ label: 'SITIO: ' + cli, lat: s.lat, lon: s.lon, huella: s.lat + ',' + s.lon });
const corto = p => p.label.startsWith('CASA') ? 'Casa' : p.label.slice(7);

const enVuelo = new Map();
async function distancia(a, b, dist) {
  if (a.label === b.label || a.huella === b.huella) return { millas: 0, fuente: 'Mismo punto' };
  const [p, q] = a.label <= b.label ? [a, b] : [b, a]; // la distancia se trata como simétrica
  const key = p.label + '||' + q.label, huella = p.huella + '|' + q.huella;
  const hit = dist.cache.get(key);
  if (hit && isFinite(hit.millas) && (hit.fuente === 'Manual' || hit.huella === huella)) return { millas: hit.millas, fuente: hit.fuente };
  const k = key + '##' + huella;
  if (enVuelo.has(k)) return enVuelo.get(k);
  const prom = (async () => {
    const millas = await llamarRoutes(p, q);
    const fecha = new Date().toISOString().slice(0, 10);
    if (hit) dist.cambios.push({ fila: hit._fila, valores: { Millas: millas, Fuente: 'Google', Huella: huella, Fecha: fecha } });
    else dist.nuevos.push([p.label, q.label, millas, 'Google', huella, fecha]);
    dist.cache.set(key, { millas, fuente: 'Google', huella, _fila: hit ? hit._fila : null });
    return { millas, fuente: 'Google' };
  })();
  enVuelo.set(k, prom);
  prom.then(() => enVuelo.delete(k), () => enVuelo.delete(k));
  return prom;
}

// Una sola escritura al final (evita pasarse de la cuota de escritura de Sheets)
async function volcarDistancias(dist) {
  if (dist.nuevos.length) await agregarFilas('DISTANCIAS', dist.nuevos.splice(0));
  if (dist.cambios.length) {
    const celdas = [];
    dist.cambios.splice(0).forEach(c => ['Millas', 'Fuente', 'Huella', 'Fecha'].forEach(k => celdas.push({ fila: c.fila, columna: dist.h.indexOf(k) + 1, valor: c.valores[k] })));
    await actualizarCeldas('DISTANCIAS', celdas);
  }
}

// ---------- cálculo del día de un empleado ----------
function estadoParada(x, paradas) {
  const ov = paradas[x.r.ID_Programacion];
  if (ov) return ov.cuenta ? 'Sí' : 'No';
  if (x.cancelada) return 'No';
  if (x.c.estado === 'Sin pago') return 'No';
  if (x.c.estado === 'Revisar') return 'Pendiente';
  return 'Sí';
}

async function calcularDia({ empleado, fecha, cand, cfg, ctx }) {
  const rate = Number.isFinite(cfg.Tarifa_Milla) ? cfg.Tarifa_Milla : 0.37;
  const umbral = Number.isFinite(cfg.Umbral_Millas_Dia) ? cfg.Umbral_Millas_Dia : 10;
  const siempre = Number.isFinite(cfg.Servicios_Pago_Siempre) ? cfg.Servicios_Pago_Siempre : 2;
  const fija = Number.isFinite(cfg.Umbral_Tarifa_Fija) ? cfg.Umbral_Tarifa_Fija : 20;
  const casa = ctx.residencias[empleado] || '';
  const ov = ctx.ajustesMillas[empleado + '|' + fecha] || null;

  const items = cand.map(x => {
    const ini = x.c ? (x.c.real.ini ?? x.c.prog.ini) : horaMin(x.r.Hora_Inicio);
    return { id: x.r.ID_Programacion, cliente: x.r.Cliente, cancelada: x.cancelada, estado: estadoParada(x, ctx.paradas), manual: !!ctx.paradas[x.r.ID_Programacion], ini: ini ?? 0 };
  }).sort((a, b) => a.ini - b.ini);
  const paradas = items.filter(i => i.estado === 'Sí');
  const dia = { fecha, items, tramos: [], millasPagadas: 0, millasTotal: 0, auto: null, monto: 0, estado: 'Sin millas', nota: '', aviso: '', paradas: paradas.length };

  let revisar = '';
  if (items.some(i => i.estado === 'Pendiente')) {
    revisar = 'Hay servicios sin check-in: ajusta sus horas o indica con "Parada" si cuentan';
  } else if (paradas.length) {
    if (!casa) revisar = ctx.hayColResidencia ? `Falta la dirección de residencia de ${empleado}` : 'Falta la columna Direccion_Residencia en EMPLEADOS';
    else {
      const sin = paradas.find(p => !ctx.sitios[p.cliente] || !isFinite(ctx.sitios[p.cliente].lat) || !isFinite(ctx.sitios[p.cliente].lon));
      if (sin) revisar = `Sin coordenadas en SITIOS: ${sin.cliente}`;
    }
  }

  if (!revisar && paradas.length) {
    const pts = [casaPunto(empleado, casa), ...paradas.map(p => sitioPunto(p.cliente, ctx.sitios[p.cliente])), casaPunto(empleado, casa)];
    const legs = await Promise.all(pts.slice(0, -1).map(async (a, i) => {
      try { const d = await distancia(a, pts[i + 1], ctx.dist); return { ok: true, millas: d.millas, fuente: d.fuente }; }
      catch (e) { return { ok: false, error: e.message }; }
    }));
    legs.forEach((l, i) => dia.tramos.push({ orden: i + 1, origen: corto(pts[i]), destino: corto(pts[i + 1]), millas: l.millas, pagado: i < legs.length - 1, fuente: l.fuente, error: l.error }));
    const fallo = legs.find(l => !l.ok);
    if (fallo) revisar = 'No se pudo calcular la distancia: ' + fallo.error;
    else {
      dia.millasPagadas = r2(dia.tramos.filter(t => t.pagado).reduce((a, t) => a + t.millas, 0));
      dia.millasTotal = r2(dia.tramos.reduce((a, t) => a + t.millas, 0));
      if (dia.millasPagadas > fija) dia.auto = null;
      else dia.auto = (paradas.length === siempre || dia.millasPagadas >= umbral) ? r2(dia.millasPagadas * rate) : 0;
    }
  }

  if (ov) { dia.estado = 'Ajustado'; dia.monto = ov.monto; dia.nota = ov.motivo; dia.aviso = revisar; }
  else if (revisar) { dia.estado = 'Revisar'; dia.nota = revisar; }
  else if (!paradas.length) { dia.estado = 'Sin millas'; }
  else if (dia.auto === null) { dia.estado = 'Revisar'; dia.nota = `Más de ${fija} mi pagadas (${dia.millasPagadas.toFixed(1)}): escribe el monto con "Ajustar monto"`; }
  else { dia.estado = 'Calculado'; dia.monto = dia.auto; }
  return dia;
}

async function calcularMillasEmpleado({ empleado, rows, canceladas, cfg, ctx }) {
  const cand = [...rows.map(c => ({ r: c.r, c, cancelada: false })), ...canceladas.map(r => ({ r, c: null, cancelada: true }))];
  const porDia = {};
  cand.forEach(x => { (porDia[x.r._fecha] = porDia[x.r._fecha] || []).push(x); });
  return Promise.all(Object.keys(porDia).sort().map(f => calcularDia({ empleado, fecha: f, cand: porDia[f], cfg, ctx })));
}

// ---------- registros manuales (solo agregan filas) ----------
async function registrarParada({ id, empleado, fecha, cuenta, motivo, admin }) {
  await asegurarHoja('NOMINA_PARADAS', PARADAS_HEADERS);
  await agregarFila('NOMINA_PARADAS', [ahora(), id, empleado, fecha, cuenta, motivo, admin]);
}
async function registrarAjusteMillas({ empleado, fecha, monto, motivo, admin }) {
  await asegurarHoja('NOMINA_MILLAS_AJUSTES', MA_HEADERS);
  await agregarFila('NOMINA_MILLAS_AJUSTES', [ahora(), empleado, fecha, monto, motivo, admin]);
}

// ---------- copia congelada al cerrar ----------
async function guardarSnapshot({ id, lunes, empleado, dias }) {
  await asegurarHoja('NOMINA_TRAMOS', TR_HEADERS);
  await asegurarHoja('NOMINA_MILLAS_DIA', MD_HEADERS);
  const tr = [], md = [];
  dias.forEach(d => {
    d.tramos.forEach(t => tr.push([id, lunes, empleado, d.fecha, t.orden, t.origen, t.destino, t.millas, t.pagado ? 'Sí' : 'No', t.fuente || '']));
    md.push([id, lunes, empleado, d.fecha, d.paradas, d.millasPagadas, d.millasTotal, d.monto, d.estado, d.estado === 'Ajustado' ? d.nota : '', d.aviso || '']);
  });
  await agregarFilas('NOMINA_TRAMOS', tr);
  await agregarFilas('NOMINA_MILLAS_DIA', md);
}
async function leerSnapshot(id) {
  const [tr, md] = await Promise.all([cargarTabla('NOMINA_TRAMOS', TR_HEADERS), cargarTabla('NOMINA_MILLAS_DIA', MD_HEADERS)]);
  return { tramos: tr.filter(t => t.ID_Liquidacion === id), dias: md.filter(d => d.ID_Liquidacion === id) };
}

// ---------- HTML ----------
const badge = e => `<span class="est ${e === 'Revisar' ? 'rev' : e === 'Ajustado' ? 'aj' : e === 'Calculado' ? 'ok' : ''}">${esc(e)}</span>`;

function tablaAbierta(dias) {
  if (!dias.length) return '<div class="aviso">Sin servicios para calcular millas esta semana.</div>';
  let tp = 0, tt = 0, tm = 0;
  const filas = dias.map(d => {
    tp += d.millasPagadas; tt += d.millasTotal; tm += d.monto;
    const items = d.items.map(i => `<div>${i.estado === 'Sí' ? '✔' : i.estado === 'No' ? '✖' : '❓'} ${esc(i.cliente)}${i.cancelada ? ' <small>(cancelado)</small>' : ''}${i.estado === 'Pendiente' ? ' <small>(sin check-in)</small>' : ''}
      <button class="btn" style="padding:1px 6px;font-size:12px;" data-id="${esc(i.id)}" data-t="${esc(i.cliente + ' · ' + d.fecha)}" data-cuenta="${i.manual ? i.estado : ''}" onclick="tcParada(this)">${i.manual ? 'Parada ✎' : 'Parada'}</button></div>`).join('');
    const tramos = d.tramos.map(t => `<div><small>${esc(t.origen)} → ${esc(t.destino)}: ${t.error ? `<span class="neg">${esc(t.error)}</span>` : (t.millas ?? 0).toFixed(1) + ' mi'}${t.pagado ? '' : ' · regreso, no se paga'}</small></div>`).join('');
    const nota = d.estado === 'Revisar' ? `<br><small class="neg">${esc(d.nota)}</small>`
      : d.estado === 'Ajustado' ? `<br><small>${esc(d.nota)} · automático: ${d.auto === null ? '—' : usd(d.auto)}${d.aviso ? ' · ⚠ ' + esc(d.aviso) : ''}</small>` : '';
    return `<tr><td>${diaSemana(d.fecha)} ${d.fecha.slice(8)}</td>
      <td><details${d.estado === 'Revisar' ? ' open' : ''}><summary><small>${d.paradas} parada(s) · ${d.items.length} servicio(s)</small></summary>${items}</details></td>
      <td><details><summary><small>Ver recorrido</small></summary>${tramos || '<small>—</small>'}</details></td>
      <td class="num">${d.millasPagadas.toFixed(1)}</td><td class="num">${d.millasTotal.toFixed(1)}</td><td class="num">${usd(d.monto)}</td>
      <td>${badge(d.estado)}${nota}</td>
      <td><button class="btn" data-fecha="${esc(d.fecha)}" data-monto="${d.monto}" data-t="${esc('Millas del ' + d.fecha)}" onclick="tcMillas(this)">Ajustar monto</button></td></tr>`;
  }).join('');
  return `<table><tr><th>Día</th><th>Paradas (✔ cuenta · ✖ no cuenta)</th><th>Recorrido</th><th class="num">Mi. pagadas</th><th class="num">Mi. total (con regreso)</th><th class="num">Monto</th><th>Estado</th><th></th></tr>${filas}
    <tfoot><tr><td colspan="3">Total semana</td><td class="num">${r2(tp).toFixed(1)}</td><td class="num">${r2(tt).toFixed(1)}</td><td class="num">${usd(r2(tm))}</td><td colspan="2"></td></tr></tfoot></table>`;
}

function tablaCerrada(snap) {
  if (!snap.dias.length) return '<div class="aviso">Esta liquidación no guarda detalle de millas (se cerró antes de la Fase 2).</div>';
  const filas = snap.dias.map(d => {
    const f = normalizarFecha(d.Fecha);
    const tr = snap.tramos.filter(t => normalizarFecha(t.Fecha) === f).sort((a, b) => (numero(a.Orden) || 0) - (numero(b.Orden) || 0))
      .map(t => `<div><small>${esc(t.Origen)} → ${esc(t.Destino)}: ${(numero(t.Millas) || 0).toFixed(1)} mi${t.Pagado === 'Sí' ? '' : ' · regreso, no se paga'}</small></div>`).join('');
    return `<tr><td>${diaSemana(f)} ${f.slice(8)}</td><td class="num">${numero(d.Paradas) || 0}</td><td>${tr || '<small>—</small>'}</td>
      <td class="num">${(numero(d.Millas_Pagadas) || 0).toFixed(1)}</td><td class="num">${(numero(d.Millas_Total) || 0).toFixed(1)}</td>
      <td class="num">${usd(numero(d.Monto_Millas) || 0)}</td><td>${badge(d.Estado)}${d.Motivo_Ajuste ? `<br><small>${esc(d.Motivo_Ajuste)}</small>` : ''}</td></tr>`;
  }).join('');
  return `<table><tr><th>Día</th><th class="num">Paradas</th><th>Recorrido</th><th class="num">Mi. pagadas</th><th class="num">Mi. total (con regreso)</th><th class="num">Monto</th><th>Estado</th></tr>${filas}</table>`;
}

module.exports = { cargarContexto, calcularMillasEmpleado, volcarDistancias, registrarParada, registrarAjusteMillas, guardarSnapshot, leerSnapshot, tablaAbierta, tablaCerrada };