// =====================================================================
// AINova · entorno de demostración
//
// Una base de datos EN MEMORIA que imita lo que la app espera del servidor (from(), rpc()):
// mismas tablas, mismas reglas de venta, abono, mora e inventario. La app real funciona sobre
// ella sin cambios, así que cada operación de la demo se ejecuta de verdad dentro de este
// almacén y se refleja en el resto de pantallas (panel, reportes, inventario...).
//
// Aislamiento: nada de esto llega nunca a la base real. Vive solo en la memoria de la pestaña
// (se pierde al recargar o al salir de la demo), no usa localStorage ni red y no comparte
// estado entre visitantes. Todos los datos son inventados.
// =====================================================================

export const DEMO_BUSINESS_ID = 'demo-negocio';
export const DEMO_USER_ID = 'demo-usuario';
export const DEMO_EMAIL = 'demo@nova-market.demo';

// Generador pseudoaleatorio con semilla: la demo se ve igual cada vez que se reinicia.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'd-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
const clone = (v) => JSON.parse(JSON.stringify(v));
const iso = (d) => d.toISOString();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function seedData() {
  const rnd = prng(20260101);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysAgo = (n, hour = 9 + Math.floor(rnd() * 9), min = Math.floor(rnd() * 60)) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, hour, min, 0);
  const inDays = (n) => ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));

  const B = DEMO_BUSINESS_ID;
  const business = {
    id: B, name: 'Nova Market Demo', legal_name: 'Nova Market Demo SRL', tax_id: '000-00000-0',
    phone: '809-555-0100', address: 'Calle Ejemplo #1, Ciudad Demo', logo_url: null,
    business_type: 'group', team_size: 3, onboarding_completed: true, currency_symbol: 'RD$',
    tax_enabled: false, tax_percentage: 0, tax_included_in_price: false,
    payment_methods: null, global_low_stock_alert: true, settings: {},
    created_at: iso(daysAgo(40)), updated_at: iso(now)
  };

  // [nombre, categoría, costo, precio, stock actual, mínimo]
  const catalog = [
    ['Café molido 250 g', 'Despensa', 120, 210, 15, 4],
    ['Arroz selecto 5 lb', 'Despensa', 140, 195, 22, 8],
    ['Leche entera 1 L', 'Lácteos', 45, 70, 6, 10],
    ['Azúcar 2 lb', 'Despensa', 55, 85, 30, 10],
    ['Aceite vegetal 1 L', 'Despensa', 130, 185, 12, 5],
    ['Huevos (cartón de 30)', 'Frescos', 160, 230, 9, 4],
    ['Pan de molde', 'Panadería', 55, 90, 0, 5],
    ['Detergente líquido 1 L', 'Limpieza', 90, 160, 5, 5],
    ['Agua mineral 500 ml', 'Bebidas', 10, 25, 48, 12],
    ['Refresco de cola 355 ml', 'Bebidas', 18, 40, 36, 12],
    ['Jabón de baño', 'Limpieza', 20, 45, 40, 10],
    ['Habichuelas rojas 1 lb', 'Despensa', 38, 60, 25, 8]
  ];
  const products = catalog.map(([name, category, cost, price, stock, min], i) => ({
    id: `demo-p${i + 1}`, business_id: B, name, category, purchase_price: cost, sale_price: price,
    stock, min_stock: min, sku: `NM-${String(i + 1).padStart(3, '0')}`, updated_at: iso(now)
  }));

  const customers = [
    ['Marisol Candelario', '809-555-0121'], ['Colmado Doña Rosa', '809-555-0134'],
    ['Luis Alberto Sánchez', '809-555-0147'], ['Taller Los Pinos', '809-555-0152'], ['Ana Beltré', '']
  ].map(([name, phone], i) => ({ id: `demo-c${i + 1}`, business_id: B, name, phone, created_at: iso(daysAgo(38 - i * 6)) }));

  const lineOf = (p, qty) => ({ id: p.id, name: p.name, qty, price: p.sale_price, cost: p.purchase_price, subtotal: qty * p.sale_price });
  const sales = [];
  const mkSale = (at, items, method) => {
    const total = items.reduce((a, i) => a + i.subtotal, 0);
    const cost = items.reduce((a, i) => a + (i.cost || 0) * i.qty, 0);
    const s = { id: uid(), business_id: B, items, total, profit: total - cost, payment_method: method, created_at: iso(at) };
    sales.push(s);
    return s;
  };

  // Ventas de los últimos 30 días: más movimiento reciente, con picos en fin de semana
  const methods = ['Efectivo', 'Efectivo', 'Efectivo', 'Tarjeta', 'Transferencia'];
  for (let d = 29; d >= 0; d--) {
    const dow = daysAgo(d).getDay();
    const count = (d === 0 ? 5 : 2 + Math.floor(rnd() * 3)) + (dow === 5 || dow === 6 ? 2 : 0);
    for (let k = 0; k < count; k++) {
      const n = 1 + Math.floor(rnd() * 3);
      const chosen = new Set();
      while (chosen.size < n) chosen.add(Math.floor(rnd() * products.length));
      const items = [...chosen].map((idx) => lineOf(products[idx], 1 + Math.floor(rnd() * 3)));
      const at = d === 0
        ? new Date(startToday.getTime() + (0.15 + 0.8 * rnd()) * Math.max(60000, now - startToday - 60000))
        : daysAgo(d);
      mkSale(at, items, pick(methods));
    }
  }

  // Cuentas por cobrar: un vencido con abono parcial, dos pendientes y uno ya pagado
  const credits = [];
  const mkCredit = (custIdx, ago, itemDefs, dueOffset, paid) => {
    const items = itemDefs.map(([pi, q]) => lineOf(products[pi], q));
    const s = mkSale(daysAgo(ago), items, 'Crédito');
    const c = { id: uid(), business_id: B, customer_id: customers[custIdx].id, sale_id: s.id, amount: s.total, amount_paid: 0,
      status: 'pendiente', created_at: s.created_at, due_date: inDays(dueOffset), late_fee_applied: false };
    credits.push(c);
    return { c, s };
  };
  const abonos = [];
  const mkAbono = (credit, custIdx, ago, amount) => {
    const s = mkSale(daysAgo(ago), [{ name: `Abono a crédito - ${customers[custIdx].name}`, qty: 1, price: amount, subtotal: amount }], 'Abono Crédito');
    s.profit = amount;
    credit.amount_paid += amount;
    credit.status = credit.amount_paid >= credit.amount ? 'pagado' : 'parcial';
    abonos.push({ sale: s, custIdx });
  };
  const a = mkCredit(0, 12, [[1, 2], [4, 2]], -3);                  // vencido
  mkAbono(a.c, 0, 5, 300);
  mkCredit(1, 5, [[0, 3], [3, 4], [8, 6]], 9);                      // pendiente
  const c3 = mkCredit(2, 25, [[5, 1], [11, 3]], -10);               // pagado
  mkAbono(c3.c, 2, 18, c3.c.amount);
  mkCredit(3, 2, [[7, 2], [2, 4]], 12);                             // pendiente

  sales.sort((x, y) => new Date(x.created_at) - new Date(y.created_at));

  // Inventario coherente: el stock actual es el de arriba; se reconstruye el histórico hacia atrás
  const sold = {};
  sales.forEach((s) => (s.items || []).forEach((i) => { if (i.id) sold[i.id] = (sold[i.id] || 0) + i.qty; }));
  const running = {};
  products.forEach((p) => { running[p.id] = p.stock + (sold[p.id] || 0); });
  const movements = products.map((p) => ({
    id: uid(), business_id: B, product_id: p.id, product_name: p.name, type: 'entrada', quantity: running[p.id],
    stock_before: 0, stock_after: running[p.id], reason: 'Registro inicial de producto', created_at: iso(daysAgo(30, 8, 0))
  }));
  sales.forEach((s) => (s.items || []).forEach((i) => {
    if (!i.id) return;
    const before = running[i.id];
    running[i.id] -= i.qty;
    movements.push({ id: uid(), business_id: B, product_id: i.id, product_name: i.name, type: 'salida', quantity: -i.qty,
      stock_before: before, stock_after: running[i.id], reason: 'Venta', created_at: s.created_at });
  }));
  // reposición manual de ejemplo
  const repo = products[8];
  movements.push({ id: uid(), business_id: B, product_id: repo.id, product_name: repo.name, type: 'ajuste', quantity: 12,
    stock_before: repo.stock - 12, stock_after: repo.stock, reason: 'Ajuste manual desde edición de producto', created_at: iso(daysAgo(3)) });

  // Facturas: una por cada venta pagada y por cada abono (las ventas a crédito se facturan al pagar)
  let n = 1001;
  const invoices = [];
  const custOfAbono = new Map(abonos.map((x) => [x.sale.id, customers[x.custIdx].id]));
  [...sales].filter((s) => s.payment_method !== 'Crédito').forEach((s) => {
    const customer_id = custOfAbono.get(s.id) || (rnd() < 0.18 ? pick(customers).id : null);
    invoices.push({ id: uid(), business_id: B, sale_id: s.id, customer_id, invoice_number: `DEMO-${n++}`, items: s.items,
      subtotal: s.total, tax_amount: 0, total: s.total, created_at: s.created_at });
  });

  const activity = [...sales].slice(-8).reverse().map((s) => ({
    id: uid(), business_id: B, user_name: DEMO_EMAIL, entity_type: null, entity_id: null, old_values: null, new_values: null,
    action: s.payment_method === 'Abono Crédito' ? `Registró un abono de RD$${s.total}` : `Registró una venta por RD$${s.total.toFixed(2)} (${s.payment_method})`,
    created_at: s.created_at
  }));

  const members = [
    { id: 'demo-m1', business_id: B, user_id: DEMO_USER_ID, role: 'admin', employee_name: null, role_title: null, permissions: {}, created_at: iso(daysAgo(40)) },
    { id: 'demo-m2', business_id: B, user_id: 'demo-u2', role: 'employee', employee_name: 'Carla Méndez', role_title: 'Cajera', permissions: { ver_dashboard: true }, created_at: iso(daysAgo(20)) },
    { id: 'demo-m3', business_id: B, user_id: 'demo-u3', role: 'employee', employee_name: 'Pedro Almonte', role_title: 'Almacén', permissions: {}, created_at: iso(daysAgo(9)) }
  ];
  const invites = [
    { id: uid(), business_id: B, code: 'EMPDEMO2X7K9', used: false, used_by: null, created_at: iso(daysAgo(2)), expires_at: iso(daysAgo(-5)) },
    { id: uid(), business_id: B, code: 'EMPDEMO8M4QA', used: true, used_by: 'demo-u3', created_at: iso(daysAgo(11)), expires_at: iso(daysAgo(4)) }
  ];

  return {
    businesses: [business], products, customers, sales, customer_credits: credits, invoices,
    inventory_movements: movements, activity_log: activity, business_members: members, employee_invites: invites
  };
}

const DEFAULTS = {
  customers: () => ({ created_at: iso(new Date()) }),
  products: () => ({ updated_at: iso(new Date()), stock: 0, min_stock: 0 }),
  inventory_movements: () => ({ created_at: iso(new Date()) }),
  activity_log: () => ({ created_at: iso(new Date()) }),
  invoices: () => ({ created_at: iso(new Date()) }),
  business_members: () => ({ created_at: iso(new Date()), permissions: {} }),
  employee_invites: () => ({ created_at: iso(new Date()), used: false, used_by: null, expires_at: iso(new Date(Date.now() + 7 * 86400000)) }),
  businesses: () => ({ created_at: iso(new Date()), settings: {} }),
  customer_credits: () => ({ created_at: iso(new Date()), amount_paid: 0, status: 'pendiente', late_fee_applied: false })
};

export function createDemoBackend() {
  let tables = seedData();
  const stats = { reads: 0, writes: 0, rpcs: 0 };
  const fail = (message) => ({ data: null, error: { message } });

  function builder(table) {
    const st = { filters: [], op: 'select', payload: null, single: false, maybe: false, order: null, limit: null };
    const exec = () => {
      const rows = (tables[table] = tables[table] || []);
      const matches = () => rows.filter((r) => st.filters.every(([k, v]) => r[k] === v));
      let hit;
      if (st.op === 'select') { stats.reads++; hit = matches(); }
      else {
        stats.writes++;
        if (st.op === 'insert' || st.op === 'upsert') {
          const arr = Array.isArray(st.payload) ? st.payload : [st.payload];
          hit = arr.map((x) => Object.assign({ id: uid() }, (DEFAULTS[table] || (() => ({})))(), clone(x)));
          if (st.op === 'upsert') {
            hit.forEach((x) => {
              const i = rows.findIndex((r) => r.id === x.id || (table === 'business_members' && r.business_id === x.business_id && r.user_id === x.user_id));
              if (i >= 0) { x = Object.assign({}, rows[i], x, { id: rows[i].id }); rows.splice(i, 1, x); } else rows.push(x);
            });
          } else rows.push(...hit);
        } else if (st.op === 'update') {
          hit = matches();
          hit.forEach((r) => Object.assign(r, clone(st.payload)));
        } else if (st.op === 'delete') {
          hit = matches();
          if (table === 'customers' && hit.some((c) => tables.customer_credits.some((cr) => cr.customer_id === c.id))) {
            return fail('update or delete on table "customers" violates foreign key constraint "customer_credits_customer_id_fkey" on table "customer_credits"');
          }
          tables[table] = rows.filter((r) => !hit.includes(r));
        }
      }
      hit = clone(hit);
      if (st.order) { const [c, asc] = st.order; hit.sort((x, y) => (x[c] > y[c] ? 1 : x[c] < y[c] ? -1 : 0) * (asc ? 1 : -1)); }
      if (st.limit) hit = hit.slice(0, st.limit);
      if (st.single) return hit[0] ? { data: hit[0], error: null } : fail('The result contains 0 rows');
      if (st.maybe) return { data: hit[0] ?? null, error: null };
      return { data: hit, error: null };
    };
    const b = {
      select() { return b; },
      eq(k, v) { st.filters.push([k, v]); return b; },
      neq() { return b; }, in() { return b; }, gte() { return b; }, lte() { return b; }, ilike() { return b; },
      order(col, o) { st.order = [col, !(o && o.ascending === false)]; return b; },
      limit(n) { st.limit = n; return b; },
      single() { st.single = true; return b; },
      maybeSingle() { st.maybe = true; return b; },
      insert(p) { st.op = 'insert'; st.payload = p; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      delete() { st.op = 'delete'; return b; },
      upsert(p) { st.op = 'upsert'; st.payload = p; return b; },
      then(res, rej) {
        // Asíncrono como la red real: así la carga y los esqueletos se comportan igual
        return new Promise((r) => setTimeout(r, 0)).then(exec).then(res, rej);
      }
    };
    return b;
  }

  // ----- Funciones del servidor (réplica de db/schema.sql) -----
  const RPC = {
    process_sale(a) {
      const items = a.p_items;
      if (!items || !items.length) return fail('El carrito está vacío.');
      if (!['Efectivo', 'Transferencia', 'Tarjeta', 'Crédito'].includes(a.p_payment_method)) return fail('Método de pago inválido.');
      if (a.p_payment_method === 'Crédito' && !a.p_customer_id) return fail('Debe seleccionar un cliente para procesar una venta a crédito.');
      let total = 0, cost = 0;
      for (const it of items) {
        const p = tables.products.find((x) => x.id === it.id && x.business_id === a.p_business_id);
        if (!p) return fail(`El producto "${it.name}" ya no está disponible en el inventario.`);
        if (p.stock <= 0) return fail(`El producto "${p.name}" está agotado.`);
        if (it.qty > p.stock) return fail(`Stock insuficiente para "${p.name}". Disponible: ${p.stock}, solicitado: ${it.qty}`);
        total += Number(it.subtotal); cost += (Number(it.cost) || 0) * it.qty;
      }
      const sale = { id: uid(), business_id: a.p_business_id, items: clone(items), total, profit: total - cost,
        payment_method: a.p_payment_method, created_at: iso(new Date()) };
      tables.sales.push(sale);
      if (a.p_payment_method === 'Crédito') {
        tables.customer_credits.push({ id: uid(), business_id: a.p_business_id, customer_id: a.p_customer_id, sale_id: sale.id,
          amount: total, amount_paid: 0, status: 'pendiente', created_at: sale.created_at, due_date: a.p_credit_due_date || null, late_fee_applied: false });
      }
      for (const it of items) {
        const p = tables.products.find((x) => x.id === it.id);
        const before = p.stock;
        p.stock -= it.qty;
        tables.inventory_movements.push({ id: uid(), business_id: a.p_business_id, product_id: p.id, product_name: it.name, type: 'salida',
          quantity: -it.qty, stock_before: before, stock_after: p.stock, reason: 'Venta', created_at: sale.created_at });
      }
      return { data: clone(sale), error: null };
    },
    process_credit_payment(a) {
      const amount = Number(a.p_amount);
      if (!(amount > 0)) return fail('El monto del abono debe ser mayor a cero.');
      const cr = tables.customer_credits.find((c) => c.id === a.p_credit_id && c.business_id === a.p_business_id);
      if (!cr) return fail('Crédito no encontrado.');
      if (cr.status === 'pagado') return fail('Este crédito ya está pagado.');
      const customer = tables.customers.find((c) => c.id === cr.customer_id);
      const late = !!cr.due_date && !cr.late_fee_applied && cr.due_date < ymd(new Date());
      const interest = late ? (cr.amount - cr.amount_paid) * 0.10 : 0;
      const newTotal = cr.amount + interest;
      cr.amount = newTotal;
      cr.amount_paid += amount;
      cr.status = cr.amount_paid >= newTotal ? 'pagado' : 'parcial';
      if (late) cr.late_fee_applied = true;
      const sale = { id: uid(), business_id: a.p_business_id,
        items: [{ name: 'Abono a crédito - ' + (customer?.name || 'Cliente') + (late ? ' (incl. recargo por mora 10%)' : ''), qty: 1, price: amount, subtotal: amount }],
        total: amount, profit: amount + interest, payment_method: 'Abono Crédito', created_at: iso(new Date()) };
      tables.sales.push(sale);
      return { data: clone(sale), error: null };
    },
    whoami() { return { data: { auth_uid: DEMO_USER_ID, sub: DEMO_USER_ID, demo: true }, error: null }; },
    report_diag() { return { data: null, error: null }; },
    redeem_invite_code() { return fail('La demostración no admite canjear invitaciones.'); }
  };

  return {
    isDemo: true,
    stats,
    from: (table) => builder(table),
    rpc: async (fn, args) => {
      stats.rpcs++;
      await new Promise((r) => setTimeout(r, 0));
      const f = RPC[fn];
      return f ? f(args || {}) : fail(`Función no disponible en la demostración: ${fn}`);
    },
    /** Vuelve a los datos de ejemplo originales. */
    reset() { tables = seedData(); stats.reads = stats.writes = stats.rpcs = 0; },
    /** Solo para pruebas: contenido actual de una tabla. */
    peek: (table) => clone(tables[table] || [])
  };
}
