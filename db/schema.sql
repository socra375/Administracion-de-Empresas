-- Esquema de Gestor de Empresas en Neon (Postgres + Managed Better Auth + Data API).
--
-- Se aplica sobre una base con la API de datos y la autenticación de Neon ya activadas:
-- ellas crean el esquema "auth" (auth.uid() devuelve el id del usuario del JWT) y el rol
-- "authenticated". No lleva datos ni secretos: es solo estructura y reglas de seguridad.
--
-- Modelo de acceso:
--   * Un negocio "individual" tiene como id el id de su dueño. Un negocio "grupo" además
--     tiene filas en business_members (admin o employee).
--   * Admin = el dueño (id del negocio = su id) o un miembro con rol admin.
--   * El id del usuario sale de private.current_user_id() (que llama a auth.uid()).
--   * Casi todo se comparte con cualquier miembro; lo administrativo es solo del admin.
--   * Los permisos "ver_dashboard" y "ver_reportes" de business_members los aplica la
--     interfaz, no la base (igual que antes de migrar).

-- ---------------------------------------------------------------------------------------
-- Funciones auxiliares de seguridad. Van en un esquema aparte que la API de datos NO
-- expone, para que nadie pueda invocarlas como endpoints (/rest/v1/rpc/...). Solo se
-- usan desde las políticas.
-- ---------------------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- Quién es el usuario de la petición. TODAS las reglas lo preguntan aquí en vez de llamar a
-- auth.uid() directamente: es un único punto para definir la identidad, y permite probar
-- las políticas reales simulando usuarios sin tocar el esquema "auth", que es de Neon.
create or replace function private.current_user_id()
returns uuid
language sql stable
set search_path = ''
as $$ select auth.uid() $$;
revoke all on function private.current_user_id() from public;
grant execute on function private.current_user_id() to authenticated;

-- ---------------------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------------------
create table public.businesses (
  id uuid primary key,
  name text not null,
  created_at timestamptz default now(),
  business_type text,
  team_size integer,
  onboarding_completed boolean default false,
  updated_at timestamptz default now(),
  legal_name text,
  tax_id text,
  phone text,
  address text,
  logo_url text,
  currency_symbol text default '$',
  tax_enabled boolean default false,
  tax_percentage numeric default 0,
  tax_included_in_price boolean default false,
  payment_methods jsonb,
  global_low_stock_alert boolean default true
);

create table public.business_members (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('admin', 'employee')),
  created_at timestamptz not null default now(),
  employee_name text,
  role_title text,
  permissions jsonb default '{}'::jsonb,
  unique (business_id, user_id)
);
create index business_members_user_idx on public.business_members (user_id);

create table public.employee_invites (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  code text not null unique,
  used boolean not null default false,
  used_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days')
);
create index employee_invites_business_idx on public.employee_invites (business_id);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  category text,
  purchase_price numeric not null default 0,
  sale_price numeric not null default 0,
  stock integer not null default 0,
  min_stock integer not null default 0,
  sku text,
  updated_at timestamptz default now()
);
create index products_business_idx on public.products (business_id);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  phone text,
  created_at timestamptz default now()
);
create index customers_business_idx on public.customers (business_id);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  items jsonb not null,
  total numeric not null,
  profit numeric not null,
  payment_method text not null,
  created_at timestamptz default now()
);
create index sales_business_created_idx on public.sales (business_id, created_at desc);

create table public.customer_credits (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id),
  sale_id uuid not null references public.sales(id),
  amount numeric not null,
  amount_paid numeric not null default 0,
  status text not null default 'pendiente' check (status in ('pendiente', 'parcial', 'pagado')),
  created_at timestamptz not null default now(),
  due_date date,
  late_fee_applied boolean default false
);
create index customer_credits_business_idx on public.customer_credits (business_id);
create index customer_credits_customer_idx on public.customer_credits (customer_id);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text,
  items jsonb not null,
  subtotal numeric not null,
  tax_amount numeric default 0,
  total numeric not null,
  created_at timestamptz default now(),
  invoice_number text,
  sale_id uuid references public.sales(id) on delete set null
);
create index invoices_business_created_idx on public.invoices (business_id, created_at desc);

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  type text not null,
  quantity integer not null,
  stock_before integer not null,
  stock_after integer not null,
  reason text,
  created_at timestamptz not null default now()
);
create index inventory_movements_business_idx on public.inventory_movements (business_id, created_at desc);

create table public.activity_log (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_name text not null,
  action text not null,
  created_at timestamptz default now(),
  entity_type text,
  entity_id uuid,
  old_values jsonb,
  new_values jsonb
);
create index activity_log_business_idx on public.activity_log (business_id, created_at desc);

-- ---------------------------------------------------------------------------------------
-- Funciones de acceso (SECURITY DEFINER: leen business_members saltándose su propia RLS,
-- que si no se llamaría a sí misma en bucle)
-- ---------------------------------------------------------------------------------------
create or replace function private.is_business_member(check_business_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.business_members m
    where m.business_id = check_business_id and m.user_id = private.current_user_id()
  );
$$;

create or replace function private.is_business_admin(check_business_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select check_business_id = private.current_user_id()
    or exists (
      select 1 from public.business_members m
      where m.business_id = check_business_id and m.user_id = private.current_user_id() and m.role = 'admin'
    );
$$;

create or replace function private.has_business_access(check_business_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select check_business_id = private.current_user_id() or private.is_business_member(check_business_id);
$$;

revoke all on function private.is_business_member(uuid) from public;
revoke all on function private.is_business_admin(uuid) from public;
revoke all on function private.has_business_access(uuid) from public;
grant execute on function private.is_business_member(uuid) to authenticated;
grant execute on function private.is_business_admin(uuid) to authenticated;
grant execute on function private.has_business_access(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------------------
alter table public.businesses enable row level security;
alter table public.business_members enable row level security;
alter table public.employee_invites enable row level security;
alter table public.products enable row level security;
alter table public.customers enable row level security;
alter table public.sales enable row level security;
alter table public.customer_credits enable row level security;
alter table public.invoices enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.activity_log enable row level security;

-- Negocio: lo ve cualquier miembro; cada usuario solo puede crear el suyo (id = su id);
-- modificarlo o borrarlo es del admin.
create policy businesses_select on public.businesses for select to authenticated
  using ((select private.has_business_access(id)));
create policy businesses_insert on public.businesses for insert to authenticated
  with check (id = (select private.current_user_id()));
create policy businesses_update on public.businesses for update to authenticated
  using ((select private.is_business_admin(id)))
  with check ((select private.is_business_admin(id)));
create policy businesses_delete on public.businesses for delete to authenticated
  using ((select private.is_business_admin(id)));

-- Miembros: se ven entre sí; solo un admin los crea, cambia o quita. Un empleado entra
-- únicamente por redeem_invite_code, nunca insertándose a sí mismo: de lo contrario
-- cualquiera podría hacerse admin de un negocio ajeno.
create policy members_select on public.business_members for select to authenticated
  using ((select private.has_business_access(business_id)));
create policy members_insert on public.business_members for insert to authenticated
  with check ((select private.is_business_admin(business_id)));
create policy members_update on public.business_members for update to authenticated
  using ((select private.is_business_admin(business_id)))
  with check ((select private.is_business_admin(business_id)));
create policy members_delete on public.business_members for delete to authenticated
  using ((select private.is_business_admin(business_id)));

-- Invitaciones: solo el admin.
create policy invites_admin on public.employee_invites for all to authenticated
  using ((select private.is_business_admin(business_id)))
  with check ((select private.is_business_admin(business_id)));

-- Datos de trabajo: cualquier miembro del negocio.
create policy products_member on public.products for all to authenticated
  using ((select private.has_business_access(business_id)))
  with check ((select private.has_business_access(business_id)));
create policy customers_member on public.customers for all to authenticated
  using ((select private.has_business_access(business_id)))
  with check ((select private.has_business_access(business_id)));
create policy sales_member on public.sales for all to authenticated
  using ((select private.has_business_access(business_id)))
  with check ((select private.has_business_access(business_id)));
create policy credits_member on public.customer_credits for all to authenticated
  using ((select private.has_business_access(business_id)))
  with check ((select private.has_business_access(business_id)));
create policy invoices_member on public.invoices for all to authenticated
  using ((select private.has_business_access(business_id)))
  with check ((select private.has_business_access(business_id)));
create policy movements_member on public.inventory_movements for all to authenticated
  using ((select private.has_business_access(business_id)))
  with check ((select private.has_business_access(business_id)));

-- Registro de actividad: los miembros lo leen y añaden; corregirlo o borrarlo es del admin.
create policy activity_select on public.activity_log for select to authenticated
  using ((select private.has_business_access(business_id)));
create policy activity_insert on public.activity_log for insert to authenticated
  with check ((select private.has_business_access(business_id)));
create policy activity_update on public.activity_log for update to authenticated
  using ((select private.is_business_admin(business_id)))
  with check ((select private.is_business_admin(business_id)));
create policy activity_delete on public.activity_log for delete to authenticated
  using ((select private.is_business_admin(business_id)));

-- ---------------------------------------------------------------------------------------
-- Operaciones atómicas
-- ---------------------------------------------------------------------------------------

-- Venta: valida stock (con bloqueo de fila), registra la venta, abre el crédito si aplica
-- y descuenta inventario, todo en una transacción. Corre con los permisos de quien llama,
-- así que la RLS sigue aplicando.
create or replace function public.process_sale(
  p_business_id uuid,
  p_items jsonb,
  p_payment_method text,
  p_customer_id uuid default null,
  p_credit_due_date date default null
) returns public.sales
language plpgsql
set search_path = public
as $$
declare
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_total numeric := 0;
  v_cost numeric := 0;
  v_sale public.sales%rowtype;
  v_new_stock integer;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'El carrito está vacío.';
  end if;

  if p_payment_method not in ('Efectivo', 'Transferencia', 'Tarjeta', 'Crédito') then
    raise exception 'Método de pago inválido.';
  end if;

  if p_payment_method = 'Crédito' and p_customer_id is null then
    raise exception 'Debe seleccionar un cliente para procesar una venta a crédito.';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item->>'qty')::integer;

    select * into v_product from public.products
      where id = (v_item->>'id')::uuid and business_id = p_business_id
      for update;

    if not found then
      raise exception 'El producto "%" ya no está disponible en el inventario.', (v_item->>'name');
    end if;

    if v_product.stock <= 0 then
      raise exception 'El producto "%" está agotado.', v_product.name;
    end if;

    if v_qty > v_product.stock then
      raise exception 'Stock insuficiente para "%". Disponible: %, solicitado: %', v_product.name, v_product.stock, v_qty;
    end if;

    v_total := v_total + (v_item->>'subtotal')::numeric;
    v_cost := v_cost + (coalesce((v_item->>'cost')::numeric, 0) * v_qty);
  end loop;

  insert into public.sales (business_id, items, total, profit, payment_method)
  values (p_business_id, p_items, v_total, v_total - v_cost, p_payment_method)
  returning * into v_sale;

  if p_payment_method = 'Crédito' then
    insert into public.customer_credits (business_id, customer_id, sale_id, amount, amount_paid, status, due_date, late_fee_applied)
    values (p_business_id, p_customer_id, v_sale.id, v_total, 0, 'pendiente', p_credit_due_date, false);
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item->>'qty')::integer;

    update public.products
      set stock = stock - v_qty
      where id = (v_item->>'id')::uuid
      returning stock into v_new_stock;

    insert into public.inventory_movements (business_id, product_id, product_name, type, quantity, stock_before, stock_after, reason)
    values (p_business_id, (v_item->>'id')::uuid, (v_item->>'name'), 'salida', -v_qty, v_new_stock + v_qty, v_new_stock, 'Venta');
  end loop;

  return v_sale;
end;
$$;

-- Abono a un crédito. Si ya venció la fecha límite y aún no se cobró la mora, suma 10%
-- sobre el saldo pendiente (una sola vez). La fecha se compara con el reloj del servidor.
create or replace function public.process_credit_payment(
  p_business_id uuid,
  p_credit_id uuid,
  p_amount numeric
) returns public.sales
language plpgsql
set search_path = public
as $$
declare
  v_credit public.customer_credits%rowtype;
  v_customer_name text;
  v_is_late boolean;
  v_interest numeric := 0;
  v_new_total numeric;
  v_new_paid numeric;
  v_new_status text;
  v_sale public.sales%rowtype;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto del abono debe ser mayor a cero.';
  end if;

  select * into v_credit from public.customer_credits
    where id = p_credit_id and business_id = p_business_id
    for update;

  if not found then
    raise exception 'Crédito no encontrado.';
  end if;

  if v_credit.status = 'pagado' then
    raise exception 'Este crédito ya está pagado.';
  end if;

  select name into v_customer_name from public.customers where id = v_credit.customer_id;

  v_new_total := v_credit.amount;
  v_is_late := v_credit.due_date is not null
    and not coalesce(v_credit.late_fee_applied, false)
    and v_credit.due_date < current_date;

  if v_is_late then
    v_interest := (v_credit.amount - v_credit.amount_paid) * 0.10;
    v_new_total := v_credit.amount + v_interest;
  end if;

  v_new_paid := v_credit.amount_paid + p_amount;
  v_new_status := case when v_new_paid >= v_new_total then 'pagado' else 'parcial' end;

  update public.customer_credits
    set amount = v_new_total,
        amount_paid = v_new_paid,
        status = v_new_status,
        late_fee_applied = case when v_is_late then true else late_fee_applied end
    where id = p_credit_id;

  insert into public.sales (business_id, items, total, profit, payment_method)
  values (
    p_business_id,
    jsonb_build_array(jsonb_build_object(
      'name', 'Abono a crédito - ' || coalesce(v_customer_name, 'Cliente') || (case when v_is_late then ' (incl. recargo por mora 10%)' else '' end),
      'qty', 1, 'price', p_amount, 'subtotal', p_amount
    )),
    p_amount,
    p_amount + v_interest,
    'Abono Crédito'
  )
  returning * into v_sale;

  return v_sale;
end;
$$;

-- Canjear un código de invitación: convierte al usuario en empleado del negocio. Es
-- SECURITY DEFINER porque el empleado todavía no pertenece al negocio y, por tanto, la
-- RLS no le dejaría leer la invitación ni insertarse como miembro.
create or replace function public.redeem_invite_code(
  input_code text,
  input_employee_name text default null
) returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_invite record;
  v_user_id uuid := private.current_user_id();
begin
  if v_user_id is null then
    raise exception 'Debes iniciar sesión para canjear una invitación.';
  end if;

  select * into v_invite from public.employee_invites where code = input_code;

  if v_invite.id is null then
    raise exception 'Código de invitación inválido o ya utilizado.';
  end if;

  if v_invite.used and v_invite.used_by is distinct from v_user_id then
    raise exception 'Código de invitación inválido o ya utilizado.';
  end if;

  if not v_invite.used and v_invite.expires_at < now() then
    raise exception 'Este código de invitación expiró. Solicita uno nuevo.';
  end if;

  update public.employee_invites
    set used = true, used_by = v_user_id
    where id = v_invite.id;

  insert into public.business_members (business_id, user_id, role, employee_name, role_title)
  values (v_invite.business_id, v_user_id, 'employee', input_employee_name, 'Empleado')
  on conflict (business_id, user_id) do update
    set employee_name = coalesce(excluded.employee_name, public.business_members.employee_name);

  return v_invite.business_id;
end;
$$;

-- Estas tres se exponen como endpoints: solo para usuarios con sesión.
revoke all on function public.process_sale(uuid, jsonb, text, uuid, date) from public;
revoke all on function public.process_credit_payment(uuid, uuid, numeric) from public;
revoke all on function public.redeem_invite_code(text, text) from public;
grant execute on function public.process_sale(uuid, jsonb, text, uuid, date) to authenticated;
grant execute on function public.process_credit_payment(uuid, uuid, numeric) to authenticated;
grant execute on function public.redeem_invite_code(text, text) to authenticated;
