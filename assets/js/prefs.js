// =====================================================================
// AINova · preferencias del negocio
// Catálogos (actividad, países, monedas, módulos), campos de formulario compartidos por el
// asistente inicial y por Configuración, y aplicación de la marca (colores) con contraste
// garantizado. Lo que se guarda va en businesses.settings (jsonb) y businesses.currency_symbol.
// =====================================================================
import { escapeHtml, ico } from './ui.js';

export const ACTIVITIES = [
  ['comercio', 'Tienda o colmado'], ['restaurante', 'Restaurante o cafetería'], ['ropa', 'Ropa y accesorios'],
  ['belleza', 'Belleza y cuidado personal'], ['ferreteria', 'Ferretería y materiales'], ['farmacia', 'Farmacia o salud'],
  ['servicios', 'Servicios'], ['distribucion', 'Distribución o mayorista'], ['otro', 'Otra actividad']
];

export const CURRENCIES = [
  ['$', '$ · Dólar / Peso'], ['RD$', 'RD$ · Peso dominicano'], ['€', '€ · Euro'], ['MXN$', 'MXN$ · Peso mexicano'],
  ['COL$', 'COL$ · Peso colombiano'], ['ARS$', 'ARS$ · Peso argentino'], ['CLP$', 'CLP$ · Peso chileno'], ['S/', 'S/ · Sol peruano'],
  ['Q', 'Q · Quetzal'], ['L', 'L · Lempira'], ['₡', '₡ · Colón costarricense'], ['B/.', 'B/. · Balboa']
];

// Al elegir país se sugieren moneda, zona horaria y formato de fecha (se pueden cambiar).
export const COUNTRIES = [
  ['DO', 'República Dominicana', 'RD$', 'America/Santo_Domingo', 'DMY'], ['MX', 'México', 'MXN$', 'America/Mexico_City', 'DMY'],
  ['CO', 'Colombia', 'COL$', 'America/Bogota', 'DMY'], ['AR', 'Argentina', 'ARS$', 'America/Argentina/Buenos_Aires', 'DMY'],
  ['CL', 'Chile', 'CLP$', 'America/Santiago', 'DMY'], ['PE', 'Perú', 'S/', 'America/Lima', 'DMY'],
  ['EC', 'Ecuador', '$', 'America/Guayaquil', 'DMY'], ['GT', 'Guatemala', 'Q', 'America/Guatemala', 'DMY'],
  ['HN', 'Honduras', 'L', 'America/Tegucigalpa', 'DMY'], ['SV', 'El Salvador', '$', 'America/El_Salvador', 'DMY'],
  ['CR', 'Costa Rica', '₡', 'America/Costa_Rica', 'DMY'], ['PA', 'Panamá', 'B/.', 'America/Panama', 'DMY'],
  ['PR', 'Puerto Rico', '$', 'America/Puerto_Rico', 'MDY'], ['US', 'Estados Unidos', '$', 'America/New_York', 'MDY'],
  ['ES', 'España', '€', 'Europe/Madrid', 'DMY'], ['OT', 'Otro país', '$', '', 'DMY']
];

export const TIMEZONES = [
  ['America/Santo_Domingo', 'Santo Domingo (GMT-4)'], ['America/Puerto_Rico', 'Puerto Rico (GMT-4)'], ['America/New_York', 'Nueva York (GMT-5/-4)'],
  ['America/Mexico_City', 'Ciudad de México (GMT-6)'], ['America/Guatemala', 'Guatemala (GMT-6)'], ['America/El_Salvador', 'El Salvador (GMT-6)'],
  ['America/Tegucigalpa', 'Tegucigalpa (GMT-6)'], ['America/Costa_Rica', 'Costa Rica (GMT-6)'], ['America/Panama', 'Panamá (GMT-5)'],
  ['America/Bogota', 'Bogotá (GMT-5)'], ['America/Lima', 'Lima (GMT-5)'], ['America/Guayaquil', 'Guayaquil (GMT-5)'],
  ['America/Santiago', 'Santiago (GMT-4/-3)'], ['America/Argentina/Buenos_Aires', 'Buenos Aires (GMT-3)'], ['Europe/Madrid', 'Madrid (GMT+1/+2)'], ['UTC', 'UTC']
];

export const DATE_FORMATS = [['DMY', 'Día/Mes/Año · 31/12/2026'], ['MDY', 'Mes/Día/Año · 12/31/2026'], ['YMD', 'Año-Mes-Día · 2026-12-31']];

// Módulos que se pueden activar o desactivar (solo los que existen de verdad). El panel y la
// configuración siempre están disponibles.
export const MODULES = [
  ['sales', 'Punto de venta', 'Registrar ventas y cobrar.', 'cart'],
  ['inventory', 'Inventario', 'Productos, existencias y movimientos.', 'package'],
  ['customers', 'Clientes', 'Fichas y estados de cuenta.', 'users'],
  ['receivables', 'Cuentas por cobrar', 'Créditos, abonos y vencimientos.', 'wallet'],
  ['reports', 'Facturas y reportes', 'Historial, gráficos y exportación.', 'file'],
  ['employees', 'Equipo y permisos', 'Empleados con su propia cuenta (negocios de grupo).', 'team']
];

export const BRAND_PRIMARY = [['#047857', 'Esmeralda'], ['#0F766E', 'Verde azulado'], ['#1D4ED8', 'Azul'], ['#4338CA', 'Índigo'], ['#BE185D', 'Rosa'], ['#C2410C', 'Naranja'], ['#B91C1C', 'Rojo'], ['#374151', 'Grafito']];
export const BRAND_ACCENT = [['#0E7C86', 'Turquesa'], ['#0369A1', 'Azul cielo'], ['#B45309', 'Ámbar'], ['#E8602C', 'Coral'], ['#6D28D9', 'Violeta'], ['#15803D', 'Verde']];
export const DEFAULT_PRIMARY = '#047857';
export const DEFAULT_ACCENT = '#0E7C86';

// ---------- Color: contraste y variantes ----------
const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
export const isHex = (v) => /^#[0-9a-fA-F]{6}$/.test(String(v || ''));
const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => '#' + rgb.map((v) => clamp(v).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const x = toRgb(a), y = toRgb(b); return toHex(x.map((v, i) => v * (1 - t) + y[i] * t)); };
function lum(hex) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = toRgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** Mueve `hex` hacia `toward` hasta lograr `min` de contraste contra `against`. */
function tune(hex, against, toward, min = 4.5) {
  let c = hex, i = 0;
  while (contrast(c, against) < min && i++ < 30) c = mix(c, toward, 0.08);
  return c;
}
const rgba = (hex, a) => `rgba(${toRgb(hex).join(', ')}, ${a})`;
const LIGHT_SURFACE = '#FFFFFF', DARK_SURFACE = '#171C19';

/** CSS con las variables de marca para ambos temas; garantiza ≥4.5:1 en botones y textos. */
export function buildBrandCss(primary, accent) {
  const p = isHex(primary) ? primary : DEFAULT_PRIMARY;
  const a = isHex(accent) ? accent : DEFAULT_ACCENT;
  // tema claro: botón relleno con texto blanco
  const pL = tune(p, '#FFFFFF', '#000000');
  const pLSoft = mix(pL, '#FFFFFF', 0.88);
  const pLInk = tune(pL, pLSoft, '#000000');
  const aL = tune(a, '#FFFFFF', '#000000');
  const aLSoft = mix(aL, '#FFFFFF', 0.86);
  const aLInk = tune(aL, aLSoft, '#000000');
  // tema oscuro: botón claro con texto oscuro
  const pD = tune(p, DARK_SURFACE, '#FFFFFF');
  const fgD = contrast(pD, '#04261A') >= 4.5 ? '#04261A' : '#000000';
  const pDSoftBase = mix(DARK_SURFACE, pD, 0.15);
  const pDInk = tune(pD, pDSoftBase, '#FFFFFF');
  const aD = tune(a, DARK_SURFACE, '#FFFFFF');
  const aDSoftBase = mix(DARK_SURFACE, aD, 0.15);
  const aDInk = tune(aD, aDSoftBase, '#FFFFFF');
  return `:root{--primary:${pL};--primary-hover:${mix(pL, '#000000', 0.18)};--primary-fg:#FFFFFF;--primary-soft:${pLSoft};--primary-ink:${pLInk};` +
    `--accent:${aL};--accent-soft:${aLSoft};--accent-ink:${aLInk};--chart-1:${pL};--chart-2:${aL};--ring:0 0 0 3px ${rgba(pL, 0.3)}}` +
    `:root[data-theme="dark"]{--primary:${pD};--primary-hover:${mix(pD, '#FFFFFF', 0.18)};--primary-fg:${fgD};--primary-soft:${rgba(pD, 0.15)};--primary-ink:${pDInk};` +
    `--accent:${aD};--accent-soft:${rgba(aD, 0.15)};--accent-ink:${aDInk};--chart-1:${pD};--chart-2:${aD};--ring:0 0 0 3px ${rgba(pD, 0.38)}}`;
}

/** Aplica (o quita, si es la marca por defecto) los colores del negocio. */
export function applyBrand(brand) {
  let el = document.getElementById('brand-style');
  const custom = brand && ((isHex(brand.primary) && brand.primary.toLowerCase() !== DEFAULT_PRIMARY) || (isHex(brand.accent) && brand.accent.toLowerCase() !== DEFAULT_ACCENT));
  if (!custom) { el?.remove(); return; }
  if (!el) { el = document.createElement('style'); el.id = 'brand-style'; document.head.appendChild(el); }
  el.textContent = buildBrandCss(brand.primary, brand.accent);
}

// ---------- Módulos activos ----------
export function moduleEnabled(settings, key) {
  const list = settings?.modules;
  return !Array.isArray(list) || list.includes(key);
}
export function activityLabel(key) { return (ACTIVITIES.find((a) => a[0] === key) || [])[1] || ''; }

// ---------- Campos de formulario (compartidos) ----------
const opt = (value, label, selected) => `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
const swatches = (prefix, kind, list, current) => list.map(([c, name]) =>
  `<button type="button" class="swatch${c.toLowerCase() === String(current).toLowerCase() ? ' is-active' : ''}" data-swatch="${kind}" data-color="${c}" style="--sw:${c}" aria-label="${escapeHtml(name)}" title="${escapeHtml(name)}">${ico('check', 'i-sm')}</button>`).join('');

export function generalFields(p, v, { withName = false } = {}) {
  return `${withName ? `<div class="field"><label for="${p}name">Nombre del negocio</label><input type="text" id="${p}name" maxlength="100" placeholder="Ej: Mi Colmado" autocomplete="organization" value="${escapeHtml(v.name || '')}"><p class="field-error" data-err="${p}name"></p></div>` : ''}
  <div class="field"><label for="${p}trade">Nombre comercial <span class="muted">(si es diferente)</span></label><input type="text" id="${p}trade" maxlength="100" placeholder="Cómo te conocen tus clientes" value="${escapeHtml(v.settings?.trade_name || '')}"></div>
  <div class="field"><label for="${p}activity">Tipo de actividad</label><select id="${p}activity">${opt('', 'Selecciona…', !v.settings?.activity)}${ACTIVITIES.map(([k, l]) => opt(k, l, v.settings?.activity === k)).join('')}</select></div>
  <div class="field"><label for="${p}desc">Descripción breve <span class="muted">(opcional)</span></label><textarea id="${p}desc" rows="2" maxlength="240" placeholder="Qué vendes o qué servicio ofreces">${escapeHtml(v.settings?.description || '')}</textarea></div>`;
}

export function brandFields(p, v) {
  const primary = v.settings?.brand?.primary || DEFAULT_PRIMARY;
  const accent = v.settings?.brand?.accent || DEFAULT_ACCENT;
  return `<div class="field"><span class="label">Color principal</span>
    <div class="swatches" id="${p}primary-sw" data-kind="primary">${swatches(p, 'primary', BRAND_PRIMARY, primary)}<label class="swatch custom" title="Elegir otro color"><input type="color" id="${p}primary" value="${primary}" aria-label="Color principal personalizado"><span>${ico('plus', 'i-sm')}</span></label></div></div>
  <div class="field"><span class="label">Color secundario</span>
    <div class="swatches" id="${p}accent-sw" data-kind="accent">${swatches(p, 'accent', BRAND_ACCENT, accent)}<label class="swatch custom" title="Elegir otro color"><input type="color" id="${p}accent" value="${accent}" aria-label="Color secundario personalizado"><span>${ico('plus', 'i-sm')}</span></label></div></div>
  <div class="brand-preview" aria-label="Vista previa de los colores"><button type="button" class="btn btn-primary btn-sm" tabindex="-1">Botón principal</button><span class="badge badge-ok">Estado</span><span class="badge badge-info">Secundario</span><span class="kpi-icon">${ico('trend-up')}</span><span class="kpi-icon is-teal">${ico('wallet')}</span></div>
  <p class="hint">Se ajustan solos para que el texto siempre se lea bien, en tema claro y oscuro.</p>`;
}

export function regionalFields(p, v) {
  const s = v.settings || {};
  const country = s.country || '';
  const cur = v.currency_symbol || '$';
  const curList = CURRENCIES.some(([c]) => c === cur) ? CURRENCIES : [[cur, cur], ...CURRENCIES];
  return `<div class="field"><label for="${p}country">País</label><select id="${p}country">${opt('', 'Selecciona…', !country)}${COUNTRIES.map(([c, n]) => opt(c, n, country === c)).join('')}</select><p class="field-error" data-err="${p}country"></p></div>
  <div class="form-grid">
    ${p === 'w-' ? `<div class="field"><label for="${p}currency">Moneda principal</label><select id="${p}currency">${curList.map(([c, l]) => opt(c, l, cur === c)).join('')}</select></div>` : ''}
    <div class="field"><label for="${p}datefmt">Formato de fecha</label><select id="${p}datefmt">${DATE_FORMATS.map(([k, l]) => opt(k, l, (s.date_format || 'DMY') === k)).join('')}</select></div>
    <div class="field"><label for="${p}tz">Zona horaria</label><select id="${p}tz">${opt('', 'Zona horaria de mi dispositivo', !s.timezone)}${TIMEZONES.map(([k, l]) => opt(k, l, s.timezone === k)).join('')}</select></div>
  </div>`;
}

export function moduleFields(p, v, { group = false } = {}) {
  return `<div class="module-pick">${MODULES.filter(([k]) => k !== 'employees' || group).map(([k, name, desc, icon]) =>
    `<label class="module-opt"><input type="checkbox" data-module="${k}" ${moduleEnabled(v.settings, k) ? 'checked' : ''}><span class="module-card"><span class="kpi-icon">${ico(icon)}</span><span><b>${escapeHtml(name)}</b><small>${escapeHtml(desc)}</small></span><span class="module-check">${ico('check', 'i-sm')}</span></span></label>`).join('')}</div>
  <p class="hint">El panel y la configuración siempre están. Puedes cambiar esto cuando quieras; no se borra ningún dato.</p>`;
}

/** Lee los valores de los campos renderizados con el prefijo `p` dentro de `root`. */
export function readPrefs(root, p) {
  const q = (id) => root.querySelector('#' + p + id);
  const val = (id) => (q(id)?.value || '').trim();
  const modules = [...root.querySelectorAll('[data-module]')].filter((c) => c.checked).map((c) => c.dataset.module);
  const out = {};
  if (q('trade')) out.trade_name = val('trade');
  if (q('activity')) out.activity = val('activity');
  if (q('desc')) out.description = val('desc');
  if (q('primary')) out.brand = { primary: val('primary'), accent: val('accent') };
  if (q('country')) { out.country = val('country'); out.date_format = val('datefmt'); out.timezone = val('tz'); }
  if (root.querySelector('[data-module]')) out.modules = modules;
  return out;
}

/** Cableado de los selectores de color: sincroniza swatch ↔ input, vista previa y callback. */
export function wireBrandFields(root, p, onChange) {
  const apply = (kind, color) => {
    const input = root.querySelector('#' + p + kind);
    if (input) input.value = color;
    root.querySelectorAll(`[data-swatch="${kind}"]`).forEach((b) => b.classList.toggle('is-active', b.dataset.color.toLowerCase() === color.toLowerCase()));
    onChange?.();
  };
  root.querySelectorAll('[data-swatch]').forEach((b) => b.addEventListener('click', () => apply(b.dataset.swatch, b.dataset.color)));
  ['primary', 'accent'].forEach((kind) => root.querySelector('#' + p + kind)?.addEventListener('input', (e) => apply(kind, e.target.value)));
}

/** Al elegir un país sugiere moneda, zona horaria y formato de fecha. */
export function wireCountry(root, p) {
  root.querySelector('#' + p + 'country')?.addEventListener('change', (e) => {
    const c = COUNTRIES.find((x) => x[0] === e.target.value);
    if (!c) return;
    const set = (id, v) => { const el = root.querySelector('#' + p + id); if (el && [...el.options].some((o) => o.value === v)) el.value = v; };
    set('currency', c[2]); set('tz', c[3]); set('datefmt', c[4]);
  });
}
