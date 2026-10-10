const { leerHoja, agregarFila, actualizarCelda, asegurarHoja } = require('./sheets');
const twilio = require('twilio');

const clienteTwilio = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886'; // numero del Sandbox
const BASE_URL = 'https://tampa-cleaning-servidor.onrender.com'; // tu propio servidor (sin AppSheet)
const CHAT_ADMIN_WHATSAPP = 'whatsapp:+18133856059';  // numero personal de Will (gerencia)

function soloDigitos(texto) {
  return String(texto || '').replace(/\D/g, '');
}

async function enviarWhatsApp(numeroConPrefijo, texto) {
  const m = await clienteTwilio.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to: numeroConPrefijo,
    body: texto,
  });
  return m.sid;
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
      const checklistTexto = col['Checklist_Tareas'] !== undefined ? (datos[i][col['Checklist_Tareas']] || '') : '';
      return {
        lat: parseFloat(datos[i][col['Latitud']]),
        lon: parseFloat(datos[i][col['Longitud']]),
        radio: parseFloat(datos[i][col['Radio_Tolerancia_m']]) || 150,
        checklist: checklistTexto.split(',').map(t => t.trim()).filter(Boolean),
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

      if (fechaTexto === hoyTexto && fila[col['Empleado']] === nombreEmpleado && fila[col['Cancelado']] !== 'Sí') {
      return {
        idProgramacion: fila[col['ID_Programacion']],
        cliente: fila[col['Cliente']],
        filaSheet: i + 1, // fila real en la hoja (encabezado = fila 1)
        col: col,
        fila: fila, // valores crudos, para saber que ya se registro (entrada/salida)
      };
    }
  }
  return null;
}

async function detectarAnomalias(nombreEmpleado, lat, lon, ahora) {
  const datos = await leerHoja('REGISTRO_TURNOS');
  const headers = datos[0];
  const col = {};
  headers.forEach((h, i) => col[h] = i);

  // Busca el check-in mas reciente de este mismo empleado (cualquier dia/sitio)
  let ultimo = null;
  for (let i = 1; i < datos.length; i++) {
    if (datos[i][col['Nombre_Empleado']] === nombreEmpleado) ultimo = datos[i];
  }
  if (!ultimo) return [];

  const alertas = [];
  const latUltimo = parseFloat(ultimo[col['Lat']]);
  const lonUltimo = parseFloat(ultimo[col['Lon']]);

  // Chequeo 1: coordenadas identicas, sin ninguna variacion
  if (latUltimo === lat && lonUltimo === lon) {
    alertas.push('coordenadas idénticas al check-in anterior');
  }

  // Chequeo 2: velocidad implicita imposible entre los dos puntos
  const fechaHoraUltimo = new Date(`${ultimo[col['Fecha']]} ${ultimo[col['Hora']]}`);
  const minutos = (ahora - fechaHoraUltimo) / 60000;
  if (minutos > 0.5 && minutos < 24 * 60) {
    const distanciaKm = distanciaMetros(lat, lon, latUltimo, lonUltimo) / 1000;
    const velocidadKmH = distanciaKm / (minutos / 60);
    if (velocidadKmH > 150) {
      alertas.push(`velocidad implícita de ${Math.round(velocidadKmH)} km/h respecto al check-in anterior`);
    }
  }

  return alertas;
}

async function procesarCheckIn(telefono, lat, lon) {
  const nombreEmpleado = await buscarEmpleadoPorTelefono(telefono) || 'DESCONOCIDO';
  const ahora = new Date();
  const alertasAnomalia = await detectarAnomalias(nombreEmpleado, lat, lon, ahora);
  const prog = await buscarProgramacionHoy(nombreEmpleado);

  let distancia = '', dentroRango = '', idProgramacion = '', clienteTexto = 'Sin asignación hoy';
  let tipo = 'Entrada'; // por defecto, si no hay programacion de referencia

  if (prog) {
    idProgramacion = prog.idProgramacion;
    clienteTexto = prog.cliente;
    const sitio = await buscarSitio(prog.cliente);
    if (sitio) {
      distancia = Math.round(distanciaMetros(lat, lon, sitio.lat, sitio.lon));
      dentroRango = distancia <= sitio.radio ? 'SI' : 'NO';
    }

    // Decide solo si es Entrada o Salida, segun lo que ya este registrado hoy
    const yaTieneEntrada = prog.col['Hora_Entrada_Real'] !== undefined && !!prog.fila[prog.col['Hora_Entrada_Real']];
    const yaTieneSalida = prog.col['Hora_Salida_Real'] !== undefined && !!prog.fila[prog.col['Hora_Salida_Real']];
    tipo = (!yaTieneEntrada) ? 'Entrada' : (!yaTieneSalida ? 'Salida' : 'Salida');

    if (prog.col[`Hora_${tipo}_Real`] !== undefined) {
      const horaLegible = ahora.toLocaleString('en-US', { timeZone: 'America/New_York' });
      await actualizarCelda('PROGRAMACION_DIARIA', prog.filaSheet, prog.col[`Hora_${tipo}_Real`] + 1, horaLegible);
      await actualizarCelda('PROGRAMACION_DIARIA', prog.filaSheet, prog.col[`Lat_${tipo}`] + 1, lat);
      await actualizarCelda('PROGRAMACION_DIARIA', prog.filaSheet, prog.col[`Lon_${tipo}`] + 1, lon);
      await actualizarCelda('PROGRAMACION_DIARIA', prog.filaSheet, prog.col[`Dentro_Rango_${tipo}`] + 1, dentroRango);
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
    await notificarGerencia(`${nombreEmpleado} hizo check-in pero no tiene servicio asignado hoy.`, 'urgente');
    return '⚠️ Registramos tu ubicación, pero no encontramos un servicio asignado para ti hoy. Ya avisamos al administrador.';
  }

  let mensaje;
  if (dentroRango === 'NO') {
    await notificarGerencia(`${nombreEmpleado} registró ${tipo.toLowerCase()} a ${distancia}m de ${clienteTexto} (fuera de rango).`, 'urgente');
    mensaje = `⚠️ Ubicación registrada, pero estás a ${distancia}m de ${clienteTexto}. Avisamos al administrador.`;
  } else {
    mensaje = `✅ ${tipo === 'Entrada' ? 'Entrada' : 'Salida'} registrada en ${clienteTexto}. ¡Gracias!`;
  }

  if (alertasAnomalia.length > 0) {
    await notificarGerencia(`Posible ubicación falsa en el check-in de ${nombreEmpleado} (${clienteTexto}): ${alertasAnomalia.join('; ')}.`, 'urgente');
  }

  if (tipo === 'Salida' && idProgramacion) {
    mensaje += `\n\nCompleta el cierre del servicio aquí:\n${BASE_URL}/cierre?id=${encodeURIComponent(idProgramacion)}`;
  }

  return mensaje;
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

function construirMensajeProgramacion(fila, col, dc, titulo) {
  const v = (campo, vivo) => fila[col[campo]] || vivo || '';
  let msg = `📅 ${titulo || 'Servicio programado para mañana'}\n\n`;
  msg += `🏠 Cliente: ${fila[col['Cliente']]}\n🕐 Horario: ${fila[col['Horario']]}\n📍 Dirección: ${v('Direccion', dc.direccion)}\n🗺️ Ver ubicación: ${v('Google_Maps_Link', dc.maps)}\n\n`;
  msg += `📋 Descripción del servicio:\n${v('Descripcion_Servicio', dc.descripcion)}\n\nℹ️ Instrucciones generales:\n${v('Instrucciones', dc.instrucciones)}\n`;
  const obs = fila[col['Observaciones_Puntuales']];
  if (obs && obs.toString().trim() !== '') msg += `\n📝 Observaciones de mañana:\n${obs}\n`;
  msg += `\n¿Confirmas este servicio? Responde:\n"Ok" o "Confirmo"\no\n"No puedo"`;
  return msg;
}


function fechaLegible(f) { const [y, m, d] = f.split('-'); return `${d}/${m}/${y}`; }

function tituloProgramacion(fecha) {
  const opt = { timeZone: 'America/New_York' };
  const hoy = new Date().toLocaleDateString('en-CA', opt);
  const man = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', opt);
  if (fecha === hoy) return 'Servicio programado para HOY';
  if (fecha === man) return 'Servicio programado para mañana';
  return `Servicio programado para el ${fechaLegible(fecha)}`;
}

// Envía todos los servicios en Borrador de una fecha (lee en vivo, nunca de la caché)
async function enviarProgramacionFecha(fecha, admin) {
  const datos = await leerHoja('PROGRAMACION_DIARIA');
  const headers = datos[0];
  const col = {};
  headers.forEach((h, i) => col[h] = i);
  const titulo = tituloProgramacion(fecha);

  let enviados = 0;
  const sinNumero = [], fallidos = [];
  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    if (normalizarFecha(fila[col['Fecha_Servicio']]) !== fecha) continue;
    if (fila[col['Estado_Envio']] === 'Enviado') continue;
    if (fila[col['Estado_Envio']] === 'No aplica') continue;
    if (fila[col['Cancelado']] === 'Sí') continue;
    const nombreEmpleado = fila[col['Empleado']];
    const cliente = fila[col['Cliente']];
    if (!nombreEmpleado || !cliente) continue;

    const telefono = await buscarTelefonoPorNombre(nombreEmpleado);
    if (!telefono) { sinNumero.push(nombreEmpleado); continue; }

    try {
      const dc = await datosClienteVivo(cliente);
      await enviarWhatsApp(`whatsapp:+${soloDigitos(telefono)}`, construirMensajeProgramacion(fila, col, dc, titulo));
    } catch (err) {
      console.error('Error enviando programación a', nombreEmpleado, err);
      fallidos.push(`${nombreEmpleado} (${cliente})`);
      continue;
    }
    await actualizarCelda('PROGRAMACION_DIARIA', i + 1, col['Estado_Envio'] + 1, 'Enviado');
    enviados++;
  }

  if (enviados > 0) await notificarGerencia(`Programación del ${fechaLegible(fecha)} enviada${admin ? ' por ' + admin : ''} — ${enviados} servicio(s) notificados.`, 'rutina');
  if (sinNumero.length) await notificarGerencia(`Sin número de WhatsApp, no se notificó a: ${sinNumero.join(', ')}.`, 'atencion');
  if (fallidos.length) await notificarGerencia(`No se pudo enviar el WhatsApp a: ${fallidos.join('; ')}. Siguen en Borrador.`, 'atencion');
  return { enviados, sinNumero, fallidos };
}

// Se mantiene para el enlace antiguo /enviar-programacion?clave=...
async function enviarProgramacionManana() {
  const manana = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const r = await enviarProgramacionFecha(manana, 'enlace /enviar-programacion');
  return r.enviados;
}

// ---------- Cambios posteriores al envío ----------
const HOJA_CAMBIOS = 'CAMBIOS_PROGRAMACION';
const ENCAB_CAMBIOS = ['Fecha_Hora', 'ID_Programacion', 'Fecha_Servicio', 'Tipo_Cambio', 'Detalle', 'Realizado_Por', 'Empleado_Notificado', 'Aviso_Enviado'];

async function registrarCambio({ id, fechaServicio, tipo, detalle, por, notificado, aviso }) {
  try {
    await asegurarHoja(HOJA_CAMBIOS, ENCAB_CAMBIOS);
    await agregarFila(HOJA_CAMBIOS, [
      new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
      id, fechaServicio, tipo, detalle, por, notificado || '', aviso,
    ]);
  } catch (err) { console.error('No se pudo registrar el cambio:', err); }
}

async function enviarYRegistrar({ id, fecha, por, empleado, texto, tipo, detalle }) {
  let ok = false;
  try {
    const tel = await buscarTelefonoPorNombre(empleado);
    if (!tel) throw new Error('sin número de WhatsApp');
    await enviarWhatsApp(`whatsapp:+${soloDigitos(tel)}`, texto);
    ok = true;
  } catch (err) { console.error('Error avisando cambio a', empleado, err); }
  await registrarCambio({ id, fechaServicio: fecha, tipo, detalle, por, notificado: empleado, aviso: ok ? 'Sí' : 'Error' });
  if (!ok) await notificarGerencia(`No se pudo avisar a ${empleado} del cambio en ${id}. Avísale directamente.`, 'urgente');
  return { empleado, ok };
}

// antes / despues: { tipo, cliente, empleado, horario }
async function notificarCambioPostEnvio({ id, fecha, por, antes, despues, cancelado, motivo }) {
  const fl = fechaLegible(fecha);
  const base = { id, fecha, por };
  const resultados = [];

  if (cancelado) {
    const texto = `❌ Servicio cancelado\n\n🏠 ${antes.cliente}\n📅 ${fl}\n🕐 ${antes.horario}\n\nYa no tienes que asistir a este servicio.`;
    resultados.push(await enviarYRegistrar({ ...base, empleado: antes.empleado, texto, tipo: 'Cancelación',
      detalle: `${antes.cliente} ${fl} ${antes.horario}. Motivo: ${motivo || ''}` }));
    return resultados;
  }

  if (antes.empleado !== despues.empleado) {
    const detalle = `${antes.empleado} → ${despues.empleado}`;
    const sale = `🔄 Cambio de asignación\n\nYa no estás asignado/a al servicio de ${antes.cliente} del ${fl} (${antes.horario}).`;
    resultados.push(await enviarYRegistrar({ ...base, empleado: antes.empleado, texto: sale, tipo: 'Cambio de empleado (sale)', detalle }));

    const encontrado = await obtenerFilaProgramacionPorId(id);
    const dc = await datosClienteVivo(despues.cliente);
    const entra = construirMensajeProgramacion(encontrado.fila, encontrado.col, dc, `Nueva asignación — ${tituloProgramacion(fecha)}`);
    resultados.push(await enviarYRegistrar({ ...base, empleado: despues.empleado, texto: entra, tipo: 'Cambio de empleado (entra)', detalle }));
    return resultados;
  }

  const cambios = [];
  if (antes.cliente !== despues.cliente) cambios.push(`🏠 Cliente: ${antes.cliente} → ${despues.cliente}`);
  if (antes.horario !== despues.horario) cambios.push(`🕐 Horario: ${antes.horario} → ${despues.horario}`);
  if (antes.tipo !== despues.tipo) cambios.push(`🧾 Tipo de servicio: ${antes.tipo} → ${despues.tipo}`);
  if (!cambios.length) return resultados;

  let texto = `🔄 Cambio en tu servicio del ${fl}\n\n${cambios.join('\n')}`;
  if (antes.cliente !== despues.cliente) {
    const dc = await datosClienteVivo(despues.cliente);
    texto += `\n📍 Dirección: ${dc.direccion}\n🗺️ Ver ubicación: ${dc.maps}`;
  }
  texto += `\n\nPor favor confirma de nuevo:\n"Ok" o "Confirmo"\no\n"No puedo"`;
  resultados.push(await enviarYRegistrar({ ...base, empleado: despues.empleado, texto, tipo: 'Cambio de cliente/horario/tipo', detalle: cambios.join(' | ').replace(/[🏠🕐🧾] /gu, '') }));
  return resultados;
}


async function procesarRespuestaConfirmacion(telefono, texto) {
  const textoLimpio = texto.trim();
  const esConfirma = /^(ok|confirmo)\b/i.test(textoLimpio);
  const esNoPuede = /^no\s*puedo\b/i.test(textoLimpio);
  if (!esConfirma && !esNoPuede) return null;

  const nombreEmpleado = await buscarEmpleadoPorTelefono(telefono);
  if (!nombreEmpleado) return null;

  const nuevoEstado = esConfirma ? 'Confirmado' : 'No puede';
  const datos = await leerHoja('PROGRAMACION_DIARIA');
  const headers = datos[0];
  const col = {};
  headers.forEach((h, i) => col[h] = i);

  const hoyTexto = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const estadoActual = fila[col['Estado_Confirmacion']];
        if (fila[col['Empleado']] === nombreEmpleado && (estadoActual === 'Pendiente' || !estadoActual)
        && fila[col['Estado_Envio']] === 'Enviado' && fila[col['Cancelado']] !== 'Sí'
        && normalizarFecha(fila[col['Fecha_Servicio']]) >= hoyTexto) {
      const cliente = fila[col['Cliente']];

      await actualizarCelda('PROGRAMACION_DIARIA', i + 1, col['Estado_Confirmacion'] + 1, nuevoEstado);
      await actualizarCelda('PROGRAMACION_DIARIA', i + 1, col['Fecha_Hora_Confirmacion'] + 1,
        new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));

      if (nuevoEstado === 'Confirmado') {
        return `✅ Confirmado. Nos vemos en ${cliente}.`;
      } else {
        await notificarGerencia(`${nombreEmpleado} NO puede cubrir el servicio de ${cliente}.`, 'urgente');
        return 'Entendido, quedó registrado que no puedes. Por favor escríbele directamente al administrador para explicarle el motivo.';
      }
    }
  }
  return null; // no hay ninguna confirmacion pendiente para este empleado
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

async function buscarProgramacionPorClienteHoy() {
  const datos = await leerHoja('PROGRAMACION_DIARIA');
  const headers = datos[0];
  const col = {};
  headers.forEach((h, i) => col[h] = i);
  const hoyTexto = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return { datos, col, hoyTexto };
}

async function procesarAviso(telefonoEmisor, texto) {
  const esWill = soloDigitos(telefonoEmisor) === soloDigitos(CHAT_ADMIN_WHATSAPP.replace('whatsapp:', ''));
  if (!esWill) return null; // silencio total para cualquiera que no sea Will

  const match = texto.match(/^aviso\s+([^:]+):\s*(.+)$/i);
  if (!match) return 'Formato: aviso [Cliente]: [mensaje]';

  const cliente = match[1].trim();
  const mensajeAviso = match[2].trim();
  const { datos, col, hoyTexto } = await buscarProgramacionPorClienteHoy();

  const notificados = [];
  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const fechaTexto = normalizarFecha(fila[col['Fecha_Servicio']]);
    if (fechaTexto === hoyTexto && fila[col['Cliente']].toLowerCase() === cliente.toLowerCase()) {
      const nombreEmpleado = fila[col['Empleado']];
      const telefonoEmpleado = await buscarTelefonoPorNombre(nombreEmpleado);
      if (!telefonoEmpleado) continue;

      await enviarWhatsApp(
        `whatsapp:+${soloDigitos(telefonoEmpleado)}`,
        `📢 Aviso sobre tu servicio actual:\n${mensajeAviso}\n\nPor favor responde "Recibido" para confirmar que lo viste.`
      );

      if (col['Avisos_Durante_Servicio'] !== undefined) {
        const previo = fila[col['Avisos_Durante_Servicio']] || '';
        const marca = `[${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}] ${mensajeAviso}`;
        await actualizarCelda('PROGRAMACION_DIARIA', i + 1, col['Avisos_Durante_Servicio'] + 1, previo ? `${previo}\n${marca}` : marca);
      }
      if (col['Aviso_Confirmado'] !== undefined) {
        await actualizarCelda('PROGRAMACION_DIARIA', i + 1, col['Aviso_Confirmado'] + 1, 'No');
      }
      notificados.push(nombreEmpleado);
    }
  }

  if (notificados.length === 0) return `No encontré ningún servicio de hoy para "${cliente}".`;
  return `✅ Enviado a: ${notificados.join(', ')}`;
}

async function procesarConfirmacionAviso(telefono, texto) {
  if (!/^recibido$/i.test(texto.trim())) return null;

  const nombreEmpleado = await buscarEmpleadoPorTelefono(telefono);
  if (!nombreEmpleado) return null;

  const { datos, col, hoyTexto } = await buscarProgramacionPorClienteHoy();
  if (col['Aviso_Confirmado'] === undefined) return null;

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const fechaTexto = normalizarFecha(fila[col['Fecha_Servicio']]);
    if (fechaTexto === hoyTexto && fila[col['Empleado']] === nombreEmpleado && fila[col['Aviso_Confirmado']] === 'No') {
      await actualizarCelda('PROGRAMACION_DIARIA', i + 1, col['Aviso_Confirmado'] + 1, 'Sí');
      await notificarGerencia(`${nombreEmpleado} confirmó que vio el aviso sobre ${fila[col['Cliente']]}.`, 'rutina');
      return '👍 Recibido, gracias.';
    }
  }
  return null;
}

async function obtenerFilaProgramacionPorId(idProgramacion) {
  const datos = await leerHoja('PROGRAMACION_DIARIA');
  const headers = datos[0];
  const col = {};
  headers.forEach((h, i) => col[h] = i);
  for (let i = 1; i < datos.length; i++) {
    if (datos[i][col['ID_Programacion']] === idProgramacion) {
      return { fila: datos[i], filaSheet: i + 1, col };
    }
  }
  return null;
}

async function obtenerDatosFormularioCierre(idProgramacion) {
  const encontrado = await obtenerFilaProgramacionPorId(idProgramacion);
  if (!encontrado) return null;
  const { fila, col } = encontrado;
  const cliente = fila[col['Cliente']];
  const sitio = await buscarSitio(cliente);
  const yaFinalizado = col['Servicio_Finalizado'] !== undefined && fila[col['Servicio_Finalizado']] === 'Sí';
  const tipoServicio = fila[col['Tipo_Servicio']] || 'Limpieza';
  const dc = await datosClienteVivo(cliente);

  return {
    cliente,
    direccion: fila[col['Direccion']] || dc.direccion,
    instrucciones: fila[col['Instrucciones']] || dc.instrucciones,
    checklist: sitio ? sitio.checklist : [],
    yaFinalizado,
    tipoServicio,
  };
}

const INSUMOS_COMUNES = ['Clorox', 'Jabón para pisos', 'Papel higiénico', 'Toallas de papel', 'Bolsas de basura'];
const AREAS_INSPECCION = ['Limpieza general', 'Uso de productos', 'Atención a instrucciones del cliente', 'Orden y organización', 'Seguridad y EPP'];

async function procesarCierreFormulario(body) {
  const idProgramacion = body.id;
  const encontrado = await obtenerFilaProgramacionPorId(idProgramacion);
  if (!encontrado) throw new Error('Servicio no encontrado');
  const { fila, filaSheet, col } = encontrado;

  if (col['Servicio_Finalizado'] !== undefined && fila[col['Servicio_Finalizado']] === 'Sí') {
    const error = new Error('Este cierre ya había sido enviado antes');
    error.yaFinalizado = true;
    throw error;
  }

  const cliente = fila[col['Cliente']];
  const empleado = fila[col['Empleado']];

  const sitio = await buscarSitio(cliente);
  const todasTareas = sitio ? sitio.checklist : [];
  let completadas = body.completadas || [];
  if (!Array.isArray(completadas)) completadas = [completadas];
  const pendientes = todasTareas.filter(t => !completadas.includes(t));
  const pendientesTexto = pendientes.length ? pendientes.join(', ') : 'Ninguna';

  let insumos = body.insumosFaltantes || [];
  if (!Array.isArray(insumos)) insumos = [insumos];
  if (body.otroInsumo && body.otroInsumo.trim()) insumos.push(body.otroInsumo.trim());
  const insumosTexto = insumos.length ? insumos.join(', ') : 'Ninguno';

  const comentario = (body.comentario || '').trim() || '(sin comentario)';

  if (col['Tareas_Pendientes'] !== undefined) await actualizarCelda('PROGRAMACION_DIARIA', filaSheet, col['Tareas_Pendientes'] + 1, pendientesTexto);
  if (col['Insumos_Faltantes'] !== undefined) await actualizarCelda('PROGRAMACION_DIARIA', filaSheet, col['Insumos_Faltantes'] + 1, insumosTexto);
  if (col['Comentario_Empleado'] !== undefined) await actualizarCelda('PROGRAMACION_DIARIA', filaSheet, col['Comentario_Empleado'] + 1, comentario);
  if (col['Servicio_Finalizado'] !== undefined) await actualizarCelda('PROGRAMACION_DIARIA', filaSheet, col['Servicio_Finalizado'] + 1, 'Sí');

  await notificarGerencia(
    `Servicio finalizado — ${cliente} (${empleado})\n` +
    `Tareas pendientes: ${pendientesTexto}\n` +
    `Insumos faltantes: ${insumosTexto}\n` +
    `Comentario: ${comentario}`,
    'rutina'
  );
}

async function procesarInspeccionFormulario(body) {
  const idProgramacion = body.id;
  const encontrado = await obtenerFilaProgramacionPorId(idProgramacion);
  if (!encontrado) throw new Error('Servicio no encontrado');
  const { fila, filaSheet, col } = encontrado;

  if (col['Servicio_Finalizado'] !== undefined && fila[col['Servicio_Finalizado']] === 'Sí') {
    const error = new Error('Esta inspección ya había sido enviada antes');
    error.yaFinalizado = true;
    throw error;
  }

  const cliente = fila[col['Cliente']];
  const supervisor = fila[col['Empleado']];

  const resumenAreas = AREAS_INSPECCION.map(area => {
    const valor = body[`area_${area}`] || 'Cumple';
    return `${area}: ${valor}`;
  }).join('; ');

  const noCumpleAlguna = AREAS_INSPECCION.some(area => body[`area_${area}`] === 'No cumple');
  const requiereAccion = body.requiereAccion === 'Si';
  const hallazgos = (body.hallazgos || '').trim() || '(sin hallazgos)';

  if (col['Resultado_Inspeccion'] !== undefined) await actualizarCelda('PROGRAMACION_DIARIA', filaSheet, col['Resultado_Inspeccion'] + 1, resumenAreas);
  if (col['Requiere_Accion_Correctiva'] !== undefined) await actualizarCelda('PROGRAMACION_DIARIA', filaSheet, col['Requiere_Accion_Correctiva'] + 1, requiereAccion ? 'Sí' : 'No');
  if (col['Estado_Correccion'] !== undefined) await actualizarCelda('PROGRAMACION_DIARIA', filaSheet, col['Estado_Correccion'] + 1, requiereAccion ? 'Pendiente' : '');
  if (col['Comentario_Empleado'] !== undefined) await actualizarCelda('PROGRAMACION_DIARIA', filaSheet, col['Comentario_Empleado'] + 1, hallazgos);
  if (col['Servicio_Finalizado'] !== undefined) await actualizarCelda('PROGRAMACION_DIARIA', filaSheet, col['Servicio_Finalizado'] + 1, 'Sí');

  const nivel = (noCumpleAlguna || requiereAccion) ? 'urgente' : 'rutina';
  await notificarGerencia(
    `Inspección finalizada — ${cliente} (${supervisor})\n` +
    `Resultado por área: ${resumenAreas}\n` +
    `Hallazgos: ${hallazgos}\n` +
    `¿Requiere acción correctiva?: ${requiereAccion ? 'Sí' : 'No'}`,
    nivel
  );
}

async function datosClienteVivo(nombre) {
  const datos = await leerHoja('CLIENTES');
  const h = datos[0] || [];
  const iN = h.indexOf('clientes');
  for (let r = 1; r < datos.length; r++) {
    if (datos[r][iN] === nombre) {
      const g = n => datos[r][h.indexOf(n)] || '';
      return { direccion: g('Direccion'), maps: g('Google Maps'), descripcion: g('Descripcion_Servicio'), instrucciones: g('Instrucciones') };
    }
  }
  return { direccion: '', maps: '', descripcion: '', instrucciones: '' };
}

module.exports = { procesarCheckIn, notificarGerencia, enviarProgramacionManana, procesarRespuestaConfirmacion, procesarQuejaODuda, procesarAviso, procesarConfirmacionAviso, obtenerDatosFormularioCierre, procesarCierreFormulario, procesarInspeccionFormulario, INSUMOS_COMUNES, AREAS_INSPECCION, enviarProgramacionFecha, notificarCambioPostEnvio, registrarCambio, enviarWhatsApp };