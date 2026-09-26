const express = require('express');
const { leerHoja } = require('./sheets');
const { procesarCheckIn, enviarProgramacionManana, procesarRespuestaConfirmacion, procesarQuejaODuda, procesarAviso, procesarConfirmacionAviso, procesarCierreCompletado } = require('./logica');
const app = express();

function escaparXml(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Twilio manda los datos como formulario (no JSON)
app.use(express.urlencoded({ extended: false }));

// Ruta de salud, para confirmar que el servidor esta vivo
app.get('/', (req, res) => {
  res.send('Servidor Tampa Cleaning activo.');
});

// Ruta de prueba: confirma que el servidor SI puede leer tu Google Sheet
app.get('/test-sheets', async (req, res) => {
  try {
    const datos = await leerHoja('EMPLEADOS');
    res.json({ ok: true, datos });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Ruta protegida para disparar el envio de la programacion de manana
// (reemplaza al boton que teniamos en Sheets con Apps Script)
app.get('/enviar-programacion', async (req, res) => {
  if (req.query.clave !== process.env.CLAVE_ADMIN) {
    return res.status(403).send('No autorizado');
  }
  try {
    const enviados = await enviarProgramacionManana();
    res.send(`Enviados: ${enviados}`);
  } catch (err) {
    console.error('Error en /enviar-programacion:', err);
    res.status(500).send('Error: ' + err.message);
  }
});

// Ruta que AppSheet llama automaticamente cuando el empleado marca
// "Servicio_Finalizado" en el formulario de cierre.
app.get('/appsheet-cierre', async (req, res) => {
  if (req.query.clave !== process.env.CLAVE_ADMIN) {
    return res.status(403).send('No autorizado');
  }
  try {
    await procesarCierreCompletado(req.query.id);
    res.send('OK');
  } catch (err) {
    console.error('Error en /appsheet-cierre:', err);
    res.status(500).send('Error: ' + err.message);
  }
});

// Aqui es donde Twilio manda cada mensaje de WhatsApp
app.post('/webhook', async (req, res) => {
  const telefono = (req.body.From || '').replace('whatsapp:', '');
  const lat = req.body.Latitude;
  const lon = req.body.Longitude;
  const texto = (req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const fotoUrl = numMedia > 0 ? req.body.MediaUrl0 : '';

  const contieneQueja = /\bquejas?\b/i.test(texto);
  const contieneDuda = /\bdudas?\b/i.test(texto);
  const esComandoAviso = /^aviso\s+/i.test(texto);

  let respuesta = null; // null = no responder nada
  try {
    const respuestaConfirmacion = texto ? await procesarRespuestaConfirmacion(telefono, texto) : null;
    const respuestaAvisoRecibido = (!respuestaConfirmacion && texto) ? await procesarConfirmacionAviso(telefono, texto) : null;

    if (respuestaConfirmacion) {
      respuesta = respuestaConfirmacion;
    } else if (respuestaAvisoRecibido) {
      respuesta = respuestaAvisoRecibido;
    } else if (esComandoAviso) {
      respuesta = await procesarAviso(telefono, texto);
    } else if (contieneQueja) {
      respuesta = await procesarQuejaODuda(telefono, 'Queja', texto, fotoUrl);
    } else if (contieneDuda) {
      respuesta = await procesarQuejaODuda(telefono, 'Duda', texto, fotoUrl);
    } else if (lat && lon) {
      respuesta = await procesarCheckIn(telefono, parseFloat(lat), parseFloat(lon));
    } else if (texto.toLowerCase() === 'hola' || texto === '/start') {
      respuesta = 'Para registrar tu entrada, toca el clip 📎 (o el ícono +) y elige "Ubicación" para compartir dónde estás.\n\nPara reportar algo, escribe:\nqueja [descripción]\nduda [descripción]';
    }
    // Si no coincide con nada de lo anterior, respuesta se queda en null (silencio)
  } catch (err) {
    console.error('Error en /webhook:', err);
    respuesta = '⚠️ Ocurrió un error procesando tu mensaje: ' + err.message;
  }

  res.set('Content-Type', 'text/xml');
  res.send(respuesta ? `<Response><Message>${escaparXml(respuesta)}</Message></Response>` : '<Response></Response>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
