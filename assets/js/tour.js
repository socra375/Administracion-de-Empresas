// =====================================================================
// AINova · tutorial interactivo
//
// Motor del recorrido guiado: bienvenida, pasos con foco animado sobre elementos REALES de la
// app (que en modo demostración trabaja con datos ficticios), pantalla final y estado.
// Sin dependencias: animaciones con CSS (transform / opacity), respeta prefers-reduced-motion.
//
// El recorrido se adapta solo: un paso se omite si su módulo no está disponible para la
// persona (permisos, módulos desactivados) o si su elemento no existe.
// =====================================================================
import { ico, escapeHtml, confirmDialog } from './ui.js';

// ---------- Estado del tutorial (localStorage, por usuario o por dispositivo) ----------
// status: 'in_progress' | 'completed' | 'skipped' (sin estado = no iniciado)
const STATE_PREFIX = 'pyme_tour_v1_';
export const tourState = {
  read(owner) { try { return JSON.parse(localStorage.getItem(STATE_PREFIX + owner)); } catch (e) { return null; } },
  save(owner, data) { try { localStorage.setItem(STATE_PREFIX + owner, JSON.stringify({ ...data, at: Date.now() })); } catch (e) { /* sin almacenamiento: no se recuerda */ } },
  clear(owner) { try { localStorage.removeItem(STATE_PREFIX + owner); } catch (e) { /* ignorar */ } }
};

const GROUPS = {
  panel: 'Panel principal', venta: 'Punto de venta', inventario: 'Inventario', clientes: 'Clientes',
  cobros: 'Cuentas por cobrar', reportes: 'Facturas y reportes', equipo: 'Equipo y permisos', ajustes: 'Configuración'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
/** Espera de verdad a que algo ocurra (consulta cada frame); falla al agotar el tiempo. */
export async function waitFor(cond, ms = 3000) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    let v; try { v = cond(); } catch (e) { v = null; }
    if (v) return v;
    await frame();
  }
  return null;
}

// ---------- Pasos ----------
// section: id de la sección de la app · target: selector(es) del elemento a resaltar ·
// interactive: la persona puede tocar dentro del resaltado · action: acción REAL opcional
// que se ejecuta sobre la demo (no simula nada: usa los mismos botones que la app).
function buildSteps(ctx) {
  const $ = (s) => document.querySelector(s);
  const click = (s) => { const el = $(s); if (!el) throw new Error('No encontré el elemento necesario.'); el.click(); };
  return [
    { id: 'panel-resumen', group: 'panel', section: 'sec-dashboard', interactive: true,
      target: ['#sec-dashboard .period-selector', '#sec-dashboard .dash-grid > .kpi'],
      title: 'Tu negocio de un vistazo',
      text: 'Ventas, costo, ganancia y lo que te deben, comparado con el período anterior. Cambia entre Hoy, Semana y Mes.' },
    { id: 'panel-grafico', group: 'panel', section: 'sec-dashboard', target: '#sec-dashboard .c-chart',
      title: 'Ingresos y costos',
      text: 'Cada barra es una hora o un día. La línea muestra cuánto ganas.' },
    { id: 'panel-alertas', group: 'panel', section: 'sec-dashboard', target: '#sec-dashboard .c-alerts',
      title: 'Alertas que importan',
      text: 'Productos que se agotan y créditos vencidos, para que actúes a tiempo.' },
    { id: 'panel-actividad', group: 'panel', section: 'sec-dashboard', target: '#sec-dashboard .c-recent',
      title: 'Actividad reciente',
      text: 'Las últimas ventas y cobros aparecen aquí al instante.' },

    { id: 'venta-catalogo', group: 'venta', section: 'sec-sales', interactive: true, target: '#pos-grid',
      onEnter: () => ctx.closeCart(),
      title: 'Elige los productos',
      text: 'Busca por nombre o código y toca un producto para sumarlo a la venta.',
      action: { label: 'Agregar un producto', done: 'Agregado a la venta de ejemplo',
        run: async () => {
          click('.pos-item:not(:disabled)');
          if (!(await waitFor(() => $('#cart-lines .cart-line')))) throw new Error('No se pudo agregar el producto.');
        } } },
    { id: 'venta-cobro', group: 'venta', section: 'sec-sales', interactive: true, target: '#pos-cart',
      onEnter: () => { if (ctx.isMobile()) ctx.openCart(); },
      onLeave: () => ctx.closeCart(),
      title: 'Cobra y listo',
      text: 'Ajusta cantidades, elige cómo paga el cliente y completa la venta. El total se calcula solo.',
      action: { label: 'Cobrar esta venta de ejemplo', done: null,
        run: async () => {
          if (!$('#cart-lines .cart-line')) { click('.pos-item:not(:disabled)'); await waitFor(() => $('#cart-lines .cart-line')); }
          click('#btn-process-sale');
          const opened = await waitFor(() => { const m = document.getElementById('modal-invoice'); return m && !m.classList.contains('hidden'); }, 5000);
          if (!opened) throw new Error('No se pudo completar la venta de ejemplo.');
          const total = document.getElementById('inv-total')?.textContent || '';
          ctx.closeModal('modal-invoice');
          return `Venta registrada en la demo: ${total}. La factura se creó sola.`;
        } } },

    { id: 'inv-lista', group: 'inventario', section: 'sec-inventory', target: '#sec-inventory .card.flat',
      title: 'Tus productos y su stock',
      text: 'Consulta precios y existencias. Los avisos de color marcan lo que se está acabando.' },
    { id: 'inv-historial', group: 'inventario', section: 'sec-inventory', target: '#modal-inventory-history .modal-card',
      onEnter: async () => {
        document.getElementById('btn-show-inventory-history')?.click();
        await waitFor(() => document.querySelector('#inventory-history-table-body tr:not(:has(.skel))'), 3000);
      },
      onLeave: () => ctx.closeModal('modal-inventory-history'),
      title: 'Cada movimiento queda registrado',
      text: 'Entradas, salidas por venta y ajustes. Si hiciste la venta de ejemplo, aparece aquí como una salida.' },

    { id: 'cli-lista', group: 'clientes', section: 'sec-customers', interactive: true, target: '#sec-customers .card.flat',
      title: 'Tus clientes',
      text: 'Guarda sus datos y mira de un vistazo quién tiene saldo pendiente.',
      action: { label: 'Abrir un perfil', done: null, run: async () => { click('.btn-account'); } } },
    { id: 'cli-perfil', group: 'clientes', section: 'sec-customers', target: '#modal-customer-account .modal-card',
      onEnter: async () => {
        const m = document.getElementById('modal-customer-account');
        if (m?.classList.contains('hidden')) document.querySelector('.btn-account')?.click();
        await waitFor(() => { const x = document.getElementById('modal-customer-account'); return x && !x.classList.contains('hidden'); }, 3000);
      },
      onLeave: () => ctx.closeModal('modal-customer-account'),
      title: 'El estado de cuenta de cada cliente',
      text: 'Créditos, abonos y compras en un solo lugar. Desde aquí registras un abono.' },

    { id: 'cobros', group: 'cobros', section: 'sec-receivables', target: '#sec-receivables .dash-grid',
      title: 'Cuentas por cobrar',
      text: 'Quién debe, cuánto y desde cuándo. Lo vencido aparece primero para que cobres a tiempo.' },
    { id: 'reportes', group: 'reportes', section: 'sec-reports', target: '#sec-reports .dash-grid',
      title: 'Facturas y reportes',
      text: 'Cada venta genera su factura. Filtra por período, mira la tendencia y exporta el historial.' },
    { id: 'equipo', group: 'equipo', section: 'sec-employees', target: '#sec-employees .employees-grid',
      title: 'Tu equipo y sus permisos',
      text: 'Invita empleados con un link y decide qué puede ver cada uno.' },
    { id: 'ajustes', group: 'ajustes', section: 'sec-settings', target: '#settings-main-list',
      title: 'Configuración',
      text: 'Aquí ajustas los datos de tu negocio, impuestos, métodos de pago y la apariencia.' }
  ];
}

// ---------- Utilidades de medida ----------
function unionRect(selectors) {
  const els = (Array.isArray(selectors) ? selectors : [selectors]).flatMap((s) => [...document.querySelectorAll(s)]).filter((e) => e.getClientRects().length);
  if (!els.length) return null;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  els.forEach((e) => { const x = e.getBoundingClientRect(); l = Math.min(l, x.left); t = Math.min(t, x.top); r = Math.max(r, x.right); b = Math.max(b, x.bottom); });
  return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t, els };
}

function overlay(html, cls) {
  const el = document.createElement('div');
  el.className = cls;
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

// ---------- Bienvenida ----------
export function showWelcome({ resume = false, step = 0, total = 0, onStart, onRestart, onExplore, exploreLabel = 'Explorar por mi cuenta' }) {
  const el = overlay(`
    <div class="tw-bg" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="tw-card" role="dialog" aria-modal="true" aria-labelledby="tw-title">
      <img class="tw-logo" src="assets/logo-horizontal.png" alt="AINova Management" width="168" height="69" style="--i:0">
      <h1 id="tw-title" style="--i:1">Bienvenido a AINova Management.</h1>
      <p class="tw-text" style="--i:2">Descubre cómo administrar y organizar tu negocio desde un solo lugar. En unos minutos conocerás las herramientas principales del sistema.</p>
      <ul class="tw-chips" style="--i:3">
        <li>${ico('clock', 'i-sm')}3-5 minutos</li>
        <li>${ico('sparkle', 'i-sm')}Datos de ejemplo</li>
        <li>${ico('shield', 'i-sm')}No guarda nada en tu negocio</li>
      </ul>
      <div class="tw-actions" style="--i:4">
        <button type="button" class="btn btn-primary btn-lg" data-act="start">${resume ? `Continuar recorrido (paso ${step + 1} de ${total})` : 'Comenzar recorrido'}</button>
        <button type="button" class="btn btn-lg" data-act="explore">${escapeHtml(exploreLabel)}</button>
      </div>
      ${resume ? '<button type="button" class="link-btn tw-restart" data-act="restart" style="--i:5">Empezar de nuevo</button>' : ''}
    </div>`, 'tour-welcome');
  const close = () => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), reduced() ? 0 : 320); };
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    close();
    if (act === 'start') onStart?.();
    if (act === 'restart') (onRestart || onStart)?.();
    if (act === 'explore') onExplore?.();
  });
  requestAnimationFrame(() => el.querySelector('[data-act=start]')?.focus({ preventScroll: true }));
  return { close };
}

// ---------- Finalización ----------
export function showComplete({ groups, onConfigure, onReplay, configureLabel = 'Configurar mi negocio' }) {
  const el = overlay(`
    <div class="tw-bg" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="tw-card" role="dialog" aria-modal="true" aria-labelledby="tc-title">
      <div class="tc-check" style="--i:0" aria-hidden="true"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"/><path d="M15 27l8 8 15-17"/></svg></div>
      <h1 id="tc-title" style="--i:1">¡Ya conoces AINova Management!</h1>
      <p class="tw-text" style="--i:2">Has completado el recorrido inicial. Ahora puedes preparar tu propio espacio de trabajo y adaptar el sistema a las necesidades de tu negocio.</p>
      <ul class="tc-groups" style="--i:3">${groups.map((g, i) => `<li style="--d:${i * 70}ms">${ico('check', 'i-sm')}${escapeHtml(GROUPS[g] || g)}</li>`).join('')}</ul>
      <div class="tw-actions" style="--i:4">
        <button type="button" class="btn btn-primary btn-lg" data-act="configure">${escapeHtml(configureLabel)}</button>
      </div>
      <p class="tc-status" role="status" aria-live="polite"></p>
      <button type="button" class="link-btn tw-restart" data-act="replay" style="--i:5">Volver a ver el recorrido</button>
    </div>`, 'tour-welcome tour-complete');
  const btn = el.querySelector('[data-act=configure]');
  const status = el.querySelector('.tc-status');
  let working = false;
  const run = async () => {
    if (working) return;
    working = true;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>Preparando tu espacio de trabajo…`;
    status.textContent = '';
    try {
      await onConfigure?.();           // si todo sale bien, la app navega y esta pantalla desaparece
    } catch (e) {
      console.error('Finalizar tutorial:', e);
      working = false;
      btn.disabled = false;
      btn.textContent = 'Reintentar';
      status.textContent = 'No se pudo preparar tu espacio: ' + (e?.message || 'error desconocido') + '.';
    }
  };
  btn.addEventListener('click', run);
  el.querySelector('[data-act=replay]').addEventListener('click', () => { el.remove(); onReplay?.(); });
  requestAnimationFrame(() => btn.focus({ preventScroll: true }));
  return { close: () => el.remove() };
}

// ---------- Recorrido ----------
export function createTour(ctx) {
  let steps = [];
  let idx = 0;
  let root = null, hole = null, card = null, cover = null;
  let blockers = {};
  let busy = false, active = false, current = null, raf = 0, generation = 0;
  const visitedGroups = new Set();

  const mobile = () => ctx.isMobile();

  function mount() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'tour-root';
    root.innerHTML = `
      <div class="tour-block" data-s="top"></div><div class="tour-block" data-s="bottom"></div>
      <div class="tour-block" data-s="left"></div><div class="tour-block" data-s="right"></div>
      <div class="tour-block tour-cover" hidden></div>
      <div class="tour-hole" aria-hidden="true"></div>
      <section class="tour-card" role="dialog" aria-modal="false" aria-labelledby="tour-title" tabindex="-1"></section>`;
    document.body.appendChild(root);
    hole = root.querySelector('.tour-hole');
    card = root.querySelector('.tour-card');
    cover = root.querySelector('.tour-cover');
    ['top', 'bottom', 'left', 'right'].forEach((s) => { blockers[s] = root.querySelector(`[data-s=${s}]`); });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    document.addEventListener('keydown', onKey, true);
    document.body.classList.add('tour-on');
    requestAnimationFrame(() => root.classList.add('is-in'));
  }

  function unmount() {
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule, true);
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('tour-on');
    cancelAnimationFrame(raf);
    const r = root; root = null;
    if (r) { r.classList.remove('is-in'); setTimeout(() => r.remove(), reduced() ? 0 : 260); }
  }

  function onKey(e) {
    if (!active || document.querySelector('[role=alertdialog]')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); skip(); }
    else if (e.key === 'ArrowRight' || (e.key === 'Enter' && document.activeElement?.closest('.tour-card') && !document.activeElement.matches('button'))) { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; layout(); });
  }

  // Coloca el resaltado, los bloqueadores de clics y la tarjeta según el elemento actual
  function layout() {
    if (!root || !current) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const r = unionRect(current.step.target);
    if (!r) return;
    const pad = 8;
    let l = Math.max(4, r.left - pad), t = Math.max(4, r.top - pad);
    let rr = Math.min(vw - 4, r.right + pad), bb = Math.min(vh - 4, r.bottom + pad);
    const w = Math.max(0, rr - l), h = Math.max(0, bb - t);
    hole.style.transform = `translate(${l}px, ${t}px)`;
    hole.style.width = w + 'px';
    hole.style.height = h + 'px';
    const set = (el, x, y, ww, hh) => { el.style.transform = `translate(${x}px, ${y}px)`; el.style.width = Math.max(0, ww) + 'px'; el.style.height = Math.max(0, hh) + 'px'; };
    set(blockers.top, 0, 0, vw, t);
    set(blockers.bottom, 0, bb, vw, vh - bb);
    set(blockers.left, 0, t, l, h);
    set(blockers.right, rr, t, vw - rr, h);
    cover.hidden = !!current.step.interactive;
    if (!current.step.interactive) set(cover, l, t, w, h);
    placeCard({ l, t, r: rr, b: bb, w, h }, vw, vh);
  }

  function placeCard(box, vw, vh) {
    if (mobile()) {
      card.style.transform = '';
      card.classList.add('is-docked');
      const lower = (box.t + box.h / 2) > vh * 0.5;
      card.classList.toggle('dock-top', lower);
      card.classList.toggle('dock-bottom', !lower);
      return;
    }
    card.classList.remove('is-docked', 'dock-top', 'dock-bottom');
    const cw = Math.min(380, vw - 32), ch = card.offsetHeight || 260, gap = 18;
    let x, y;
    const clampX = (v) => Math.max(16, Math.min(vw - cw - 16, v));
    const clampY = (v) => Math.max(16, Math.min(vh - ch - 16, v));
    if (box.b + gap + ch <= vh - 16) { x = clampX(box.l); y = box.b + gap; }                 // debajo
    else if (box.t - gap - ch >= 16) { x = clampX(box.l); y = box.t - gap - ch; }            // encima
    else if (box.r + gap + cw <= vw - 16) { x = box.r + gap; y = clampY(box.t); }            // a la derecha
    else if (box.l - gap - cw >= 16) { x = box.l - gap - cw; y = clampY(box.t); }            // a la izquierda
    else { x = clampX(vw - cw - 24); y = clampY(vh - ch - 24); }                             // sobre el contenido
    card.style.width = cw + 'px';
    card.style.transform = `translate(${x}px, ${y}px)`;
  }

  function progressHtml() {
    const groups = [...new Set(steps.map((s) => s.group))];
    const curGroup = steps[idx].group;
    const curIdx = groups.indexOf(curGroup);
    return groups.map((g, i) => {
      const inGroup = steps.filter((s) => s.group === g);
      const pos = inGroup.indexOf(steps[idx]);
      const state = i < curIdx ? 'done' : i === curIdx ? 'cur' : 'todo';
      const frac = state === 'done' ? 1 : state === 'cur' ? (pos + 1) / inGroup.length : 0;
      return `<i class="seg ${state}" style="--f:${frac}" title="${escapeHtml(GROUPS[g])}"></i>`;
    }).join('');
  }

  function renderCard(popGroup) {
    const s = steps[idx];
    const last = idx === steps.length - 1;
    card.innerHTML = `
      <div class="tour-card-head"><span class="tour-tag">${escapeHtml(GROUPS[s.group])}</span><span class="tour-count">${idx + 1} de ${steps.length}</span></div>
      <div class="tour-progress" aria-hidden="true">${progressHtml()}</div>
      <h3 id="tour-title">${escapeHtml(s.title)}</h3>
      <p class="tour-text">${escapeHtml(s.text)}</p>
      ${s.action ? `<div class="tour-action"><button type="button" class="btn btn-sm tour-try">${ico('bolt', 'i-sm')}${escapeHtml(s.action.label)}</button><span class="tour-result" role="status" aria-live="polite"></span></div>` : ''}
      <div class="tour-foot">
        <button type="button" class="link-btn tour-skip">Saltar tutorial</button>
        <span class="grow"></span>
        <button type="button" class="btn btn-sm tour-prev" ${idx === 0 ? 'disabled' : ''}>Anterior</button>
        <button type="button" class="btn btn-primary btn-sm tour-next">${last ? 'Finalizar' : 'Siguiente'}</button>
      </div>`;
    if (popGroup) card.querySelector('.tour-tag').classList.add('is-new');
    card.querySelector('.tour-skip').onclick = skip;
    card.querySelector('.tour-prev').onclick = prev;
    card.querySelector('.tour-next').onclick = next;
    const tryBtn = card.querySelector('.tour-try');
    if (tryBtn) tryBtn.onclick = () => runAction(tryBtn);
  }

  async function runAction(btn) {
    const s = steps[idx];
    const result = card.querySelector('.tour-result');
    if (!s.action || btn.disabled) return;
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>Ejecutando…`;
    result.className = 'tour-result';
    result.textContent = '';
    try {
      const out = await s.action.run();
      btn.innerHTML = `${ico('check', 'i-sm')}Hecho`;
      btn.classList.add('is-done');
      const msg = typeof out === 'string' ? out : s.action.done;
      if (msg) { result.textContent = msg; result.classList.add('ok'); }
      schedule();
      setTimeout(layout, 350);
    } catch (e) {
      console.error('Acción del tutorial:', e);
      btn.disabled = false;
      btn.innerHTML = `${ico('bolt', 'i-sm')}Reintentar`;
      result.textContent = e?.message || 'No se pudo completar.';
      result.classList.add('err');
    }
  }

  async function goTo(i, direction = 1) {
    if (busy) return;
    busy = true;
    const gen = ++generation;
    try {
      const leaving = current;
      if (leaving?.step.onLeave) { try { await leaving.step.onLeave(); } catch (e) { /* ignorar */ } }
      let target = i;
      // Busca el siguiente paso que se pueda mostrar (módulo o elemento ausente → se omite)
      while (target >= 0 && target < steps.length) {
        const s = steps[target];
        if (s.section !== leaving?.step.section || !leaving) {
          ctx.closeModals();
          ctx.showSection(s.section);
          await frame(); await frame();
        }
        try { await s.onEnter?.(); } catch (e) { console.warn('onEnter:', e); }
        const found = await waitFor(() => unionRect(s.target), 3000);
        if (found) break;
        console.warn('Paso omitido (no hay elemento):', s.id);
        steps.splice(target, 1);
        if (direction < 0) target = Math.max(0, target - 1);
        if (!steps.length) throw new Error('No hay pasos disponibles.');
      }
      if (target >= steps.length) { busy = false; return finish(); }
      if (target < 0) target = 0;
      const popGroup = leaving && steps[target].group !== leaving.step.group && direction > 0;
      if (popGroup) visitedGroups.add(leaving.step.group);
      idx = target;
      current = { step: steps[idx] };
      visitedGroups.add(steps[idx].group);
      renderCard(popGroup);
      await scrollToTarget(steps[idx]);
      layout();
      root.classList.add('has-step');
      card.classList.remove('is-swapping');
      void card.offsetWidth;
      card.classList.add('is-swapping');
      ctx.onStep?.(idx, steps[idx], steps.length);
      setTimeout(() => { if (gen === generation) { layout(); card.querySelector('.tour-next')?.focus({ preventScroll: true }); } }, reduced() ? 0 : 320);
    } catch (e) {
      console.error('Tutorial:', e);
      showError(e);
    } finally {
      busy = false;
    }
  }

  async function scrollToTarget(step) {
    const r = unionRect(step.target);
    if (!r) return;
    const vh = window.innerHeight;
    const inView = r.top >= 70 && r.bottom <= vh - 20;
    if (inView) return;
    const el = r.els[0];
    const fixed = (e) => { for (let n = e; n && n !== document.body; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') return true; return false; };
    if (fixed(el)) return;
    const wantTop = mobile() ? 96 : Math.max(96, (vh - Math.min(r.height, vh * 0.6)) / 3);
    window.scrollBy({ top: r.top - wantTop, behavior: reduced() ? 'auto' : 'smooth' });
    // espera a que el desplazamiento termine de verdad (posición estable)
    let last = -1, stable = 0;
    await waitFor(() => { const y = window.scrollY; stable = y === last ? stable + 1 : 0; last = y; return stable >= 4; }, 1200);
  }

  function showError(e) {
    if (!card) return;
    card.innerHTML = `<h3 id="tour-title">Algo no salió como esperábamos</h3><p class="tour-text">${escapeHtml(e?.message || 'Error inesperado')}. Puedes reintentar o salir del tutorial.</p>
      <div class="tour-foot"><button type="button" class="link-btn tour-skip">Salir</button><span class="grow"></span><button type="button" class="btn btn-primary btn-sm tour-retry">Reintentar</button></div>`;
    card.querySelector('.tour-skip').onclick = skip;
    card.querySelector('.tour-retry').onclick = () => goTo(idx, 1);
    card.classList.add('dock-bottom', 'is-docked');
  }

  async function next() { if (!busy) { if (idx >= steps.length - 1) return finish(); return goTo(idx + 1, 1); } }
  async function prev() { if (!busy && idx > 0) return goTo(idx - 1, -1); }

  async function finish() {
    if (current?.step.onLeave) { try { await current.step.onLeave(); } catch (e) { /* ignorar */ } }
    ctx.closeModals();
    const groups = [...new Set(steps.map((s) => s.group))];
    active = false; current = null;
    unmount();
    ctx.onFinish?.(groups);
  }

  async function skip() {
    if (busy) return;
    const ok = await confirmDialog({ title: '¿Saltar el tutorial?', message: 'No pasa nada: podrás volver a verlo cuando quieras desde «Ayuda y tutorial».', confirmLabel: 'Saltar tutorial', cancelLabel: 'Seguir' });
    if (!ok) return;
    if (current?.step.onLeave) { try { await current.step.onLeave(); } catch (e) { /* ignorar */ } }
    ctx.closeModals();
    active = false; current = null;
    unmount();
    ctx.onSkip?.();
  }

  return {
    get active() { return active; },
    /** Pasos disponibles para esta persona (según sus permisos y módulos). */
    availableSteps() { return buildSteps(ctx).filter((s) => ctx.sectionAllowed(s.section)); },
    async start(from = 0) {
      steps = buildSteps(ctx).filter((s) => ctx.sectionAllowed(s.section));
      if (!steps.length) throw new Error('No hay secciones disponibles para mostrar.');
      active = true; current = null; idx = 0;
      visitedGroups.clear();
      mount();
      await goTo(Math.max(0, Math.min(from, steps.length - 1)), 1);
    },
    stop() { if (!active) return; active = false; current = null; unmount(); }
  };
}
