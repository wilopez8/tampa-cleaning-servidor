// Datos propios de la empresa. Orden de prioridad: variable de entorno > hoja CONFIG_EMPRESA > valor por defecto (Tampa Cleaning).
// Se leen en cada uso (no al cargar el archivo), asi un cambio en la hoja se aplica sin reiniciar el servidor.
const config = require('./config');
const E = process.env;

const ENV = { Zona_Horaria: 'EMPRESA_ZONA', Prefijo_Pais: 'EMPRESA_PREFIJO_PAIS', Gerencia_WhatsApp: 'CHAT_ADMIN_WHATSAPP' };
const delEntorno = clave => { const v = ENV[clave] && E[ENV[clave]]; return v && config.valido(clave, v) ? v : ''; };
const valor = clave => delEntorno(clave) || config.valor(clave);

module.exports = {
  get zonaHoraria() { return valor('Zona_Horaria'); },
  get prefijoPais() { return valor('Prefijo_Pais'); },
  get gerenciaWhatsapp() { return valor('Gerencia_WhatsApp'); },
  // Solo infraestructura (variables de entorno): no se cambian desde la hoja
  whatsappFrom: E.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886', // numero del Sandbox
  baseUrl: E.BASE_URL || 'https://tampa-cleaning-servidor.onrender.com',
  // Para revisar que valor se esta usando y de donde viene (ruta /config-empresa)
  estado() {
    return config.CLAVES.map(clave => {
      const crudo = ENV[clave] && E[ENV[clave]];
      const fuente = delEntorno(clave) ? 'variable de entorno ' + ENV[clave] : (config.enHoja(clave) ? 'hoja CONFIG_EMPRESA' : 'por defecto');
      const avisos = [config.aviso(clave), crudo && !delEntorno(clave) ? 'La variable ' + ENV[clave] + ' tiene un valor no valido y se ignora.' : ''].filter(Boolean);
      return { clave, valor: valor(clave), fuente, avisos };
    });
  },
};