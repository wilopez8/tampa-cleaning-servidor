const express = require('express');
const { leerHoja } = require('./sheets');
const { procesarCheckIn, enviarProgramacionManana, procesarRespuestaConfirmacion, procesarQuejaODuda, procesarAviso, procesarConfirmacionAviso, obtenerDatosFormularioCierre, procesarCierreFormulario, procesarInspeccionFormulario, INSUMOS_COMUNES, AREAS_INSPECCION, enviarWhatsApp  } = require('./logica');
const app = express();
app.set('trust proxy', 1); // Render va detrás de un proxy; así req.ip es la IP real
const auth = require('./auth');
const edicion = require('./edicion');
const { invalidarCache, edadCacheSegundos } = require('./sheets');
const { paginaAgenda } = require('./agenda');



function escaparHtml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function volverSeguro(v) { return (typeof v === 'string' && /^\/(?!\/)/.test(v)) ? v : '/agenda'; }
function paginaLogin(error, volver) {
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acceso</title>
<style>body{font-family:-apple-system,Arial,sans-serif;max-width:340px;margin:80px auto;padding:20px;color:#222;}
input{width:100%;padding:12px;font-size:16px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;margin:10px 0;}
button{background:#2e7d32;color:white;padding:12px;border:none;border-radius:8px;font-size:16px;width:100%;}
.e{color:#b91c1c;}</style></head><body>
<h2>Tampa Cleaning</h2><p>Ingresa tu clave de administrador</p>
${error ? `<p class="e">${escaparHtml(error)}</p>` : ''}
<form method="POST" action="/login"><input type="hidden" name="volver" value="${escaparHtml(volver)}">
<input type="password" name="clave" autocomplete="current-password" autofocus required><button type="submit">Entrar</button></form></body></html>`;
}



function escaparXml(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Twilio manda los datos como formulario (no JSON)
app.use(express.urlencoded({ extended: false }));

app.use(express.json({ limit: '200kb' }));

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

// Muestra el formulario de cierre de servicio (nuestra propia pagina, sin AppSheet)
app.get('/cierre', async (req, res) => {
  try {
    const datos = await obtenerDatosFormularioCierre(req.query.id);
    if (!datos) return res.status(404).send('Servicio no encontrado.');

    if (datos.yaFinalizado) {
      res.set('Content-Type', 'text/html');
      return res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:-apple-system,Arial,sans-serif;text-align:center;padding:60px 20px;">
        <h2 style="color:#b45309;">⚠️ Este servicio ya fue cerrado</h2>
        <p style="color:#555;font-size:16px;">El cierre de <strong>${datos.cliente}</strong> ya se envió anteriormente y no se puede modificar.<br>Si necesitas corregir algo, comunícate directamente con el administrador.</p>
      </body></html>`);
    }

    if (datos.tipoServicio === 'Inspeccion') {
      const areasHtml = AREAS_INSPECCION.map(area => `
        <div style="margin:14px 0;">
          <p style="font-weight:600;margin-bottom:6px;">${area}</p>
          <label style="margin-right:16px;"><input type="radio" name="area_${area}" value="Cumple" checked> Cumple</label>
          <label style="margin-right:16px;"><input type="radio" name="area_${area}" value="Cumple con observaciones"> Con observaciones</label>
          <label><input type="radio" name="area_${area}" value="No cumple"> No cumple</label>
        </div>`).join('');

      res.set('Content-Type', 'text/html');
      return res.send(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inspección de calidad</title>
<style>
  body{font-family:-apple-system,Arial,sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#222;}
  h2{color:#1d4ed8;margin-bottom:4px;}
  h3{margin-top:28px;margin-bottom:8px;font-size:17px;}
  p{color:#555;font-size:15px;}
  button{background:#1d4ed8;color:white;padding:14px 20px;border:none;border-radius:8px;font-size:17px;width:100%;margin-top:24px;}
  textarea{width:100%;padding:10px;font-size:15px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;min-height:90px;}
</style>
</head><body>
<h2>Inspección de calidad</h2>
<p><strong>${datos.cliente}</strong><br>${datos.direccion}</p>
<form method="POST" action="/cierre">
  <input type="hidden" name="id" value="${req.query.id}">
  <h3>Evaluación por área</h3>
  ${areasHtml}
  <h3>Hallazgos</h3>
  <textarea name="hallazgos" placeholder="Describe lo que encontraste"></textarea>
  <h3>¿Requiere acción correctiva?</h3>
  <label style="margin-right:16px;"><input type="radio" name="requiereAccion" value="No" checked> No</label>
  <label><input type="radio" name="requiereAccion" value="Si"> Sí</label>
  <button type="submit">Guardar inspección</button>
</form>
</body></html>`);
    }

    const checklistHtml = datos.checklist.length
      ? datos.checklist.map(t => `
        <label style="display:block;margin:10px 0;font-size:16px;">
          <input type="checkbox" name="completadas" value="${t}" checked style="width:20px;height:20px;vertical-align:middle;"> ${t}
        </label>`).join('')
      : '<p>Este cliente no tiene checklist configurado.</p>';

    const insumosHtml = INSUMOS_COMUNES.map(i => `
      <label style="display:block;margin:10px 0;font-size:16px;">
        <input type="checkbox" name="insumosFaltantes" value="${i}" style="width:20px;height:20px;vertical-align:middle;"> ${i}
      </label>`).join('');

    res.set('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cierre de servicio</title>
<style>
  body{font-family:-apple-system,Arial,sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#222;}
  h2{color:#2e7d32;margin-bottom:4px;}
  h3{margin-top:28px;margin-bottom:8px;font-size:17px;}
  p{color:#555;font-size:15px;}
  button{background:#2e7d32;color:white;padding:14px 20px;border:none;border-radius:8px;font-size:17px;width:100%;margin-top:24px;}
  textarea, input[type=text]{width:100%;padding:10px;font-size:15px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;}
  textarea{min-height:90px;}
</style>
</head><body>
<h2>Cierre de servicio</h2>
<p><strong>${datos.cliente}</strong><br>${datos.direccion}</p>
${datos.instrucciones ? `<p><strong>Instrucciones:</strong> ${datos.instrucciones}</p>` : ''}
<form method="POST" action="/cierre">
  <input type="hidden" name="id" value="${req.query.id}">
  <h3>Tareas completadas (desmarca las que NO alcanzaste a hacer)</h3>
  ${checklistHtml}
  <h3>Insumos faltantes</h3>
  ${insumosHtml}
  <label style="display:block;margin:10px 0;font-size:15px;">Otro insumo:<br><input type="text" name="otroInsumo"></label>
  <h3>Comentario del servicio</h3>
  <textarea name="comentario" placeholder="Escribe cualquier observación (opcional)"></textarea>
  <button type="submit">Guardar cierre</button>
</form>
</body></html>`);
  } catch (err) {
    console.error('Error en GET /cierre:', err);
    res.status(500).send('Ocurrió un error cargando el formulario.');
  }
});

// Recibe el formulario de cierre ya lleno
app.post('/cierre', async (req, res) => {
  try {
    const datosServicio = await obtenerDatosFormularioCierre(req.body.id);
    if (datosServicio && datosServicio.tipoServicio === 'Inspeccion') {
      await procesarInspeccionFormulario(req.body);
    } else {
      await procesarCierreFormulario(req.body);
    }
    res.set('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="font-family:-apple-system,Arial,sans-serif;text-align:center;padding:60px 20px;">
      <h2 style="color:#2e7d32;">✅ ¡Gracias!</h2>
      <p style="color:#555;font-size:16px;">El cierre del servicio quedó registrado.<br>Ya puedes cerrar esta ventana.</p>
    </body></html>`);
  } catch (err) {
    console.error('Error en POST /cierre:', err);
    if (err.yaFinalizado) {
      res.set('Content-Type', 'text/html');
      return res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:-apple-system,Arial,sans-serif;text-align:center;padding:60px 20px;">
        <h2 style="color:#b45309;">⚠️ Este cierre ya había sido enviado</h2>
        <p style="color:#555;font-size:16px;">No se guardó de nuevo para evitar duplicar la información.</p>
      </body></html>`);
    }
    res.status(500).send('Ocurrió un error guardando el cierre.');
  }
});

app.get('/test-reply', auth.requiereAdmin, async (req, res) => {
  const tel = String(req.query.tel || '').replace(/\D/g, '');
  if (tel.length < 10) return res.status(400).send('Falta ?tel=NUMERO con código de país, ej. 1813XXXXXXX');
  try {
    const a = await enviarWhatsApp(`whatsapp:+${tel}`, 'Prueba A: responde con Reply a ESTE mensaje escribiendo: ok A');
    const b = await enviarWhatsApp(`whatsapp:+${tel}`, 'Prueba B: responde con Reply a ESTE mensaje escribiendo: ok B');
    res.send(`Enviados. SID A=${a} | SID B=${b}`);
  } catch (err) { res.status(500).send('Error: ' + err.message); }
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
    
  console.log('TEST-REPLY', JSON.stringify({ Body: texto, Original: req.body.OriginalRepliedMessageSid || null,
  CamposReply: Object.keys(req.body).filter(k => /repl|context/i.test(k)) }));

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

app.get('/login', (req, res) => res.send(paginaLogin('', volverSeguro(req.query.volver))));

app.post('/login', (req, res) => {
  const volver = volverSeguro(req.body.volver);
  if (auth.bloqueado(req.ip)) return res.status(429).send(paginaLogin('Demasiados intentos. Espera 15 minutos.', volver));
  const nombre = auth.identificarAdmin(String(req.body.clave || ''));
  if (!nombre) {
    auth.registrarFallo(req.ip);
    return res.status(401).send(paginaLogin('Clave incorrecta.', volver));
  }
  auth.limpiarFallos(req.ip);
  res.set('Set-Cookie', auth.cookieSesion(nombre));
  res.redirect(volver);
});

app.get('/logout', (req, res) => {
  res.set('Set-Cookie', auth.cookieCierre);
  res.redirect('/login');
});

// Botón "Actualizar": descarta la caché de lectura
app.post('/actualizar-cache', auth.requiereAdmin, (req, res) => {
  invalidarCache();
  res.redirect(volverSeguro(req.body.volver));
});

// Marcador temporal; la etapa 3 lo reemplaza por la agenda real
app.get('/agenda', auth.requiereAdmin, async (req, res) => {
  try {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(await paginaAgenda(req.query, req.admin));
  } catch (err) {
    console.error('Error en GET /agenda:', err);
    res.status(500).send('Error cargando la agenda: ' + err.message);
  }
});

app.post('/agenda/guardar', auth.requiereAdmin, async (req, res) => {
  try {
    res.json(await edicion.procesarGuardado({
      fecha: req.body.fecha, filas: req.body.filas, admin: req.admin, soloValidar: !!req.body.soloValidar, motivo: req.body.motivo,
    }));
  } catch (err) {
    console.error('Error en POST /agenda/guardar:', err);
    res.status(500).json({ ok: false, general: 'Error: ' + err.message });
  }
});

app.post('/agenda/cancelar', auth.requiereAdmin, async (req, res) => {
  try {
    res.json(await edicion.cancelarServicio({ id: req.body.id, motivo: req.body.motivo, admin: req.admin }));
  } catch (err) {
    console.error('Error en POST /agenda/cancelar:', err);
    res.status(500).json({ ok: false, general: 'Error: ' + err.message });
  }
});

app.post('/agenda/enviar', auth.requiereAdmin, async (req, res) => {
  try {
    res.json(await edicion.guardarYEnviar({ fecha: req.body.fecha, filas: req.body.filas, admin: req.admin }));
  } catch (err) {
    console.error('Error en POST /agenda/enviar:', err);
    res.status(500).json({ ok: false, general: 'Error: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
