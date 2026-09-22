const express = require('express');
const app = express();

// Twilio manda los datos como formulario (no JSON)
app.use(express.urlencoded({ extended: false }));

// Ruta de salud, para confirmar que el servidor esta vivo
app.get('/', (req, res) => {
  res.send('Servidor Tampa Cleaning activo.');
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
