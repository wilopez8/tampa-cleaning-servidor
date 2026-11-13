// Datos propios de la empresa. Los valores por defecto son los de Tampa Cleaning (como estaba antes en el codigo).
// Cualquiera se puede cambiar con una variable de entorno en Render, sin tocar el codigo.
const E = process.env;
module.exports = {
  zonaHoraria: E.EMPRESA_ZONA || 'America/New_York',
  prefijoPais: E.EMPRESA_PREFIJO_PAIS || '1',
  whatsappFrom: E.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886', // numero del Sandbox
  gerenciaWhatsapp: E.CHAT_ADMIN_WHATSAPP || 'whatsapp:+18133856059', // numero de gerencia
  baseUrl: E.BASE_URL || 'https://tampa-cleaning-servidor.onrender.com',
};