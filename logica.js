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

function normalizarFecha(valor) {
  const texto = String(valor).trim();
  const isoMatch = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const partesSlash = texto.split('/');
  if (partesSlash.length === 3) {
    const [mm, dd, yyyy] = partesSlash;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return texto;
}

async function buscarProgramacionHoy(nombreEmpleado) {
  const datos = await leerHoja('PROGRAMACION_DIARIA');
  const headers = datos[0];
  const col = {};
  headers.forEach((h, i) => col[h] = i);

  // "Hoy" segun la hora de Florida, no la del servidor (evita el corrimiento de UTC)
  const hoyTexto = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const fechaTexto = normalizarFecha(fila[col['Fecha_Servicio']]);

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
      const horaLegible = ahora.toLocaleString('en-US', { timeZone: 'America/New_York' });
      await actualizarCelda('PROGRAMACION_DIARIA', prog.filaSheet, prog.col[`Hora_${prefijo}_Real`] + 1, horaLegible);
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

async function buscarTelefonoPorNombre(nombreEmpleado) {
  const datos = await leerHoja('EMPLEADOS');
  const idxTelefono = 0; // columna A: reutilizada como numero de WhatsApp
  const idxNombre = 1;
  for (let i = 1; i < datos.length; i++) {
    if (datos[i][idxNombre] === nombreEmpleado) return datos[i][idxTelefono];
  }
  return null;
}

function construirMensajeProgramacion(fila, col) {
  let msg = `📅 Servicio programado para mañana\n\n`;
  msg += `🏠 Cliente: ${fila[col['Cliente']]}\n🕐 Horario: ${fila[col['Horario']]}\n📍 Dirección: ${fila[col['Direccion']]}\n🗺️ Ver ubicación: ${fila[col['Google_Maps_Link']]}\n\n`;
  msg += `📋 Descripción del servicio:\n${fila[col['Descripcion_Servicio']]}\n\nℹ️ Instrucciones generales:\n${fila[col['Instrucciones']]}\n`;
  const obs = fila[col['Observaciones_Puntuales']];
  if (obs && obs.toString().trim() !== '') msg += `\n📝 Observaciones de mañana:\n${obs}\n`;
  msg += `\n¿Confirmas este servicio? Responde exactamente:\n"Confirmo ${fila[col['Cliente']]}"\no\n"No puedo ${fila[col['Cliente']]}"`;
  return msg;
}

async function enviarProgramacionManana() {
  const datos = await leerHoja('PROGRAMACION_DIARIA');
  const headers = datos[0];
  const col = {};
  headers.forEach((h, i) => col[h] = i);

  const manana = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const mananaTexto = manana.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  let enviados = 0;
  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const fechaTexto = normalizarFecha(fila[col['Fecha_Servicio']]);
    if (fechaTexto !== mananaTexto) continue;
    if (fila[col['Estado_Envio']] === 'Enviado') continue;

    const nombreEmpleado = fila[col['Empleado']];
    const telefono = await buscarTelefonoPorNombre(nombreEmpleado);
    if (!telefono) {
      await notificarGerencia(`No se pudo notificar a "${nombreEmpleado}" — no se encontró su número de WhatsApp.`, 'atencion');
      continue;
    }

    const mensaje = construirMensajeProgramacion(fila, col);
    await enviarWhatsApp(`whatsapp:+${soloDigitos(telefono)}`, mensaje);
    await actualizarCelda('PROGRAMACION_DIARIA', i + 1, col['Estado_Envio'] + 1, 'Enviado');
    enviados++;
  }

  await notificarGerencia(`Programación de mañana enviada — ${enviados} servicio(s) notificados.`, 'rutina');
  return enviados;
}

async function procesarRespuestaConfirmacion(telefono, texto) {
  const confirmaMatch = texto.match(/^confirmo\s+(.+)$/i);
  const noPuedeMatch = texto.match(/^no\s*puedo\s+(.+)$/i);
  if (!confirmaMatch && !noPuedeMatch) return null;

  const cliente = (confirmaMatch || noPuedeMatch)[1].trim();
  const nuevoEstado = confirmaMatch ? 'Confirmado' : 'No puede';
  const nombreEmpleado = await buscarEmpleadoPorTelefono(telefono);
  if (!nombreEmpleado) return null;

  const datos = await leerHoja('PROGRAMACION_DIARIA');
  const headers = datos[0];
  const col = {};
  headers.forEach((h, i) => col[h] = i);

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    if (fila[col['Empleado']] === nombreEmpleado &&
        fila[col['Cliente']].toLowerCase() === cliente.toLowerCase() &&
        (fila[col['Estado_Confirmacion']] === 'Pendiente' || !fila[col['Estado_Confirmacion']])) {

      await actualizarCelda('PROGRAMACION_DIARIA', i + 1, col['Estado_Confirmacion'] + 1, nuevoEstado);
      await actualizarCelda('PROGRAMACION_DIARIA', i + 1, col['Fecha_Hora_Confirmacion'] + 1,
        new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));

      if (nuevoEstado === 'Confirmado') {
        return `✅ Confirmado. Nos vemos mañana en ${fila[col['Cliente']]}.`;
      } else {
        await notificarGerencia(`${nombreEmpleado} NO puede cubrir el servicio de ${fila[col['Cliente']]} mañana.`, 'urgente');
        return 'Entendido, quedó registrado que no puedes. Por favor escríbele directamente al administrador para explicarle el motivo.';
      }
    }
  }
  return null; // no se encontro fila pendiente que coincida
}

async function procesarQuejaODuda(telefono, tipo, descripcion, fotoUrl) {
  const nombreEmpleado = await buscarEmpleadoPorTelefono(telefono) || 'DESCONOCIDO';
  const prog = await buscarProgramacionHoy(nombreEmpleado);
  const ahora = new Date();
  const idQueja = `${tipo === 'Queja' ? 'QJ' : 'DU'}-${Date.now()}`;

  await agregarFila('QUEJAS', [
    idQueja,
    ahora.toLocaleString('en-US', { timeZone: 'America/New_York' }),
    tipo,
    'WhatsApp',
    prog ? prog.idProgramacion : '',
    prog ? prog.cliente : '',
    tipo === 'Queja' ? 'Alta' : 'Media',
    descripcion,
    nombreEmpleado,
    '', // Contacto_Cliente (se llena manualmente si aplica)
    fotoUrl || '',
    '', // Responsable_Asignado
    '', // Accion_Correctiva
    'Abierta',
    '', // Fecha_Cierre
  ]);

  const nivel = tipo === 'Queja' ? 'urgente' : 'atencion';
  const clienteTexto = prog ? prog.cliente : 'servicio sin identificar';
  await notificarGerencia(
    `${tipo === 'Queja' ? 'Queja' : 'Consulta'} de ${nombreEmpleado} (${clienteTexto}): "${descripcion}"${fotoUrl ? ' [con foto adjunta]' : ''}`,
    nivel
  );

  return tipo === 'Queja'
    ? '✅ Tu reporte fue enviado, en breve te responden.'
    : '✅ Tu consulta fue enviada, en breve te responden.';
}

module.exports = { procesarCheckIn, notificarGerencia, enviarProgramacionManana, procesarRespuestaConfirmacion, procesarQuejaODuda };
