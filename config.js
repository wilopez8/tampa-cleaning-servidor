// Configuracion de la empresa guardada en la hoja CONFIG_EMPRESA (columnas Clave, Valor, Descripcion).
// Si falta la hoja, una clave o el valor es invalido, se usa el valor por defecto (el de Tampa Cleaning): nunca se rompe el servidor.
const { leerHoja, agregarFilas, asegurarHoja } = require('./sheets');

const HOJA = 'CONFIG_EMPRESA';
const ENCABEZADOS = ['Clave', 'Valor', 'Descripcion'];
const REFRESCO_MS = 60 * 1000;      // la hoja se vuelve a leer como maximo cada 60 s
const LIMITE_ARRANQUE_MS = 8000;    // si la hoja no responde al arrancar, el servidor arranca igual con los valores por defecto

const zonaOk = z => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch (e) { return false; } };

// [clave, valor por defecto (Tampa), descripcion, validador]
const DEFECTOS = [
  ['Zona_Horaria', 'America/New_York', 'Zona horaria de la empresa, nombre IANA (ejemplo: America/Bogota). Define que es "hoy" y la hora que se guarda.', zonaOk],
  ['Prefijo_Pais', '1', 'Codigo de pais que se antepone a los WhatsApp de 10 digitos (1 = EE. UU., 57 = Colombia). Solo digitos.', v => /^\d{1,3}$/.test(v)],
  ['Gerencia_WhatsApp', 'whatsapp:+18133856059', 'WhatsApp que recibe las alertas de gerencia. Formato: whatsapp:+NUMERO (con codigo de pais).', v => /^whatsapp:\+\d{8,15}$/.test(v)],
];
const porClave = {};
DEFECTOS.forEach(d => { porClave[d[0]] = d; });
const CLAVES = DEFECTOS.map(d => d[0]);

let valores = {};   // clave -> valor valido leido de la hoja
let avisos = {};    // clave -> motivo por el que se ignoro el valor de la hoja
let ultima = 0, cargando = null, hojaLista = false;

async function leer() {
  if (!hojaLista) { await asegurarHoja(HOJA, ENCABEZADOS); hojaLista = true; }
  const d = await leerHoja(HOJA);
  const h = d[0] || ENCABEZADOS, iK = h.indexOf('Clave'), iV = h.indexOf('Valor');
  if (iK < 0 || iV < 0) throw new Error('La hoja ' + HOJA + ' debe tener las columnas Clave y Valor');
  const filas = d.slice(1);
  const existentes = new Set(filas.map(f => String(f[iK] || '').trim()));
  const faltan = DEFECTOS.filter(x => !existentes.has(x[0])).map(x => [x[0], x[1], x[2]]);
  if (faltan.length) await agregarFilas(HOJA, d.length ? faltan : [ENCABEZADOS, ...faltan]);
  const nuevos = {}, av = {};
  filas.forEach(f => {
    const k = String(f[iK] || '').trim(), def = porClave[k];
    if (!def) return;
    const v = String(f[iV] ?? '').trim();
    if (v === '') return; // vacio = usar el valor por defecto
    if (def[3](v)) nuevos[k] = v; else av[k] = 'Valor no valido en la hoja ("' + v + '"): se usa el valor por defecto.';
  });
  valores = nuevos; avisos = av; ultima = Date.now();
}

function cargar() {
  if (!cargando) {
    cargando = leer()
      .catch(e => { console.error('CONFIG_EMPRESA: no se pudo leer (se conservan los valores anteriores):', e.message); ultima = Date.now(); })
      .finally(() => { cargando = null; });
  }
  return cargando;
}
function cargarAlArrancar() { return Promise.race([cargar(), new Promise(r => setTimeout(r, LIMITE_ARRANQUE_MS))]); }
function refrescarSiHaceFalta() { if (!cargando && Date.now() - ultima > REFRESCO_MS) cargar(); }

const valor = clave => (clave in valores ? valores[clave] : porClave[clave][1]);
const valido = (clave, v) => !!porClave[clave] && porClave[clave][3](String(v));
const enHoja = clave => clave in valores;
const aviso = clave => avisos[clave] || '';

module.exports = { CLAVES, cargar: cargarAlArrancar, refrescarSiHaceFalta, valor, valido, enHoja, aviso };