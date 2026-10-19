const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ITEMS = [['/agenda', 'Agenda'], ['/pendientes', 'Pendientes'], ['/nomina', 'Nómina']];

const MENU_CSS = `
nav.tcmenu{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:0;padding:0;}
nav.tcmenu span{font-size:13px;color:#555;margin-right:6px;}
nav.tcmenu a{display:inline-block;padding:6px 12px;border:1px solid #ccc;border-radius:6px;background:#fff;color:#222;font-size:14px;line-height:1.2;text-decoration:none;white-space:nowrap;}
nav.tcmenu a.act{background:#1d4ed8;border-color:#1d4ed8;color:#fff;}
nav.tcmenu a.sal{color:#b91c1c;}`;

function menuHtml(actual, admin) {
  return `<nav class="tcmenu"><span>${esc(admin)}</span>` +
    ITEMS.map(([href, t]) => `<a href="${href}"${href === actual ? ' class="act"' : ''}>${t}</a>`).join('') +
    `<a class="sal" href="/logout">Cerrar sesión</a></nav>`;
}

module.exports = { MENU_CSS, menuHtml };
