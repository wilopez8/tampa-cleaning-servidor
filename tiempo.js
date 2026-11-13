// Fecha y hora segun la zona horaria de la empresa (ver empresa.js). Render corre en UTC, por eso no se usa la hora del servidor.
const { zonaHoraria } = require('./empresa');
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: zonaHoraria });   // AAAA-MM-DD
const ahora = () => new Date().toLocaleString('en-US', { timeZone: zonaHoraria });      // M/D/AAAA, h:mm:ss AM/PM
module.exports = { hoy, ahora, zonaHoraria };
