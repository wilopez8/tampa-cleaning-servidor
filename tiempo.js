// Fecha y hora segun la zona horaria de la empresa (ver empresa.js). Render corre en UTC, por eso no se usa la hora del servidor.
const empresa = require('./empresa');
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: empresa.zonaHoraria });   // AAAA-MM-DD
const ahora = () => new Date().toLocaleString('en-US', { timeZone: empresa.zonaHoraria });      // M/D/AAAA, h:mm:ss AM/PM
module.exports = { hoy, ahora };