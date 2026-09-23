const express = require('express');
const { leerHoja } = require('./sheets');
const { procesarCheckIn } = require('./logica');
const app = express();

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

// Aqui es donde Twilio manda cada mensaje de WhatsApp
app.post('/webhook', async (req, res) => {
  const telefono = (req.body.From || '').replace('whatsapp:', '');
  const lat = req.body.Latitude;
  const lon = req.body.Longitude;
  const texto = (req.body.Body || '').trim();

  let respuesta;
  try {
    if (lat && lon) {
      respuesta = await procesarCheckIn(telefono, parseFloat(lat), parseFloat(lon), 'Entrada');
    } else {
      respuesta = 'Para registrar tu entrada, toca el clip 📎 (o el ícono +) y elige "Ubicación" para compartir dónde estás.';
    }
  } catch (err) {
    console.error('Error en /webhook:', err);
    respuesta = '⚠️ Ocurrió un error procesando tu mensaje: ' + err.message;
  }

  res.set('Content-Type', 'text/xml');
  res.send(`<Response><Message>${respuesta}</Message></Response>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
