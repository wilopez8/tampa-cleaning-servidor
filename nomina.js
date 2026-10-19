const { leerHoja, agregarFila, agregarFilas, actualizarCeldas, asegurarHoja, invalidarCache, edadCacheSegundos } = require('./sheets');
const { normalizarFecha, fechaValida, hoyFlorida, sumarDias, inicioSemana, diaSemana, filasDelRango } = require('./agenda');
const millas = require('./millas');
const menu = require('./menu');

const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const enc = s => encodeURIComponent(s).replace(/'/g, '%27');
const jsonSeguro = v => JSON.stringify(v).replace(/</g, '\\u003c');
const HORA = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp])?\.?[Mm]?/g;
const p2 = n => String(n).padStart(2, '0');
const r2 = x => Math.round(x * 100) / 100;

const CONFIG_HEADERS = ['Clave', 'Valor', 'Descripcion'];
const CONFIG_DEFAULTS = [
  ['Recargo_Sabado_Hora', '1', 'USD adicionales por cada hora trabajada en sábado'],
  ['Tarifa_Milla', '0.37', 'USD por milla'],
  ['Umbral_Millas_Dia', '10', 'El día paga millas solo si el total de millas pagadas (sin el regreso) llega a este número'],
  ['Servicios_Pago_Siempre', '2', 'Con esta cantidad de servicios en el día, las millas se pagan siempre'],
  ['Umbral_Tarifa_Fija', '20', 'Por encima de estas millas pagadas el administrador escribe el monto del día'],
];
const AJ_HEADERS = ['Fecha_Hora', 'ID_Programacion', 'Empleado', 'Fecha_Servicio', 'Pago_Inicio', 'Pago_Fin', 'Motivo', 'Ajustado_Por', 'Referencia'];
const PA_HEADERS = ['ID_Concepto', 'Semana_Inicio', 'Empleado', 'Fecha', 'Tipo', 'Descripcion', 'Monto', 'ID_Programacion', 'Creado_Por', 'Fecha_Creacion', 'Estado', 'Anulado_Por', 'Motivo_Anulacion', 'ID_Liquidacion'];
const LQ_HEADERS = ['ID_Liquidacion', 'Semana_Inicio', 'Empleado', 'Estado', 'Servicios', 'Minutos', 'Monto_Horas', 'Monto_Millas', 'Monto_Propinas_Bonos', 'Monto_Descuentos', 'Total', 'Cerrado_Por', 'Fecha_Cierre', 'Reabierto_Por', 'Fecha_Reapertura', 'Motivo_Reapertura'];
const ND_HEADERS = ['ID_Liquidacion', 'Semana_Inicio', 'Empleado', 'ID_Programacion', 'Fecha_Servicio', 'Cliente', 'Tipo_Servicio', 'Prog_Inicio', 'Prog_Fin', 'Real_Entrada', 'Real_Salida', 'Pago_Inicio', 'Pago_Fin', 'Minutos', 'Tarifa_Base', 'Recargo_Sabado', 'Tarifa_Efectiva', 'Monto_Horas', 'Estado_Calculo', 'Millas_Pagadas', 'Monto_Millas', 'Motivo_Ajuste'];
const TIPOS = ['Propina', 'Bono', 'Descuento', 'Otro'];

// Una sola escritura sensible a la vez (evita IDs repetidos y dobles cierres)
let cola = Promise.resolve();
const enCola = fn => { const p = cola.then(fn); cola = p.catch(() => {}); return p; };
const ahora = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

// ---------- utilidades ----------
function numero(t) {
  let s = String(t ?? '').replace(/[$\s]/g, '');
  if (!s) return NaN;
  const c = s.lastIndexOf(','), p = s.lastIndexOf('.');
  if (c >= 0 && p >= 0) s = c > p ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (c >= 0) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
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
const t12 = m => (m === null || m === undefined) ? '' : f12(m);
const fmtDur = min => `${Math.floor(min / 60)} h ${p2(min % 60)} min`;
const usd = n => '$' + (n || 0).toFixed(2);
const sec = (t, c) => `<details class="sec" open><summary>${t}</summary>${c}</details>`;

// ---------- lectura de hojas ----------
const aseguradas = new Set();
async function cargarTabla(nombre, headers) {
  if (!aseguradas.has(nombre)) { await asegurarHoja(nombre, headers); aseguradas.add(nombre); }
  const d = await leerHoja(nombre, { cache: true });
  const lista = [];
  lista.h = (d[0] && d[0].length) ? d[0] : headers;
  for (let i = 1; i < d.length; i++) {
    const o = { _fila: i + 1 }; // fila real en la hoja
    lista.h.forEach((n, j) => { o[n] = d[i][j] === undefined ? '' : String(d[i][j]); });
    lista.push(o);
  }
  return lista;
}

async function cargarConfig() {
  if (!aseguradas.has('CONFIG_NOMINA')) { await asegurarHoja('CONFIG_NOMINA', CONFIG_HEADERS); aseguradas.add('CONFIG_NOMINA'); }
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
  const mapa = {};
  (await cargarTabla('NOMINA_AJUSTES', AJ_HEADERS)).forEach(o => {
    const id = o.ID_Programacion;
    if (!id) return;
    const ini = o.Pago_Inicio.trim(), fin = o.Pago_Fin.trim();
    if (!ini && !fin) delete mapa[id];
    else mapa[id] = { ini, fin, sinPago: ini.toUpperCase() === 'SIN PAGO', motivo: o.Motivo, por: o.Ajustado_Por };
  });
  return mapa;
}

async function cargarConceptos() {
  const l = await cargarTabla('PAGOS_ADICIONALES', PA_HEADERS);
  const out = l.filter(o => o.ID_Concepto).map(o => ({ ...o, _semana: normalizarFecha(o.Semana_Inicio), _monto: numero(o.Monto) || 0 }));
  out.h = l.h;
  return out;
}

async function cargarLiquidaciones() {
  const l = await cargarTabla('LIQUIDACIONES', LQ_HEADERS);
  const out = l.filter(o => o.ID_Liquidacion).map(o => ({ ...o, _semana: normalizarFecha(o.Semana_Inicio) }));
  out.h = l.h;
  return out;
}
const cerradaDe = (liqs, sem, emp) => liqs.find(l => l.Estado === 'Cerrada' && l._semana === sem && l.Empleado === emp);
const idsCerrados = liqs => new Set(liqs.filter(l => l.Estado === 'Cerrada').map(l => l.ID_Liquidacion));
const conceptoAbierto = (c, cerrados) => c.Estado === 'Activo' && (!c.ID_Liquidacion || !cerrados.has(c.ID_Liquidacion));
function sumaCons(lista) {
  let mas = 0, menos = 0;
  lista.forEach(c => { if (c.Tipo === 'Descuento') menos += c._monto; else mas += c._monto; });
  return { mas: r2(mas), menos: r2(menos) };
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
  if (ajuste && ajuste.sinPago) {
    estado = 'Sin pago';
  } else if (ajuste) {
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
  if (estado !== 'Revisar' && estado !== 'Sin pago' && min <= 0) { estado = 'Revisar'; nota = 'Horas pagadas ≤ 0'; min = 0; ini = fin = null; }

  const sabado = diaSemana(r._fecha) === 'Sáb';
  const sinTarifa = estado !== 'Sin pago' && !(tarifa > 0);
  const recargo = sabado ? (cfg.Recargo_Sabado_Hora || 0) : 0;
  const efectiva = tarifa > 0 ? tarifa + recargo : 0;
  const monto = (estado === 'Revisar' || estado === 'Sin pago' || sinTarifa) ? 0 : r2(min / 60 * efectiva);
  return { r, prog: { ini: pIni, fin: pFin }, real: { ini: eIni, fin: eFin }, pago: { ini, fin }, min, refMin, sabado, tarifa: tarifa > 0 ? tarifa : 0, recargo, efectiva, monto, estado, nota, sinTarifa, ajuste };
}
const necesitaRevision = c => c.estado === 'Revisar' || c.sinTarifa;

async function datosEmpleado(empleado, lunes) {
  const [filas, cfg, tar, ajustes] = await Promise.all([filasDelRango(lunes, sumarDias(lunes, 6)), cargarConfig(), cargarTarifas(), cargarAjustes()]);
  const propias = filas.filter(r => String(r.Empleado || '').trim() === empleado);
  const rows = propias.filter(r => r._estado !== 'Cancelado').map(r => calcular(r, ajustes[r.ID_Programacion], tar.mapa[empleado], cfg));
  const canceladas = propias.filter(r => r._estado === 'Cancelado');
  return { rows, canceladas, cfg };
}

// ---------- acciones ----------
async function buscarServicio(id) {
  const datos = await leerHoja('PROGRAMACION_DIARIA');
  if (!datos.length) return null;
  const h = datos[0], ix = n => h.indexOf(n);
  const f = datos.slice(1).find(x => x[ix('ID_Programacion')] === id);
  if (!f) return null;
  return { f, ix, empleado: String(f[ix('Empleado')] || '').trim(), fecha: normalizarFecha(f[ix('Fecha_Servicio')]), cancelado: f[ix('Cancelado')] === 'Sí' };
}

async function ajustar({ id, inicio, fin, sinPago, motivo, admin }) {
  id = String(id || '').trim();
  inicio = String(inicio || '').trim(); fin = String(fin || '').trim();
  if (String(motivo || '').trim().length < 3) return { ok: false, general: 'El motivo es obligatorio (mínimo 3 caracteres).' };
  if (!sinPago) {
    if ((inicio && !fin) || (!inicio && fin)) return { ok: false, general: 'Indica inicio y fin, o deja ambos vacíos para quitar el ajuste.' };
    if (inicio) {
      const a = minutosDe(inicio), b = minutosDe(fin);
      if (a === null || b === null) return { ok: false, general: 'Hora no válida.' };
      if (a === b) return { ok: false, general: 'El inicio y el fin no pueden ser iguales (usa "Sin pago").' };
    }
  }
  const s = await buscarServicio(id);
  if (!s) return { ok: false, general: 'Servicio no encontrado.' };
  if (s.cancelado) return { ok: false, general: 'El servicio está cancelado.' };
  if (cerradaDe(await cargarLiquidaciones(), inicioSemana(s.fecha), s.empleado)) return { ok: false, general: 'La liquidación de esa semana está cerrada. Reábrela primero.' };
  const ix = s.ix, f = s.f;
  const referencia = `Prog: ${f[ix('Horario')] || ''} | Real: ${f[ix('Hora_Entrada_Real')] || '—'} → ${f[ix('Hora_Salida_Real')] || '—'}`;
  await agregarFila('NOMINA_AJUSTES', [ahora(), id, s.empleado, s.fecha, sinPago ? 'SIN PAGO' : inicio, sinPago ? 'SIN PAGO' : fin, String(motivo).trim(), admin, referencia]);
  return { ok: true };
}

async function marcarParada({ id, cuenta, motivo, admin }) {
  id = String(id || '').trim(); cuenta = String(cuenta || '').trim();
  if (!['Sí', 'No', ''].includes(cuenta)) return { ok: false, general: 'Opción no válida.' };
  if (String(motivo || '').trim().length < 3) return { ok: false, general: 'El motivo es obligatorio.' };
  const s = await buscarServicio(id);
  if (!s) return { ok: false, general: 'Servicio no encontrado.' };
  if (cerradaDe(await cargarLiquidaciones(), inicioSemana(s.fecha), s.empleado)) return { ok: false, general: 'La liquidación de esa semana está cerrada. Reábrela primero.' };
  await millas.registrarParada({ id, empleado: s.empleado, fecha: s.fecha, cuenta, motivo: String(motivo).trim(), admin });
  return { ok: true };
}

async function ajustarMillasDia({ empleado, fecha, monto, motivo, admin }) {
  empleado = String(empleado || '').trim();
  if (!fechaValida(fecha)) return { ok: false, general: 'Fecha no válida.' };
  if (String(motivo || '').trim().length < 3) return { ok: false, general: 'El motivo es obligatorio.' };
  const tar = await cargarTarifas();
  if (!Object.prototype.hasOwnProperty.call(tar.mapa, empleado)) return { ok: false, general: 'Empleado no encontrado en EMPLEADOS.' };
  let m = '';
  if (String(monto ?? '').trim() !== '') {
    m = numero(monto);
    if (!(m >= 0)) return { ok: false, general: 'El monto no es válido.' };
    m = r2(m);
  }
  if (cerradaDe(await cargarLiquidaciones(), inicioSemana(fecha), empleado)) return { ok: false, general: 'La liquidación de esa semana está cerrada. Reábrela primero.' };
  await millas.registrarAjusteMillas({ empleado, fecha, monto: m, motivo: String(motivo).trim(), admin });
  return { ok: true };
}

function agregarConcepto({ empleado, semana, tipo, descripcion, monto, idServicio, admin }) {
  return enCola(async () => {
    empleado = String(empleado || '').trim();
    const tar = await cargarTarifas();
    if (!Object.prototype.hasOwnProperty.call(tar.mapa, empleado)) return { ok: false, general: 'Empleado no encontrado en EMPLEADOS.' };
    if (!TIPOS.includes(tipo)) return { ok: false, general: 'Tipo no válido.' };
    const m = numero(monto);
    if (!(m > 0)) return { ok: false, general: 'El monto debe ser mayor que 0.' };
    if (String(descripcion || '').trim().length < 3) return { ok: false, general: 'La descripción es obligatoria (mínimo 3 caracteres).' };
    const [liqs, conceptos] = await Promise.all([cargarLiquidaciones(), cargarConceptos()]);
    const pedida = inicioSemana(fechaValida(semana) ? semana : hoyFlorida());
    let sem = pedida, n = 0;
    while (cerradaDe(liqs, sem, empleado) && n++ < 52) sem = sumarDias(sem, 7);
    const hoy = hoyFlorida();
    const prefijo = `PAG-${hoy.replace(/-/g, '')}-`;
    const id = prefijo + p2(conceptos.filter(c => c.ID_Concepto.startsWith(prefijo)).length + 1);
    await agregarFila('PAGOS_ADICIONALES', [id, sem, empleado, hoy, tipo, String(descripcion).trim(), r2(m), String(idServicio || '').trim(), admin, ahora(), 'Activo', '', '', '']);
    return { ok: true, id, semana: sem, movida: sem !== pedida };
  });
}

function anularConcepto({ id, motivo, admin }) {
  return enCola(async () => {
    if (String(motivo || '').trim().length < 3) return { ok: false, general: 'El motivo es obligatorio.' };
    const conceptos = await cargarConceptos();
    const c = conceptos.find(x => x.ID_Concepto === String(id || ''));
    if (!c) return { ok: false, general: 'Concepto no encontrado.' };
    if (c.Estado !== 'Activo') return { ok: false, general: 'El concepto ya estaba anulado.' };
    const liqs = await cargarLiquidaciones();
    if (!conceptoAbierto(c, idsCerrados(liqs))) return { ok: false, general: 'Está en una liquidación cerrada. Reábrela primero.' };
    const col = n => conceptos.h.indexOf(n) + 1;
    await actualizarCeldas('PAGOS_ADICIONALES', [
      { fila: c._fila, columna: col('Estado'), valor: 'Anulado' },
      { fila: c._fila, columna: col('Anulado_Por'), valor: admin },
      { fila: c._fila, columna: col('Motivo_Anulacion'), valor: String(motivo).trim() },
    ]);
    return { ok: true };
  });
}

function cerrar({ empleado, semana, admin }) {
  return enCola(async () => {
    empleado = String(empleado || '').trim();
    if (!fechaValida(semana)) return { ok: false, general: 'Semana no válida.' };
    const lunes = inicioSemana(semana);
    ['PROGRAMACION_DIARIA', 'EMPLEADOS', 'CONFIG_NOMINA', 'SITIOS', 'LIQUIDACIONES', 'PAGOS_ADICIONALES', 'NOMINA_AJUSTES', 'NOMINA_PARADAS', 'NOMINA_MILLAS_AJUSTES', 'DISTANCIAS'].forEach(invalidarCache); // cierre siempre con datos frescos
    const [liqs, conceptos] = await Promise.all([cargarLiquidaciones(), cargarConceptos()]);
    if (cerradaDe(liqs, lunes, empleado)) return { ok: false, general: 'Esta liquidación ya está cerrada.' };
    const { rows, canceladas, cfg } = await datosEmpleado(empleado, lunes);
    const cerrados = idsCerrados(liqs);
    const cons = conceptos.filter(c => c._semana === lunes && c.Empleado === empleado && conceptoAbierto(c, cerrados));

    const pend = rows.filter(necesitaRevision).length;
    if (pend) return { ok: false, general: `Hay ${pend} servicio(s) por revisar (sin check-in o sin tarifa). Ajústalos o márcalos "Sin pago".` };

    const ctx = await millas.cargarContexto();
    const dias = await millas.calcularMillasEmpleado({ empleado, rows, canceladas, cfg, ctx });
    try { await millas.volcarDistancias(ctx.dist); } catch (e) { console.error('No se pudo guardar DISTANCIAS:', e.message); }
    const pendM = dias.filter(d => d.estado === 'Revisar').length;
    if (pendM) return { ok: false, general: `Hay ${pendM} día(s) con millas por revisar.` };
    const montoM = r2(dias.reduce((a, d) => a + d.monto, 0));
    if (!rows.length && !cons.length && !montoM) return { ok: false, general: 'No hay servicios, millas ni conceptos para cerrar.' };

    const minutos = rows.reduce((a, c) => a + c.min, 0);
    const montoH = r2(rows.reduce((a, c) => a + c.monto, 0));
    const { mas, menos } = sumaCons(cons);
    const total = r2(montoH + montoM + mas - menos);
    const id = `LIQ-${lunes.replace(/-/g, '')}-${p2(liqs.filter(l => l._semana === lunes).length + 1)}`;

    await asegurarHoja('NOMINA_DIAS', ND_HEADERS);
    await agregarFilas('NOMINA_DIAS', rows.map(c => [
      id, lunes, empleado, c.r.ID_Programacion, c.r._fecha, c.r.Cliente, c.r.Tipo_Servicio || 'Limpieza',
      t12(c.prog.ini), t12(c.prog.fin), t12(c.real.ini), t12(c.real.fin), t12(c.pago.ini), t12(c.pago.fin),
      c.min, c.tarifa, c.sabado ? c.recargo : 0, c.efectiva, c.monto, c.estado, 0, 0, c.ajuste ? c.ajuste.motivo : '',
    ]));
    await millas.guardarSnapshot({ id, lunes, empleado, dias });
    await agregarFila('LIQUIDACIONES', [id, lunes, empleado, 'Cerrada', rows.length, minutos, montoH, montoM, mas, menos, total, admin, ahora(), '', '', '']);
    if (cons.length) {
      const col = conceptos.h.indexOf('ID_Liquidacion') + 1;
      await actualizarCeldas('PAGOS_ADICIONALES', cons.map(c => ({ fila: c._fila, columna: col, valor: id })));
    }
    return { ok: true, id, total };
  });
}

function reabrir({ empleado, semana, motivo, admin }) {
  return enCola(async () => {
    if (String(motivo || '').trim().length < 3) return { ok: false, general: 'El motivo es obligatorio.' };
    if (!fechaValida(semana)) return { ok: false, general: 'Semana no válida.' };
    const lunes = inicioSemana(semana);
    const liqs = await cargarLiquidaciones();
    const l = cerradaDe(liqs, lunes, String(empleado || '').trim());
    if (!l) return { ok: false, general: 'No hay una liquidación cerrada para reabrir.' };
    const col = n => liqs.h.indexOf(n) + 1;
    await actualizarCeldas('LIQUIDACIONES', [
      { fila: l._fila, columna: col('Estado'), valor: 'Reabierta' },
      { fila: l._fila, columna: col('Reabierto_Por'), valor: admin },
      { fila: l._fila, columna: col('Fecha_Reapertura'), valor: ahora() },
      { fila: l._fila, columna: col('Motivo_Reapertura'), valor: String(motivo).trim() },
    ]);
    return { ok: true };
  });
}

// ---------- página ----------
const CSS = `
body{font-family:-apple-system,Arial,sans-serif;margin:0;padding:20px 28px;color:#222;background:#f6f7f9;}
a{color:#1d4ed8;text-decoration:none;}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;}
.nav{display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap;}
.btn{background:#fff;border:1px solid #ccc;border-radius:6px;padding:7px 12px;font-size:14px;cursor:pointer;color:#222;}
.btn:disabled{opacity:.5;cursor:not-allowed;}
.hoy{background:#2e7d32;color:#fff;border-color:#2e7d32;}
.warn{background:#b45309;color:#fff;border-color:#b45309;}
.aviso{background:#eef2ff;border-radius:6px;padding:8px 12px;font-size:14px;margin-bottom:12px;}
.aviso.r{background:#fef2f2;} .aviso.y{background:#fffbeb;}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;margin-bottom:18px;}
th,td{padding:8px 10px;text-align:left;font-size:13px;border-bottom:1px solid #eee;vertical-align:top;}
th{background:#f1f3f5;} tfoot td{font-weight:700;background:#f9fafb;}
.num{text-align:right;white-space:nowrap;} .neg{color:#b91c1c;}
.est{padding:2px 8px;border-radius:10px;font-size:12px;background:#e5e7eb;}
.est.ok{background:#bbf7d0;} .est.aj{background:#bfdbfe;} .est.rev{background:#fecaca;} .est.cer{background:#ddd6fe;} .est.sp{background:#fde68a;}
small{color:#777;}
dialog{border:1px solid #ccc;border-radius:10px;padding:18px;max-width:360px;width:90%;}
dialog label{display:block;margin:10px 0;font-size:14px;}
dialog input,dialog select{width:100%;padding:8px;font-size:15px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;}
details.sec{margin-bottom:14px;} details.sec>summary{cursor:pointer;font-weight:700;font-size:15px;padding:8px 12px;background:#e8ebf0;border-radius:6px;margin-bottom:8px;}
td details summary{cursor:pointer;color:#1d4ed8;}
table.tm{table-layout:fixed;}
table.tm th:nth-child(1){width:7%;} table.tm th:nth-child(2){width:23%;} table.tm th:nth-child(3){width:23%;}
table.tm th:nth-child(4){width:8%;} table.tm th:nth-child(5){width:10%;} table.tm th:nth-child(6){width:8%;}
table.tm th:nth-child(7){width:12%;} table.tm th:nth-child(8){width:9%;}
table.tm td{overflow-wrap:anywhere;} table.tm .btn{white-space:normal;}`;

const SCRIPT = `
function $(i){return document.getElementById(i);}
function post(url,data,errId,okFn){fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(function(r){return r.json();}).then(function(j){if(j.ok){if(okFn){okFn(j);}else{location.reload();}}else{$(errId).textContent=j.general||'Error';}}).catch(function(){$(errId).textContent='Error de conexión';});}
var ajId=null;
function tcAjustar(b){ajId=b.dataset.id;$('dt').textContent=b.dataset.t;$('di').value=b.dataset.ini;$('df').value=b.dataset.fin;$('dm').value='';$('de').textContent='';$('dlg').showModal();}
function tcGuardar(sin){var m=$('dm').value.trim();if(m.length<3){$('de').textContent='El motivo es obligatorio.';return;}post('/nomina/ajustar',{id:ajId,inicio:sin?'':$('di').value,fin:sin?'':$('df').value,sinPago:!!sin,motivo:m},'de');}
function tcConcepto(){$('ct').value='Propina';$('cd').value='';$('cmn').value='';$('cs').value='';$('ce').textContent='';$('dlgc').showModal();}
function tcGuardarConcepto(){post('/nomina/concepto',{empleado:EMP,semana:SEM,tipo:$('ct').value,descripcion:$('cd').value,monto:$('cmn').value,idServicio:$('cs').value},'ce',function(j){if(j.movida){alert('La semana de este empleado está cerrada. El concepto quedó en la semana '+j.semana+'.');}location.reload();});}
var motivoFn=null;
function tcPedirMotivo(titulo,fn){$('mt').textContent=titulo;$('mm').value='';$('me').textContent='';motivoFn=fn;$('dlgm').showModal();}
function tcMotivoOk(){var m=$('mm').value.trim();if(m.length<3){$('me').textContent='El motivo es obligatorio.';return;}motivoFn(m);}
function tcAnular(b){var id=b.dataset.id;tcPedirMotivo('Anular concepto '+id,function(m){post('/nomina/concepto/anular',{id:id,motivo:m},'me');});}
function tcReabrir(){tcPedirMotivo('Reabrir la liquidación de '+EMP,function(m){post('/nomina/reabrir',{empleado:EMP,semana:SEM,motivo:m},'me');});}
function tcCerrar(){if(!confirm('¿Cerrar la liquidación de '+EMP+'? Quedará congelada (puedes reabrirla con motivo).'))return;post('/nomina/cerrar',{empleado:EMP,semana:SEM},'ce2');}
var parId=null;
function tcParada(b){parId=b.dataset.id;$('pt').textContent=b.dataset.t;$('pc').value=b.dataset.cuenta;$('pm').value='';$('pe').textContent='';$('dlgp').showModal();}
function tcGuardarParada(){var m=$('pm').value.trim();if(m.length<3){$('pe').textContent='El motivo es obligatorio.';return;}post('/nomina/parada',{id:parId,cuenta:$('pc').value,motivo:m},'pe');}
var mmFecha=null;
function tcMillas(b){mmFecha=b.dataset.fecha;$('mmt').textContent=b.dataset.t;$('mmv').value=b.dataset.monto;$('mmm').value='';$('mme').textContent='';$('dlgmm').showModal();}
function tcGuardarMillas(){var m=$('mmm').value.trim();if(m.length<3){$('mme').textContent='El motivo es obligatorio.';return;}post('/nomina/millas/ajustar',{empleado:EMP,fecha:mmFecha,monto:$('mmv').value,motivo:m},'mme');}
function tcTodo(a){document.querySelectorAll('details.sec').forEach(function(d){d.open=a;});}`;

async function paginaNomina(query, admin) {
  const hoy = hoyFlorida();
  const fecha = fechaValida(query.fecha) ? query.fecha : hoy;
  const lunes = inicioSemana(fecha), domingo = sumarDias(lunes, 6);

  const [filas, cfg, tar, ajustes, liqs, conceptos, ctx] = await Promise.all([
    filasDelRango(lunes, domingo), cargarConfig(), cargarTarifas(), cargarAjustes(), cargarLiquidaciones(), cargarConceptos(), millas.cargarContexto()]);

  const cerrados = idsCerrados(liqs);
  const cerradas = {};
  liqs.filter(l => l.Estado === 'Cerrada' && l._semana === lunes).forEach(l => { cerradas[l.Empleado] = l; });
  const consAbiertos = {};
  conceptos.filter(c => c._semana === lunes && conceptoAbierto(c, cerrados)).forEach(c => { (consAbiertos[c.Empleado] = consAbiertos[c.Empleado] || []).push(c); });

  const grupos = {}, cancelados = {};
  filas.filter(r => r.Empleado).forEach(r => {
    const nombre = r.Empleado.trim();
    if (r._estado === 'Cancelado') (cancelados[nombre] = cancelados[nombre] || []).push(r);
    else (grupos[nombre] = grupos[nombre] || []).push(calcular(r, ajustes[r.ID_Programacion], tar.mapa[nombre], cfg));
  });
  Object.values(grupos).forEach(g => g.sort((a, b) => a.r._fecha.localeCompare(b.r._fecha) || (a.prog.ini ?? 0) - (b.prog.ini ?? 0)));
  const nombres = [...new Set([...Object.keys(grupos), ...Object.keys(cancelados), ...Object.keys(consAbiertos), ...Object.keys(cerradas)])].sort((a, b) => a.localeCompare(b));
  const emp = nombres.includes(query.empleado) ? query.empleado : '';

  // millas de los empleados abiertos (los cerrados usan su copia congelada)
  const millasEmp = {};
  await Promise.all(nombres.filter(n => !cerradas[n]).map(async n => {
    millasEmp[n] = await millas.calcularMillasEmpleado({ empleado: n, rows: grupos[n] || [], canceladas: cancelados[n] || [], cfg, ctx });
  }));
  try { await millas.volcarDistancias(ctx.dist); } catch (e) { console.error('No se pudo guardar DISTANCIAS:', e.message); }

  const q = (f, e) => `/nomina?fecha=${f}${e ? '&empleado=' + enc(e) : ''}`;
  const tot = n => {
    const l = cerradas[n];
    if (l) return { cerrada: true, n: numero(l.Servicios) || 0, min: numero(l.Minutos) || 0, montoH: numero(l.Monto_Horas) || 0, millas: numero(l.Monto_Millas) || 0, mas: numero(l.Monto_Propinas_Bonos) || 0, menos: numero(l.Monto_Descuentos) || 0, total: numero(l.Total) || 0, rev: 0 };
    const g = grupos[n] || [], dm = millasEmp[n] || [], s = sumaCons(consAbiertos[n] || []);
    const montoH = r2(g.reduce((a, c) => a + c.monto, 0)), montoM = r2(dm.reduce((a, d) => a + d.monto, 0));
    return { cerrada: false, n: g.length, min: g.reduce((a, c) => a + c.min, 0), montoH, millas: montoM, mas: s.mas, menos: s.menos, total: r2(montoH + montoM + s.mas - s.menos),
      rev: g.filter(necesitaRevision).length + dm.filter(d => d.estado === 'Revisar').length };
  };

  // ----- resumen -----
  const G = { min: 0, montoH: 0, millas: 0, mas: 0, menos: 0, total: 0, rev: 0 };
  const resumen = nombres.map(n => {
    const t = tot(n);
    Object.keys(G).forEach(k => { G[k] += t[k]; });
    return `<tr><td><a href="${q(lunes, n)}">${esc(n)}</a></td><td class="num">${t.n}</td><td class="num">${fmtDur(t.min)}</td><td class="num">${usd(t.montoH)}</td><td class="num">${usd(t.millas)}</td>
      <td class="num">${usd(t.mas)}</td><td class="num neg">${t.menos ? '− ' + usd(t.menos) : usd(0)}</td><td class="num"><b>${usd(t.total)}</b></td>
      <td class="num">${t.rev ? `<span class="est rev">${t.rev}</span>` : '0'}</td><td>${t.cerrada ? '<span class="est cer">Cerrada</span>' : '<span class="est">Abierta</span>'}</td></tr>`;
  }).join('') || '<tr><td colspan="10" style="text-align:center;color:#888;padding:20px;">No hay servicios ni conceptos esta semana.</td></tr>';

  // ----- bloques reutilizables -----
  const caja = t => `<table style="width:360px;"><tr><td>Horas</td><td class="num">${usd(t.montoH)}</td></tr>
    <tr><td>Millas</td><td class="num">${usd(t.millas)}</td></tr>
    <tr><td>Propinas y bonos</td><td class="num">${usd(t.mas)}</td></tr>
    <tr><td>Descuentos</td><td class="num neg">− ${usd(t.menos)}</td></tr>
    <tfoot><tr><td>TOTAL A PAGAR</td><td class="num">${usd(t.total)}</td></tr></tfoot></table>`;

  const conceptosHtml = (lista, editable) => `<table>
    <tr><th>Fecha</th><th>Tipo</th><th>Descripción</th><th>Servicio</th><th class="num">Monto</th><th>Registrado por</th><th></th></tr>
    ${lista.length ? lista.map(c => `<tr><td>${esc(normalizarFecha(c.Fecha))}</td><td>${esc(c.Tipo)}</td><td>${esc(c.Descripcion)}</td><td><small>${esc(c.ID_Programacion)}</small></td>
      <td class="num ${c.Tipo === 'Descuento' ? 'neg' : ''}">${c.Tipo === 'Descuento' ? '− ' : ''}${usd(c._monto)}</td><td>${esc(c.Creado_Por)}</td>
      <td>${editable ? `<button class="btn" data-id="${esc(c.ID_Concepto)}" onclick="tcAnular(this)">Anular</button>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="7" style="text-align:center;color:#999;">Sin conceptos</td></tr>'}</table>`;

  // ----- detalle -----
  let detalle = '', scriptVars = '';
  if (emp) {
    const g = grupos[emp] || [];
    const liq = cerradas[emp];
    scriptVars = `var EMP=${jsonSeguro(emp)};var SEM=${jsonSeguro(lunes)};`;
    if (liq) {
      const [snap, snapM] = await Promise.all([cargarTabla('NOMINA_DIAS', ND_HEADERS), millas.leerSnapshot(liq.ID_Liquidacion)]);
      const snapDias = snap.filter(s => s.ID_Liquidacion === liq.ID_Liquidacion);
      const consLiq = conceptos.filter(c => c.ID_Liquidacion === liq.ID_Liquidacion && c.Estado === 'Activo');
      const idsVivos = g.map(c => c.r.ID_Programacion).sort().join(','), idsSnap = snapDias.map(s => s.ID_Programacion).sort().join(',');
      const montoVivo = r2(g.reduce((a, c) => a + c.monto, 0));
      const difiere = idsVivos !== idsSnap || Math.abs(montoVivo - (numero(liq.Monto_Horas) || 0)) > 0.005;
      const filasSnap = snapDias.map(s => {
        const f = normalizarFecha(s.Fecha_Servicio);
        const pi = minutosDe(s.Pago_Inicio), pf = minutosDe(s.Pago_Fin);
        return `<tr><td>${diaSemana(f)} ${f.slice(8)}</td><td>${esc(s.Cliente)}<br><small>${esc(s.Tipo_Servicio)}</small></td>
          <td>${f12(minutosDe(s.Prog_Inicio))} – ${f12(minutosDe(s.Prog_Fin))}</td><td>${f12(minutosDe(s.Real_Entrada))} – ${f12(minutosDe(s.Real_Salida))}</td>
          <td>${pi !== null ? `${f12(pi)} – ${f12(pf)}` : '—'}</td><td class="num">${fmtDur(numero(s.Minutos) || 0)}</td>
          <td class="num">${numero(s.Tarifa_Efectiva) > 0 ? usd(numero(s.Tarifa_Efectiva)) + '/h' : '—'}</td><td class="num">${usd(numero(s.Monto_Horas) || 0)}</td>
          <td><span class="est ${s.Estado_Calculo === 'Sin pago' ? 'sp' : (s.Estado_Calculo === 'Ajustado' ? 'aj' : 'ok')}" title="${esc(s.Motivo_Ajuste)}">${esc(s.Estado_Calculo)}</span></td></tr>`;
      }).join('');
      detalle = `<h3>${esc(emp)} <span class="est cer">Cerrada por ${esc(liq.Cerrado_Por)} · ${esc(liq.Fecha_Cierre)}</span></h3>
        ${difiere ? '<div class="aviso y">⚠️ El cálculo de horas en vivo ya no coincide con lo cerrado (cambió la agenda, la tarifa o la configuración). Lo cerrado no se modifica; reabre la liquidación si quieres recalcular.</div>' : ''}
        <div style="margin-bottom:8px;"><button class="btn" onclick="tcTodo(true)">Abrir todo</button> <button class="btn" onclick="tcTodo(false)">Cerrar todo</button></div>
        ${sec('Horas (servicios)', `<table><tr><th>Día</th><th>Servicio</th><th>Programado</th><th>Real (check-in)</th><th>Pagado</th><th class="num">Horas</th><th class="num">Tarifa</th><th class="num">Monto</th><th>Estado</th></tr>${filasSnap}</table>`)}
        ${sec('Millas', millas.tablaCerrada(snapM))}
        ${sec('Otros conceptos', conceptosHtml(consLiq, false))}
        ${caja(tot(emp))}
        <button class="btn warn" onclick="tcReabrir()">Reabrir liquidación</button>`;
    } else {
      const dm = millasEmp[emp] || [];
      const filasHtml = g.map(c => {
        const r = c.r;
        const cls = c.estado === 'Revisar' ? 'rev' : (c.estado === 'Ajustado' ? 'aj' : (c.estado === 'Sin pago' ? 'sp' : 'ok'));
        const horas = c.min ? fmtDur(c.min) : (c.refMin && c.estado !== 'Sin pago' ? `<small>prog. ${fmtDur(c.refMin)}</small>` : '—');
        const titulo = c.ajuste ? ` title="${esc(c.ajuste.motivo + ' — ' + c.ajuste.por)}"` : '';
        return `<tr>
          <td>${diaSemana(r._fecha)} ${r._fecha.slice(8)}${c.sabado ? '<br><small>sábado</small>' : ''}</td>
          <td>${esc(r.Cliente)}<br><small>${esc(r.Tipo_Servicio || 'Limpieza')}</small></td>
          <td>${f12(c.prog.ini)} – ${f12(c.prog.fin)}</td>
          <td>${f12(c.real.ini)} – ${f12(c.real.fin)}${r.Origen_Registro === 'Manual' ? ' ✍️' : ''}</td>
          <td>${c.pago.ini !== null ? `${f12(c.pago.ini)} – ${f12(c.pago.fin)}` : '—'}</td>
          <td class="num">${horas}</td>
          <td class="num">${c.efectiva > 0 ? usd(c.efectiva) + '/h' : '—'}</td>
          <td class="num">${usd(c.monto)}</td>
          <td><span class="est ${cls}"${titulo}>${esc(c.estado)}</span>${c.nota ? `<br><small>${esc(c.nota)}</small>` : ''}${c.sinTarifa ? '<br><small>Sin tarifa</small>' : ''}</td>
          <td><button class="btn" data-id="${esc(r.ID_Programacion)}" data-t="${esc(r.Cliente + ' · ' + r._fecha)}" data-ini="${f24(c.pago.ini ?? c.prog.ini)}" data-fin="${f24(c.pago.fin ?? c.prog.fin)}" onclick="tcAjustar(this)">Ajustar</button></td></tr>`;
      }).join('') || '<tr><td colspan="10" style="text-align:center;color:#999;">Sin servicios esta semana</td></tr>';
      const bloqueaH = g.filter(necesitaRevision).length, bloqueaM = dm.filter(d => d.estado === 'Revisar').length;
      const opcionesServ = g.map(c => `<option value="${esc(c.r.ID_Programacion)}">${diaSemana(c.r._fecha)} ${c.r._fecha.slice(8)} · ${esc(c.r.Cliente)}</option>`).join('');
      const pendTxt = [bloqueaH ? bloqueaH + ' servicio(s) por revisar' : '', bloqueaM ? bloqueaM + ' día(s) con millas por revisar' : ''].filter(Boolean).join(' · ');
      detalle = `<h3>${esc(emp)}</h3>
        <div style="margin-bottom:8px;"><button class="btn" onclick="tcTodo(true)">Abrir todo</button> <button class="btn" onclick="tcTodo(false)">Cerrar todo</button></div>
        ${sec('Horas (servicios)', `<table><tr><th>Día</th><th>Servicio</th><th>Programado</th><th>Real (check-in)</th><th>Pagado</th><th class="num">Horas</th><th class="num">Tarifa</th><th class="num">Monto</th><th>Estado</th><th></th></tr>${filasHtml}</table>`)}
        ${sec('Millas', millas.tablaAbierta(dm))}
        ${sec('Otros conceptos', conceptosHtml(consAbiertos[emp] || [], true) + '<button class="btn" onclick="tcConcepto()">+ Agregar concepto</button>')}
        <div style="margin-top:14px;">${caja(tot(emp))}</div>
        <button class="btn hoy" onclick="tcCerrar()" ${(bloqueaH || bloqueaM) ? 'disabled' : ''}>Cerrar liquidación de ${esc(emp)}</button>
        <span id="ce2" style="color:#b91c1c;font-size:13px;margin-left:8px;">${esc(pendTxt)}</span>
        <dialog id="dlgc"><h3 style="margin-top:0;">Agregar concepto</h3>
          <label>Tipo<select id="ct">${TIPOS.map(t => `<option>${t}</option>`).join('')}</select></label>
          <label>Descripción (obligatoria)<input type="text" id="cd" maxlength="200"></label>
          <label>Monto (USD)<input type="number" id="cmn" min="0" step="0.01"></label>
          <label>Servicio relacionado (opcional)<select id="cs"><option value="">— Ninguno —</option>${opcionesServ}</select></label>
          <p id="ce" style="color:#b91c1c;font-size:13px;"></p>
          <button class="btn hoy" onclick="tcGuardarConcepto()">Guardar</button> <button class="btn" onclick="$('dlgc').close()">Cancelar</button></dialog>
        <dialog id="dlgp"><h3 id="pt" style="margin-top:0;"></h3>
          <label>¿Cuenta como parada?<select id="pc"><option value="">Automático (según horas y check-in)</option><option value="Sí">Sí, pagar el desplazamiento</option><option value="No">No, no pagar el desplazamiento</option></select></label>
          <label>Motivo (obligatorio)<input type="text" id="pm" maxlength="200"></label>
          <p id="pe" style="color:#b91c1c;font-size:13px;"></p>
          <button class="btn hoy" onclick="tcGuardarParada()">Guardar</button> <button class="btn" onclick="$('dlgp').close()">Cancelar</button></dialog>
        <dialog id="dlgmm"><h3 id="mmt" style="margin-top:0;"></h3>
          <label>Monto de millas del día (USD)<input type="number" id="mmv" min="0" step="0.01"></label>
          <label>Motivo (obligatorio)<input type="text" id="mmm" maxlength="200"></label>
          <p style="font-size:12px;color:#777;">Deja el monto vacío para volver al cálculo automático.</p>
          <p id="mme" style="color:#b91c1c;font-size:13px;"></p>
          <button class="btn hoy" onclick="tcGuardarMillas()">Guardar</button> <button class="btn" onclick="$('dlgmm').close()">Cancelar</button></dialog>`;
    }
  }

  const sufijo = emp ? '&empleado=' + enc(emp) : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nómina ${lunes}</title><style>${CSS}${menu.MENU_CSS}</style></head><body>
<div class="top"><h2 style="margin:0;">Nómina — semana ${lunes} → ${domingo}</h2>
${menu.menuHtml('/nomina', admin)}</div>
<div class="nav">
  <a class="btn" href="${q(sumarDias(lunes, -7), emp)}">←</a>
  <a class="btn hoy" href="${q(hoy, emp)}">Esta semana</a>
  <a class="btn" href="${q(sumarDias(lunes, 7), emp)}">→</a>
  <input type="date" class="btn" value="${fecha}" onchange="if(this.value)location='/nomina?fecha='+this.value+'${esc(sufijo)}'">
  <form method="POST" action="/actualizar-cache" style="margin:0 0 0 auto;display:flex;gap:8px;align-items:center;">
    <span style="font-size:12px;color:#777;">Datos de hace ${edadCacheSegundos('PROGRAMACION_DIARIA') ?? 0} s</span>
    <input type="hidden" name="volver" value="${esc(q(fecha, emp))}"><button class="btn">Actualizar</button></form>
</div>
<div class="aviso">Horas: inicio más tarde y fin más temprano entre lo programado y el check-in. Millas: se pagan todos los tramos menos el regreso a casa. Lo que falta por revisar queda en $0 y bloquea el cierre. Al cerrar un empleado, sus valores quedan congelados.</div>
${tar.hayColumna ? '' : '<div class="aviso r">Falta la columna <b>Tarifa_Hora</b> en la hoja EMPLEADOS: todos los montos salen en $0.00.</div>'}
<table><tr><th>Empleado</th><th class="num">Servicios</th><th class="num">Horas pagadas</th><th class="num">Monto horas</th><th class="num">Millas</th><th class="num">Propinas y bonos</th><th class="num">Descuentos</th><th class="num">Total</th><th class="num">Por revisar</th><th>Estado</th></tr>${resumen}
<tfoot><tr><td>Total</td><td></td><td class="num">${fmtDur(G.min)}</td><td class="num">${usd(G.montoH)}</td><td class="num">${usd(G.millas)}</td><td class="num">${usd(G.mas)}</td><td class="num neg">− ${usd(G.menos)}</td><td class="num">${usd(G.total)}</td><td class="num">${G.rev}</td><td></td></tr></tfoot></table>
${detalle}
<dialog id="dlg"><h3 id="dt" style="margin-top:0;"></h3>
  <label>Inicio pagado<input type="time" id="di"></label>
  <label>Fin pagado<input type="time" id="df"></label>
  <label>Motivo (obligatorio)<input type="text" id="dm" maxlength="200"></label>
  <p style="font-size:12px;color:#777;">Inicio y fin vacíos quitan el ajuste y vuelven al cálculo automático. "Sin pago" deja el servicio en $0 de forma definitiva.</p>
  <p id="de" style="color:#b91c1c;font-size:13px;"></p>
  <button class="btn hoy" onclick="tcGuardar(false)">Guardar</button> <button class="btn warn" onclick="tcGuardar(true)">Sin pago</button> <button class="btn" onclick="$('dlg').close()">Cancelar</button></dialog>
<dialog id="dlgm"><h3 id="mt" style="margin-top:0;"></h3>
  <label>Motivo (obligatorio)<input type="text" id="mm" maxlength="200"></label>
  <p id="me" style="color:#b91c1c;font-size:13px;"></p>
  <button class="btn hoy" onclick="tcMotivoOk()">Confirmar</button> <button class="btn" onclick="$('dlgm').close()">Cancelar</button></dialog>
<script>${scriptVars}${SCRIPT}</script>
</body></html>`;
}

// ---------- rutas ----------
function rutas(app, auth) {
  const api = (ruta, fn) => app.post(ruta, auth.requiereAdmin, async (req, res) => {
    try { res.json(await fn(req.body || {}, req.admin)); }
    catch (err) { console.error('Error en POST ' + ruta, err); res.status(500).json({ ok: false, general: 'Error: ' + err.message }); }
  });
  app.get('/nomina', auth.requiereAdmin, async (req, res) => {
    try { res.set('Content-Type', 'text/html; charset=utf-8'); res.send(await paginaNomina(req.query, req.admin)); }
    catch (err) { console.error('Error en GET /nomina:', err); res.status(500).send('Error cargando la nómina: ' + err.message); }
  });
  api('/nomina/ajustar', (b, admin) => ajustar({ id: b.id, inicio: b.inicio, fin: b.fin, sinPago: !!b.sinPago, motivo: b.motivo, admin }));
  api('/nomina/parada', (b, admin) => marcarParada({ id: b.id, cuenta: b.cuenta, motivo: b.motivo, admin }));
  api('/nomina/millas/ajustar', (b, admin) => ajustarMillasDia({ empleado: b.empleado, fecha: b.fecha, monto: b.monto, motivo: b.motivo, admin }));
  api('/nomina/concepto', (b, admin) => agregarConcepto({ empleado: b.empleado, semana: b.semana, tipo: b.tipo, descripcion: b.descripcion, monto: b.monto, idServicio: b.idServicio, admin }));
  api('/nomina/concepto/anular', (b, admin) => anularConcepto({ id: b.id, motivo: b.motivo, admin }));
  api('/nomina/cerrar', (b, admin) => cerrar({ empleado: b.empleado, semana: b.semana, admin }));
  api('/nomina/reabrir', (b, admin) => reabrir({ empleado: b.empleado, semana: b.semana, motivo: b.motivo, admin }));
}

module.exports = { rutas, paginaNomina };
