(function () {
  'use strict';
  var TC = window.TC = {};

  function el(tag, props, texto) {
    var e = document.createElement(tag), k;
    if (props) { for (k in props) { e[k] = props[k]; } }
    if (texto !== undefined) { e.textContent = texto; }
    return e;
  }

  TC.post = function (url, data) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(data) })
      .then(function (r) {
        if (r.status === 401) { location.href = '/login?volver=' + encodeURIComponent(location.pathname + location.search); return null; }
        return r.json();
      });
  };

  TC.toast = function (msg, tipo) {
    var p = document.getElementById('tc-toasts');
    if (!p) { p = el('div', { id: 'tc-toasts' }); document.body.appendChild(p); }
    var t = el('div', { className: 'tc-toast ' + (tipo || 'ok') }, msg);
    p.appendChild(t);
    setTimeout(function () {
      t.className += ' fuera';
      setTimeout(function () { if (t.parentNode) { t.parentNode.removeChild(t); } }, 300);
    }, tipo === 'mal' ? 6000 : 3500);
  };

  function abrir(opt) {
    return new Promise(function (resolve) {
      var d = el('dialog', { className: 'tc-dlg' }), input = null, err = el('p', { className: 'tc-err' }), cerrado = false;
      if (opt.titulo) { d.appendChild(el('h3', null, opt.titulo)); }
      if (opt.texto) { d.appendChild(el('p', { className: 'tc-txt' }, opt.texto)); }
      if (opt.campo) {
        var l = el('label', null, opt.campo.etiqueta);
        input = el('input', { type: 'text', maxLength: 300 });
        l.appendChild(input);
        d.appendChild(l);
      }
      d.appendChild(err);
      var fila = el('div', { className: 'tc-acc' });
      function fin(v) {
        if (cerrado) { return; }
        cerrado = true;
        d.close();
        if (d.parentNode) { d.parentNode.removeChild(d); }
        resolve(v);
      }
      if (opt.no !== null) {
        var bn = el('button', { type: 'button', className: 'btn' }, opt.no || 'Cancelar');
        bn.onclick = function () { fin(input ? null : false); };
        fila.appendChild(bn);
      }
      var bs = el('button', { type: 'button', className: 'btn hoy' }, opt.si || 'Aceptar');
      bs.onclick = function () {
        if (input) {
          var v = input.value.trim();
          if (opt.campo.min && v.length < opt.campo.min) { err.textContent = 'Escribe al menos ' + opt.campo.min + ' caracteres.'; return; }
          fin(v);
          return;
        }
        fin(true);
      };
      fila.appendChild(bs);
      d.appendChild(fila);
      d.addEventListener('cancel', function (e) { e.preventDefault(); fin(input ? null : (opt.no === null)); });
      if (input) { input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { bs.click(); } }); }
      document.body.appendChild(d);
      d.showModal();
      if (input) { input.focus(); }
    });
  }

  TC.confirmar = function (texto, o) { o = o || {}; return abrir({ titulo: o.titulo || 'Confirmar', texto: texto, si: o.si || 'Aceptar' }); };
  TC.alerta = function (texto, o) { o = o || {}; return abrir({ titulo: o.titulo || 'Aviso', texto: texto, si: 'Entendido', no: null }); };
  TC.pedir = function (o) { return abrir({ titulo: o.titulo, texto: o.texto, campo: { etiqueta: o.etiqueta, min: o.min || 0 }, si: o.si || 'Guardar' }); };

  // cierra los menús "⋯" al hacer clic fuera o sobre una opción
  document.addEventListener('click', function (e) {
    var ab = document.querySelectorAll('details.mnu[open]'), i, dentroLista;
    for (i = 0; i < ab.length; i++) {
      dentroLista = e.target.closest && e.target.closest('.mnu-l') && ab[i].contains(e.target);
      if (!ab[i].contains(e.target) || dentroLista) { ab[i].removeAttribute('open'); }
    }
  });
})();