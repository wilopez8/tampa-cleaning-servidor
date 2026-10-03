const crypto = require('crypto');

// El orden es fijo: la clave N identifica al administrador N. Las 4 claves deben ser distintas.
const ADMINS = [
  { nombre: 'Wilmar Lopez',    variable: 'CLAVE_ADMIN_1' },
  { nombre: 'Carolina Gallego', variable: 'CLAVE_ADMIN_2' },
  { nombre: 'Andres Madrid',   variable: 'CLAVE_ADMIN_3' },
  { nombre: 'Claudia Lopez',   variable: 'CLAVE_ADMIN_4' },
];
const COOKIE = 'tc_sesion';
const DURACION_MS = 12 * 60 * 60 * 1000;
const MAX_FALLOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;

function secreto() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('Falta SESSION_SECRET (mínimo 32 caracteres)');
  return s;
}
function firmar(texto) {
  return crypto.createHmac('sha256', secreto()).update(texto).digest('base64url');
}
// Comparación en tiempo constante
function iguales(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function identificarAdmin(clave) {
  let encontrado = null;
  for (const a of ADMINS) {               // recorre todas, sin cortar antes
    const esperada = process.env[a.variable];
    if (esperada && iguales(clave, esperada)) encontrado = a.nombre;
  }
  return encontrado;
}

function crearToken(nombre) {
  const carga = Buffer.from(JSON.stringify({ n: nombre, e: Date.now() + DURACION_MS })).toString('base64url');
  return `${carga}.${firmar(carga)}`;
}
function leerToken(token) {
  if (!token || !token.includes('.')) return null;
  const [carga, firma] = token.split('.');
  if (!iguales(firma, firmar(carga))) return null;
  try {
    const d = JSON.parse(Buffer.from(carga, 'base64url').toString());
    if (!d.e || d.e < Date.now()) return null;
    return ADMINS.some(a => a.nombre === d.n) ? d.n : null;
  } catch { return null; }
}

function leerCookie(req, nombre) {
  for (const par of (req.headers.cookie || '').split(';')) {
    const i = par.indexOf('=');
    if (i > 0 && par.slice(0, i).trim() === nombre) return decodeURIComponent(par.slice(i + 1).trim());
  }
  return null;
}
function cookieSesion(nombre) {
  return `${COOKIE}=${encodeURIComponent(crearToken(nombre))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DURACION_MS / 1000}`;
}
const cookieCierre = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// Freno simple a intentos de adivinar la clave (en memoria, por IP)
const fallos = new Map();
function bloqueado(ip) {
  const f = fallos.get(ip);
  if (!f) return false;
  if (f.hasta && f.hasta < Date.now()) { fallos.delete(ip); return false; }
  return !!f.hasta;
}
function registrarFallo(ip) {
  const f = fallos.get(ip) || { n: 0 };
  f.n++;
  if (f.n >= MAX_FALLOS) f.hasta = Date.now() + BLOQUEO_MS;
  fallos.set(ip, f);
}
function limpiarFallos(ip) { fallos.delete(ip); }

function requiereAdmin(req, res, next) {
  const nombre = leerToken(leerCookie(req, COOKIE));
  if (nombre) { req.admin = nombre; return next(); }
  if (req.method === 'GET') return res.redirect('/login?volver=' + encodeURIComponent(req.originalUrl));
  res.status(401).send('Sesión vencida. Vuelve a iniciar sesión.');
}

module.exports = { identificarAdmin, requiereAdmin, cookieSesion, cookieCierre, bloqueado, registrarFallo, limpiarFallos };