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
async function leerHoja(nombreHoja) {
  const sheets = autenticar();
  const respuesta = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: nombreHoja,
  });
  return respuesta.data.values || [];
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

module.exports = { leerHoja, agregarFila, actualizarCelda };
