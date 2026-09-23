const { leerHoja, agregarFila, actualizarCelda } = require('./sheets');
const twilio = require('twilio');

const clienteTwilio = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886'; // numero del Sandbox
const CHAT_ADMIN_WHATSAPP = 'whatsapp:+18133856059';  // numero personal de Will (gerencia)

function soloDigitos(texto) {
  return String(texto || '').replace(/\D/g, '');
}

async function enviarWhatsApp(numeroConPrefijo, texto) {
  await clienteTwilio.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to: numeroConPrefijo,
    body: texto,
  });
}

async function notificarGerencia(mensaje, nivel) {
  const prefijos = { urgente: '🔴', atencion: '🟡', rutina: '✅' };
  const prefijo = prefijos[nivel] || 'ℹ️';
  await enviarWhatsApp(CHAT_ADMIN_WHATSAPP, `${prefijo} ${mensaje}`);
}

function distanciaMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function buscarEmpleadoPorTelefono(telefono) {
  const datos = await leerHoja('EMPLEADOS');
  const headers = datos[0];
  const idxTelefono = headers.indexOf('ID_Telegram'); // reutilizamos esta columna para el numero de WhatsApp
  const idxNombre = headers.indexOf('Nombre');
  for (let i = 1; i < datos.length; i++) {
    if (soloDigitos(datos[i][idxTelefono]) === soloDigitos(telefono)) {
      return datos[i][idxNombre];
    }
  }
  return null;
}

async function buscarSitio(nombreCliente) {
  const datos = await leerHoja('SITIOS');
  const headers = datos[0];
  const col = {};
  headers.forEach((h, i) => col[h] = i);
  for (let i = 1; i < datos.length; i++) {
    if (datos[i][col['Nombre_Cliente']] === nombreCliente) {
      return {
        lat: parseFloat(datos[i][col['Latitud']]),
        lon: parseFloat(datos[i][col['Longitud']]),
        radio: parseFloat(datos[i][col['Radio_Tolerancia_m']]) || 150,
      };
    }
  }
  return null;
}

async function buscarProgramacionHoy(nombreEmpleado) {
  const datos = await leerHoja('PROGRAMACION_DIARIA');
  const headers = datos[0];
  const col = {};
  headers.forEach((h, i) => col[h] = i);

  const hoy = new Date();
  const hoyTexto = hoy.toISOString().split('T')[0]; // YYYY-MM-DD

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const fechaCelda = new Date(fila[col['Fecha_Servicio']]);
    const fechaTexto = isNaN(fechaCelda) ? '' : fechaCelda.toISOString().split('T')[0];

    if (fechaTexto === hoyTexto && fila[col['Empleado']] === nombreEmpleado) {
      return {
        idProgramacion: fila[col['ID_Programacion']],
        cliente: fila[col['Cliente']],
        filaSheet: i + 1, // fila real en la hoja (encabezado = fila 1)
        col: col,
      };
    }
  }
  return null;
}

async function procesarCheckIn(telefono, lat, lon, tipo) {
  const nombreEmpleado = await buscarEmpleadoPorTelefono(telefono) || 'DESCONOCIDO';
  const prog = await buscarProgramacionHoy(nombreEmpleado);
  const ahora = new Date();

  let distancia = '', dentroRango = '', idProgramacion = '', clienteTexto = 'Sin asignación hoy';

  if (prog) {
    idProgramacion = prog.idProgramacion;
    clienteTexto = prog.cliente;
    const sitio = await buscarSitio(prog.cliente);
    if (sitio) {
      distancia = Math.round(distanciaMetros(lat, lon, sitio.lat, sitio.lon));
      dentroRango = distancia <= sitio.radio ? 'SI' : 'NO';
    }

    const prefijo = (tipo === 'Entrada') ? 'Entrada' : 'Salida';
    if (prog.col[`Hora_${prefijo}_Real`] !== undefined) {
      await actualizarCelda('PROGRAMACION_DIARIA', prog.filaSheet, prog.col[`Hora_${prefijo}_Real`] + 1, ahora.toISOString());
      await actualizarCelda('PROGRAMACION_DIARIA', prog.filaSheet, prog.col[`Lat_${prefijo}`] + 1, lat);
      await actualizarCelda('PROGRAMACION_DIARIA', prog.filaSheet, prog.col[`Lon_${prefijo}`] + 1, lon);
      await actualizarCelda('PROGRAMACION_DIARIA', prog.filaSheet, prog.col[`Dentro_Rango_${prefijo}`] + 1, dentroRango);
    }
  }

  await agregarFila('REGISTRO_TURNOS', [
    ahora.toLocaleDateString('en-US', { timeZone: 'America/New_York' }),
    ahora.toLocaleTimeString('en-US', { timeZone: 'America/New_York' }),
    telefono,
    nombreEmpleado,
    lat,
    lon,
    idProgramacion,
    distancia,
    dentroRango,
    tipo,
  ]);

  if (!prog) {
    await notificarGerencia(`${nombreEmpleado} hizo check-in (${tipo}) pero no tiene servicio asignado hoy.`, 'urgente');
    return '⚠️ Registramos tu ubicación, pero no encontramos un servicio asignado para ti hoy. Ya avisamos al administrador.';
  }

  if (dentroRango === 'NO') {
    await notificarGerencia(`${nombreEmpleado} registró ${tipo.toLowerCase()} a ${distancia}m de ${clienteTexto} (fuera de rango).`, 'urgente');
    return `⚠️ Ubicación registrada, pero estás a ${distancia}m de ${clienteTexto}. Avisamos al administrador.`;
  }

  return `✅ ${tipo === 'Entrada' ? 'Entrada' : 'Salida'} registrada en ${clienteTexto}. ¡Gracias!`;
}

module.exports = { procesarCheckIn, notificarGerencia };
