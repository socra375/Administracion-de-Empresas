/* AINova · motor de temas (claro / oscuro / automático).
 *
 * Se carga como script clásico en el <head>, ANTES de que se pinte nada, para que no haya
 * parpadeo. Lo comparten la presentación (index.html) y la app (app.html).
 *
 * Preferencia guardada en localStorage['pyme_theme']: 'light' | 'dark' | 'auto'.
 * Los valores 'light' y 'dark' ya existían (versión anterior), así que quien eligió uno
 * lo conserva. Sin preferencia guardada se usa 'auto' (sigue al dispositivo).
 *
 * El resultado se publica en <html data-theme="light|dark"> (tema efectivo) y
 * <html data-theme-pref="light|dark|auto"> (lo que eligió la persona).
 *
 * Controles declarativos (funcionan en cualquier página que cargue este archivo):
 *   [data-theme-set="light|dark|auto"]   fija el tema; recibe .is-active y aria-pressed
 *   [data-theme-toggle]                  botón que abre/cierra el menú rápido (.popover vecino)
 */
(function () {
  var KEY = 'pyme_theme';
  var root = document.documentElement;
  var mq = null;
  var listeners = [];
  try { mq = window.matchMedia('(prefers-color-scheme: dark)'); } catch (e) { /* sin matchMedia */ }

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      if (v === 'light' || v === 'dark' || v === 'auto') return v;
    } catch (e) { /* almacenamiento bloqueado */ }
    return 'auto';
  }
  function resolve(p) { return p === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : p; }

  var pref = read();

  function syncControls() {
    var nodes = document.querySelectorAll('[data-theme-set]');
    for (var i = 0; i < nodes.length; i++) {
      var on = nodes[i].getAttribute('data-theme-set') === pref;
      nodes[i].classList.toggle('is-active', on);
      nodes[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function apply() {
    var r = resolve(pref);
    root.setAttribute('data-theme', r);
    root.setAttribute('data-theme-pref', pref);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', r === 'dark' ? '#0F1311' : '#F7F5F0');
    syncControls();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](r, pref); } catch (e) { console.error(e); }
    }
  }

  function set(next) {
    if (next !== 'light' && next !== 'dark' && next !== 'auto') next = 'auto';
    pref = next;
    try { localStorage.setItem(KEY, next); } catch (e) { /* ignorar: sigue valiendo en esta sesión */ }
    apply();
  }

  if (mq) {
    var onSystemChange = function () { if (pref === 'auto') apply(); };
    if (mq.addEventListener) mq.addEventListener('change', onSystemChange);
    else if (mq.addListener) mq.addListener(onSystemChange);
  }
  // Otra pestaña cambió el tema.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) { pref = read(); apply(); }
  });

  window.AinovaTheme = {
    get: function () { return pref; },
    resolved: function () { return resolve(pref); },
    set: set,
    onChange: function (fn) { listeners.push(fn); }
  };

  apply();

  function closePopovers(except) {
    var open = document.querySelectorAll('.popover:not(.hidden)');
    for (var i = 0; i < open.length; i++) {
      if (open[i] === except) continue;
      open[i].classList.add('hidden');
      var t = open[i].parentNode && open[i].parentNode.querySelector('[data-theme-toggle]');
      if (t) t.setAttribute('aria-expanded', 'false');
    }
  }

  document.addEventListener('click', function (e) {
    var setter = e.target.closest && e.target.closest('[data-theme-set]');
    if (setter) {
      set(setter.getAttribute('data-theme-set'));
      closePopovers(null);
      return;
    }
    var toggle = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (toggle) {
      var pop = toggle.parentNode.querySelector('.popover');
      if (!pop) return;
      var willOpen = pop.classList.contains('hidden');
      closePopovers(null);
      pop.classList.toggle('hidden', !willOpen);
      toggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      return;
    }
    if (!(e.target.closest && e.target.closest('.popover'))) closePopovers(null);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePopovers(null); });
  document.addEventListener('DOMContentLoaded', syncControls);
})();
