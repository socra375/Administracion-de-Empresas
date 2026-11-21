// =====================================================================
// AINova · utilidades de interfaz compartidas por toda la app
// Íconos, formato de dinero/fechas, avisos (toasts), confirmaciones y ventanas.
// Sin dependencias del negocio: lo único que recibe de fuera es la moneda (setCurrency).
// =====================================================================

// ---------- Seguridad ----------
// Escapa texto antes de insertarlo en HTML vía innerHTML/template strings. Nombres de
// clientes, productos, empleados, etc. vienen de formularios del propio usuario (o de
// otro miembro del negocio) y se guardan tal cual en la base de datos: sin esto, un nombre
// como <img src=x onerror=alert(1)> se ejecutaría al mostrarse en cualquier tabla o factura.
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// ---------- Iconos ----------
export function ico(name, cls = '') {
  return `<svg class="i ${cls}" aria-hidden="true"><use href="assets/icons.svg#i-${name}"/></svg>`;
}

// ---------- Dinero y fechas ----------
let currency = '$';
export function setCurrency(symbol) { currency = symbol || '$'; }
export function getCurrency() { return currency; }
export function fmtNum(n) {
  return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function money(n) { return currency + fmtNum(n); }

// ---------- Región: formato de fecha y zona horaria ----------
// 'auto' usa el formato del dispositivo; 'DMY' = 31/12/2026, 'MDY' = 12/31/2026, 'YMD' = 2026-12-31.
let regional = { dateFormat: 'auto', timeZone: null };
export function setRegional(r) {
  const tz = r?.timeZone || null;
  let valid = null;
  if (tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); valid = tz; } catch (e) { valid = null; } }
  regional = { dateFormat: ['DMY', 'MDY', 'YMD'].includes(r?.dateFormat) ? r.dateFormat : 'auto', timeZone: valid };
}
function joinDate(y, m, d) {
  if (regional.dateFormat === 'MDY') return `${m}/${d}/${y}`;
  if (regional.dateFormat === 'YMD') return `${y}-${m}-${d}`;
  return `${d}/${m}/${y}`;
}
function dateParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: regional.timeZone || undefined }).formatToParts(date);
  const get = (t) => parts.find((x) => x.type === t).value;
  return [get('year'), get('month'), get('day')];
}
export function fmtDate(value) {
  const d = new Date(value);
  if (isNaN(d)) return '—';
  if (regional.dateFormat === 'auto' && !regional.timeZone) return d.toLocaleDateString();
  const [y, m, day] = dateParts(d);
  return regional.dateFormat === 'auto' ? new Intl.DateTimeFormat(undefined, { timeZone: regional.timeZone }).format(d) : joinDate(y, m, day);
}
export function fmtDateTime(value) {
  const d = new Date(value);
  if (isNaN(d)) return '—';
  if (regional.dateFormat === 'auto' && !regional.timeZone) return d.toLocaleString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: regional.timeZone || undefined });
  return `${fmtDate(d)} ${time}`;
}
/** Fecha "YYYY-MM-DD" sin hora (no se mueve de día por zona horaria). */
export function fmtYmd(str) {
  if (!str) return '—';
  const [y, m, d] = String(str).split('-');
  if (regional.dateFormat === 'auto') return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString();
  return joinDate(y, m, d);
}

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function timeAgo(date) {
  const d = new Date(date);
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const days = Math.floor(h / 24);
  if (days < 7) return `hace ${days} d`;
  return d.toLocaleDateString();
}

// ---------- Avisos (reemplazan a alert()) ----------
export function toast(message, type = 'ok') {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const icon = { ok: 'check-circle', err: 'alert', warn: 'alert', info: 'info' }[type] || 'info';
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'ok' ? '' : ' ' + type);
  el.setAttribute('role', type === 'err' ? 'alert' : 'status');
  el.innerHTML = `${ico(icon)}<span></span><button type="button" aria-label="Cerrar aviso">${ico('x', 'i-sm')}</button>`;
  el.querySelector('span').textContent = message;
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 220); };
  el.querySelector('button').onclick = close;
  region.appendChild(el);
  while (region.children.length > 4) region.firstChild.remove();
  const ms = Math.min(12000, 3800 + message.length * 45) + (type === 'err' ? 2500 : 0);
  setTimeout(close, ms);
}
toast.ok = (m) => toast(m, 'ok');
toast.err = (m) => toast(m, 'err');
toast.warn = (m) => toast(m, 'warn');
toast.info = (m) => toast(m, 'info');

// ---------- Ventanas ----------
// Las ventanas que se pueden cerrar con Esc / clic fuera / el botón de cerrar.
export const closableModalIds = [
  'modal-invoice', 'modal-customer-account', 'modal-inventory-history', 'modal-password',
  'modal-product', 'modal-customer-new', 'more-sheet'
];
const openers = new Map();

function syncScrollLock() {
  const anyOpen = document.querySelector('.modal-root:not(.hidden)');
  document.body.style.overflow = anyOpen ? 'hidden' : '';
}

export function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  openers.set(id, document.activeElement);
  el.classList.remove('hidden');
  syncScrollLock();
  const first = el.querySelector('input:not([type=hidden]):not([readonly]), select, textarea');
  const target = first || el.querySelector('[data-close-modal], button');
  // Un frame después: el elemento acaba de dejar de estar oculto.
  requestAnimationFrame(() => { try { target?.focus({ preventScroll: true }); } catch (e) { /* ignorar */ } });
}

export function closeModal(id) {
  const el = document.getElementById(id);
  if (!el || el.classList.contains('hidden')) return;
  el.classList.add('hidden');
  syncScrollLock();
  const prev = openers.get(id);
  openers.delete(id);
  try { if (prev && document.contains(prev)) prev.focus({ preventScroll: true }); } catch (e) { /* ignorar */ }
}

export function closeAllModals() {
  closableModalIds.forEach(closeModal);
}

document.addEventListener('click', (e) => {
  const closer = e.target.closest?.('[data-close-modal]');
  if (!closer) return;
  const root = closer.closest('.modal-root');
  if (root?.id) closeModal(root.id);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // La ventana de más arriba es la última abierta en el documento (así se apilan: una factura
  // abierta desde el perfil de un cliente queda encima del perfil).
  const open = [...document.querySelectorAll('.modal-root:not(.hidden)')].filter((el) => closableModalIds.includes(el.id));
  if (open.length) closeModal(open[open.length - 1].id);
});

// ---------- Confirmación (reemplaza a confirm()) ----------
export function confirmDialog({ title = '¿Seguro?', message = '', confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false } = {}) {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'modal-root';
    root.style.zIndex = '720'; // por encima del tutorial (640) y de la bienvenida (700)
    root.innerHTML = `
      <div class="modal-scrim"></div>
      <div class="modal-card narrow" role="alertdialog" aria-modal="true" aria-labelledby="cf-title">
        <div class="modal-head"><div><h3 id="cf-title"></h3></div></div>
        <div class="modal-body"><p class="cf-msg" style="color:var(--text-2)"></p></div>
        <div class="modal-foot">
          <button type="button" class="btn" data-act="cancel"></button>
          <button type="button" class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-act="ok"></button>
        </div>
      </div>`;
    root.querySelector('#cf-title').textContent = title;
    root.querySelector('.cf-msg').textContent = message;
    root.querySelector('[data-act=cancel]').textContent = cancelLabel;
    root.querySelector('[data-act=ok]').textContent = confirmLabel;
    const prev = document.activeElement;
    const finish = (value) => {
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      syncScrollLock();
      try { prev?.focus?.({ preventScroll: true }); } catch (e) { /* ignorar */ }
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    };
    root.querySelector('[data-act=cancel]').onclick = () => finish(false);
    root.querySelector('[data-act=ok]').onclick = () => finish(true);
    root.querySelector('.modal-scrim').onclick = () => finish(false);
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    document.body.style.overflow = 'hidden';
    root.querySelector('[data-act=ok]').focus();
  });
}

// ---------- Estados vacíos y de carga ----------
export function emptyState({ icon = 'info', title = '', text = '', actionHtml = '' } = {}) {
  return `${ico(icon)}<h4>${escapeHtml(title)}</h4>${text ? `<p>${escapeHtml(text)}</p>` : ''}${actionHtml}`;
}

export function skeletonRows(cols, rows = 4) {
  const cell = '<td><span class="skel" style="height:14px;width:' + '70%' + '"></span></td>';
  return Array.from({ length: rows }, () => `<tr>${cell.repeat(cols)}</tr>`).join('');
}

// ---------- Estados de botón ----------
export async function withBusy(button, busyLabel, fn) {
  if (!button) return fn();
  const original = button.innerHTML;
  button.disabled = true;
  if (busyLabel) button.textContent = busyLabel;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

// ---------- Colores para gráficos (leen los tokens del tema activo) ----------
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
export function chartPalette() {
  return {
    c1: cssVar('--chart-1'), c2: cssVar('--chart-2'), c3: cssVar('--chart-3'),
    c4: cssVar('--chart-4'), c5: cssVar('--chart-5'),
    grid: cssVar('--chart-grid'), text: cssVar('--chart-text'),
    surface: cssVar('--surface'), font: cssVar('--font')
  };
}
