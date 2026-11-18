const fs = require('fs');
const path = require('path');
const marca = require('./marca');

const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ver = f => { try { return Math.round(fs.statSync(path.join(__dirname, 'public', f)).mtimeMs); } catch (e) { return 0; } };
const V_CSS = ver('tc.css'), V_JS = ver('tc.js');

// Barra superior: cinco secciones agrupadas por tarea. [clave, ruta, texto]. Las URL de las páginas no cambian.
const SECCIONES = [['hoy', '/resumen', 'Hoy'], ['operacion', '/agenda', 'Operación'], ['clientes', '/cartera/clientes', 'Clientes'],
  ['equipo', '/directorio/empleados', 'Equipo'], ['cartera', '/cartera', 'Cartera']];
// Sub-pestañas de cada sección: [clave, ruta, texto, conserva ?mes=]
const SUBS = {
  operacion: [['agenda', '/agenda', 'Agenda', false], ['pendientes', '/pendientes', 'Pendientes', false]],
  clientes: [['cobros', '/cartera/clientes', 'Cobros por cliente', true], ['calidad', '/cartera/calidad', 'Calidad', false], ['directorio', '/directorio/clientes', 'Directorio', false]],
  equipo: [['empleados', '/directorio/empleados', 'Empleados', false], ['nomina', '/nomina', 'Nómina', false]],
  cartera: [['cobros', '/cartera', 'Cobros', true], ['ingresos', '/cartera/pagos', 'Ingresos', true], ['egresos', '/cartera/egresos', 'Egresos', true], ['reportes', '/cartera/reportes', 'Reportes', false]],
};

// css: estilos propios de la pantalla (van antes de tc.css, que los complementa)
function head(titulo, css, claseBody) {
  const pie = `${marca.EMPRESA} · Plataforma desarrollada por ${marca.PRODUCTO}`;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(titulo)} · ${esc(marca.EMPRESA)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
${css ? `<style>${css}</style>` : ''}<link rel="stylesheet" href="/static/tc.css?v=${V_CSS}"><style>body::after{content:${JSON.stringify(pie)};display:block;text-align:center;color:var(--gray);font-size:12px;margin-top:40px;}</style><script src="/static/tc.js?v=${V_JS}"></script></head><body${claseBody ? ` class="${claseBody}"` : ''}>`;
}

// titulo: texto plano (se escapa). tituloHtml: HTML ya seguro.
// seccion: clave de SECCIONES. activa: clave de la sub-pestaña (las listas la pasan; las fichas no, y usan ruta).
// ruta: migas de pan [[texto, href], …, [texto]]; el último (sin href) es la página actual.
function cabecera({ titulo, tituloHtml, seccion, admin, activa, mes, ruta }) {
  const barra = `<header class="tc-bar"><a class="tc-brand" href="/resumen" title="Hoy"><img src="${esc(marca.LOGO_CLARO)}" alt="${esc(marca.PRODUCTO)}"></a><span class="tc-empresa">${esc(marca.EMPRESA)}</span>
<nav>${SECCIONES.map(([k, h, t]) => `<a href="${h}"${k === seccion ? ' class="act"' : ''}>${t}</a>`).join('')}</nav>
<div class="tc-user"><span>${esc(admin)}</span><a href="/logout">Cerrar sesión</a></div></header>`;
  const tabs = activa && SUBS[seccion] ? `<div class="tc-tabs">${SUBS[seccion].map(([k, h, t, conMes]) => {
    const href = conMes && mes ? h + '?mes=' + encodeURIComponent(mes) : h;
    return `<a href="${esc(href)}"${k === activa ? ' class="act"' : ''}>${t}</a>`;
  }).join('')}</div>` : '';
  const migas = ruta && ruta.length ? `<nav class="tc-ruta" aria-label="Ruta">${ruta.map(([t, h], i) => (i ? '<span>›</span>' : '') + (h ? `<a href="${esc(h)}">${esc(t)}</a>` : `<b>${esc(t)}</b>`)).join('')}</nav>` : '';
  return `${barra}${migas}<div class="tc-titulo"><h1>${tituloHtml !== undefined ? tituloHtml : esc(titulo)}</h1></div>${tabs}`;
}

// items: [[etiqueta, valor(HTML seguro), clase opcional]]
function kpis(items) {
  return `<div class="kpis">${items.map(([et, v, cls]) => `<div class="kpi${cls ? ' ' + cls : ''}"><span>${esc(et)}</span><b>${v}</b></div>`).join('')}</div>`;
}

module.exports = { head, cabecera, kpis, esc };