// Datos de marca. Un solo lugar para reutilizar la aplicación con otras empresas.
// Los valores se pueden cambiar con variables de entorno en Render (opcional).
module.exports = {
  PRODUCTO: process.env.MARCA_PRODUCTO || 'ADB Consulting', // quien desarrolla y opera la plataforma
  EMPRESA: process.env.MARCA_EMPRESA || 'Tampa Cleaning',   // empresa cliente
  LOGO: process.env.MARCA_LOGO || '/static/logo-adb.png',                   // para fondo blanco (login)
  LOGO_CLARO: process.env.MARCA_LOGO_CLARO || '/static/logo-adb-claro.png', // para la barra oscura
};
