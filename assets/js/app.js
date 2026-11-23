// =====================================================================
// AINova Management · lógica de la aplicación
//
// Estructura:
//   0. Utilidades y personalización (fondo)       5. Clientes, créditos y cuentas por cobrar
//   1. Neon: autenticación y base de datos        6. Punto de venta
//   2. Estado global                              7. Equipo (empleados e invitaciones)
//   3. Navegación, permisos y configuración       8. Dashboard, actividad y ajustes
//   4. Autenticación, roles y registro            9. Facturas, inventario y reportes
//
// El tema (claro/oscuro/automático) lo gestiona assets/js/theme.js; las utilidades visuales
// (íconos, avisos, ventanas, formato) viven en ui.js.
// =====================================================================
import {
  escapeHtml, ico, setCurrency, setRegional, fmtDate, fmtDateTime, fmtYmd, money, fmtNum, initials, timeAgo,
  toast, openModal, closeModal, closeAllModals, confirmDialog,
  emptyState, skeletonRows, withBusy, chartPalette
} from './ui.js';
import { createDemoBackend, DEMO_BUSINESS_ID, DEMO_USER_ID, DEMO_EMAIL } from './demo.js';
import { createTour, showWelcome, showComplete, tourState } from './tour.js';
import {
  applyBrand, moduleEnabled, generalFields, brandFields, regionalFields, moduleFields,
  readPrefs, wireBrandFields, wireCountry, CURRENCIES, MODULES
} from './prefs.js';

// -------------------------------------------------------------
// 0. PERSONALIZACIÓN: fondo de pantalla (preferencia por dispositivo, en localStorage).
// El tema lo aplica theme.js antes de pintar; aquí solo se restaura el fondo.
// -------------------------------------------------------------
const BG_STORAGE_KEY = 'pyme_custom_bg';
const SIDEBAR_KEY = 'pyme_sidebar';
const PENDING_INVITE_KEY = 'pyme_pending_invite';
// Marca de que en este dispositivo hay una sesión abierta. index.html (la página de
// presentación) la lee para apartarse y llevar directo a la app. Se pone al entrar y se
// quita al cerrar sesión, así que la presentación vuelve a verse después de salir, que
// es cuando de nuevo tiene algo que decir.
const VISITED_KEY = 'pyme_visited';
// Distingue "pulsó Salir" de "abrió la app sin sesión" y de "se le caducó la sesión":
// los tres llegan al mismo sitio en onAuthStateChange, pero solo el primero vuelve a
// la presentación.
let userRequestedLogout = false;

// Dirección pública del sitio: la CARPETA, no este archivo. Los correos del servicio de
// autenticación (restablecer contraseña) y los links de invitación apuntan aquí a
// propósito: los enlaces que ya se enviaron antes de separar la presentación de la app
// también apuntan ahí, y el dominio https://socra375.github.io es de confianza en Neon
// Auth (se valida el origen, no la ruta). index.html reenvía a la página de la app
// conservando el ?query y el #hash intactos.
function siteBaseUrl() {
  return window.location.origin + window.location.pathname.replace(/[^/]*$/, '');
}

function applyCustomBackground(dataUrl) {
  if (dataUrl) {
    document.body.style.backgroundImage = `url("${dataUrl}")`;
    document.body.classList.add('has-custom-bg');
  } else {
    document.body.style.backgroundImage = '';
    document.body.classList.remove('has-custom-bg');
  }
}

try {
  applyCustomBackground(localStorage.getItem(BG_STORAGE_KEY));
} catch (e) {
  console.error('No se pudo aplicar el fondo guardado:', e);
}

// -------------------------------------------------------------
// 1. NEON: AUTENTICACIÓN Y BASE DE DATOS
// -------------------------------------------------------------
// Una sola dirección pública (servidor + base). El cliente deriva de ella la del servicio
// de autenticación y la de la API de datos. No hay claves en el navegador: la seguridad
// la ponen las reglas de la base (RLS, ver db/schema.sql) y el token de cada usuario.
const NEON_URL = "https://ep-old-credit-bc1j2pi5.c-16.us-east-1.aws.neon.tech/neondb";
// ---- Guarda de identidad para la API de datos ----
// La base trata como «anónima» cualquier petición cuya cabecera Authorization no sea un JWT válido y
// vigente. El cliente arma esa cabecera con session.token, que solo es un JWT cuando la respuesta de
// sesión trajo el JWT firmado; si no, viaja el token de sesión opaco. Al cargar, la app lanza varias
// lecturas en paralelo y alguna puede salir así: llega como anónima, no da error y devuelve una lista
// VACÍA (clientes que «desaparecen»), o rechaza una escritura por seguridad.
// Aquí, antes de enviar cada petición a la API de datos, se garantiza un JWT vigente:
//   · si la cabecera ya lleva uno, pasa tal cual (y se recuerda en memoria);
//   · si no, se usa el último JWT bueno de esta sesión;
//   · si tampoco hay, UNA sola consulta compartida a la sesión (hasta ~2 s) lo obtiene para todas.
// IMPORTANTE: esto debe instalarse ANTES de crear el cliente: el cliente guarda la función fetch que
// existe en ese momento, y una guarda instalada después no vería ninguna petición.
const DATA_API_PATH = '/rest/v1/';
const jwtClaimsOf = (t) => {
  try {
    if (typeof t !== 'string' || t.split('.').length !== 3) return null;
    return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch (e) { return null; }
};
const jwtUsable = (t, margin = 10) => { const c = jwtClaimsOf(t); return !!(c && c.role && c.exp && c.exp * 1000 > Date.now() + margin * 1000); };
window.__dataAuth = { ok: 0, cached: 0, replaced: 0, unfixed: 0, nosession: 0 };
let lastGoodJwt = null;        // último JWT vigente visto o recuperado en esta sesión
let jwtInFlight = null;        // consulta compartida a la sesión
const clearJwtCache = () => { lastGoodJwt = null; jwtInFlight = null; };
if (new URLSearchParams(window.location.search).get('demo') !== '1') {
  const nativeFetch = window.fetch.bind(window);
  // Pide la sesión. La primera vez usa la del cliente (en memoria); si su token no es un JWT vigente
  // —el cliente guarda en caché la primera respuesta de sesión y, si esa no trajo el JWT, queda el
  // token opaco para siempre—, se fuerza una consulta nueva a la red (cabecera X-Force-Fetch del
  // cliente de autenticación), que además reemplaza esa caché por la sesión buena.
  const fetchSessionJwt = () => {
    if (!jwtInFlight) {
      jwtInFlight = (async () => {
        let hadSession = false;
        const ba = realNeon.auth.getBetterAuthInstance?.();
        const betterAuth = typeof ba?.getSession === 'function' ? ba : null;
        for (let i = 0; i < 6; i++) {
          let token = null, session = null;
          if (i === 0 || !betterAuth) {
            const { data } = await realNeon.auth.getSession();
            session = data?.session; token = session?.access_token;
          } else {
            const res = await betterAuth.getSession({ fetchOptions: { headers: { 'X-Force-Fetch': '1' } } });
            session = res?.data?.session; token = session?.token;
          }
          if (i === 0 && !session) break;                       // sin sesión: no hay nada que esperar
          if (session) hadSession = true;
          if (jwtUsable(token)) { lastGoodJwt = token; return { jwt: token, hadSession: true }; }
          await new Promise((r) => setTimeout(r, 250 * i));
        }
        return { jwt: null, hadSession };
      })().finally(() => { jwtInFlight = null; });
    }
    return jwtInFlight;
  };
  window.fetch = async function guardedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
    if (!url.includes(DATA_API_PATH)) return nativeFetch(input, init);
    try {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      const current = (headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (jwtUsable(current)) { lastGoodJwt = current; window.__dataAuth.ok++; return nativeFetch(input, init); }
      let token = jwtUsable(lastGoodJwt, 30) ? lastGoodJwt : null;
      if (token) window.__dataAuth.cached++;
      else {
        const { jwt, hadSession } = await fetchSessionJwt();
        token = jwt;
        if (!token) { window.__dataAuth[hadSession ? 'unfixed' : 'nosession']++; return nativeFetch(input, init); }
        window.__dataAuth.replaced++;
      }
      headers.set('Authorization', 'Bearer ' + token);
      return nativeFetch(input instanceof Request ? new Request(input, { headers }) : input, { ...(init || {}), headers });
    } catch (e) {
      console.warn('Guarda de identidad:', e);
      return nativeFetch(input, init);   // la guarda nunca debe impedir la petición
    }
  };
}

const realNeon = window.NeonSupabase.createClient(NEON_URL);

// ---- Modo demostración (?demo=1) ----
// En la demostración TODAS las lecturas y escrituras de datos van a una base en memoria
// (assets/js/demo.js): nunca llegan a Neon. La demo vive en su propia carga de página, así que
// es imposible que se mezcle con los datos reales (al salir se recarga la página).
const pageParams = new URLSearchParams(window.location.search);
const demoMode = pageParams.get('demo') === '1';
const demoBackend = demoMode ? createDemoBackend() : null;
const demoAuth = {
  getUser: async () => ({ data: { user: { id: DEMO_USER_ID, email: DEMO_EMAIL } }, error: null }),
  getSession: async () => ({ data: { session: null }, error: null }),
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  signOut: async () => ({ error: null }),
  signInWithOAuth: async () => ({ error: { message: 'No disponible en la demostración.' } }),
  signUp: async () => ({ error: { message: 'No disponible en la demostración.' } }),
  signInWithPassword: async () => ({ error: { message: 'No disponible en la demostración.' } }),
  resetPasswordForEmail: async () => ({ error: { message: 'No disponible en la demostración.' } })
};
const neon = {
  from: (table) => (demoMode ? demoBackend : realNeon).from(table),
  rpc: (fn, args) => (demoMode ? demoBackend : realNeon).rpc(fn, args),
  removeAllChannels: () => realNeon.removeAllChannels?.(),
  auth: demoMode ? demoAuth : realNeon.auth
};

// -------------------------------------------------------------
// 2. ESTADO GLOBAL
// -------------------------------------------------------------
let currentBusinessId = null;
let currentUserRole = 'admin'; // 'admin' | 'employee'
let currentUserPermissions = {}; // permisos adicionales otorgados a un empleado (ver NAV_ITEMS)
let currentBusinessData = null;
let inventorySnapshot = [];
let salesHistory = [];
let invoicesSnapshot = [];
let customersSnapshot = [];
let creditsSnapshot = [];
let employeesSnapshot = [];
let cart = [];
let activePeriod = 'today';
let reportPeriod = 'all';
let selectedBusinessType = 'individual';
let modulesInitialized = false;
let currentSectionId = null;
const loaded = { products: false, customers: false, credits: false, invoices: false, employees: false };

const charts = { trend: null, pay: null, sales: null };
let lastDash = null; // últimos datos del dashboard, para redibujar los gráficos al cambiar de tema

function setBusiness(b) {
  currentBusinessData = b;
  setCurrency(b?.currency_symbol);
  const st = b?.settings || {};
  setRegional({ dateFormat: st.date_format, timeZone: st.timezone });
  applyBrand(demoMode ? null : st.brand);   // colores del negocio (la demo usa los de AINova)
}
const businessName = () => currentBusinessData?.settings?.trade_name || currentBusinessData?.name || 'Mi Negocio';
const isAdmin = () => currentUserRole === 'admin';
const $ = (id) => document.getElementById(id);
const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// -------------------------------------------------------------
// 3. NAVEGACIÓN, PERMISOS Y CONFIGURACIÓN
// -------------------------------------------------------------
// Una sola lista define qué secciones existen y quién las ve. Reproduce exactamente los
// permisos de antes: el admin ve todo (Equipo solo en negocios de grupo); un empleado ve
// Ventas, Inventario y Clientes, más Dashboard / Facturas si el admin se los otorgó.
const MODULE_OF = { 'sec-sales': 'sales', 'sec-inventory': 'inventory', 'sec-customers': 'customers', 'sec-receivables': 'receivables', 'sec-reports': 'reports', 'sec-employees': 'employees' };
const moduleOn = (sectionId) => !MODULE_OF[sectionId] || moduleEnabled(currentBusinessData?.settings, MODULE_OF[sectionId]);
const NAV_ITEMS_BASE = [
  { id: 'sec-dashboard',   label: 'Dashboard',          short: 'Inicio',     icon: 'dashboard', group: 'Operación',
    allowed: () => isAdmin() || !!currentUserPermissions.ver_dashboard },
  { id: 'sec-sales',       label: 'Punto de venta',     short: 'Vender',     icon: 'cart',      group: 'Operación', allowed: () => true },
  { id: 'sec-inventory',   label: 'Inventario',         short: 'Inventario', icon: 'package',   group: 'Operación', allowed: () => true },
  { id: 'sec-customers',   label: 'Clientes',           short: 'Clientes',   icon: 'users',     group: 'Clientes',  allowed: () => true },
  { id: 'sec-receivables', label: 'Cuentas por cobrar', short: 'Por cobrar', icon: 'wallet',    group: 'Clientes',  allowed: () => true },
  { id: 'sec-reports',     label: 'Facturas',           short: 'Facturas',   icon: 'file',      group: 'Negocio',
    allowed: () => isAdmin() || !!currentUserPermissions.ver_reportes },
  { id: 'sec-employees',   label: 'Equipo',             short: 'Equipo',     icon: 'team',      group: 'Negocio',
    allowed: () => isAdmin() && currentBusinessData?.business_type === 'group' },
  { id: 'sec-settings',    label: 'Configuración',      short: 'Ajustes',    icon: 'settings',  group: 'Cuenta',    allowed: () => true }
];
// Un módulo que el negocio desactivó en sus preferencias no aparece (los datos no se tocan).
const NAV_ITEMS = NAV_ITEMS_BASE.map((n) => ({ ...n, allowed: () => n.allowed() && moduleOn(n.id) }));
const MOBILE_PRIORITY = ['sec-dashboard', 'sec-sales', 'sec-inventory', 'sec-customers', 'sec-receivables'];
const modules = document.querySelectorAll('.view-module');

function renderNav() {
  const allowed = NAV_ITEMS.filter(n => n.allowed());

  const groups = [...new Set(allowed.map(n => n.group))];
  $('sidebar-nav').innerHTML = groups.map(g =>
    `<div class="sb-group-title">${escapeHtml(g)}</div>` +
    allowed.filter(n => n.group === g).map(n =>
      `<button type="button" class="sb-item nav-item" data-target="${n.id}" title="${escapeHtml(n.label)}">${ico(n.icon)}<span class="sb-label">${escapeHtml(n.label)}</span></button>`
    ).join('')
  ).join('');

  const primary = MOBILE_PRIORITY.filter(id => allowed.some(n => n.id === id)).slice(0, 4);
  $('app-nav').innerHTML = primary.map(id => {
    const n = NAV_ITEMS.find(x => x.id === id);
    return `<button type="button" class="tab-item nav-item" data-target="${n.id}">${ico(n.icon)}<span>${escapeHtml(n.short)}</span></button>`;
  }).join('') + `<button type="button" id="btn-more" class="tab-item">${ico('menu')}<span>Más</span></button>`;

  $('more-sheet-list').innerHTML = allowed.filter(n => !primary.includes(n.id)).map(n =>
    `<button type="button" class="sb-item nav-item" data-target="${n.id}">${ico(n.icon)}<span class="sb-label">${escapeHtml(n.label)}</span></button>`
  ).join('');
  $('more-sheet-sub').textContent = currentBusinessData?.name || '';
  $('btn-more').onclick = () => openModal('more-sheet');
  $('app-nav').dataset.primary = primary.join(',');
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.nav-item[data-target]');
  if (btn) showModuleSection(btn.dataset.target);
});

// Muestra una sección de módulo ocultando el resto. Respeta los permisos de NAV_ITEMS.
function showModuleSection(id) {
  const target = $(id);
  if (!target) return;
  const item = NAV_ITEMS.find(n => n.id === id);
  if (item && !item.allowed()) return;
  closeAllModals();
  modules.forEach(m => m.classList.add('hidden'));
  target.classList.remove('hidden');
  currentSectionId = id;

  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.target === id));
  const primary = ($('app-nav').dataset.primary || '').split(',');
  $('btn-more')?.classList.toggle('active', !primary.includes(id));

  $('page-title').textContent = item?.label || '';
  document.title = `${item?.label || 'AINova'} · AINova Management`;
  window.scrollTo({ top: 0 });

  if (id === 'sec-dashboard') { try { charts.trend?.resize(); charts.pay?.resize(); } catch (e) { /* ignorar */ } }
  if (id === 'sec-sales') renderPosCatalog();
  if (id === 'sec-receivables') renderReceivables();
  if (id === 'sec-reports') renderReports();
  if (id === 'sec-settings') enterSettings();
}

// Los selectores de período del Dashboard
document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    activePeriod = e.currentTarget.dataset.period;
    calculateFinancialDashboard();
  });
});

// Nota: se filtra por [data-type] porque .radio-card es una clase de estilo genérica
// que también usan los selectores de modo de impuesto; sin este filtro, hacer clic en
// esos otros selectores también dispararía este handler.
document.querySelectorAll('.radio-card[data-type]').forEach(card => {
  card.addEventListener('click', (e) => {
    document.querySelectorAll('.radio-card[data-type]').forEach(c => c.classList.remove('selected'));
    const target = e.currentTarget;
    target.classList.add('selected');
    selectedBusinessType = target.dataset.type;
    if (typeof renderWizModules === 'function') renderWizModules();

    const teamContainer = $('team-size-container');
    if (selectedBusinessType === 'group') {
      teamContainer.classList.add('expanded');
      $('onb-team-size').required = true;
    } else {
      teamContainer.classList.remove('expanded');
      $('onb-team-size').required = false;
    }
  });
});

// Mostrar campo de nombre completo si hay código de invitación
$('auth-invite-code').addEventListener('input', (e) => {
  $('invite-fullname-container').classList.toggle('expanded', e.target.value.trim().length > 0);
});

// Link de invitación (?invite=CODE): precarga y bloquea el código para que un empleado
// no pueda registrarse "a medias" sin saberlo. Antes el código era solo texto que el
// empleado debía copiar y volver a escribir a mano; si lo olvidaba u omitía, terminaba
// registrado como admin de un negocio nuevo y vacío en vez de unirse al de su empleador.
(function prefillInviteFromLink() {
  const linkCode = new URLSearchParams(window.location.search).get('invite');
  if (!linkCode) return;
  const codeInput = $('auth-invite-code');
  codeInput.value = linkCode;
  codeInput.readOnly = true;
  $('invite-fullname-container').classList.add('expanded');
  $('auth-invite-banner').classList.remove('hidden');
  window.history.replaceState({}, document.title, window.location.pathname);
})();

$('btn-clear-invite').onclick = () => {
  const codeInput = $('auth-invite-code');
  codeInput.value = '';
  codeInput.readOnly = false;
  $('invite-fullname-container').classList.remove('expanded');
  $('auth-invite-banner').classList.add('hidden');
};

// Botón Entrar con Google
$('btn-google-auth').onclick = async () => {
  // Si hay un código de invitación cargado (a mano o vía link), debe viajar también en el
  // login con Google: si no, Google redirige a una URL "limpia" y el empleado termina
  // registrado como admin de un negocio nuevo en vez de unirse al de su empleador.
  const inviteCode = $('auth-invite-code').value.trim();
  const employeeName = $('auth-employee-name').value.trim();

  if (inviteCode && !employeeName) {
    toast.err("Debes escribir tu nombre completo para registrarte con un código de invitación.");
    return;
  }

  const baseUrl = siteBaseUrl();
  let redirectTo = baseUrl;
  if (inviteCode) {
    const params = new URLSearchParams({ invite: inviteCode, empname: employeeName });
    redirectTo = `${baseUrl}?${params.toString()}`;
    // Respaldo además de la URL: Google o el servicio de autenticación pueden descartar el query string al
    // completar el login (p. ej. si la URL exacta no está entre los dominios de confianza
    // del servicio), dejando al empleado sin el código al volver. Guardarlo
    // también en este navegador permite recuperarlo aunque eso pase.
    try { localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({ code: inviteCode, name: employeeName })); } catch (e) { /* ignorar */ }
  }

  const { error } = await neon.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo }
  });
  if (error) toast.err("Error OAuth: " + error.message);
};

// Contraseña: se crea o se cambia con un enlace que llega al correo
$('btn-set-password').onclick = () => openModal('modal-password');
$('btn-close-password').onclick = () => closeModal('modal-password');
$('btn-save-password').onclick = async () => {
  const email = await currentUserEmail();
  if (!email) return toast.err("No pude leer tu correo. Cierra sesión y vuelve a entrar.");
  const error = await sendPasswordLink(email);
  if (error) return toast.err("No pude enviar el enlace: " + authErrorMessage(error));
  toast.ok(`Listo. Te enviamos un enlace a ${email}. Ábrelo desde el correo para elegir tu contraseña.`);
  closeModal('modal-password');
};

// "¿Olvidaste tu contraseña?" en la pantalla de acceso.
$('btn-forgot-password').onclick = async () => {
  const email = $('auth-email').value.trim();
  if (!email) return toast.err("Escribe primero tu correo en el campo de arriba.");
  const error = await sendPasswordLink(email);
  if (error) return toast.err("No pude enviar el enlace: " + authErrorMessage(error));
  toast.ok("Si ese correo está registrado, te enviamos un enlace para crear una contraseña nueva.");
};

// Llegada desde el enlace del correo: ?reset=1&token=... (o ?reset=1&error=... si venció).
{
  const qs = new URLSearchParams(window.location.search);
  const resetToken = qs.get('reset') === '1' ? qs.get('token') : null;
  const clearResetFromUrl = () => window.history.replaceState({}, document.title, window.location.pathname);
  if (resetToken) {
    openModal('modal-reset-password');
  } else if (qs.get('reset') === '1') {
    toast.err("El enlace para crear la contraseña no es válido o ya venció. Pide uno nuevo.");
    clearResetFromUrl();
  }
  $('btn-cancel-reset-password').onclick = () => {
    closeModal('modal-reset-password');
    clearResetFromUrl();
  };
  $('btn-save-reset-password').onclick = async () => {
    const pass = $('input-reset-password').value;
    if (pass.length < 8) return toast.err("La contraseña debe tener al menos 8 caracteres.");
    const { error } = await neon.auth.getBetterAuthInstance().resetPassword({ newPassword: pass, token: resetToken });
    if (error) return toast.err("No pude guardar la contraseña: " + authErrorMessage(error));
    toast.ok("Contraseña guardada. Ya puedes entrar con tu correo y esta contraseña.");
    $('input-reset-password').value = '';
    closeModal('modal-reset-password');
    clearResetFromUrl();
  };
}

// Chip de usuario (barra superior) -> Mi cuenta
$('btn-header-settings').onclick = () => {
  showModuleSection('sec-settings');
  openSettingsSubpage('settings-page-account');
};

// Menú lateral: contraer / expandir (se recuerda por dispositivo)
function setSidebarCollapsed(collapsed) {
  $('app-shell').classList.toggle('sb-collapsed', collapsed);
  const btn = $('btn-sidebar-collapse');
  btn.setAttribute('aria-label', collapsed ? 'Expandir menú' : 'Contraer menú');
  btn.title = collapsed ? 'Expandir menú' : 'Contraer menú';
  btn.querySelector('.sb-label').textContent = collapsed ? 'Expandir menú' : 'Contraer menú';
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded'); } catch (e) { /* ignorar */ }
}
$('btn-sidebar-collapse').onclick = () => setSidebarCollapsed(!$('app-shell').classList.contains('sb-collapsed'));
try { if (localStorage.getItem(SIDEBAR_KEY) === 'collapsed') setSidebarCollapsed(true); } catch (e) { /* ignorar */ }

// Atajos de teclado: Ctrl+G Configuración, Shift+I Inventario, Shift+V Ventas,
// Shift+F Facturas (solo admin o con permiso), C luego E Clientes.
let pendingChordKey = null;
let pendingChordTime = 0;

document.addEventListener('keydown', (e) => {
  const activeEl = document.activeElement;
  const tag = activeEl?.tagName;
  const isEditableField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || activeEl?.isContentEditable;
  if (isEditableField) { pendingChordKey = null; return; }
  if ($('app-shell').classList.contains('hidden')) return; // aún sin iniciar sesión
  if (document.querySelector('.modal-root:not(.hidden)')) return;

  const key = e.key.toLowerCase();

  if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'g') {
    e.preventDefault();
    $('btn-header-settings').click();
    pendingChordKey = null;
    return;
  }
  if (e.shiftKey && !e.ctrlKey && !e.altKey && key === 'i') {
    e.preventDefault();
    showModuleSection('sec-inventory');
    pendingChordKey = null;
    return;
  }
  if (e.shiftKey && !e.ctrlKey && !e.altKey && key === 'v') {
    e.preventDefault();
    showModuleSection('sec-sales');
    pendingChordKey = null;
    return;
  }
  if (e.shiftKey && !e.ctrlKey && !e.altKey && key === 'f') {
    e.preventDefault();
    if (isAdmin() || currentUserPermissions.ver_reportes) showModuleSection('sec-reports');
    pendingChordKey = null;
    return;
  }
  if (!e.ctrlKey && !e.shiftKey && !e.altKey && key === 'e' && pendingChordKey === 'c' && (Date.now() - pendingChordTime) < 800) {
    e.preventDefault();
    showModuleSection('sec-customers');
    pendingChordKey = null;
    return;
  }
  if (!e.ctrlKey && !e.shiftKey && !e.altKey && key === 'c') {
    pendingChordKey = 'c';
    pendingChordTime = Date.now();
    return;
  }
  pendingChordKey = null;
});

// ---------- Configuración: lista de secciones + página ----------
const desktopSettings = () => window.matchMedia('(min-width: 761px)').matches;
let lastSettingsPage = 'settings-page-account';

function enterSettings() {
  document.querySelectorAll('#sec-settings .nav-admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
  if (isAdmin()) loadSettingsIntoForm();
  syncAccountSubpage();
  if (desktopSettings()) openSettingsSubpage(lastSettingsPage);
  else closeSettingsSubpage();
}

function openSettingsSubpage(id) {
  const page = $(id);
  if (!page) return;
  if (!isAdmin() && id.startsWith('tab-cfg-')) return; // los ajustes del negocio son del admin
  lastSettingsPage = id;
  document.querySelectorAll('#settings-subpage-container .settings-subpage').forEach(el => el.classList.add('hidden'));
  page.classList.remove('hidden');
  $('settings-layout').classList.add('show-page');
  document.querySelectorAll('.settings-list-item').forEach(b => b.classList.toggle('active', b.dataset.subpage === id));
  if (id === 'tab-cfg-activity') loadActivityLog();
  if (id === 'settings-page-customization') syncCustomizationSubpage();
  if (id === 'settings-page-account') syncAccountSubpage();
}
function closeSettingsSubpage() {
  $('settings-layout').classList.remove('show-page');
}
document.querySelectorAll('#sec-settings [data-subpage]').forEach(btn => {
  btn.addEventListener('click', () => openSettingsSubpage(btn.dataset.subpage));
});
$('btn-settings-subpage-back').onclick = closeSettingsSubpage;

async function syncAccountSubpage() {
  const email = await currentUserEmail();
  $('account-email').textContent = email || '—';
}

// Toggle de detalle de impuesto
$('cfg-tax-enabled').addEventListener('change', (e) => {
  $('cfg-tax-details').classList.toggle('expanded', e.target.checked);
});
document.querySelectorAll('.radio-tax-mode').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.radio-tax-mode').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
  });
});

// Apariencia: el tema lo manejan los botones [data-theme-set] (theme.js). Aquí solo el fondo.
function syncCustomizationSubpage() {
  const bgPreview = $('cfg-bg-preview');
  let savedBg = null;
  try { savedBg = localStorage.getItem(BG_STORAGE_KEY); } catch (e) { /* ignorar */ }
  if (savedBg) {
    bgPreview.src = savedBg;
    bgPreview.classList.remove('hidden');
  } else {
    bgPreview.classList.add('hidden');
  }
}

$('cfg-bg-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast.err("Selecciona un archivo de imagen.");

  const reader = new FileReader();
  reader.onload = (readerEvent) => {
    const img = new Image();
    img.onload = () => {
      // Reducir la imagen a un tamaño manejable antes de guardarla en localStorage,
      // para no agotar la cuota del navegador con fotos/capturas de alta resolución.
      const maxDim = 1600;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);

      try {
        localStorage.setItem(BG_STORAGE_KEY, dataUrl);
        applyCustomBackground(dataUrl);
        syncCustomizationSubpage();
        toast.ok("Fondo aplicado en este dispositivo.");
      } catch (err) {
        toast.err("No se pudo guardar el fondo: la imagen es demasiado grande para este navegador. Prueba con una imagen más pequeña.");
      }
    };
    img.onerror = () => toast.err("No se pudo leer la imagen seleccionada.");
    img.src = readerEvent.target.result;
  };
  reader.onerror = () => toast.err("No se pudo leer el archivo seleccionado.");
  reader.readAsDataURL(file);
  e.target.value = '';
});

$('btn-remove-bg').onclick = () => {
  try { localStorage.removeItem(BG_STORAGE_KEY); } catch (e) { console.error(e); }
  applyCustomBackground(null);
  syncCustomizationSubpage();
};

// Al cambiar de tema los gráficos se vuelven a dibujar con los colores del tema nuevo.
window.AinovaTheme?.onChange(() => {
  if (!modulesInitialized) return;
  try { drawDashboardCharts(); renderSalesTrend(); } catch (e) { console.error(e); }
});

// -------------------------------------------------------------
// 4. AUTENTICACIÓN, ROLES & REGISTRO DE EMPLEADOS
// -------------------------------------------------------------
// Los mensajes de error del servicio de autenticación vienen en inglés: se traducen los
// habituales y el resto se muestra tal cual.
function authErrorMessage(err) {
  const m = String(err?.message || err || '');
  if (/invalid (email or )?password|invalid credentials|incorrect/i.test(m)) return 'Correo o contraseña incorrectos.';
  if (/already exist|already registered|use another email/i.test(m)) return 'Ese correo ya tiene una cuenta. Si es tuyo, revisa la contraseña.';
  if (/too short|at least|min(imum)? length/i.test(m)) return 'La contraseña es demasiado corta (mínimo 8 caracteres).';
  if (/too long/i.test(m)) return 'La contraseña es demasiado larga.';
  if (/invalid email|valid email/i.test(m)) return 'El correo no es válido.';
  if (/too many|rate limit/i.test(m)) return 'Demasiados intentos. Espera un momento y vuelve a intentarlo.';
  if (/token/i.test(m) && /(invalid|expired)/i.test(m)) return 'El enlace no es válido o ya venció. Pide uno nuevo.';
  return m || 'Error desconocido.';
}

// La contraseña se crea o se cambia con un enlace que llega al correo: el servicio de
// autenticación no permite cambiarla desde una sesión abierta. El mismo enlace sirve a quien
// entró con Google y todavía no tiene contraseña.
async function sendPasswordLink(email) {
  const { error } = await neon.auth.resetPasswordForEmail(email, { redirectTo: `${siteBaseUrl()}?reset=1` });
  return error;
}
async function currentUserEmail() {
  const { data: { user } } = await neon.auth.getUser();
  return user?.email || null;
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('auth-email').value;
  const password = $('auth-password').value;
  const inviteCode = $('auth-invite-code').value.trim();
  const employeeName = $('auth-employee-name').value.trim();
  const submitBtn = e.currentTarget.querySelector('button[type=submit]');

  if (inviteCode && !employeeName) {
    toast.err("Debes escribir tu nombre completo para registrarte con un código de invitación.");
    return;
  }

  await withBusy(submitBtn, 'Entrando…', async () => {
    const { error } = await neon.auth.signInWithPassword({ email, password });

    if (error) {
      // Quien no tiene cuenta se registra con el mismo formulario. Si el correo ya existe, el
      // fallo real es la contraseña, y así se le dice.
      if (password.length < 8) {
        toast.err("Si ya tienes cuenta, revisa tu contraseña. Si te estás registrando, la contraseña debe tener al menos 8 caracteres.");
        return;
      }
      const baseUrl = siteBaseUrl();
      const params = new URLSearchParams();
      if (inviteCode) {
        params.set('invite', inviteCode);
        params.set('empname', employeeName);
      }
      const redirectUrl = inviteCode ? `${baseUrl}?${params.toString()}` : baseUrl;
      if (inviteCode) {
        try { localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({ code: inviteCode, name: employeeName })); } catch (e2) { /* ignorar */ }
      }

      const { error: signUpError } = await neon.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: redirectUrl,
          // El servicio exige un nombre. Un empleado ya escribió el suyo; el resto usa su correo.
          data: { displayName: employeeName || email.split('@')[0] }
        }
      });

      if (signUpError) {
        toast.err(/already exist|already registered|use another email/i.test(signUpError.message || '')
          ? authErrorMessage(error)
          : "Error de autenticación: " + authErrorMessage(signUpError));
        return;
      }
      // Sin verificación de correo, el registro abre la sesión de inmediato y onAuthStateChange
      // entra a la app: no hace falta avisar nada.
    }
  });
});


// Pregunta a la base quién cree que es la persona de esta sesión (función public.whoami) y espera,
// con unos pocos reintentos, a que la reconozca. Se hace ANTES de leer ningún dato: una petición sin
// identidad no da error, devuelve «nada», y la app tomaría a un empleado por administrador de un
// negocio vacío. Devuelve true cuando la base ve la misma identidad que la sesión.
async function checkDatabaseIdentity(userId) {
  let seen = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { data, error } = await neon.rpc('whoami');
      seen = data?.auth_uid || null;
      console.info('whoami:', data, error);
      if (attempt === 0 || !(!error && seen === userId)) {
        reportDiag(attempt === 0 ? 'login_whoami' : 'login_whoami_retry', { attempt, whoami: data || null, whoamiError: error?.message || null });
      }
      if (!error && seen === userId) return true;
    } catch (e) { console.error('whoami:', e); }
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  toast.err(`La base de datos no reconoce tu sesión (te ve como ${seen || 'nadie'}). Cierra sesión y vuelve a entrar; si sigue igual, avísanos.`);
  return false;
}

// Lista leída de la base. Una lista VACÍA puede ser verdad (aún no hay clientes) o una lectura anónima:
// una petición sin identidad no da error, devuelve «nada». Por eso, si llega vacía se comprueba quién
// ve la base y, si no reconoce la sesión, se vuelve a leer en lugar de mostrar «nada» como si los
// datos se hubieran borrado.
let currentUserId = null;
async function readList(label, run) {
  let res = await run();
  if (!res?.error && Array.isArray(res?.data) && res.data.length === 0 && currentUserId) {
    let seen = null;
    try { seen = (await neon.rpc('whoami'))?.data?.auth_uid || null; } catch (e) { /* ignorar */ }
    if (seen !== currentUserId) {
      reportDiag('empty_read_anon', { label, seen });
      await new Promise((r) => setTimeout(r, 700));
      res = await run();
    }
  }
  return okData(res, label);
}

// Lectura de datos: si falla, se avisa (una vez cada 15 s) en lugar de dejar la lista vacía sin
// explicación. Devuelve los datos, o null si hubo error (así no se pisa lo que ya se había cargado).
let lastLoadFailToast = 0;
function okData(res, label) {
  if (!res?.error) return res?.data ?? null;
  console.error(`Carga de ${label}:`, res.error);
  if (Date.now() - lastLoadFailToast > 15000) {
    lastLoadFailToast = Date.now();
    toast.err(`No se pudieron cargar ${label}: ${res.error.message || res.error}. Recarga la página; si sigue igual, vuelve a entrar.`);
  }
  reportDiag('load_failed', { label, message: res.error.message || String(res.error) });
  return null;
}

// ---------- Diagnóstico y reintento ante rechazos de las reglas de seguridad ----------
// A veces la PRIMERA escritura después de entrar llega a la base sin que ésta reconozca la
// identidad (la base la rechaza con "row-level security") y la siguiente funciona. Mientras se
// investiga la causa: se deja constancia en la base (public.report_diag: qué identidad vio la
// base y qué token tenía la sesión) y se reintenta una vez, tras una breve espera, para que la
// persona no tenga que repetir la acción. Una escritura rechazada por seguridad no guarda nada,
// así que reintentar no duplica datos.
function decodeJwtClaims(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const c = JSON.parse(atob(payload));
    return { sub: c.sub, iat: c.iat, exp: c.exp, role: c.role };
  } catch (e) { return null; }
}
async function reportDiag(event, extra = {}) {
  try {
    const { data: { session } } = await neon.auth.getSession();
    await neon.rpc('report_diag', { p: {
      event, userId: session?.user?.id || null, businessId: currentBusinessId,
      claims: session?.access_token ? decodeJwtClaims(session.access_token) : null,
      clientNow: Math.floor(Date.now() / 1000), page: window.location.hostname,
      ua: navigator.userAgent.slice(0, 120), dataAuth: window.__dataAuth, ...extra
    } });
  } catch (e) { /* el diagnóstico nunca debe romper la acción */ }
}
const isRlsError = (err) => /row-level security/i.test(err?.message || '');
async function writeWithRetry(label, doWrite) {
  let res = await doWrite();
  if (res?.error && isRlsError(res.error)) {
    await reportDiag('rls_rejected', { label, message: res.error.message });
    await new Promise(r => setTimeout(r, 800));
    res = await doWrite();
    await reportDiag(res?.error ? 'rls_retry_failed' : 'rls_retry_ok', { label, message: res?.error?.message || null });
  }
  return res;
}

neon.auth.onAuthStateChange(async (event, session) => {
  if (session?.user) {
    const userId = session.user.id;
    currentUserId = userId;
    // Antes del corte de abajo: la marca debe ponerse en cada evento con sesión, no solo
    // la primera vez que se montan los módulos.
    try { localStorage.setItem(VISITED_KEY, '1'); } catch (e) { /* ignorar */ }
    if (modulesInitialized) return;

    // Primero: que la base reconozca esta sesión (si no, cualquier lectura devolvería «nada»).
    if (!(await checkDatabaseIdentity(userId))) return;

    // Canjear código de invitación pendiente. Se busca primero en localStorage (guardado
    // justo antes de salir hacia Google/el correo de confirmación) porque es más
    // confiable que la URL: el servicio de autenticación puede redirigir a una URL "limpia"
    // sin el query string si la URL exacta no está entre sus dominios de confianza. Si no hay
    // nada en localStorage, se revisa la URL como respaldo (flujo de correo original).
    let pendingCode = null, pendingName = '';
    try {
      const stored = localStorage.getItem(PENDING_INVITE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        pendingCode = parsed.code;
        pendingName = parsed.name || '';
      }
    } catch (e) { /* ignorar */ }

    if (!pendingCode) {
      const urlParams = new URLSearchParams(window.location.search);
      pendingCode = urlParams.get('invite');
      pendingName = urlParams.get('empname') || '';
    }

    if (pendingCode) {
      const { data: redeemedBusinessId, error: redeemError } = await neon.rpc('redeem_invite_code', { input_code: pendingCode, input_employee_name: pendingName });
      try { localStorage.removeItem(PENDING_INVITE_KEY); } catch (e) { /* ignorar */ }
      window.history.replaceState({}, document.title, window.location.pathname);

      if (redeemError) {
        toast.err("El código de invitación no es válido o ya fue usado: " + redeemError.message);
      } else if (redeemedBusinessId) {
        currentBusinessId = redeemedBusinessId;
        currentUserRole = 'employee';
      }
    }

    // Si no se acaba de canjear un código, determinar rol normalmente
    if (!currentBusinessId) {
      const { data: memberData } = await neon
        .from('business_members')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (memberData) {
        currentBusinessId = memberData.business_id;
        currentUserRole = memberData.role;
        currentUserPermissions = memberData.permissions || {};
      } else {
        currentBusinessId = userId;
        currentUserRole = 'admin';
      }
    }

    // Cargar Ajustes y Datos de Negocio
    let { data: bData, error: bLoadErr } = await neon.from('businesses').select('*').eq('id', currentBusinessId).maybeSingle();
    if (bLoadErr) {
      console.error('No se pudo leer el negocio:', bLoadErr);
      toast.err('No se pudo cargar tu negocio: ' + bLoadErr.message + '. Recarga la página; si sigue igual, vuelve a entrar.');
      return;
    }

    if (!bData && currentUserRole === 'admin') {
      const { data: newB, error: newBErr } = await neon.from('businesses').insert([{ id: currentBusinessId, name: 'Mi Negocio', onboarding_completed: false }]).select().single();
      if (newBErr) {
        console.error('No se pudo crear el negocio:', newBErr);
        toast.err("No se pudo crear tu negocio: " + newBErr.message + ". Recarga la página; si sigue igual, avísanos.");
      }
      bData = newB;
    }

    setBusiness(bData);

    // Ocultar pantalla de acceso
    $('auth-screen').classList.add('auth-exit');

    setTimeout(async () => {
      $('auth-screen').classList.add('hidden');
      $('auth-screen').classList.remove('auth-exit');

      // FLUJO ONBOARDING & ROLES
      if (currentUserRole === 'admin' && (!currentBusinessData || !currentBusinessData.onboarding_completed)) {
        enterFirstRun(userId);   // bienvenida + tutorial la primera vez, y luego el asistente
      } else {
        setupRoleInterface();
        startSystemModules();
        boot.hide();
        handleGotoParam();
      }
    }, 400);

  } else {
    clearJwtCache();
    // Sin sesión: se borra la marca para que la presentación vuelva a aparecer al
    // entrar por la raíz del sitio.
    try { localStorage.removeItem(VISITED_KEY); } catch (e) { /* ignorar */ }
    currentBusinessId = null;
    modulesInitialized = false;
    neon.removeAllChannels?.(); // la app no usa tiempo real; el cliente de Neon no lo trae
    closeAllModals();
    $('auth-screen').classList.remove('hidden');
    $('onboarding-screen').classList.add('hidden');
    $('app-shell').classList.add('hidden');
    modules.forEach(m => m.classList.add('hidden'));
    document.title = 'AINova Management';
    boot.hide();

    // Quien acaba de pulsar "Salir" vuelve a la presentación, no se queda en la
    // pantalla de acceso: al cerrar sesión deja de ser alguien de dentro.
    //
    // Solo con el botón, y por eso la bandera: este mismo bloque corre también al
    // abrir app.html sin sesión (evento INITIAL_SESSION). Reenviar ahí encerraría a
    // quien llega desde la presentación en un ida y vuelta sin fin, y echaría a la
    // página de marketing a quien solo quiere entrar. También se queda fuera el caso
    // de una sesión que caduca sola: ahí la pantalla de acceso es lo útil, no un
    // folleto.
    if (userRequestedLogout) {
      userRequestedLogout = false;
      window.location.replace('index.html');
    }
  }
});

// (El guardado de la configuración inicial vive en el asistente por pasos: ver sección 10.)

// Forzado de contraseña en onboarding de grupo
$('btn-save-forced-password').onclick = async () => {
  const email = await currentUserEmail();
  if (!email) return toast.err("No pude leer tu correo. Cierra sesión y vuelve a entrar.");
  const error = await sendPasswordLink(email);
  if (error) return toast.err("No pude enviar el enlace: " + authErrorMessage(error));
  toast.ok(`Te enviamos un enlace a ${email} para crear tu contraseña. Ábrelo cuando puedas; mientras tanto ya puedes entrar.`);

  closeModal('modal-forced-password');
  enterApp();
};

function setupRoleInterface() {
  const name = businessName();
  $('business-display-name').textContent = name;
  $('user-role-badge').textContent = isAdmin() ? 'Admin' : 'Empleado';
  $('user-avatar').textContent = initials(name);
  $('user-chip-role').textContent = isAdmin() ? 'Administrador' : 'Empleado';
  $('user-chip-name').textContent = name;
  if (!demoMode) currentUserEmail().then(email => { if (email) $('user-chip-name').textContent = email.split('@')[0]; }).catch(() => {});
  $('page-date').textContent = new Date().toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });

  $('app-shell').classList.remove('hidden');
  document.querySelectorAll('.nav-admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
  renderNav();
  // Un empleado empieza en Ventas (aunque el admin le haya dado acceso al Dashboard);
  // el admin, en el Dashboard.
  showModuleSection(isAdmin() ? 'sec-dashboard' : 'sec-sales');
}

// Arranca los módulos y devuelve una promesa que se cumple cuando sus datos están cargados.
// onProgress(hechos, total, etiqueta) se llama cada vez que termina una carga REAL.
async function startSystemModules(onProgress) {
  if (modulesInitialized) return;
  const tasks = [
    ['Productos y existencias', initInventory()],
    (initSales(), null),
    ['Ventas y reportes', initReports()],
    ['Clientes y créditos', initCustomersAndCredits()],
    ['Equipo', initEmployeeManagement()],
    ['Facturas', initInvoices()]
  ].filter(Boolean);
  applyLogoToHeader();
  renderPayMethods();
  modulesInitialized = true;
  let done = 0;
  await Promise.all(tasks.map(([label, promise]) => Promise.resolve(promise).then(() => { done++; onProgress?.(done, tasks.length, label); })));
}

function applyLogoToHeader() {
  const logoSrc = currentBusinessData?.logo_url || 'logo.png';
  $('header-logo-img').src = logoSrc;
  document.querySelector('.topbar-logo').src = logoSrc;
  $('cfg-logo-preview').src = logoSrc;
}

// Tras cambiar la moneda hay que repintar todo lo que muestra dinero.
function refreshCurrencyViews() {
  renderInventory();
  renderPosCatalog();
  renderCart();
  renderCustomersTable();
  renderReceivables();
  renderReports();
  calculateFinancialDashboard();
}

// -------------------------------------------------------------
// 5. CLIENTES, CRÉDITOS Y CUENTAS POR COBRAR
// -------------------------------------------------------------
const pendingOf = (cr) => parseFloat(cr.amount) - parseFloat(cr.amount_paid);

// Formatea una fecha "YYYY-MM-DD" (sin hora) evitando el corrimiento de zona horaria
function formatDateOnly(dateStr) {
  return fmtYmd(dateStr);
}

// true si hoy ya pasó la fecha límite (pagar el mismo día cuenta como a tiempo)
function isPastDueDate(dueDateStr) {
  if (!dueDateStr) return false;
  const [y, m, d] = dueDateStr.split('-').map(Number);
  const due = new Date(y, m - 1, d, 23, 59, 59);
  return new Date() > due;
}

// Estado visual de un crédito
function creditState(cr) {
  if (cr.status === 'pagado') return { key: 'paid', label: 'Pagado', cls: 'badge-ok' };
  if (cr.due_date && isPastDueDate(cr.due_date)) return { key: 'overdue', label: 'Vencido', cls: 'badge-danger' };
  if (cr.status === 'parcial') return { key: 'partial', label: 'Parcial', cls: 'badge-info' };
  return { key: 'pending', label: 'Pendiente', cls: 'badge-warn' };
}

async function loadCustomers() {
  const data = await readList('los clientes', () => neon.from('customers').select('*').eq('business_id', currentBusinessId));
  if (data) {
    customersSnapshot = data.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    loaded.customers = true;
    populateSalesCustomerSelect();
    await loadCredits();
  }
}

// ---------- Clientes: validación, edición y eliminación ----------
let editingCustomerId = null;     // null = el formulario crea; con id = edita ese cliente
let openAccountCustomerId = null; // cliente cuyo perfil está abierto
const normName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const phoneDigits = (s) => String(s || '').replace(/\D/g, '');

// Devuelve el motivo por el que no se puede guardar, o null si todo está bien.
function validateCustomer(name, phone, ignoreId) {
  if (name.length < 2) return 'Escribe el nombre del cliente (mínimo 2 letras).';
  if (name.length > 150) return 'El nombre es demasiado largo (máximo 150 caracteres).';
  if (phone && !/^[0-9+()\-.\s]{7,25}$/.test(phone)) return 'El teléfono solo puede llevar números, espacios y + ( ) - . (de 7 a 25 caracteres).';
  const dup = customersSnapshot.find((c) => c.id !== ignoreId && normName(c.name) === normName(name) && phoneDigits(c.phone) === phoneDigits(phone));
  if (dup) return 'Ya tienes un cliente con ese nombre y ese teléfono.';
  return null;
}

// Mensaje de la base en palabras de la persona (restricciones y permisos).
function friendlyDbError(err) {
  const m = err?.message || String(err || '');
  if (/customers_name_check/.test(m)) return 'revisa el nombre (1 a 150 caracteres) y el teléfono (hasta 40).';
  if (/foreign key|violates foreign key/i.test(m)) return 'tiene registros asociados (créditos o facturas).';
  if (/row-level security/i.test(m)) return 'tu usuario no tiene permiso para esta acción (' + m + ').';
  return m;
}

let returnToProfileId = null;      // al terminar de editar, se vuelve al perfil de este cliente
function openCustomerForm(customerId) {
  editingCustomerId = customerId;
  // El perfil y el formulario comparten capa y el perfil va después: se cierra el perfil para que el
  // formulario quede delante, y se vuelve a abrir al terminar (guardando o cancelando).
  returnToProfileId = (customerId && !$('modal-customer-account').classList.contains('hidden')) ? customerId : null;
  if (returnToProfileId) closeModal('modal-customer-account');
  const c = customerId ? customersSnapshot.find((x) => x.id === customerId) : null;
  $('customer-form').reset();
  $('customer-form-title').textContent = c ? 'Editar cliente' : 'Nuevo cliente';
  $('customer-form-sub').textContent = c ? 'Corrige el nombre o el teléfono. Sus créditos y facturas no cambian.' : 'Podrás venderle a crédito y llevar su cuenta.';
  $('customer-form-submit').textContent = c ? 'Guardar cambios' : 'Guardar cliente';
  if (c) { $('cust-name').value = c.name || ''; $('cust-phone').value = c.phone || ''; }
  openModal('modal-customer-new');
}

async function deleteCurrentCustomer() {
  const id = openAccountCustomerId;
  const c = customersSnapshot.find((x) => x.id === id);
  if (!c || !isAdmin()) return;
  if (!loaded.invoices) await loadInvoicesList();
  const hasCredits = creditsSnapshot.some((cr) => cr.customer_id === id);
  const hasInvoices = invoicesSnapshot.some((inv) => inv.customer_id === id);
  if (hasCredits || hasInvoices) {
    toast.warn('No se puede eliminar: tiene ' + (hasCredits ? 'créditos' : 'facturas') + ' registrados. Su historial debe conservarse.');
    return;
  }
  const ok = await confirmDialog({ title: '¿Eliminar a ' + c.name + '?', message: 'Se borra solo este cliente (no tiene créditos ni facturas). No se puede deshacer.', confirmLabel: 'Eliminar', danger: true });
  if (!ok) return;
  const { error } = await neon.from('customers').delete().eq('id', id);
  if (error) return toast.err('No se pudo eliminar: ' + friendlyDbError(error));
  await logActivity('Eliminó un cliente', { entityType: 'customer', entityId: id, oldValues: { name: c.name } });
  closeModal('modal-customer-account');
  toast.ok('Cliente «' + c.name + '» eliminado.');
  await loadCustomers();
}

async function initCustomersAndCredits() {
  $('customers-table-body').innerHTML = skeletonRows(5);
  $('receivables-table-body').innerHTML = skeletonRows(8);
  await loadCustomers();

  // Formulario de cliente: sirve para crear y para editar (editingCustomerId).
  $('btn-show-add-customer').onclick = () => openCustomerForm(null);
  $('customer-search').addEventListener('input', renderCustomersTable);

  $('customer-form').onsubmit = async (e) => {
    e.preventDefault();
    const submit = e.currentTarget.querySelector('button[type=submit]');
    const name = $('cust-name').value.replace(/\s+/g, ' ').trim();
    const phone = $('cust-phone').value.trim();
    const problem = validateCustomer(name, phone, editingCustomerId);
    if (problem) { toast.err(problem); return; }
    await withBusy(submit, 'Guardando…', async () => {
      const editing = editingCustomerId;
      const { error } = await writeWithRetry(editing ? 'customers.update' : 'customers.insert', () => editing
        ? neon.from('customers').update({ name, phone: phone || null }).eq('id', editing)
        : neon.from('customers').insert([{ business_id: currentBusinessId, name, phone: phone || null }]));
      if (error) return toast.err((editing ? "No se pudo guardar el cambio: " : "No se pudo guardar el cliente: ") + friendlyDbError(error));
      $('customer-form').reset();
      closeModal('modal-customer-new');
      toast.ok(editing ? `Cliente «${name}» actualizado.` : `Cliente «${name}» guardado.`);
      if (editing) await logActivity('Editó un cliente', { entityType: 'customer', entityId: editing });
      editingCustomerId = null;
      await loadCustomers();
      if (editing && !$('modal-customer-account').classList.contains('hidden')) openCustomerAccountModal(editing);   // refresca el nombre
    });
  };

  $('btn-edit-customer').onclick = () => { if (openAccountCustomerId) openCustomerForm(openAccountCustomerId); };
  new MutationObserver(() => {
    if ($('modal-customer-new').classList.contains('hidden') && returnToProfileId) {
      const id = returnToProfileId; returnToProfileId = null; editingCustomerId = null;
      openCustomerAccountModal(id);
    }
  }).observe($('modal-customer-new'), { attributes: true, attributeFilter: ['class'] });
  $('btn-delete-customer').onclick = deleteCurrentCustomer;

  // Filtros de Cuentas por cobrar
  document.querySelectorAll('#rec-filter button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#rec-filter button').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      renderReceivables();
    });
  });
  $('rec-search').addEventListener('input', renderReceivables);

  // Pestañas del perfil del cliente
  document.querySelectorAll('#account-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#account-tabs button').forEach(b => b.classList.toggle('is-active', b === btn));
      $('account-tab-credits').classList.toggle('hidden', btn.dataset.accTab !== 'credits');
      $('account-tab-history').classList.toggle('hidden', btn.dataset.accTab !== 'history');
    });
  });
}

async function loadCredits() {
  const data = await readList('las cuentas por cobrar', () => neon.from('customer_credits').select('*').eq('business_id', currentBusinessId));
  if (data) {
    creditsSnapshot = data;
    loaded.credits = true;
    renderCustomersTable();
    renderReceivables();
    calculateFinancialDashboard();
  }
}

// Saldo pendiente de un cliente y si tiene algún crédito vencido
function customerBalance(customerId) {
  const open = creditsSnapshot.filter(cr => cr.customer_id === customerId && cr.status !== 'pagado');
  return {
    pending: open.reduce((acc, cr) => acc + pendingOf(cr), 0),
    overdue: open.some(cr => cr.due_date && isPastDueDate(cr.due_date)),
    openCount: open.length
  };
}

function renderCustomersTable() {
  const tbody = $('customers-table-body');
  const empty = $('customers-empty');
  if (!loaded.customers) { tbody.innerHTML = skeletonRows(5); return; }

  const q = $('customer-search').value.trim().toLowerCase();
  const list = customersSnapshot.filter(c => !q || String(c.name).toLowerCase().includes(q) || String(c.phone || '').toLowerCase().includes(q));

  // Resumen
  let withDebt = 0, totalBalance = 0;
  customersSnapshot.forEach(c => { const b = customerBalance(c.id); if (b.pending > 0) { withDebt++; totalBalance += b.pending; } });
  $('cust-stat-total').textContent = customersSnapshot.length;
  $('cust-stat-debt').textContent = withDebt;
  $('cust-stat-balance').textContent = money(totalBalance);

  tbody.innerHTML = list.map(c => {
    const b = customerBalance(c.id);
    const badge = b.overdue ? '<span class="badge badge-danger">Vencido</span>'
      : b.pending > 0 ? '<span class="badge badge-warn">Con saldo</span>'
      : '<span class="badge badge-ok">Al día</span>';
    return `<tr>
      <td class="cell-main"><div class="cell-person"><span class="avatar">${escapeHtml(initials(c.name))}</span><b>${escapeHtml(c.name)}</b></div></td>
      <td data-label="Teléfono">${escapeHtml(c.phone) || '<span class="muted">—</span>'}</td>
      <td class="num" data-label="Saldo pendiente" style="${b.pending > 0 ? 'color:var(--coral-ink);font-weight:700' : ''}">${money(b.pending)}</td>
      <td data-label="Estado">${badge}</td>
      <td class="cell-actions"><button type="button" class="btn btn-sm btn-account" data-id="${c.id}">Ver perfil ${ico('chevron-right', 'i-sm')}</button></td>
    </tr>`;
  }).join('');

  if (!list.length) {
    empty.classList.remove('hidden');
    empty.innerHTML = customersSnapshot.length
      ? emptyState({ icon: 'search', title: 'Sin resultados', text: 'Prueba con otro nombre o teléfono.' })
      : emptyState({ icon: 'users', title: 'Aún no tienes clientes', text: 'Registra a tus clientes para venderles a crédito y llevar su cuenta.', actionHtml: '<button type="button" class="btn btn-primary" id="empty-add-customer">Nuevo cliente</button>' });
    $('empty-add-customer')?.addEventListener('click', () => $('btn-show-add-customer').click());
  } else {
    empty.classList.add('hidden');
  }

  tbody.querySelectorAll('.btn-account').forEach(btn => {
    btn.onclick = (e) => openCustomerAccountModal(e.currentTarget.dataset.id);
  });
}

// Cuentas por cobrar: todos los créditos con su estado, filtros y búsqueda
function renderReceivables() {
  const tbody = $('receivables-table-body');
  const empty = $('receivables-empty');
  if (!loaded.credits) return;

  const open = creditsSnapshot.filter(cr => cr.status !== 'pagado');
  const overdue = open.filter(cr => cr.due_date && isPastDueDate(cr.due_date));
  $('rec-total').textContent = money(open.reduce((a, cr) => a + pendingOf(cr), 0));
  $('rec-open-count').textContent = `${open.length} ${open.length === 1 ? 'crédito abierto' : 'créditos abiertos'}`;
  $('rec-overdue').textContent = money(overdue.reduce((a, cr) => a + pendingOf(cr), 0));
  $('rec-overdue').classList.toggle('is-danger', overdue.length > 0);
  $('rec-overdue-count').textContent = `${overdue.length} ${overdue.length === 1 ? 'crédito vencido' : 'créditos vencidos'}`;
  $('rec-collected').textContent = money(open.reduce((a, cr) => a + parseFloat(cr.amount_paid), 0));
  $('rec-customers').textContent = new Set(open.map(cr => cr.customer_id)).size;

  const filter = document.querySelector('#rec-filter .is-active')?.dataset.filter || 'open';
  const q = $('rec-search').value.trim().toLowerCase();
  const customerName = (id) => customersSnapshot.find(c => c.id === id)?.name || 'Cliente';
  const rank = { overdue: 0, partial: 1, pending: 2, paid: 3 };

  const rows = creditsSnapshot.filter(cr => {
    const st = creditState(cr).key;
    if (filter === 'open' && st === 'paid') return false;
    if (filter === 'overdue' && st !== 'overdue') return false;
    if (filter === 'paid' && st !== 'paid') return false;
    return !q || customerName(cr.customer_id).toLowerCase().includes(q);
  }).sort((a, b) => {
    const ra = rank[creditState(a).key], rb = rank[creditState(b).key];
    if (ra !== rb) return ra - rb;
    return String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')) || (new Date(b.created_at) - new Date(a.created_at));
  });

  tbody.innerHTML = rows.map(cr => {
    const st = creditState(cr);
    const total = parseFloat(cr.amount), paid = parseFloat(cr.amount_paid);
    const pct = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
    const name = customerName(cr.customer_id);
    return `<tr>
      <td class="cell-main"><div class="cell-person"><span class="avatar">${escapeHtml(initials(name))}</span><b>${escapeHtml(name)}</b></div></td>
      <td data-label="Fecha">${fmtDate(cr.created_at)}</td>
      <td data-label="Vence" style="${st.key === 'overdue' ? 'color:var(--danger-ink);font-weight:600' : ''}">${formatDateOnly(cr.due_date)}</td>
      <td class="num" data-label="Monto">${money(total)}</td>
      <td class="num" data-label="Abonado">${money(paid)}</td>
      <td class="num" data-label="Saldo"><div class="balance-cell"><b>${money(Math.max(0, total - paid))}</b><div class="progress ${st.key === 'overdue' ? 'danger' : ''}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Pagado ${pct}%"><i style="width:${pct}%"></i></div></div></td>
      <td data-label="Estado"><span class="badge ${st.cls}">${st.label}</span></td>
      <td class="cell-actions"><button type="button" class="btn btn-sm ${st.key === 'paid' ? '' : 'btn-primary'} btn-rec-account" data-customer="${cr.customer_id}" data-credit="${cr.id}">${st.key === 'paid' ? 'Ver cuenta' : 'Abonar'}</button></td>
    </tr>`;
  }).join('');

  if (!rows.length) {
    empty.classList.remove('hidden');
    empty.innerHTML = creditsSnapshot.length
      ? emptyState({ icon: 'check-circle', title: filter === 'overdue' ? 'No hay créditos vencidos' : 'Nada por mostrar aquí', text: 'Ajusta el filtro o la búsqueda para ver otros créditos.' })
      : emptyState({ icon: 'wallet', title: 'Sin cuentas por cobrar', text: 'Cuando vendas a crédito, el saldo de cada cliente aparecerá aquí.' });
  } else {
    empty.classList.add('hidden');
  }

  tbody.querySelectorAll('.btn-rec-account').forEach(btn => {
    btn.onclick = (e) => openCustomerAccountModal(e.currentTarget.dataset.customer, e.currentTarget.dataset.credit);
  });
}

function openCustomerAccountModal(customerId, preselectCreditId = null) {
  const customer = customersSnapshot.find(c => c.id === customerId);
  if (!customer) return;
  openAccountCustomerId = customerId;
  $('btn-delete-customer').classList.toggle('hidden', !isAdmin());

  $('account-avatar').textContent = initials(customer.name);
  $('account-customer-name').textContent = customer.name;
  $('account-customer-phone').textContent = customer.phone ? `Tel: ${customer.phone}` : 'Sin teléfono registrado';

  const clientCredits = creditsSnapshot.filter(cr => cr.customer_id === customerId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const openCredits = clientCredits.filter(cr => cr.status !== 'pagado');
  const pendingTotal = openCredits.reduce((acc, cr) => acc + pendingOf(cr), 0);

  $('account-total-pending').textContent = fmtNum(pendingTotal);
  document.querySelector('.acc-cur').textContent = money(0).replace(/[\d.,]+$/, '');
  $('account-open-count').textContent = openCredits.length;
  $('account-total-paid').textContent = money(clientCredits.reduce((a, cr) => a + parseFloat(cr.amount_paid), 0));

  // Estado de cuenta
  const tbody = $('account-credits-list');
  tbody.innerHTML = clientCredits.length ? clientCredits.map(cr => {
    const st = creditState(cr);
    return `<tr>
      <td class="cell-main">${fmtDate(cr.created_at)}</td>
      <td data-label="Vence">${formatDateOnly(cr.due_date)}</td>
      <td class="num" data-label="Monto">${money(cr.amount)}</td>
      <td class="num" data-label="Abonado">${money(cr.amount_paid)}</td>
      <td class="num" data-label="Pendiente"><b>${money(Math.max(0, pendingOf(cr)))}</b></td>
      <td data-label="Estado"><span class="badge ${st.cls}">${st.label}</span></td>
    </tr>`;
  }).join('') : `<tr><td colspan="6"><div class="empty">${emptyState({ icon: 'wallet', title: 'Sin créditos', text: 'Este cliente todavía no tiene compras a crédito.' })}</div></td></tr>`;

  // Compras y pagos: créditos otorgados + facturas ligadas al cliente, de más nuevo a más viejo
  const events = [];
  clientCredits.forEach(cr => {
    const sale = salesHistory.find(s => s.id === cr.sale_id);
    const items = (sale?.items || []).map(i => `${i.name} ×${i.qty}`).join(', ');
    events.push({ at: cr.created_at, icon: 'wallet', tone: 'is-coral', title: 'Compra a crédito', sub: items || 'Venta a crédito', amount: money(cr.amount) });
  });
  invoicesSnapshot.filter(inv => inv.customer_id === customerId).forEach(inv => {
    const isPayment = String(inv.items?.[0]?.name || '').startsWith('Abono');
    events.push({ at: inv.created_at, icon: isPayment ? 'check-circle' : 'file', tone: isPayment ? '' : 'is-teal', title: isPayment ? 'Abono recibido' : 'Factura', sub: inv.invoice_number, amount: money(inv.total), invoiceId: inv.id });
  });
  events.sort((a, b) => new Date(b.at) - new Date(a.at));
  $('account-invoices-list').innerHTML = events.length ? events.map(ev => `
    <${ev.invoiceId ? 'button type="button" data-invoice="' + ev.invoiceId + '"' : 'div'} class="activity-item" style="${ev.invoiceId ? 'width:100%;background:none;border-left:0;border-right:0;border-top:0;text-align:left;cursor:pointer;color:inherit;font:inherit' : ''}">
      <span class="activity-ico ${ev.tone}">${ico(ev.icon)}</span>
      <span class="activity-main"><b>${escapeHtml(ev.title)}</b><small>${escapeHtml(ev.sub)} · ${fmtDate(ev.at)}</small></span>
      <span class="activity-amount">${ev.amount}</span>
    </${ev.invoiceId ? 'button' : 'div'}>`).join('')
    : emptyState({ icon: 'history', title: 'Sin movimientos', text: 'Aquí verás las compras, facturas y abonos del cliente.' });
  $('account-invoices-list').querySelectorAll('[data-invoice]').forEach(btn => {
    btn.onclick = () => { const inv = invoicesSnapshot.find(i => i.id === btn.dataset.invoice); if (inv) openInvoiceModal(inv); };
  });

  // Selector de abono
  const creditSelect = $('payment-credit-select');
  creditSelect.innerHTML = '';
  openCredits.forEach(cr => {
    const opt = document.createElement('option');
    opt.value = cr.id;
    const lateTag = (cr.due_date && !cr.late_fee_applied && isPastDueDate(cr.due_date)) ? ' · vencido (+10% mora)' : '';
    opt.textContent = `Crédito ${fmtDate(cr.created_at)} · pendiente ${money(pendingOf(cr))}${lateTag}`;
    creditSelect.appendChild(opt);
  });
  if (preselectCreditId && openCredits.some(c => c.id === preselectCreditId)) creditSelect.value = preselectCreditId;
  $('payment-form').classList.toggle('hidden', openCredits.length === 0);
  $('payment-amount').value = '';

  // Pestaña inicial
  document.querySelectorAll('#account-tabs button').forEach(b => b.classList.toggle('is-active', b.dataset.accTab === 'credits'));
  $('account-tab-credits').classList.remove('hidden');
  $('account-tab-history').classList.add('hidden');

  openModal('modal-customer-account');

  // Procesar Abono: valida el monto, recalcula el recargo por mora (si aplica) y
  // actualiza el crédito dentro de una sola transacción en el servidor con bloqueo de
  // fila (process_credit_payment), evitando que dos abonos simultáneos al mismo crédito
  // se pisen entre sí o que el cliente pueda forzar montos inválidos. Luego se genera la
  // venta/factura correspondiente al abono, igual que antes.
  $('payment-form').onsubmit = async (e) => {
    e.preventDefault();
    const creditId = creditSelect.value;
    const amountToPay = parseFloat($('payment-amount').value);

    if (!creditId || !(amountToPay > 0)) return toast.err("Monto o crédito inválido.");

    const submit = e.currentTarget.querySelector('button[type=submit]');
    await withBusy(submit, 'Procesando…', async () => {
      const { data: saleData, error: payErr } = await neon.rpc('process_credit_payment', {
        p_business_id: currentBusinessId,
        p_credit_id: creditId,
        p_amount: amountToPay
      });
      if (payErr) return toast.err("Error al registrar abono: " + payErr.message);

      const interestAmount = parseFloat(saleData.profit) - parseFloat(saleData.total);
      const isLate = interestAmount > 0;

      salesHistory.unshift(saleData);
      const { data: invData, error: invErr } = await createInvoiceForSale(saleData, customerId);

      $('payment-amount').value = '';
      await loadCredits();
      await loadInvoicesList();
      openCustomerAccountModal(customerId);

      if (isLate) toast.warn(`Pago recibido después de la fecha límite: se aplicó un recargo por mora del 10% (${money(interestAmount)}).`);

      if (invErr) {
        toast.err("Abono registrado, pero hubo un error generando su factura: " + invErr.message);
      } else if (invData) {
        toast.ok("Abono registrado correctamente.");
        openInvoiceModal(invData);
      } else {
        toast.ok("Abono registrado correctamente.");
      }
    });
  };
}

$('btn-close-account').onclick = () => closeModal('modal-customer-account');

function populateSalesCustomerSelect() {
  const select = $('sale-customer-select');
  select.innerHTML = '<option value="">Seleccionar cliente…</option>';
  customersSnapshot.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  });
}

// -------------------------------------------------------------
// 6. PUNTO DE VENTA (integrado con crédito)
// -------------------------------------------------------------
let posQuery = '';
let posCategory = '';

const PAY_METHODS = [
  { key: 'efectivo', value: 'Efectivo', icon: 'cash' },
  { key: 'transferencia', value: 'Transferencia', icon: 'bank' },
  { key: 'tarjeta', value: 'Tarjeta', icon: 'card' },
  { key: 'credito', value: 'Crédito', icon: 'clock' }
];

// Solo se ofrecen los métodos que el admin dejó activos en Configuración → Métodos de pago.
function enabledPayMethods() {
  const pm = currentBusinessData?.payment_methods || {};
  return PAY_METHODS.filter(m => pm[m.key] !== false);
}

function renderPayMethods() {
  const methods = enabledPayMethods();
  const box = $('pay-methods');
  const current = $('sale-payment-method').value;
  const selected = methods.some(m => m.value === current) ? current : (methods[0]?.value || '');
  box.innerHTML = methods.map(m =>
    `<button type="button" class="pay-method ${m.value === selected ? 'selected' : ''}" role="radio" aria-checked="${m.value === selected}" data-method="${m.value}">${ico(m.icon)}${m.value === 'Crédito' ? 'Crédito / fiao' : m.value}</button>`
  ).join('') || '<p class="hint">No hay métodos de pago activos. Actívalos en Configuración.</p>';
  box.querySelectorAll('.pay-method').forEach(b => b.onclick = () => setPaymentMethod(b.dataset.method));
  setPaymentMethod(selected);
}

function setPaymentMethod(value) {
  $('sale-payment-method').value = value;
  document.querySelectorAll('#pay-methods .pay-method').forEach(b => {
    const on = b.dataset.method === value;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  const isCredit = value === 'Crédito';
  $('credit-customer-container').classList.toggle('expanded', isCredit);
  $('sale-customer-select').required = isCredit;
}

// Recarga el inventario (también lo usa el POS tras vender, para no ofrecer stock que ya no existe)
async function loadProducts() {
  const data = await readList('los productos', () => neon.from('products').select('*').eq('business_id', currentBusinessId));
  if (data) {
    inventorySnapshot = data.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    loaded.products = true;
    renderInventory();
    renderPosCatalog();
    renderLowStock();
  }
}

function isLowStock(p) { return p.stock <= p.min_stock; }

function renderPosCatalog() {
  const grid = $('pos-grid');
  if (!grid) return;
  const alertsOn = currentBusinessData?.global_low_stock_alert !== false;

  // Categorías
  const cats = [...new Set(inventorySnapshot.map(p => p.category).filter(Boolean))].sort();
  if (posCategory && !cats.includes(posCategory)) posCategory = '';
  $('pos-categories').innerHTML = cats.length > 1
    ? [''].concat(cats).map(c => `<button type="button" class="chip ${c === posCategory ? 'is-active' : ''}" data-cat="${escapeHtml(c)}">${c ? escapeHtml(c) : 'Todos'}</button>`).join('')
    : '';
  $('pos-categories').querySelectorAll('.chip').forEach(ch => ch.onclick = () => { posCategory = ch.dataset.cat; renderPosCatalog(); });

  const q = posQuery.trim().toLowerCase();
  const list = inventorySnapshot.filter(p =>
    (!posCategory || p.category === posCategory) &&
    (!q || String(p.name).toLowerCase().includes(q) || String(p.sku || '').toLowerCase().includes(q) || String(p.category || '').toLowerCase().includes(q)));

  if (!loaded.products) {
    grid.innerHTML = Array.from({ length: 8 }, () => '<span class="skel" style="height:112px;border-radius:12px"></span>').join('');
    return;
  }
  if (!list.length) {
    grid.innerHTML = `<div class="empty card" style="grid-column:1/-1">${inventorySnapshot.length
      ? emptyState({ icon: 'search', title: 'Sin resultados', text: 'Prueba con otro nombre o código.' })
      : emptyState({ icon: 'package', title: 'Aún no hay productos', text: 'Agrega productos al inventario para empezar a vender.', actionHtml: '<button type="button" class="btn btn-primary" id="pos-go-inventory">Ir al inventario</button>' })}</div>`;
    $('pos-go-inventory')?.addEventListener('click', () => showModuleSection('sec-inventory'));
    return;
  }

  grid.innerHTML = list.map(p => {
    const inCart = cart.find(i => i.id === p.id)?.qty || 0;
    const out = p.stock <= 0;
    const low = !out && alertsOn && isLowStock(p);
    return `<button type="button" class="pos-item" data-id="${p.id}" ${out ? 'disabled' : ''}>
      ${inCart ? `<span class="in-cart">${inCart}</span>` : ''}
      <span class="pos-item-name">${escapeHtml(p.name)}</span>
      <span class="pos-item-meta">${out ? '<span class="badge badge-danger no-dot">Agotado</span>' : low ? `<span class="badge badge-warn no-dot">Stock bajo · ${p.stock}</span>` : `Stock: ${p.stock}`}</span>
      <span class="pos-item-price">${money(p.sale_price)}</span>
    </button>`;
  }).join('');
  grid.querySelectorAll('.pos-item').forEach(btn => btn.onclick = () => addToCart(btn.dataset.id, 1));
}

function addToCart(productId, qty = 1) {
  const product = inventorySnapshot.find(p => p.id === productId);
  if (!product || qty <= 0) return;
  if (qty > product.stock) return toast.err("Stock insuficiente.");

  const idx = cart.findIndex(i => i.id === productId);
  if (idx > -1) {
    if (cart[idx].qty + qty > product.stock) return toast.warn(`Excede el stock: solo hay ${product.stock} de «${product.name}».`);
    cart[idx].qty += qty;
    cart[idx].subtotal = cart[idx].qty * parseFloat(product.sale_price);
  } else {
    cart.push({
      id: product.id, name: product.name,
      cost: parseFloat(product.purchase_price), price: parseFloat(product.sale_price),
      qty: qty, subtotal: qty * parseFloat(product.sale_price)
    });
  }
  renderCart();
  renderPosCatalog();
}

function renderCart() {
  const box = $('cart-lines');
  let total = 0, count = 0;
  cart.forEach(item => { total += item.subtotal; count += item.qty; });

  box.innerHTML = cart.length ? cart.map((item, index) => `
    <div class="cart-line">
      <div class="cart-line-name">${escapeHtml(item.name)}</div>
      <div class="cart-line-total">${money(item.subtotal)}</div>
      <div class="cart-line-sub">${money(item.price)} c/u</div>
      <div style="display:flex;align-items:center;gap:6px;justify-content:flex-end">
        <div class="stepper" role="group" aria-label="Cantidad de ${escapeHtml(item.name)}">
          <button type="button" data-act="dec" data-index="${index}" aria-label="Quitar uno">${ico('minus', 'i-sm')}</button>
          <b>${item.qty}</b>
          <button type="button" data-act="inc" data-index="${index}" aria-label="Agregar uno">${ico('plus', 'i-sm')}</button>
        </div>
        <button type="button" class="btn btn-ghost btn-icon btn-sm btn-remove" data-act="rm" data-index="${index}" aria-label="Quitar ${escapeHtml(item.name)}">${ico('trash', 'i-sm')}</button>
      </div>
    </div>`).join('')
    : `<div class="cart-empty">${ico('cart')}<span>Toca un producto para agregarlo a la venta.</span></div>`;

  $('cart-total').textContent = fmtNum(total);
  $('cart-currency').textContent = money(0).replace(/[\d.,]+$/, '');
  $('cart-count').textContent = count;
  $('cartbar-count').textContent = count;
  $('cartbar-total').textContent = money(total);
  $('pos-cartbar').hidden = cart.length === 0;
  if (!cart.length) closeCartSheet();
}

$('cart-lines').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const index = parseInt(btn.dataset.index);
  const item = cart[index];
  if (!item) return;
  if (btn.dataset.act === 'rm') cart.splice(index, 1);
  if (btn.dataset.act === 'dec') { item.qty -= 1; if (item.qty <= 0) cart.splice(index, 1); else item.subtotal = item.qty * item.price; }
  if (btn.dataset.act === 'inc') {
    const product = inventorySnapshot.find(p => p.id === item.id);
    if (product && item.qty + 1 > product.stock) return toast.warn(`Excede el stock: solo hay ${product.stock} de «${item.name}».`);
    item.qty += 1; item.subtotal = item.qty * item.price;
  }
  renderCart();
  renderPosCatalog();
});

$('btn-clear-cart').onclick = () => { cart = []; renderCart(); renderPosCatalog(); };

// Hoja del carrito en pantallas chicas
function openCartSheet() { $('pos-cart').classList.add('open'); $('pos-cart-scrim').classList.remove('hidden'); }
function closeCartSheet() { $('pos-cart').classList.remove('open'); $('pos-cart-scrim').classList.add('hidden'); }
$('pos-cartbar').onclick = openCartSheet;
$('pos-cart-scrim').onclick = closeCartSheet;
$('btn-close-cart').onclick = closeCartSheet;

$('pos-search').addEventListener('input', (e) => { posQuery = e.target.value; renderPosCatalog(); });
// Enter agrega el producto si la búsqueda lo identifica (código exacto o un único resultado):
// pensado para lectores de código de barras.
$('pos-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = posQuery.trim().toLowerCase();
  if (!q) return;
  const exact = inventorySnapshot.find(p => String(p.sku || '').toLowerCase() === q);
  const matches = inventorySnapshot.filter(p => String(p.name).toLowerCase().includes(q));
  const pick = exact || (matches.length === 1 ? matches[0] : null);
  if (pick && pick.stock > 0) {
    addToCart(pick.id, 1);
    posQuery = ''; e.target.value = ''; renderPosCatalog();
  }
});

function initSales() {
  $('btn-process-sale').onclick = async (e) => {
    if (cart.length === 0) return toast.err("La venta está vacía: agrega al menos un producto.");

    const paymentMethod = $('sale-payment-method').value;
    const customerId = $('sale-customer-select').value;
    const creditDueDate = $('sale-credit-due-date').value;

    if (!paymentMethod) return toast.err("No hay un método de pago activo. Actívalo en Configuración.");
    if (paymentMethod === 'Crédito' && !customerId) {
      return toast.err("Debes seleccionar un cliente para procesar ventas a crédito.");
    }

    // Validar stock disponible de todo el carrito antes de registrar la venta
    for (const item of cart) {
      const currentProd = inventorySnapshot.find(p => p.id === item.id);
      if (!currentProd) {
        return toast.err(`El producto "${item.name}" ya no está disponible en el inventario.`);
      }
      if (currentProd.stock <= 0) {
        return toast.err(`El producto "${item.name}" está agotado.`);
      }
      if (item.qty > currentProd.stock) {
        return toast.err(`Stock insuficiente para "${item.name}". Disponible: ${currentProd.stock}, solicitado: ${item.qty}.`);
      }
    }

    const totalAmount = cart.reduce((acc, i) => acc + i.subtotal, 0);

    await withBusy(e.currentTarget, 'Procesando…', async () => {
      try {
        // Venta atómica: valida stock, crea la venta, registra la deuda (si aplica) y
        // descuenta el inventario dentro de una sola transacción en el servidor, para
        // evitar condiciones de carrera y escrituras parciales si algo falla a mitad de camino.
        const { data: saleData, error: saleErr } = await neon.rpc('process_sale', {
          p_business_id: currentBusinessId,
          p_items: cart,
          p_payment_method: paymentMethod,
          p_customer_id: paymentMethod === 'Crédito' ? customerId : null,
          p_credit_due_date: paymentMethod === 'Crédito' ? (creditDueDate || null) : null
        });

        if (saleErr) throw saleErr;

        // Generar automáticamente la factura de la venta, EXCEPTO en ventas a crédito:
        // esas solo quedan registradas como deuda: la factura se genera cuando el cliente abone.
        let invData = null, invErr = null;
        if (paymentMethod !== 'Crédito') {
          ({ data: invData, error: invErr } = await createInvoiceForSale(saleData, customerId));
        }

        cart = [];
        renderCart();
        closeCartSheet();
        $('sale-credit-due-date').value = '';
        $('sale-customer-select').value = '';
        await loadCredits();
        await logActivity(`Registró una venta por ${money(totalAmount)} (${paymentMethod})`);

        // refrescar historial de ventas, inventario y facturas
        salesHistory.unshift(saleData);
        calculateFinancialDashboard();
        await loadProducts();
        await loadInvoicesList();

        if (paymentMethod === 'Crédito') {
          toast.ok("Venta a crédito registrada en la cuenta del cliente. La factura se generará cuando pague.");
        } else if (invErr) {
          toast.warn(`Venta completada, pero hubo un error generando la factura: ${invErr.message}`);
        } else {
          await logActivity(`Generó automáticamente la factura ${invData.invoice_number}`);
          toast.ok(`Venta completada por ${money(totalAmount)}.`);
          openInvoiceModal(invData);
        }
      } catch (err) {
        toast.err("Error al procesar la venta: " + err.message);
      }
    });
  };
  renderCart();
}

// -------------------------------------------------------------
// 7. EQUIPO: EMPLEADOS E INVITACIONES (ADMIN)
// -------------------------------------------------------------
// Genera un código de invitación con aleatoriedad criptográfica (no Math.random, que no
// es apta para tokens de seguridad) y suficiente longitud para que adivinarlo por fuerza
// bruta sea inviable incluso antes de que expire (ver expires_at en employee_invites).
function generateSecureInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I/L, para evitar confusiones al escribirlo
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let code = 'EMP';
  bytes.forEach(b => code += alphabet[b % alphabet.length]);
  return code;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
}

function initEmployeeManagement() {
  $('btn-generate-invite').onclick = async (e) => {
    await withBusy(e.currentTarget, 'Generando…', async () => {
      const code = generateSecureInviteCode();
      const { error } = await neon.from('employee_invites').insert([{
        business_id: currentBusinessId,
        code: code
      }]);

      if (error) toast.err("Error generando código: " + error.message);
      else {
        const link = demoMode ? 'Enlace de demostración: no es válido' : `${siteBaseUrl()}?invite=${code}`;
        $('lbl-generated-link').textContent = link;
        $('lbl-generated-code').textContent = code;
        $('invite-code-display').classList.remove('hidden');
        await logActivity(`Generó un link de invitación para empleado`);
        loadInvites();
      }
    });
  };

  $('btn-copy-link').onclick = async () => {
    const ok = await copyText($('lbl-generated-link').textContent);
    ok ? toast.ok("Link copiado. Envíaselo a tu empleado por WhatsApp, correo, etc.") : toast.err("No pude copiarlo automáticamente: selecciona el link y cópialo a mano.");
  };

  $('btn-copy-code').onclick = async () => {
    const ok = await copyText($('lbl-generated-code').textContent);
    ok ? toast.ok("Código copiado.") : toast.err("No pude copiarlo automáticamente.");
  };

  $('employees-table-body').innerHTML = skeletonRows(7);
  return Promise.all([loadEmployeesList(), loadInvites()]);
}

// Invitaciones emitidas y su estado (solo las ve el admin; la regla de la base lo exige)
async function loadInvites() {
  if (!isAdmin()) return;
  const data = await readList('las invitaciones', () => neon.from('employee_invites').select('*').eq('business_id', currentBusinessId).order('created_at', { ascending: false }).limit(8));
  const box = $('invites-list');
  const list = (data || []).slice(0, 8);
  box.innerHTML = list.length ? list.map(inv => {
    const expired = !inv.used && inv.expires_at && new Date(inv.expires_at) < new Date();
    const badge = inv.used ? '<span class="badge badge-ok">Usada</span>' : expired ? '<span class="badge badge-danger">Vencida</span>' : '<span class="badge badge-warn">Pendiente</span>';
    return `<div class="invite-row"><div><code>${escapeHtml(inv.code)}</code><small>Creada ${fmtDate(inv.created_at)}${inv.used ? '' : ` · vence ${fmtDate(inv.expires_at)}`}</small></div>${badge}</div>`;
  }).join('') : '<p class="hint">Todavía no has generado invitaciones.</p>';
}

async function loadEmployeesList() {
  const data = await readList('el equipo', () => neon.from('business_members')
    .select('*')
    .eq('business_id', currentBusinessId)
    .eq('role', 'employee'));

  if (data) {
    employeesSnapshot = data;
    loaded.employees = true;
    const tbody = $('employees-table-body');
    $('employees-empty').classList.toggle('hidden', data.length > 0);
    $('employees-empty').innerHTML = data.length ? '' : emptyState({ icon: 'team', title: 'Aún no hay empleados', text: 'Genera un link de invitación y envíaselo a la persona que quieres sumar.' });
    tbody.innerHTML = '';
    data.forEach(m => {
      const perms = m.permissions || {};
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="cell-main"><input type="text" class="input-employee-name" data-id="${m.id}" value="${escapeHtml(m.employee_name)}" placeholder="Nombre" maxlength="150" aria-label="Nombre del empleado"><span class="badge badge-info">Empleado</span></td>
        <td data-label="Cargo"><input type="text" class="input-role-title" data-id="${m.id}" value="${escapeHtml(m.role_title)}" placeholder="Ej: Cajero" maxlength="50" aria-label="Cargo"></td>
        <td data-label="Ver Dashboard"><label class="switch"><input type="checkbox" class="chk-perm-dashboard" data-id="${m.id}" ${perms.ver_dashboard ? 'checked' : ''} aria-label="Puede ver el Dashboard"><span></span></label></td>
        <td data-label="Ver Facturas"><label class="switch"><input type="checkbox" class="chk-perm-reportes" data-id="${m.id}" ${perms.ver_reportes ? 'checked' : ''} aria-label="Puede ver las Facturas"><span></span></label></td>
        <td data-label="Agregado">${fmtDate(m.created_at)}</td>
        <td class="cell-actions"><button type="button" class="btn-remove-employee btn btn-sm btn-danger" data-id="${m.id}" data-name="${escapeHtml(m.employee_name || 'este empleado')}">${ico('trash', 'i-sm')}Eliminar</button></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.input-employee-name').forEach(input => {
      input.addEventListener('change', async (e) => {
        const newName = e.target.value.trim();
        const oldName = e.target.defaultValue;
        const { error } = await neon.from('business_members').update({ employee_name: newName }).eq('id', e.target.dataset.id);
        if (error) return toast.err("No se pudo guardar el nombre: " + error.message);
        await logActivity(`Cambió el nombre de un empleado a "${newName}"`, {
          entityType: 'employee', entityId: e.target.dataset.id,
          oldValues: { Nombre: oldName || '(sin nombre)' }, newValues: { Nombre: newName }
        });
        e.target.defaultValue = newName;
        toast.ok("Nombre actualizado.");
      });
    });

    tbody.querySelectorAll('.input-role-title').forEach(input => {
      input.addEventListener('change', async (e) => {
        const newTitle = e.target.value;
        const oldTitle = e.target.defaultValue;
        const { error } = await neon.from('business_members').update({ role_title: newTitle }).eq('id', e.target.dataset.id);
        if (error) return toast.err("No se pudo guardar el cargo: " + error.message);
        await logActivity(`Actualizó el cargo de un empleado a "${newTitle}"`, {
          entityType: 'employee', entityId: e.target.dataset.id,
          oldValues: { Cargo: oldTitle || '(sin cargo)' }, newValues: { Cargo: newTitle }
        });
        e.target.defaultValue = newTitle;
        toast.ok("Cargo actualizado.");
      });
    });

    const savePermission = async (checkbox, key, value, label) => {
      const id = checkbox.dataset.id;
      const member = data.find(m => m.id === id);
      const newPermissions = { ...(member?.permissions || {}), [key]: value };
      const { error } = await neon.from('business_members').update({ permissions: newPermissions }).eq('id', id);
      if (error) {
        checkbox.checked = !value; // se deshace en pantalla: no se guardó
        toast.err("Error al actualizar el permiso: " + error.message);
        return;
      }
      if (member) member.permissions = newPermissions;
      await logActivity(`${value ? 'Otorgó' : 'Quitó'} el permiso "${label}" a un empleado`, {
        entityType: 'employee', entityId: id
      });
      toast.ok(`Permiso «${label}» ${value ? 'otorgado' : 'retirado'}. Se aplica la próxima vez que inicie sesión.`);
    };

    tbody.querySelectorAll('.chk-perm-dashboard').forEach(chk => {
      chk.addEventListener('change', (e) => savePermission(e.target, 'ver_dashboard', e.target.checked, 'Ver Dashboard'));
    });
    tbody.querySelectorAll('.chk-perm-reportes').forEach(chk => {
      chk.addEventListener('change', (e) => savePermission(e.target, 'ver_reportes', e.target.checked, 'Ver Facturas'));
    });

    tbody.querySelectorAll('.btn-remove-employee').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.dataset.id;
        const name = e.currentTarget.dataset.name;
        const ok = await confirmDialog({
          title: `¿Eliminar a ${name}?`,
          message: 'Perderá el acceso al negocio de inmediato. Podrás invitarlo de nuevo cuando quieras.',
          confirmLabel: 'Eliminar empleado', danger: true
        });
        if (!ok) return;
        const { error } = await neon.from('business_members').delete().eq('id', id);
        if (error) return toast.err("Error al eliminar empleado: " + error.message);
        await logActivity(`Eliminó al empleado "${name}"`);
        toast.ok(`${name} ya no tiene acceso.`);
        await loadEmployeesList();
      });
    });
  }
}

// -------------------------------------------------------------
// 8. DASHBOARD FINANCIERO Y CÁLCULOS
// -------------------------------------------------------------
// % de cambio contra el período anterior (ayer, semana pasada, mes pasado)
function computeTrendPct(current, previous) {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

// invert=true para métricas donde subir es malo (ej. gastos)
function renderTrendBadge(elementId, pct, invert = false) {
  const el = $(elementId);
  if (!el) return;
  const isIncrease = pct >= 0;
  const isGood = invert ? !isIncrease : isIncrease;
  el.classList.toggle('trend-up', isGood);
  el.classList.toggle('trend-down', !isGood);
  el.textContent = `${isIncrease ? '↑' : '↓'} ${Math.abs(pct).toFixed(0)}%`;
}

const PERIOD_LEAD = {
  today: 'Resumen de hoy, comparado con ayer.',
  week: 'Resumen de los últimos 7 días, comparado con los 7 anteriores.',
  month: 'Resumen de este mes, comparado con el mes pasado.'
};

function calculateFinancialDashboard() {
  const now = new Date();
  let filteredSales = [];
  let prevSales = [];

  // Un abono a crédito no es una venta nueva: el ingreso (y la ganancia) ya se contaron
  // por completo cuando se otorgó el crédito. Si también se suma aquí, la misma plata
  // queda contada dos veces en Ventas Brutas y Ganancia Neta.
  const revenueHistory = salesHistory.filter(s => s.payment_method !== 'Abono Crédito');

  revenueHistory.forEach(s => {
    const d = new Date(s.created_at);
    if (activePeriod === 'today') {
      if (d.toDateString() === now.toDateString()) filteredSales.push(s);
      const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
      if (d.toDateString() === yesterday.toDateString()) prevSales.push(s);
    } else if (activePeriod === 'week') {
      const diffDays = Math.ceil(Math.abs(now - d) / (1000 * 60 * 60 * 24));
      if (diffDays <= 7) filteredSales.push(s);
      else if (diffDays > 7 && diffDays <= 14) prevSales.push(s);
    } else if (activePeriod === 'month') {
      if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) filteredSales.push(s);
      const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      if (d.getMonth() === prevMonthDate.getMonth() && d.getFullYear() === prevMonthDate.getFullYear()) prevSales.push(s);
    }
  });

  const grossSales = filteredSales.reduce((acc, s) => acc + parseFloat(s.total), 0);
  const netProfit = filteredSales.reduce((acc, s) => acc + parseFloat(s.profit), 0);
  const expenses = grossSales - netProfit;

  const prevGrossSales = prevSales.reduce((acc, s) => acc + parseFloat(s.total), 0);
  const prevNetProfit = prevSales.reduce((acc, s) => acc + parseFloat(s.profit), 0);
  const prevExpenses = prevGrossSales - prevNetProfit;

  renderTrendBadge('trend-sales', computeTrendPct(grossSales, prevGrossSales));
  renderTrendBadge('trend-profit', computeTrendPct(netProfit, prevNetProfit));
  renderTrendBadge('trend-expenses', computeTrendPct(expenses, prevExpenses), true);

  // Cálculo Métrica Cuentas por Cobrar
  const openCredits = creditsSnapshot.filter(cr => cr.status !== 'pagado');
  const totalReceivables = openCredits.reduce((acc, cr) => acc + pendingOf(cr), 0);
  const debtors = new Set(openCredits.map(cr => cr.customer_id)).size;

  $('dash-receivables').textContent = money(totalReceivables);
  $('dash-receivables-sub').textContent = debtors ? `${debtors} ${debtors === 1 ? 'cliente' : 'clientes'} con saldo` : 'Sin saldos pendientes';
  $('dash-lead').textContent = PERIOD_LEAD[activePeriod];

  animateCounter('dash-net-profit', netProfit);
  $('dash-gross-sales').textContent = money(grossSales);
  $('dash-expenses').textContent = money(expenses);

  const profitRatio = grossSales > 0 ? ((netProfit / grossSales) * 100).toFixed(0) : 0;
  $('dash-profit-ratio').textContent = `${profitRatio}% de las ventas`;

  // Tarjetas informativas adicionales del Dashboard (no deben interrumpir el resto si fallan)
  try { renderOverdueCredits(); } catch (e) { console.error('renderOverdueCredits:', e); }
  try { renderLowStock(); } catch (e) { console.error('renderLowStock:', e); }
  try { renderTopProducts(filterInvoicesByPeriod(invoicesSnapshot, activePeriod)); } catch (e) { console.error('renderTopProducts:', e); }
  try { renderPaymentBreakdown(filteredSales); } catch (e) { console.error('renderPaymentBreakdown:', e); }
  try { renderRecentActivity(); } catch (e) { console.error('renderRecentActivity:', e); }

  lastDash = { sales: filteredSales };
  try { drawDashboardCharts(); } catch (e) { console.error('drawDashboardCharts:', e); }
}

// Lista los créditos vencidos (fecha límite pasada, aún no pagados en su totalidad)
function renderOverdueCredits() {
  const list = $('dash-overdue-credits-list');
  if (!list) return;

  const overdue = creditsSnapshot.filter(cr => cr.status !== 'pagado' && cr.due_date && isPastDueDate(cr.due_date));
  if (overdue.length === 0) {
    list.innerHTML = `<div class="alert-none">${ico('check-circle')}Sin créditos vencidos.</div>`;
  } else {
    list.innerHTML = overdue.slice(0, 5).map(cr => {
      const customer = customersSnapshot.find(c => c.id === cr.customer_id);
      return `<div class="alert-item is-danger"><span>${escapeHtml(customer?.name || 'Cliente')} · venció ${formatDateOnly(cr.due_date)}</span><b>${money(pendingOf(cr))}</b></div>`;
    }).join('') + (overdue.length > 5 ? `<button type="button" class="link-btn" data-go="sec-receivables">Ver los ${overdue.length} vencidos</button>` : '');
    list.querySelector('[data-go]')?.addEventListener('click', () => showModuleSection('sec-receivables'));
  }
  updateAlertsCount();
}

// Productos con stock bajo o agotados
function renderLowStock() {
  const list = $('dash-low-stock-list');
  if (!list) return;
  const low = inventorySnapshot.filter(isLowStock).sort((a, b) => a.stock - b.stock);
  if (low.length === 0) {
    list.innerHTML = `<div class="alert-none">${ico('check-circle')}Todo el inventario está por encima del mínimo.</div>`;
  } else {
    list.innerHTML = low.slice(0, 5).map(p =>
      `<div class="alert-item ${p.stock <= 0 ? 'is-danger' : 'is-warn'}"><span>${escapeHtml(p.name)}</span><b>${p.stock <= 0 ? 'Agotado' : `${p.stock} uds.`}</b></div>`
    ).join('') + (low.length > 5 ? `<button type="button" class="link-btn" data-go="sec-inventory">Ver los ${low.length} productos</button>` : '');
    list.querySelector('[data-go]')?.addEventListener('click', () => showModuleSection('sec-inventory'));
  }
  updateAlertsCount();
}

function updateAlertsCount() {
  const badge = $('dash-alerts-count');
  if (!badge) return;
  const n = inventorySnapshot.filter(isLowStock).length + creditsSnapshot.filter(cr => cr.status !== 'pagado' && cr.due_date && isPastDueDate(cr.due_date)).length;
  badge.textContent = n ? `${n} por atender` : 'Todo en orden';
  badge.className = 'badge no-dot ' + (n ? 'badge-coral' : 'badge-ok');
}

// Top 5 productos más vendidos (por cantidad), calculado a partir de las FACTURAS
// (no de las ventas crudas) dentro del período activo del Dashboard. Así solo cuenta
// lo realmente facturado/cobrado, igual que la Ganancia Neta.
function renderTopProducts(invoices) {
  const list = $('dash-top-products-list');
  if (!list) return;

  const totals = {};
  invoices.forEach(inv => {
    (inv.items || []).forEach(item => {
      if (!item.id) return; // ignora ítems que no son productos del inventario (ej. abonos a crédito)
      const key = item.name || 'Producto';
      if (!totals[key]) totals[key] = { qty: 0, revenue: 0 };
      totals[key].qty += parseFloat(item.qty) || 0;
      totals[key].revenue += parseFloat(item.subtotal) || 0;
    });
  });

  const top = Object.entries(totals).sort((a, b) => b[1].qty - a[1].qty).slice(0, 5);
  if (top.length === 0) {
    list.innerHTML = `<div class="empty" style="padding:24px 8px">${emptyState({ icon: 'package', title: 'Sin ventas en este período' })}</div>`;
    return;
  }
  const max = top[0][1].qty || 1;
  list.innerHTML = top.map(([name, t], i) => `
    <div class="rank-row">
      <span class="rank-pos">${i + 1}</span>
      <span class="rank-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <span class="rank-val">${t.qty} uds. · ${money(t.revenue)}</span>
      <div class="progress"><i style="width:${Math.round((t.qty / max) * 100)}%"></i></div>
    </div>`).join('');
}

// Desglose de ventas por método de pago dentro del período activo del Dashboard
function renderPaymentBreakdown(sales) {
  const el = $('dash-payment-breakdown');
  if (!el) return;

  const totals = {};
  sales.forEach(s => {
    const method = s.payment_method || 'Otro';
    totals[method] = (totals[method] || 0) + parseFloat(s.total);
  });

  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    el.innerHTML = '<p class="hint" style="text-align:center">Sin ventas en este período.</p>';
    return;
  }
  const palette = chartPalette();
  const colors = [palette.c1, palette.c2, palette.c3, palette.c4, palette.c5];
  el.innerHTML = entries.map(([method, total], i) => `
    <div class="pay-row"><i style="background:${colors[i % colors.length]}"></i><span>${escapeHtml(method)}</span><b class="num">${money(total)}</b></div>
  `).join('');
}

// Las últimas ventas y abonos registrados
function renderRecentActivity() {
  const el = $('dash-recent-list');
  if (!el) return;
  const recent = salesHistory.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 6);
  if (!recent.length) {
    el.innerHTML = `<div class="empty" style="padding:24px 8px">${emptyState({ icon: 'receipt', title: 'Aún no hay ventas', text: 'Tus ventas y abonos aparecerán aquí.' })}</div>`;
    return;
  }
  el.innerHTML = recent.map(s => {
    const isPayment = s.payment_method === 'Abono Crédito';
    const isCredit = s.payment_method === 'Crédito';
    const items = (s.items || []);
    const title = isPayment ? 'Abono recibido' : (items.length === 1 ? `${items[0].name}${items[0].qty > 1 ? ` ×${items[0].qty}` : ''}` : `${items.length || 1} productos`);
    const icon = isPayment ? 'check-circle' : isCredit ? 'clock' : 'cart';
    const tone = isPayment ? 'is-teal' : isCredit ? 'is-coral' : '';
    return `<div class="activity-item"><span class="activity-ico ${tone}">${ico(icon)}</span><span class="activity-main"><b>${escapeHtml(title)}</b><small>${escapeHtml(isPayment ? 'Cobro a crédito' : s.payment_method)} · ${timeAgo(s.created_at)}</small></span><span class="activity-amount">${money(s.total)}</span></div>`;
  }).join('');
}

function animateCounter(elementId, targetVal) {
  const el = $(elementId);
  if (!el) return;
  if (prefersReducedMotion()) { el.textContent = money(targetVal); return; }
  const duration = 800;
  const startTime = performance.now();

  function update(currentTime) {
    const progress = Math.min((currentTime - startTime) / duration, 1);
    el.textContent = money(targetVal * progress);
    if (progress < 1) requestAnimationFrame(update);
    else el.textContent = money(targetVal);
  }
  requestAnimationFrame(update);
}

// ---------- Gráficos (los colores salen de los tokens del tema activo) ----------
function chartReady() { return typeof window.Chart === 'function'; }
function applyChartDefaults(p) {
  try {
    window.Chart.defaults.color = p.text;
    window.Chart.defaults.font.family = p.font;
    window.Chart.defaults.font.size = 12;
  } catch (e) { /* ignorar */ }
}
function destroyChart(key) { if (charts[key]) { try { charts[key].destroy(); } catch (e) { /* ignorar */ } charts[key] = null; } }

// Agrupa las ventas del período en barras: por hora (hoy) o por día (semana / mes)
function bucketSales(sales) {
  const now = new Date();
  const rows = [];
  if (activePeriod === 'today') {
    const hours = sales.map(s => new Date(s.created_at).getHours());
    const lo = Math.min(6, ...(hours.length ? hours : [6]));
    const hi = Math.max(21, ...(hours.length ? hours : [21]));
    for (let h = lo; h <= hi; h++) rows.push({ key: h, label: `${h}h` });
    const idx = (d) => d.getHours();
    return fill(rows, sales, idx);
  }
  if (activePeriod === 'week') {
    for (let i = 7; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      rows.push({ key: d.toDateString(), label: d.toLocaleDateString('es', { weekday: 'short', day: 'numeric' }) });
    }
    const out = fill(rows, sales, (d) => d.toDateString());
    // el primer día solo entra si hubo ventas (la ventana de 7 días puede tocar 8 fechas)
    if (out.sales[0] === 0) { out.labels.shift(); out.sales.shift(); out.cost.shift(); out.profit.shift(); }
    return out;
  }
  const last = now.getDate();
  for (let day = 1; day <= last; day++) rows.push({ key: day, label: String(day) });
  return fill(rows, sales, (d) => d.getDate());
}
function fill(rows, sales, keyOf) {
  const map = new Map(rows.map((r, i) => [r.key, i]));
  const out = { labels: rows.map(r => r.label), sales: rows.map(() => 0), cost: rows.map(() => 0), profit: rows.map(() => 0) };
  sales.forEach(s => {
    const i = map.get(keyOf(new Date(s.created_at)));
    if (i === undefined) return;
    const total = parseFloat(s.total), profit = parseFloat(s.profit);
    out.sales[i] += total; out.profit[i] += profit; out.cost[i] += total - profit;
  });
  return out;
}

function drawDashboardCharts() {
  if (!lastDash) return;
  const sales = lastDash.sales;
  const p = chartPalette();
  const hasSales = sales.length > 0;

  $('chartTrend-empty').classList.toggle('hidden', hasSales);
  $('chartTrend').closest('.chart-box').classList.toggle('hidden', !hasSales);
  $('chartPayments').closest('.chart-box').classList.toggle('hidden', !hasSales);
  renderPaymentBreakdown(sales); // vuelve a pintar los puntos de color con el tema activo

  destroyChart('trend');
  destroyChart('pay');
  if (!chartReady() || !hasSales) return;
  applyChartDefaults(p);

  const b = bucketSales(sales);
  const curr = money(0).replace(/[\d.,]+$/, '');
  charts.trend = new window.Chart($('chartTrend'), {
    data: {
      labels: b.labels,
      datasets: [
        { type: 'bar', label: 'Ventas', data: b.sales, backgroundColor: p.c1, borderRadius: 6, maxBarThickness: 28, order: 2 },
        { type: 'bar', label: 'Costo', data: b.cost, backgroundColor: p.c3, borderRadius: 6, maxBarThickness: 28, order: 2 },
        { type: 'line', label: 'Ganancia', spanGaps: true, data: b.profit.map((v, i) => (b.sales[i] || b.cost[i]) ? v : null), borderColor: p.c2, backgroundColor: p.c2, borderWidth: 2.5, pointRadius: 3, pointHoverRadius: 5, tension: .35, order: 1 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: prefersReducedMotion() ? false : { duration: 600 },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${curr}${fmtNum(c.parsed.y)}` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: p.text, maxRotation: 0, autoSkip: true } },
        y: { beginAtZero: true, grid: { color: p.grid }, border: { display: false }, ticks: { color: p.text, callback: (v) => curr + Number(v).toLocaleString('en-US') } }
      }
    }
  });

  const totals = {};
  sales.forEach(s => { const m = s.payment_method || 'Otro'; totals[m] = (totals[m] || 0) + parseFloat(s.total); });
  const entries = Object.entries(totals).sort((a, b2) => b2[1] - a[1]);
  const colors = [p.c1, p.c2, p.c3, p.c4, p.c5];
  charts.pay = new window.Chart($('chartPayments'), {
    type: 'doughnut',
    data: { labels: entries.map(e => e[0]), datasets: [{ data: entries.map(e => e[1]), backgroundColor: entries.map((_, i) => colors[i % colors.length]), borderColor: p.surface, borderWidth: 3, hoverOffset: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '68%',
      animation: prefersReducedMotion() ? false : { duration: 600 },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${curr}${fmtNum(c.parsed)}` } } }
    }
  });
}

// -------------------------------------------------------------
// 8b. REGISTRO DE ACTIVIDAD (BITÁCORA)
// -------------------------------------------------------------
// details opcional: { entityType, entityId, oldValues, newValues } para dejar constancia
// de qué cambió exactamente (ej. precio de un producto antes/después).
async function logActivity(action, details = {}) {
  if (!currentBusinessId) return;
  try {
    const { data: { user } } = await neon.auth.getUser();
    await neon.from('activity_log').insert([{
      business_id: currentBusinessId,
      user_name: user?.email || 'Desconocido',
      action: action,
      entity_type: details.entityType || null,
      entity_id: details.entityId || null,
      old_values: details.oldValues || null,
      new_values: details.newValues || null
    }]);
  } catch (e) {
    console.error('logActivity:', e);
  }
}

// Arma un texto compacto "campo: antes → después" para los campos que cambiaron
function describeChanges(oldValues, newValues) {
  if (!oldValues || !newValues) return '';
  const changes = Object.keys(newValues)
    .filter(k => String(oldValues[k] ?? '') !== String(newValues[k] ?? ''))
    .map(k => `${escapeHtml(k)}: ${escapeHtml(oldValues[k] ?? '—')} → ${escapeHtml(newValues[k] ?? '—')}`);
  return changes.length ? ` (${changes.join(', ')})` : '';
}

async function loadActivityLog() {
  const tbody = $('activity-log-table-body');
  tbody.innerHTML = skeletonRows(3);
  const data = await readList('el registro de actividad', () => neon.from('activity_log').select('*').eq('business_id', currentBusinessId).order('created_at', { ascending: false }).limit(30));
  tbody.innerHTML = '';
  if (data && data.length) {
    data.forEach(log => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="cell-main">${escapeHtml(log.user_name || 'Sistema')}</td><td data-label="Acción">${escapeHtml(log.action)}${describeChanges(log.old_values, log.new_values)}</td><td data-label="Fecha y hora">${fmtDateTime(log.created_at)}</td>`;
      tbody.appendChild(tr);
    });
  } else {
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty">${emptyState({ icon: 'activity', title: 'Sin actividad registrada' })}</div></td></tr>`;
  }
}

// -------------------------------------------------------------
// 8c. CONFIGURACIÓN CENTRALIZADA (ADMIN)
// -------------------------------------------------------------
function loadSettingsIntoForm() {
  const b = currentBusinessData || {};
  $('cfg-name').value = b.name || '';
  $('cfg-legal-name').value = b.legal_name || '';
  $('cfg-tax-id').value = b.tax_id || '';
  $('cfg-phone').value = b.phone || '';
  $('cfg-address').value = b.address || '';
  populateCurrencyOptions(b.currency_symbol || '$');
  $('cfg-currency-symbol').value = b.currency_symbol || '$';
  renderPrefsForm();

  const taxEnabled = b.tax_enabled || false;
  $('cfg-tax-enabled').checked = taxEnabled;
  $('cfg-tax-details').classList.toggle('expanded', taxEnabled);
  $('cfg-tax-percentage').value = b.tax_percentage || 0;

  document.querySelectorAll('.radio-tax-mode').forEach(c => c.classList.remove('selected'));
  const modeSel = b.tax_included_in_price ? 'included' : 'added';
  document.querySelector(`.radio-tax-mode[data-mode="${modeSel}"]`)?.classList.add('selected');

  const pm = b.payment_methods || { efectivo: true, transferencia: true, tarjeta: true, credito: true };
  $('cfg-pm-efectivo').checked = pm.efectivo !== false;
  $('cfg-pm-transferencia').checked = pm.transferencia !== false;
  $('cfg-pm-tarjeta').checked = pm.tarjeta !== false;
  $('cfg-pm-credito').checked = pm.credito !== false;

  $('cfg-global-low-stock').checked = b.global_low_stock_alert !== false;

  $('cfg-logo-preview').src = b.logo_url || 'logo.png';
  logoMarkedForRemoval = false;
}

let logoMarkedForRemoval = false;
$('btn-remove-logo').onclick = async () => {
  const ok = await confirmDialog({ title: '¿Eliminar el logotipo?', message: 'Se usará el logotipo de AINova hasta que subas otro. Se aplica al guardar.', confirmLabel: 'Eliminar', danger: true });
  if (!ok) return;
  logoMarkedForRemoval = true;
  $('cfg-logo-file').value = '';
  $('cfg-logo-preview').src = 'logo.png';
};

// El logo se reduce a 256 px y se guarda como imagen incrustada en la propia fila del
// negocio (logo_url). Así no hace falta un servicio de archivos aparte, y la factura lo
// dibuja sin problemas de permisos entre dominios. Pasa de unos 200 KB de PNG a JPEG.
function fileToLogoDataUrl(file, maxSide = 256) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      let dataUrl = canvas.toDataURL('image/png');
      if (dataUrl.length > 200000) {
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      }
      URL.revokeObjectURL(url);
      resolve(dataUrl);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen.')); };
    img.src = url;
  });
}

$('form-cfg-business').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submit = e.currentTarget.querySelector('button[type=submit]');
  await withBusy(submit, 'Guardando…', async () => {
    let logoUrl = logoMarkedForRemoval ? null : (currentBusinessData?.logo_url || null);

    const fileInput = $('cfg-logo-file');
    if (fileInput.files.length > 0) {
      try {
        logoUrl = await fileToLogoDataUrl(fileInput.files[0]);
      } catch (err) {
        toast.err("Error preparando el logo: " + err.message);
      }
    }

    const updates = {
      name: $('cfg-name').value,
      legal_name: $('cfg-legal-name').value,
      tax_id: $('cfg-tax-id').value,
      phone: $('cfg-phone').value,
      address: $('cfg-address').value,
      logo_url: logoUrl,
      updated_at: new Date()
    };

    const oldData = currentBusinessData || {};
    const { error } = await neon.from('businesses').update(updates).eq('id', currentBusinessId);
    if (error) return toast.err("Error: " + error.message);

    setBusiness({ ...currentBusinessData, ...updates });
    logoMarkedForRemoval = false;
    $('business-display-name').textContent = businessName();
    $('user-avatar').textContent = initials(businessName());
    applyLogoToHeader();
    await logActivity('Actualizó los datos del negocio', {
      entityType: 'business', entityId: currentBusinessId,
      oldValues: { Nombre: oldData.name, 'Nombre Legal': oldData.legal_name, Teléfono: oldData.phone, Dirección: oldData.address },
      newValues: { Nombre: updates.name, 'Nombre Legal': updates.legal_name, Teléfono: updates.phone, Dirección: updates.address }
    });
    toast.ok("Datos del negocio guardados.");
  });
});

$('form-cfg-tax').addEventListener('submit', async (e) => {
  e.preventDefault();
  const isIncluded = document.querySelector('.radio-tax-mode.selected')?.dataset.mode === 'included';
  const updates = {
    currency_symbol: $('cfg-currency-symbol').value,
    tax_enabled: $('cfg-tax-enabled').checked,
    tax_percentage: parseFloat($('cfg-tax-percentage').value) || 0,
    tax_included_in_price: isIncluded,
    updated_at: new Date()
  };
  const { error } = await neon.from('businesses').update(updates).eq('id', currentBusinessId);
  if (error) return toast.err("Error: " + error.message);
  setBusiness({ ...currentBusinessData, ...updates });
  refreshCurrencyViews();
  await logActivity('Actualizó moneda e impuestos');
  toast.ok("Configuración fiscal guardada.");
});

$('form-cfg-payments').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payment_methods = {
    efectivo: $('cfg-pm-efectivo').checked,
    transferencia: $('cfg-pm-transferencia').checked,
    tarjeta: $('cfg-pm-tarjeta').checked,
    credito: $('cfg-pm-credito').checked
  };
  const { error } = await neon.from('businesses').update({ payment_methods, updated_at: new Date() }).eq('id', currentBusinessId);
  if (error) return toast.err("Error: " + error.message);
  currentBusinessData.payment_methods = payment_methods;
  renderPayMethods();
  await logActivity('Actualizó métodos de pago');
  toast.ok("Métodos de pago guardados.");
});

$('form-cfg-alerts').addEventListener('submit', async (e) => {
  e.preventDefault();
  const val = $('cfg-global-low-stock').checked;
  const { error } = await neon.from('businesses').update({ global_low_stock_alert: val, updated_at: new Date() }).eq('id', currentBusinessId);
  if (error) return toast.err("Error: " + error.message);
  currentBusinessData.global_low_stock_alert = val;
  renderPosCatalog();
  await logActivity('Actualizó alerta de stock bajo');
  toast.ok("Ajustes de inventario guardados.");
});

// -------------------------------------------------------------
// 9. FACTURAS, INVENTARIO Y REPORTES
// -------------------------------------------------------------
function initInvoices() {
  $('invoices-table-body').innerHTML = skeletonRows(5);
  const loading = loadInvoicesList();

  document.querySelectorAll('#report-period button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#report-period button').forEach(b => b.classList.toggle('is-active', b === btn));
      reportPeriod = btn.dataset.rperiod;
      renderReports();
    });
  });
  $('invoice-search').addEventListener('input', renderReports);
  $('btn-export-invoices').onclick = exportInvoicesCsv;
  return loading;
}

// Calcula impuestos y genera la factura correspondiente a una venta.
// Se invoca automáticamente al completar cualquier venta (Efectivo, Tarjeta,
// Transferencia o Crédito), garantizando la relación 1:1 Venta-Factura.
async function createInvoiceForSale(sale, customerId) {
  const taxEnabled = currentBusinessData?.tax_enabled;
  const taxRate = taxEnabled ? (currentBusinessData.tax_percentage / 100) : 0;
  let subtotal = sale.total;
  let taxAmount = 0;

  if (taxEnabled) {
    if (currentBusinessData.tax_included_in_price) {
      subtotal = sale.total / (1 + taxRate);
      taxAmount = sale.total - subtotal;
    } else {
      taxAmount = sale.total * taxRate;
    }
  }
  const total = subtotal + taxAmount;
  const invoiceNumber = (demoMode ? 'DEMO-' : 'FAC-') + Math.floor(100000 + Math.random() * 900000);

  return neon.from('invoices').insert([{
    business_id: currentBusinessId,
    sale_id: sale.id,
    customer_id: customerId || null,
    invoice_number: invoiceNumber,
    items: sale.items || [],
    subtotal: subtotal,
    tax_amount: taxAmount,
    total: total
  }]).select().single();
}

async function loadInvoicesList() {
  const data = await readList('las facturas', () => neon.from('invoices').select('*').eq('business_id', currentBusinessId).order('created_at', { ascending: false }));
  if (data) invoicesSnapshot = data;
  loaded.invoices = true;
  try { renderTopProducts(filterInvoicesByPeriod(invoicesSnapshot, activePeriod)); } catch (e) { console.error('renderTopProducts:', e); }
  renderReports();
}

// Filtra facturas por período (Hoy/Semana/Mes) igual que las ventas del Dashboard; 'all' no filtra
function filterInvoicesByPeriod(invoices, period) {
  const now = new Date();
  return invoices.filter(inv => {
    const d = new Date(inv.created_at);
    if (period === 'today') return d.toDateString() === now.toDateString();
    if (period === 'week') return Math.ceil(Math.abs(now - d) / (1000 * 60 * 60 * 24)) <= 7;
    if (period === 'month') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    return true;
  });
}

const customerNameOf = (id) => customersSnapshot.find(c => c.id === id)?.name || '';

function visibleInvoices() {
  const q = $('invoice-search').value.trim().toLowerCase();
  return filterInvoicesByPeriod(invoicesSnapshot, reportPeriod).filter(inv =>
    !q || String(inv.invoice_number).toLowerCase().includes(q) || customerNameOf(inv.customer_id).toLowerCase().includes(q));
}

function renderReports() {
  const tbody = $('invoices-table-body');
  if (!tbody || !loaded.invoices) return;
  const list = visibleInvoices();
  const total = list.reduce((a, i) => a + parseFloat(i.total), 0);

  $('rep-count').textContent = list.length;
  $('rep-total').textContent = money(total);
  $('rep-avg').textContent = money(list.length ? total / list.length : 0);

  tbody.innerHTML = list.map(inv => `
    <tr>
      <td class="cell-main"><b>${escapeHtml(inv.invoice_number)}</b></td>
      <td data-label="Fecha">${fmtDate(inv.created_at)}</td>
      <td data-label="Cliente">${escapeHtml(customerNameOf(inv.customer_id)) || '<span class="muted">Cliente general</span>'}</td>
      <td class="num" data-label="Total"><b>${money(inv.total)}</b></td>
      <td class="cell-actions"><button type="button" class="btn btn-sm btn-view-invoice" data-id="${inv.id}">Ver</button></td>
    </tr>`).join('');

  const empty = $('invoices-empty');
  if (!list.length) {
    empty.classList.remove('hidden');
    empty.innerHTML = invoicesSnapshot.length
      ? emptyState({ icon: 'search', title: 'Sin facturas para este filtro', text: 'Cambia el período o la búsqueda.' })
      : emptyState({ icon: 'file', title: 'Aún no hay facturas', text: 'Se crean solas con cada venta y con cada abono.' });
  } else {
    empty.classList.add('hidden');
  }

  tbody.querySelectorAll('.btn-view-invoice').forEach(btn => {
    btn.onclick = (e) => {
      const inv = invoicesSnapshot.find(i => i.id === e.currentTarget.dataset.id);
      if (inv) openInvoiceModal(inv);
    };
  });
  renderSalesTrend();
}

// Tendencia de ventas de los últimos 30 días (sin contar abonos, que no son ventas nuevas)
function renderSalesTrend() {
  const canvas = $('salesChart');
  if (!canvas) return;
  const now = new Date();
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
  const idx = new Map(days.map((d, i) => [d.toDateString(), i]));
  const totals = days.map(() => 0);
  salesHistory.filter(s => s.payment_method !== 'Abono Crédito').forEach(s => {
    const i = idx.get(new Date(s.created_at).toDateString());
    if (i !== undefined) totals[i] += parseFloat(s.total);
  });
  const hasData = totals.some(v => v > 0);
  $('salesChart-empty').classList.toggle('hidden', hasData);
  canvas.closest('.chart-box').classList.toggle('hidden', !hasData);
  destroyChart('sales');
  if (!hasData || !chartReady()) return;

  const p = chartPalette();
  applyChartDefaults(p);
  const curr = money(0).replace(/[\d.,]+$/, '');
  charts.sales = new window.Chart(canvas, {
    type: 'line',
    data: {
      labels: days.map(d => d.toLocaleDateString('es', { day: 'numeric', month: 'short' })),
      datasets: [{ label: 'Ventas', data: totals, borderColor: p.c1, backgroundColor: p.c1 + '26', fill: true, borderWidth: 2.5, tension: .35, pointRadius: 0, pointHoverRadius: 5 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: prefersReducedMotion() ? false : { duration: 600 },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `Ventas: ${curr}${fmtNum(c.parsed.y)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: p.text, maxTicksLimit: 8, maxRotation: 0 } },
        y: { beginAtZero: true, grid: { color: p.grid }, border: { display: false }, ticks: { color: p.text, callback: (v) => curr + Number(v).toLocaleString('en-US') } }
      }
    }
  });
}

// Exporta a CSV las facturas que se ven (período + búsqueda). Los textos que empiezan con
// = + - @ se neutralizan para que una hoja de cálculo no los interprete como fórmula.
function exportInvoicesCsv() {
  const list = visibleInvoices();
  if (!list.length) return toast.info("No hay facturas para exportar con este filtro.");
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const rows = [['N° factura', 'Fecha', 'Cliente', 'Subtotal', 'Impuesto', 'Total']].concat(list.map(inv => [
    inv.invoice_number, fmtDate(inv.created_at), customerNameOf(inv.customer_id) || 'Cliente general',
    parseFloat(inv.subtotal).toFixed(2), parseFloat(inv.tax_amount).toFixed(2), parseFloat(inv.total).toFixed(2)
  ]));
  const csv = '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `facturas-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast.ok(`${list.length} ${list.length === 1 ? 'factura exportada' : 'facturas exportadas'}.`);
}

// -------------------------------------------------------------
// 9b. FACTURA: vista previa editable, generada como imagen dentro de la web
// -------------------------------------------------------------
function addInvoiceItemRow(item) {
  const tbody = $('inv-items-body');
  const tr = document.createElement('tr');
  const qty = item?.qty ?? 1;
  const price = item?.price ?? 0;
  tr.innerHTML = `
    <td class="invoice-editable" contenteditable="true">${escapeHtml(item?.name)}</td>
    <td class="num invoice-editable inv-qty" contenteditable="true">${qty}</td>
    <td class="num invoice-editable inv-price" contenteditable="true">${parseFloat(price).toFixed(2)}</td>
    <td class="num inv-line-total">0.00</td>
    <td><button type="button" class="btn-remove-item" aria-label="Quitar línea">✕</button></td>
  `;
  tbody.appendChild(tr);

  tr.querySelectorAll('.inv-qty, .inv-price').forEach(cell => {
    cell.addEventListener('input', recalcInvoiceTotals);
  });
  tr.querySelector('.btn-remove-item').onclick = () => { tr.remove(); recalcInvoiceTotals(); };
  recalcInvoiceTotals();
}

function recalcInvoiceTotals() {
  let subtotal = 0;
  document.querySelectorAll('#inv-items-body tr').forEach(tr => {
    const qty = parseFloat(tr.querySelector('.inv-qty').textContent) || 0;
    const price = parseFloat(tr.querySelector('.inv-price').textContent) || 0;
    const lineTotal = qty * price;
    tr.querySelector('.inv-line-total').textContent = lineTotal.toFixed(2);
    subtotal += lineTotal;
  });

  const taxEnabled = currentBusinessData?.tax_enabled;
  const taxRate = taxEnabled ? (currentBusinessData.tax_percentage / 100) : 0;
  const taxAmount = subtotal * taxRate;
  const total = subtotal + taxAmount;

  $('inv-subtotal').textContent = money(subtotal);
  $('inv-tax').textContent = money(taxAmount);
  $('inv-total').textContent = money(total);
}

function openInvoiceModal(invoice) {
  const b = currentBusinessData || {};

  $('inv-biz-name').textContent = businessName();
  $('inv-biz-legal').textContent = b.legal_name || '';
  $('inv-biz-address').textContent = b.address || '';
  $('inv-biz-phone').textContent = b.phone ? `Tel: ${b.phone}` : '';
  $('inv-biz-tax').textContent = b.tax_id ? `RNC/Tax ID: ${b.tax_id}` : '';
  const logoImg = $('inv-biz-logo');
  if (b.logo_url) { logoImg.src = b.logo_url; logoImg.classList.remove('hidden'); }
  else { logoImg.classList.add('hidden'); }

  $('inv-number').textContent = invoice.invoice_number;
  $('inv-date').textContent = fmtDate(invoice.created_at);

  const customer = customersSnapshot.find(c => c.id === invoice.customer_id);
  $('inv-customer-name').textContent = customer?.name || 'Cliente General';
  $('inv-customer-phone').textContent = customer?.phone || '';

  $('inv-items-body').innerHTML = '';
  if (invoice.items?.length) {
    invoice.items.forEach(item => addInvoiceItemRow({ name: item.name, qty: item.qty, price: item.price }));
  } else {
    addInvoiceItemRow({ name: 'Producto/Servicio', qty: 1, price: invoice.subtotal });
  }
  recalcInvoiceTotals();

  $('inv-notes').textContent = demoMode ? 'FACTURA DE DEMOSTRACIÓN: datos ficticios, sin valor comercial.' : 'Gracias por su compra.';

  openModal('modal-invoice');
}

$('btn-close-invoice').onclick = () => closeModal('modal-invoice');
$('btn-invoice-add-row').onclick = () => addInvoiceItemRow({ name: '', qty: 1, price: 0 });

// Las librerías de exportación (≈560 KB) se cargan solo la primera vez que se exporta una factura,
// con versión exacta y huella de integridad (SRI): ya no pesan en cada visita ni dependen de «lo último».
const EXPORT_LIBS = {
  html2canvas: { src: 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js', integrity: 'sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H', ready: () => typeof window.html2canvas === 'function' },
  jspdf: { src: 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js', integrity: 'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk', ready: () => !!window.jspdf?.jsPDF }
};
const libLoads = {};
function loadExportLib(name) {
  const lib = EXPORT_LIBS[name];
  if (lib.ready()) return Promise.resolve();
  if (!libLoads[name]) {
    libLoads[name] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = lib.src; s.integrity = lib.integrity; s.crossOrigin = 'anonymous'; s.referrerPolicy = 'no-referrer';
      s.onload = () => (lib.ready() ? resolve() : reject(new Error(name + ' no quedó disponible')));
      s.onerror = () => { delete libLoads[name]; reject(new Error('No se pudo descargar ' + name)); };
      document.head.appendChild(s);
    });
  }
  return libLoads[name];
}

async function renderInvoiceCanvas() {
  try { await loadExportLib('html2canvas'); }
  catch (e) { console.error('html2canvas:', e); toast.err("No se pudo cargar el generador de imágenes. Revisa tu conexión e inténtalo de nuevo."); return null; }
  return window.html2canvas($('invoice-paper'), { scale: 2, backgroundColor: '#ffffff', useCORS: true });
}

$('btn-download-invoice-png').onclick = async (e) => {
  await withBusy(e.currentTarget, 'Generando…', async () => {
    const canvas = await renderInvoiceCanvas();
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `${$('inv-number').textContent || 'factura'}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  });
};

$('btn-download-invoice-pdf').onclick = async (e) => {
  await withBusy(e.currentTarget, 'Generando…', async () => {
    const canvas = await renderInvoiceCanvas();
    if (!canvas) return;
    try { await loadExportLib('jspdf'); }
    catch (e) { console.error('jspdf:', e); return toast.err("No se pudo cargar el generador de PDF. Revisa tu conexión e inténtalo de nuevo."); }
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'px', format: [canvas.width, canvas.height] });
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, canvas.width, canvas.height);
    pdf.save(`${$('inv-number').textContent || 'factura'}.pdf`);
  });
};

// -------------------------------------------------------------
// 9c. INVENTARIO
// -------------------------------------------------------------
// Registra un movimiento de inventario (entrada/salida/ajuste). No debe interrumpir
// la operación principal (venta o guardado de producto) si llega a fallar.
async function logInventoryMovement(productId, productName, type, quantity, stockBefore, stockAfter, reason) {
  try {
    await neon.from('inventory_movements').insert([{
      business_id: currentBusinessId,
      product_id: productId,
      product_name: productName,
      type, quantity, stock_before: stockBefore, stock_after: stockAfter, reason
    }]);
  } catch (e) {
    console.error('logInventoryMovement:', e);
  }
}

function openProductModal(prod) {
  const form = $('product-form');
  form.reset();
  $('prod-id').value = prod?.id || '';
  $('product-form-title').textContent = prod ? 'Editar producto' : 'Nuevo producto';
  if (prod) {
    $('prod-name').value = prod.name;
    $('prod-sku').value = prod.sku || '';
    $('prod-category').value = prod.category || '';
    $('prod-cost').value = prod.purchase_price;
    $('prod-price').value = prod.sale_price;
    $('prod-stock').value = prod.stock;
    $('prod-min').value = prod.min_stock;
  } else {
    $('prod-min').value = 3;
  }
  openModal('modal-product');
}

async function initInventory() {
  const form = $('product-form');
  $('inventory-table-body').innerHTML = skeletonRows(6);
  $('btn-show-add-product').onclick = () => openProductModal(null);
  $('btn-cancel-product').onclick = () => closeModal('modal-product');

  $('inventory-search').addEventListener('input', renderInventory);
  $('inventory-category-filter').addEventListener('change', renderInventory);
  $('inventory-low-toggle').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', on ? 'true' : 'false');
    e.currentTarget.classList.toggle('is-active', on);
    renderInventory();
  });

  $('btn-show-inventory-history').onclick = async () => {
    const tbody = $('inventory-history-table-body');
    tbody.innerHTML = skeletonRows(6);
    openModal('modal-inventory-history');
    const data = await readList('los movimientos de inventario', () => neon.from('inventory_movements').select('*')
      .eq('business_id', currentBusinessId).order('created_at', { ascending: false }).limit(100));
    const typeBadge = {
      entrada: '<span class="badge badge-ok">Entrada</span>',
      salida: '<span class="badge badge-danger">Salida</span>',
      ajuste: '<span class="badge badge-warn">Ajuste</span>'
    };
    tbody.innerHTML = (data || []).map(m => `
      <tr>
        <td class="cell-main">${fmtDateTime(m.created_at)}</td>
        <td data-label="Producto">${escapeHtml(m.product_name)}</td>
        <td data-label="Tipo">${typeBadge[m.type] || escapeHtml(m.type)}</td>
        <td class="num" data-label="Cant.">${m.quantity > 0 ? '+' : ''}${m.quantity}</td>
        <td data-label="Antes → después" class="num">${m.stock_before} → ${m.stock_after}</td>
        <td data-label="Motivo">${escapeHtml(m.reason) || '—'}</td>
      </tr>`).join('');
    if ((data || []).length === 0) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty">${emptyState({ icon: 'history', title: 'Sin movimientos registrados todavía' })}</div></td></tr>`;
    }
  };
  $('btn-close-inventory-history').onclick = () => closeModal('modal-inventory-history');

  await loadProducts();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const submit = form.querySelector('button[type=submit]');
    await withBusy(submit, 'Guardando…', async () => {
      const id = $('prod-id').value;
      const existingProd = id ? inventorySnapshot.find(p => p.id === id) : null;
      const payload = {
        business_id: currentBusinessId,
        name: $('prod-name').value.trim(),
        sku: $('prod-sku').value.trim() || null,
        category: $('prod-category').value.trim() || 'General',
        purchase_price: parseFloat($('prod-cost').value) || 0,
        sale_price: parseFloat($('prod-price').value),
        stock: parseInt($('prod-stock').value),
        min_stock: parseInt($('prod-min').value)
      };

      if (id) {
        const { error } = await writeWithRetry('products.update', () => neon.from('products').update(payload).eq('id', id));
        if (error) return toast.err("No se pudo guardar el producto: " + error.message);
        const stockBefore = existingProd ? existingProd.stock : 0;
        if (payload.stock !== stockBefore) {
          await logInventoryMovement(id, payload.name, 'ajuste', payload.stock - stockBefore, stockBefore, payload.stock, 'Ajuste manual desde edición de producto');
        }
      } else {
        const { data: newProd, error } = await writeWithRetry('products.insert', () => neon.from('products').insert([payload]).select().single());
        if (error) return toast.err("No se pudo guardar el producto: " + error.message);
        if (newProd) {
          await logInventoryMovement(newProd.id, payload.name, 'entrada', payload.stock, 0, payload.stock, 'Registro inicial de producto');
        }
      }

      if (id) {
        await logActivity(`Editó el producto "${payload.name}"`, {
          entityType: 'product',
          entityId: id,
          oldValues: existingProd ? {
            'Precio Compra': existingProd.purchase_price, 'Precio Venta': existingProd.sale_price, Stock: existingProd.stock
          } : null,
          newValues: { 'Precio Compra': payload.purchase_price, 'Precio Venta': payload.sale_price, Stock: payload.stock }
        });
      } else {
        await logActivity(`Creó el producto "${payload.name}"`, { entityType: 'product' });
      }
      closeModal('modal-product');
      toast.ok(id ? `«${payload.name}» actualizado.` : `«${payload.name}» agregado al inventario.`);
      await loadProducts();
    });
  };
}

function stockBadge(p) {
  if (p.stock <= 0) return '<span class="badge badge-danger">Agotado</span>';
  if (isLowStock(p)) return '<span class="badge badge-warn">Stock bajo</span>';
  return '<span class="badge badge-ok">Disponible</span>';
}

function renderInventory() {
  const tbody = $('inventory-table-body');
  if (!tbody) return;
  if (!loaded.products) { tbody.innerHTML = skeletonRows(6); return; }

  // Resumen
  $('inv-stat-total').textContent = inventorySnapshot.length;
  $('inv-stat-low').textContent = inventorySnapshot.filter(p => p.stock > 0 && isLowStock(p)).length;
  $('inv-stat-out').textContent = inventorySnapshot.filter(p => p.stock <= 0).length;

  // Sugerencias de categoría (autocompletar) y filtro, a partir de las ya usadas
  const categories = [...new Set(inventorySnapshot.map(p => p.category).filter(Boolean))].sort();
  $('category-list').innerHTML = categories.map(c => `<option value="${escapeHtml(c)}"></option>`).join('');
  const filter = $('inventory-category-filter');
  const selected = filter.value;
  filter.innerHTML = '<option value="">Todas las categorías</option>' + categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  filter.value = categories.includes(selected) ? selected : '';

  const q = $('inventory-search').value.trim().toLowerCase();
  const lowOnly = $('inventory-low-toggle').getAttribute('aria-pressed') === 'true';
  const list = inventorySnapshot.filter(p =>
    (!filter.value || p.category === filter.value) &&
    (!lowOnly || isLowStock(p)) &&
    (!q || String(p.name).toLowerCase().includes(q) || String(p.sku || '').toLowerCase().includes(q) || String(p.category || '').toLowerCase().includes(q)));

  tbody.innerHTML = list.map(p => `
    <tr class="${p.stock <= 0 ? 'inv-out' : isLowStock(p) ? 'inv-low' : ''}">
      <td class="cell-main">${escapeHtml(p.name)}${p.sku ? `<span class="sub">SKU: ${escapeHtml(p.sku)}</span>` : ''}</td>
      <td data-label="Categoría">${escapeHtml(p.category) || 'General'}</td>
      <td class="num" data-label="Precio">${money(p.sale_price)}</td>
      <td class="num stock-pill" data-label="Stock">${p.stock}</td>
      <td data-label="Estado">${stockBadge(p)}</td>
      <td class="cell-actions"><button type="button" class="btn-edit btn btn-sm" data-id="${p.id}">${ico('pencil', 'i-sm')}Editar</button></td>
    </tr>`).join('');

  const empty = $('inventory-empty');
  if (!list.length) {
    empty.classList.remove('hidden');
    empty.innerHTML = inventorySnapshot.length
      ? emptyState({ icon: 'search', title: 'Ningún producto coincide', text: 'Prueba con otra búsqueda o quita los filtros.' })
      : emptyState({ icon: 'package', title: 'Tu inventario está vacío', text: 'Agrega tu primer producto para empezar a vender.', actionHtml: '<button type="button" class="btn btn-primary" id="empty-add-product">Nuevo producto</button>' });
    $('empty-add-product')?.addEventListener('click', () => openProductModal(null));
  } else {
    empty.classList.add('hidden');
  }

  tbody.querySelectorAll('.btn-edit').forEach(btn => {
    btn.onclick = (e) => {
      const prod = inventorySnapshot.find(p => p.id === e.currentTarget.dataset.id);
      if (prod) openProductModal(prod);
    };
  });
}

async function loadSales() {
  const data = await readList('las ventas', () => neon.from('sales').select('*').eq('business_id', currentBusinessId).order('created_at', { ascending: false }));
  if (data) {
    salesHistory = data;
    calculateFinancialDashboard();
    renderSalesTrend();
  }
}
const initReports = loadSales;


// -------------------------------------------------------------
// 10. ARRANQUE, DEMOSTRACIÓN, TUTORIAL Y CONFIGURACIÓN INICIAL
// -------------------------------------------------------------
// ---------- Pantalla de carga de arranque (refleja procesos reales) ----------
const boot = {
  hide() { $('boot-loader')?.classList.add('is-done'); },
  show(msg, sub = '') {
    const el = $('boot-loader');
    el.classList.remove('is-done', 'has-error');
    $('boot-msg').textContent = msg;
    $('boot-sub').textContent = sub;
    $('boot-bar').classList.add('indeterminate');
  },
  progress(done, total, label) {
    const bar = $('boot-bar');
    bar.classList.remove('indeterminate');
    bar.style.setProperty('--p', Math.max(0.06, done / total).toFixed(3));
    if (label) $('boot-sub').textContent = `Listo: ${label}`;
  },
  error(text, retry) {
    const el = $('boot-loader');
    el.classList.remove('is-done');
    el.classList.add('has-error');
    $('boot-err-text').textContent = text;
    $('boot-retry').onclick = retry;
    $('boot-exit').onclick = () => window.location.replace('index.html?landing');
  }
};

function enterApp() {
  setupRoleInterface();
  startSystemModules();
  boot.hide();
  handleGotoParam();
}

// ?goto=settings: al terminar el tutorial desde «Ayuda» se llega a la configuración real.
function handleGotoParam() {
  if (demoMode || pageParams.get('goto') !== 'settings') return;
  showModuleSection('sec-settings');
  openSettingsSubpage('tab-cfg-business');
  window.history.replaceState({}, document.title, window.location.pathname);
}

// ---------- Primera vez: bienvenida → tutorial → configuración ----------
// Solo para quien es nuevo (negocio sin configurar). El estado se recuerda por usuario.
function enterFirstRun(userId) {
  const device = tourState.read('device');
  if (!tourState.read(userId) && device?.status === 'completed') tourState.save(userId, { status: 'completed' });
  const st = tourState.read(userId);
  boot.hide();
  if (!st || st.status === 'in_progress') {
    const resume = st?.status === 'in_progress' && (st.step || 0) > 0;
    const go = (step) => {
      tourState.save(userId, { status: 'in_progress', step, total: st?.total });
      boot.show('Preparando tu espacio de demostración…', 'Cargando los datos de ejemplo');
      window.location.href = `app.html?demo=1&tour=1&first=1&step=${step}`;
    };
    showWelcome({
      resume, step: st?.step || 0, total: st?.total || 14,
      onStart: () => go(resume ? st.step : 0),
      onRestart: () => go(0),
      onExplore: () => { tourState.save(userId, { status: 'skipped' }); showWizard(); }
    });
  } else {
    showWizard();
  }
}

// ---------- Demostración ----------
let tourCtl = null;
let tourOwner = 'device';       // usuario autenticado, o el dispositivo si es un visitante
let demoOrigin = 'guest';       // 'first' (nuevo usuario), 'help' (desde Ayuda) o 'guest' (visitante)
const isMobileView = () => window.matchMedia('(max-width: 760px)').matches;

function makeTour() {
  if (tourCtl) return tourCtl;
  tourCtl = createTour({
    showSection: showModuleSection,
    sectionAllowed: (id) => !!NAV_ITEMS.find(n => n.id === id)?.allowed(),
    isMobile: isMobileView,
    closeModals: closeAllModals,
    closeModal,
    openCart: openCartSheet,
    closeCart: closeCartSheet,
    onStep: (i, step, total) => tourState.save(tourOwner, { status: 'in_progress', step: i, total }),
    onFinish: (groups) => showTourComplete(groups),
    onSkip: () => onTourSkipped()
  });
  return tourCtl;
}

async function startTour(from = 0) {
  try { await makeTour().start(from); }
  catch (e) { console.error(e); toast.err('No se pudo iniciar el recorrido: ' + e.message); }
}

function showTourComplete(groups) {
  tourState.save(tourOwner, { status: 'completed' });
  showComplete({ groups, onReplay: () => startTour(0), onConfigure: finishDemoToSetup });
}

// «Configurar mi negocio»: 1) termina el modo demo, 2) guarda el progreso, 3) descarta los datos
// ficticios recargando la página (la demo solo existía en memoria), 4-5) lleva a la pantalla real.
async function finishDemoToSetup() {
  tourState.save(tourOwner, { status: 'completed' });
  if (demoOrigin === 'guest') tourState.save('device', { status: 'completed' }); // al crear su cuenta no se repite
  window.location.replace(demoOrigin === 'help' ? 'app.html?goto=settings' : 'app.html');
}

function onTourSkipped() {
  tourState.save(tourOwner, { status: 'skipped' });
  if (demoOrigin === 'guest') { toast.info('Puedes seguir explorando la demostración cuando quieras.'); return; }
  window.location.replace('app.html');
}

async function resetDemo() {
  await withBusy($('demo-reset'), 'Reiniciando…', async () => {
    demoBackend.reset();
    cart = [];
    closeAllModals();
    closeCartSheet();
    Object.keys(loaded).forEach(k => { loaded[k] = false; });
    renderInventory(); renderCustomersTable(); renderPosCatalog();
    await Promise.all([loadProducts(), loadCustomers(), loadSales(), loadInvoicesList(), loadEmployeesList(), loadInvites()]);
    renderCart(); renderPosCatalog();
    toast.ok('Demostración reiniciada con los datos de ejemplo.');
  });
}

async function startDemoSession() {
  boot.show('Preparando tu espacio de demostración…', 'Organizando los datos de ejemplo…');
  try {
    // ¿quién es? (solo la sesión de acceso: ninguna tabla real se consulta en la demo)
    let realUserId = null;
    try { const { data } = await realNeon.auth.getSession(); realUserId = data?.session?.user?.id || null; } catch (e) { /* visitante */ }
    demoOrigin = pageParams.get('first') === '1' ? 'first' : (realUserId ? 'help' : 'guest');
    tourOwner = realUserId || 'device';

    document.body.classList.add('is-demo');
    $('auth-screen').classList.add('hidden');
    currentBusinessId = DEMO_BUSINESS_ID;
    currentUserRole = 'admin';
    currentUserPermissions = {};
    const { data: biz, error } = await neon.from('businesses').select('*').eq('id', DEMO_BUSINESS_ID).maybeSingle();
    if (error || !biz) throw new Error(error?.message || 'No se pudieron preparar los datos de ejemplo.');
    setBusiness(biz);
    setupRoleInterface();
    await startSystemModules((done, total, label) => boot.progress(done, total, label));
    document.title = 'Demostración · AINova Management';
    boot.hide();

    $('demo-tour').onclick = () => startTour(0);
    $('demo-reset').onclick = resetDemo;
    $('demo-exit').onclick = () => window.location.replace(demoOrigin === 'guest' ? 'index.html?landing' : 'app.html');

    if (pageParams.get('tour') === '1') {
      startTour(parseInt(pageParams.get('step')) || 0);
    } else {
      const st = tourState.read(tourOwner);
      const resume = st?.status === 'in_progress' && (st.step || 0) > 0;
      showWelcome({ resume, step: st?.step || 0, total: st?.total || 14,
        onStart: () => startTour(resume ? st.step : 0), onRestart: () => startTour(0), onExplore: () => {} });
    }
  } catch (e) {
    console.error('Demo:', e);
    boot.error('No se pudo preparar la demostración: ' + (e.message || e), () => window.location.reload());
  }
}

// «Ayuda y tutorial»: abre la demostración con el recorrido (en una carga de página aparte)
document.querySelectorAll('.js-start-tour').forEach(btn => {
  btn.onclick = () => { window.location.href = 'app.html?demo=1&tour=1'; };
});

// ---------- Asistente de configuración inicial ----------
const WIZ_TOTAL = 4;
let wizStep = 1;
let wizLogo = null;

const blankBusiness = () => ({ name: '', currency_symbol: '$', settings: {} });

function showWizard() {
  const root = $('wizard');
  $('onboarding-screen').classList.remove('hidden');
  root.classList.remove('is-saving', 'is-done');
  const v = blankBusiness();
  $('w-general').innerHTML = generalFields('w-', v, { withName: true });
  $('w-brand').innerHTML = brandFields('w-', v);
  $('w-regional').innerHTML = regionalFields('w-', v);
  renderWizModules();
  wireBrandFields(root, 'w-', () => applyBrand(readPrefs(root, 'w-').brand));
  wireCountry(root, 'w-');
  root.querySelectorAll('input, select, textarea').forEach(el => el.addEventListener('input', () => {
    const field = el.closest('.field'); field?.classList.remove('has-error'); const err = field?.querySelector('.field-error'); if (err) err.textContent = '';
  }));
  wizGo(1);
}

// Los módulos que se ofrecen dependen del tipo de negocio (Equipo solo en grupos); se conserva lo ya marcado.
function renderWizModules() {
  const box = $('w-modules');
  if (!box) return;
  const off = new Set([...box.querySelectorAll('[data-module]')].filter(c => !c.checked).map(c => c.dataset.module));
  const modules = MODULES.map(m => m[0]).filter(k => !off.has(k));
  box.innerHTML = moduleFields('w-', { settings: { modules } }, { group: selectedBusinessType === 'group' });
}

function wizGo(n) {
  wizStep = Math.max(1, Math.min(WIZ_TOTAL, n));
  document.querySelectorAll('#wizard .wiz-step').forEach(el => el.classList.toggle('is-current', Number(el.dataset.step) === wizStep));
  document.querySelectorAll('#wiz-steps li').forEach((li, i) => { li.classList.toggle('is-current', i + 1 === wizStep); li.classList.toggle('is-done', i + 1 < wizStep); });
  $('wiz-bar-fill').style.setProperty('--p', (wizStep / WIZ_TOTAL).toFixed(3));
  $('wiz-mobile-step').textContent = `Paso ${wizStep} de ${WIZ_TOTAL}`;
  $('wiz-back').style.visibility = wizStep === 1 ? 'hidden' : 'visible';
  $('wiz-next').textContent = wizStep === WIZ_TOTAL ? 'Guardar y terminar' : 'Siguiente';
  window.scrollTo({ top: 0 });
  requestAnimationFrame(() => document.querySelector(`#wizard .wiz-step[data-step="${wizStep}"] input:not([type=file]):not([type=hidden]):not([type=color]), #wizard .wiz-step[data-step="${wizStep}"] select`)?.focus({ preventScroll: true }));
}

function setFieldError(id, msg) {
  const e = document.querySelector(`[data-err="${id}"]`);
  if (e) e.textContent = msg;
  e?.closest('.field')?.classList.toggle('has-error', !!msg);
}

function wizValidate(step) {
  let ok = true;
  if (step === 1) {
    const name = ($('w-name').value || '').trim();
    setFieldError('w-name', name.length < 2 ? 'Escribe el nombre de tu negocio (mínimo 2 letras).' : '');
    if (name.length < 2) { ok = false; $('w-name').focus(); }
    if (selectedBusinessType === 'group') {
      const bad = !(parseInt($('onb-team-size').value) >= 1);
      setFieldError('onb-team-size', bad ? 'Indica cuántas personas forman el equipo (1 o más).' : '');
      if (bad) { if (ok) $('onb-team-size').focus(); ok = false; }
    } else setFieldError('onb-team-size', '');
  }
  return ok;
}

$('wiz-back').onclick = () => wizGo(wizStep - 1);
$('wiz-next').onclick = () => { if (!wizValidate(wizStep)) return; if (wizStep < WIZ_TOTAL) wizGo(wizStep + 1); else wizSave(0); };
$('onboarding-form').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !['TEXTAREA', 'BUTTON'].includes(e.target.tagName)) { e.preventDefault(); $('wiz-next').click(); }
});
$('onboarding-form').addEventListener('submit', (e) => e.preventDefault());
$('w-logo-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { e.target.value = ''; return toast.err('Selecciona un archivo de imagen.'); }
  try { wizLogo = await fileToLogoDataUrl(file); $('w-logo-preview').src = wizLogo; }
  catch (err) { toast.err('No se pudo leer el logo: ' + err.message); }
});

function wizPayload() {
  const prefs = readPrefs($('wizard'), 'w-');
  const group = selectedBusinessType === 'group';
  const settings = {
    ...(currentBusinessData?.settings || {}),
    trade_name: prefs.trade_name, activity: prefs.activity, description: prefs.description, brand: prefs.brand,
    country: prefs.country, date_format: prefs.date_format, timezone: prefs.timezone,
    modules: (prefs.modules || []).filter(k => group || k !== 'employees')
  };
  const payload = {
    id: currentBusinessId, name: ($('w-name').value || '').trim(), business_type: selectedBusinessType,
    team_size: group ? (parseInt($('onb-team-size').value) || null) : null,
    currency_symbol: $('w-currency').value || '$', onboarding_completed: true, settings, updated_at: new Date()
  };
  if (wizLogo) payload.logo_url = wizLogo;
  return payload;
}

// Guardado con progreso real: cada línea se marca cuando su operación termina de verdad.
async function wizSave(fromIndex = 0) {
  const root = $('wizard');
  const payload = wizPayload();
  const group = payload.business_type === 'group';
  const steps = [
    { label: 'Guardando los datos de tu negocio', run: async () => { const { error } = await neon.from('businesses').upsert(payload); if (error) throw error; } },
    ...(group ? [{ label: 'Registrando tu usuario administrador', run: async () => {
      const { error } = await neon.from('business_members').upsert([{ business_id: currentBusinessId, user_id: currentBusinessId, role: 'admin' }]);
      if (error) throw error; } }] : []),
    { label: 'Aplicando tu configuración', run: async () => { setBusiness({ ...(currentBusinessData || {}), ...payload }); await logActivity('Completó la configuración inicial del negocio'); } }
  ];
  root.classList.add('is-saving');
  root.classList.remove('is-done');
  $('wiz-saving').classList.remove('has-error');
  const list = $('save-list');
  list.innerHTML = steps.map((st, i) => `<li data-i="${i}" class="${i < fromIndex ? 'is-ok' : ''}"><span class="st">${i < fromIndex ? ico('check', 'i-sm') : ''}</span>${escapeHtml(st.label)}</li>`).join('');
  window.scrollTo({ top: 0 });
  for (let i = fromIndex; i < steps.length; i++) {
    const li = list.querySelector(`[data-i="${i}"]`);
    li.className = 'is-run';
    try {
      await steps[i].run();
      li.className = 'is-ok';
      li.querySelector('.st').innerHTML = ico('check', 'i-sm');
    } catch (err) {
      console.error('Configuración inicial:', err);
      li.className = 'is-err';
      $('save-err-text').textContent = 'No se pudo guardar: ' + (err.message || err) + '.';
      $('wiz-saving').classList.add('has-error');
      $('save-retry').onclick = () => wizSave(i);
      return;
    }
  }
  root.classList.remove('is-saving');
  root.classList.add('is-done');
}

$('wiz-finish').onclick = () => {
  $('onboarding-screen').classList.add('hidden');
  if (currentBusinessData?.business_type === 'group') openModal('modal-forced-password');
  else enterApp();
};

// ---------- Preferencias del negocio (Configuración) ----------
function populateCurrencyOptions(current) {
  const sel = $('cfg-currency-symbol');
  const list = CURRENCIES.some(([c]) => c === current) ? CURRENCIES : [[current, current], ...CURRENCIES];
  sel.innerHTML = list.map(([c, l]) => `<option value="${escapeHtml(c)}">${escapeHtml(l)}</option>`).join('');
}

function renderPrefsForm() {
  const b = currentBusinessData || {};
  const root = $('form-cfg-prefs');
  $('s-general').innerHTML = generalFields('s-', b);
  $('s-brand').innerHTML = brandFields('s-', b);
  $('s-regional').innerHTML = regionalFields('s-', b);
  $('s-modules').innerHTML = moduleFields('s-', b, { group: b.business_type === 'group' });
  wireBrandFields(root, 's-', () => applyBrand(readPrefs(root, 's-').brand));
  wireCountry(root, 's-');
}

$('form-cfg-prefs').addEventListener('submit', async (e) => {
  e.preventDefault();
  const root = e.currentTarget;
  await withBusy(root.querySelector('button[type=submit]'), 'Guardando…', async () => {
    const group = currentBusinessData?.business_type === 'group';
    const prefs = readPrefs(root, 's-');
    const settings = { ...(currentBusinessData?.settings || {}), ...prefs };
    settings.modules = (prefs.modules || []).filter(k => group || k !== 'employees');
    const { error } = await neon.from('businesses').update({ settings, updated_at: new Date() }).eq('id', currentBusinessId);
    if (error) return toast.err('No se pudieron guardar las preferencias: ' + error.message);
    setBusiness({ ...currentBusinessData, settings });
    $('business-display-name').textContent = businessName();
    $('user-avatar').textContent = initials(businessName());
    renderNav();
    if (currentSectionId && !NAV_ITEMS.find(n => n.id === currentSectionId)?.allowed()) showModuleSection(isAdmin() ? 'sec-dashboard' : 'sec-sales');
    else document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.target === currentSectionId));
    refreshCurrencyViews();
    await logActivity('Actualizó las preferencias del negocio');
    toast.ok('Preferencias guardadas.');
  });
});

// Salir: el botón del menú lateral, el de Mi cuenta y el de la hoja "Más".
// No se depende del aviso del cliente de autenticación (el real no siempre lo emite en la
// misma pestaña): se espera a que el servicio cierre la sesión y se sale por aquí mismo.
let loggingOut = false;
async function logout() {
  if (loggingOut) return;
  loggingOut = true;
  userRequestedLogout = true;
  document.querySelectorAll('.js-logout').forEach(b => { b.disabled = true; });
  let failure = null;
  try {
    const res = await neon.auth.signOut();
    failure = res?.error || null;
  } catch (e) {
    failure = e;
  }
  if (failure) {
    console.error('signOut:', failure);
    userRequestedLogout = false;
    loggingOut = false;
    document.querySelectorAll('.js-logout').forEach(b => { b.disabled = false; });
    toast.err("No se pudo cerrar la sesión: " + (failure.message || failure) + ". Revisa tu conexión e inténtalo de nuevo.");
    return;
  }
  try { localStorage.removeItem(VISITED_KEY); } catch (e) { /* ignorar */ }
  window.location.replace('index.html');
}
document.querySelectorAll('.js-logout').forEach(btn => { btn.onclick = logout; });

// Arranque en modo demostración (la demo se prepara en esta misma carga de página)
if (demoMode) startDemoSession();
