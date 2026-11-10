const fs = require('fs');
const path = require('path');

const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ver = f => { try { return Math.round(fs.statSync(path.join(__dirname, 'public', f)).mtimeMs); } catch (e) { return 0; } };
const V_CSS = ver('tc.css'), V_JS = ver('tc.js');

const SECCIONES = [['/agenda', 'Agenda'], ['/pendientes', 'Pendientes'], ['/nomina', 'Nómina'], ['/cartera', 'Cartera']];
// [clave, ruta, texto, conserva ?mes=]
const SUBS = {
  cartera: [['servicios', '/cartera', 'Servicios', true], ['clientes', '/cartera/clientes', 'Clientes', true], ['ingresos', '/cartera/pagos', 'Ingresos', false],
    ['egresos', '/cartera/egresos', 'Egresos', false], ['reportes', '/cartera/reportes', 'Reportes', false], ['calidad', '/cartera/calidad', 'Calidad', false]],
};

// css: estilos propios de la pantalla (van antes de tc.css, que los complementa)
function head(titulo, css, claseBody) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(titulo)} · Tampa Cleaning</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
${css ? `<style>${css}</style>` : ''}<link rel="stylesheet" href="/static/tc.css?v=${V_CSS}"><script src="/static/tc.js?v=${V_JS}"></script></head><body${claseBody ? ` class="${claseBody}"` : ''}>`;
}

// titulo: texto plano (se escapa). tituloHtml: HTML ya seguro.
function cabecera({ titulo, tituloHtml, seccion, admin, sub, activa, mes }) {
  const barra = `<header class="tc-bar"><a class="tc-brand" href="/agenda"><i></i>Tampa Cleaning</a><nav>${SECCIONES.map(([h, t]) => `<a href="${h}"${h === seccion ? ' class="act"' : ''}>${t}</a>`).join('')}</nav>
<div class="tc-user"><span>${esc(admin)}</span><a href="/logout">Cerrar sesión</a></div></header>`;
  const tabs = sub && SUBS[sub] ? `<div class="tc-tabs">${SUBS[sub].map(([k, h, t, conMes]) => {
    const href = conMes && mes ? h + '?mes=' + encodeURIComponent(mes) : h;
    return `<a href="${esc(href)}"${k === activa ? ' class="act"' : ''}>${t}</a>`;
  }).join('')}</div>` : '';
  return `${barra}<div class="tc-titulo"><h1>${tituloHtml !== undefined ? tituloHtml : esc(titulo)}</h1></div>${tabs}`;
}

// items: [[etiqueta, valor(HTML seguro), clase opcional]]
function kpis(items) {
  return `<div class="kpis">${items.map(([et, v, cls]) => `<div class="kpi${cls ? ' ' + cls : ''}"><span>${esc(et)}</span><b>${v}</b></div>`).join('')}</div>`;
}

module.exports = { head, cabecera, kpis, esc };