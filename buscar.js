// Búsqueda global de la barra superior: /buscar?q=
// - Un ID exacto abre su registro: PRG- → ficha de servicio, PND- → ese pendiente,
//   LIQ- → la semana del empleado en Nómina, COB- → ficha del cliente › Cobros y pagos de ese mes.
// - Un texto busca en los nombres de clientes y empleados (sin distinguir mayúsculas ni tildes).
//   Si hay una sola coincidencia abre su ficha; si no, muestra la lista de resultados.
// Solo lectura: no escribe en ninguna hoja.

const { leerHoja } = require('./sheets');
const layout = require('./layout');
const E = require('./enlaces');
const { normalizarFecha } = require('./agenda');
const Dir = () => require('./directorio'); // carga diferida

const esc = layout.esc;
const limpio = t => String(t ?? '').trim();
const normal = t => limpio(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const RE_ID = /^(PRG|PND|LIQ|COB)-\d{8}-\d+$/;

// Busca una fila por la columna de ID en una hoja (que puede no existir todavía).
async function filaPorId(hoja, colId, id) {
  let d;
  try { d = await leerHoja(hoja, { cache: true }); } catch (e) { return null; }
  if (!d || !d.length) return null;
  const h = d[0].map(limpio), i = h.indexOf(colId);
  if (i < 0) return null;
  const r = d.slice(1).find(f => limpio(f[i]).toUpperCase() === id);
  if (!r) return null;
  const o = {};
  h.forEach((n, j) => { o[n] = limpio(r[j]); });
  return o;
}

// Devuelve la URL del registro, o null si el ID no existe.
async function urlDeId(id) {
  const tipo = id.slice(0, 3);
  if (tipo === 'PRG') return E.url.servicio(id); // la ficha de servicio ya avisa si no existe
  if (tipo === 'PND') return E.url.pendiente(id);
  if (tipo === 'LIQ') {
    const l = await filaPorId('LIQUIDACIONES', 'ID_Liquidacion', id);
    return l && l.Empleado ? E.url.liquidacion(l.Empleado, normalizarFecha(l.Semana_Inicio)) : null;
  }
  if (tipo === 'COB') {
    const c = await filaPorId('COBROS_SERVICIO', 'ID_Cobro', id);
    return c && c.Cliente ? E.url.cliente(c.Cliente, normalizarFecha(c.Fecha).slice(0, 7), 'cobros') : null;
  }
  return null;
}

async function buscarNombres(q) {
  const n = normal(q);
  const [cl, em] = await Promise.all([Dir().leerClientes(false), Dir().leerEmpleados(false)]);
  const coincide = x => normal(x.nombre).includes(n);
  const orden = (a, b) => (b.act - a.act) || a.nombre.localeCompare(b.nombre); // activos primero
  return {
    clientes: cl.lista.filter(coincide).sort(orden),
    empleados: em.lista.filter(coincide).sort(orden),
  };
}

const CSS = `.bus-sec{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin-bottom:16px;}
.bus-sec h2{font-size:15px;margin:0 0 8px;} .bus-sec ul{list-style:none;margin:0;padding:0;}
.bus-sec li{padding:7px 0;border-top:1px solid var(--line);display:flex;gap:10px;align-items:center;flex-wrap:wrap;} .bus-sec li:first-child{border-top:0;}
.bus-sec .det{color:var(--gray-d);font-size:13px;} .bus-in{color:var(--gray-d);font-size:12px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;}
.bus-vacio{color:var(--gray-d);}`;

function pagina(admin, q, r, aviso) {
  const fila = (link, det, act) => `<li>${link}${det ? `<span class="det">${esc(det)}</span>` : ''}${act ? '' : '<span class="bus-in">Inactivo</span>'}</li>`;
  const sec = (titulo, lista, f) => `<div class="bus-sec"><h2>${titulo} (${lista.length})</h2>${lista.length ? `<ul>${lista.map(f).join('')}</ul>` : '<span class="bus-vacio">Sin coincidencias.</span>'}</div>`;
  const cuerpo = r ? sec('Clientes', r.clientes, c => fila(E.cliente(c.nombre), [c.ciudad, c.tipo].filter(Boolean).join(' · '), c.act))
    + sec('Empleados', r.empleados, e => fila(E.empleado(e.nombre), e.rol, e.act)) : '';
  return `${layout.head('Buscar', CSS)}
${layout.cabecera({ titulo: q ? `Buscar: “${q}”` : 'Buscar', admin, q })}
${aviso ? `<div class="aviso">${aviso}</div>` : ''}
${cuerpo}
<p class="bus-vacio">Se busca por nombre de cliente o empleado, o por ID exacto: PRG-…, PND-…, LIQ-…, COB-….</p>
</body></html>`;
}

function rutas(app, auth) {
  app.get('/buscar', auth.requiereAdmin, async (req, res) => {
    const q = limpio(req.query.q).slice(0, 100);
    try {
      if (!q) return res.send(pagina(req.admin, '', null, 'Escribe un nombre o un ID en el buscador de arriba.'));
      const id = q.toUpperCase().replace(/\s+/g, '');
      if (RE_ID.test(id)) {
        const u = await urlDeId(id);
        if (u) return res.redirect(u);
        return res.send(pagina(req.admin, q, null, `No se encontró <b>${esc(id)}</b>.`));
      }
      const r = await buscarNombres(q);
      const total = r.clientes.length + r.empleados.length;
      if (total === 1) return res.redirect(r.clientes.length ? E.url.cliente(r.clientes[0].nombre) : E.url.empleado(r.empleados[0].nombre));
      res.send(pagina(req.admin, q, total ? r : null, total ? '' : `Ningún cliente ni empleado coincide con <b>${esc(q)}</b>.`));
    } catch (e) {
      console.error('Error en /buscar:', e.message);
      res.status(500).send(pagina(req.admin, q, null, 'No se pudo buscar: ' + esc(e.message)));
    }
  });
}

module.exports = { rutas, _t: { normal, RE_ID, urlDeId } };
