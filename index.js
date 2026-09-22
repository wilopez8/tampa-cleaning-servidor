const express = require('express');
const { leerHoja } = require('./sheets');
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

// Aqui es donde Twilio va a mandar cada mensaje de WhatsApp
app.post('/webhook', (req, res) => {
  const mensajeEntrante = req.body.Body || '';
  const numeroDe = req.body.From || '';

  console.log(`Mensaje recibido de ${numeroDe}: ${mensajeEntrante}`);

  // Respuesta en formato TwiML (el formato que espera Twilio)
  res.set('Content-Type', 'text/xml');
  res.send(`
    <Response>
      <Message>Recibido: ${mensajeEntrante}</Message>
    </Response>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
