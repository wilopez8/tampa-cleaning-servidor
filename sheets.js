const { google } = require('googleapis');

// El ID de tu Google Sheet (esta en la URL: docs.google.com/spreadsheets/d/ESTE_ID_LARGO/edit)
const SPREADSHEET_ID = '1ivKfO_iW7MIr_Oe9mERzUcZJEwIKmlY85DzSGxmHKLg';

function autenticar() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      // Render guarda la clave en una sola linea; hay que restaurar los saltos de linea reales
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Lee todas las filas de una hoja (ej. 'EMPLEADOS', 'PROGRAMACION_DIARIA')
const CACHE_TTL_MS = 45 * 1000;
const cache = new Map(); // nombreHoja -> { creado, expira, promesa }

function invalidarCache(nombreHoja) {
  if (nombreHoja) cache.delete(nombreHoja); else cache.clear();
}
function edadCacheSegundos(nombreHoja) {
  const e = cache.get(nombreHoja);
  return e ? Math.round((Date.now() - e.creado) / 1000) : null;
}

async function leerHojaDirecto(nombreHoja) {
  const sheets = autenticar();
  const respuesta = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: nombreHoja,
  });
  return respuesta.data.values || [];
}

// Con { cache: true } devuelve datos de hasta 45 s; quien la use no debe modificar el arreglo devuelto.
async function leerHoja(nombreHoja, opciones = {}) {
  if (!opciones.cache) return leerHojaDirecto(nombreHoja);
  const e = cache.get(nombreHoja);
  if (e && e.expira > Date.now()) return e.promesa;
  const promesa = leerHojaDirecto(nombreHoja);
  cache.set(nombreHoja, { creado: Date.now(), expira: Date.now() + CACHE_TTL_MS, promesa });
  promesa.catch(() => { if (cache.get(nombreHoja)?.promesa === promesa) cache.delete(nombreHoja); });
  return promesa;
}

// Agrega una fila nueva al final de una hoja
async function agregarFila(nombreHoja, filaValores) {
  const sheets = autenticar();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: nombreHoja,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [filaValores] },
  });
  invalidarCache(nombreHoja);
}

// Actualiza una celda especifica (fila y columna son 1-indexados, como en Sheets)
async function actualizarCelda(nombreHoja, fila, columna, valor) {
  const sheets = autenticar();
  const columnaLetra = numeroAColumna(columna);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${nombreHoja}!${columnaLetra}${fila}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[valor]] },
  });
  invalidarCache(nombreHoja);
}

function numeroAColumna(n) {
  let letra = '';
  while (n > 0) {
    const resto = (n - 1) % 26;
    letra = String.fromCharCode(65 + resto) + letra;
    n = Math.floor((n - 1) / 26);
  }
  return letra;
}

module.exports = { leerHoja, agregarFila, actualizarCelda, invalidarCache, edadCacheSegundos };