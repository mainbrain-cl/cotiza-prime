-- Migración 17 — Cotizaciones, líneas e historia (H-025 y H-026, Q2)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261005110000_quotes.down.sql
-- Especificación: docs/arquitectura/cotizaciones-y-calculo.md §1, §2, §4 y §5.
--
-- Cotizaciones y líneas NO se escriben directo: no hay permisos de insert/update/delete para
-- `authenticated`. Solo `create_quote` y `save_quote_draft` escriben, y esta última recalcula todo
-- con app.quote_calc_v1 y lo compara con lo que calculó la aplicación.
--
-- Códigos de error propios (SQLSTATE): CP404 no encontrado · CP409 choque de revisión (otra pestaña
-- guardó antes) · CP422 dato inválido (el motivo va en el mensaje) · CP423 ya no se puede editar ·
-- CP500 el cálculo de la aplicación y el de la base no coinciden · 42501 sin permiso.

-- 0. Ajustes a la migración 15 --------------------------------------------------------------

-- Revisión del cálculo: no depender del orden de evaluación del `and`. Mismo resultado de siempre.
create or replace function app.calc_jsonb_int_in_range(p jsonb, p_min numeric, p_max numeric) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select case
    when jsonb_typeof(p) = 'number'
      then (p::numeric) = trunc(p::numeric) and (p::numeric) between p_min and p_max
    else false
  end
$$;

-- Las funciones internas del cálculo no las ejecuta nadie desde la API (solo las de abajo, que
-- corren con los permisos de su dueño).
revoke all on function
  app.quote_calc_v1(jsonb, text, bigint, integer),
  app.round_half_up_div(numeric, numeric),
  app.calc_jsonb_int_in_range(jsonb, numeric, numeric),
  app.vat_rate_bp()
  from public, anon, authenticated;

-- ¿El texto tiene forma de UUID? (para validar entradas JSON antes de convertirlas)
create function app.is_uuid_text(p text) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select coalesce(p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
$$;
revoke all on function app.is_uuid_text(text) from public, anon, authenticated;

-- 1. quotes ---------------------------------------------------------------------------------
create table public.quotes (
  id                          uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null references public.tenants (tenant_id) on update cascade,
  number_seq                  bigint not null check (number_seq > 0),
  number_scope                text not null check (number_scope = 'continuous' or number_scope ~ '^Y[0-9]{4}$'),
  number_display              text not null check (char_length(number_display) between 1 and 40),
  version                     smallint not null default 1 check (version >= 1),
  root_quote_id               uuid not null,
  supersedes_quote_id         uuid,
  customer_id                 uuid not null,
  status                      text not null default 'draft' check (status in (
    'draft', 'pending_approval', 'changes_requested', 'rejected_internal', 'sent', 'viewed',
    'rejected_by_customer', 'expired', 'accepted', 'pending_payment', 'pending_deposit',
    'deposit_paid', 'pending_balance', 'paid', 'superseded')),
  revision                    integer not null default 1 check (revision >= 1),   -- choques entre pestañas
  last_save_id                uuid,                                                -- un guardado repetido no se aplica dos veces
  creation_key                uuid not null,
  currency                    text not null default 'CLP' check (currency = 'CLP'),
  tax_rate_bp                 integer not null check (tax_rate_bp between 0 and 10000),   -- IVA congelado (1900 = 19%)
  calc_version                text not null default 'quote-calc-v1',
  global_discount_kind        text not null default 'none' check (global_discount_kind in ('none', 'percent', 'amount')),
  global_discount_value       bigint not null default 0,
  subtotal_taxable_clp        bigint not null default 0 check (subtotal_taxable_clp >= 0),
  subtotal_exempt_clp         bigint not null default 0 check (subtotal_exempt_clp >= 0),
  subtotal_clp                bigint not null default 0 check (subtotal_clp >= 0),
  line_discounts_clp          bigint not null default 0 check (line_discounts_clp >= 0),
  global_discount_clp         bigint not null default 0 check (global_discount_clp >= 0),
  global_discount_taxable_clp bigint not null default 0 check (global_discount_taxable_clp >= 0),
  global_discount_exempt_clp  bigint not null default 0 check (global_discount_exempt_clp >= 0),
  net_taxable_clp             bigint not null default 0 check (net_taxable_clp >= 0),
  net_exempt_clp              bigint not null default 0 check (net_exempt_clp >= 0),
  tax_clp                     bigint not null default 0 check (tax_clp >= 0),
  total_clp                   bigint not null default 0 check (total_clp >= 0),
  validity_mode               text check (validity_mode in ('days', 'date')),
  validity_days               smallint check (validity_days between 1 and 365),
  valid_until                 date,
  observations                text check (observations is null or char_length(observations) <= 4000),
  conditions                  text check (conditions is null or char_length(conditions) <= 4000),
  payment_terms               text check (payment_terms in ('full', 'split_50_50')),
  sent_at                     timestamptz,
  archived_at                 timestamptz,
  created_by                  uuid not null references auth.users (id),
  updated_by                  uuid references auth.users (id),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint quotes_subtotal_sum      check (subtotal_clp = subtotal_taxable_clp + subtotal_exempt_clp),
  constraint quotes_global_sum        check (global_discount_clp = global_discount_taxable_clp + global_discount_exempt_clp),
  constraint quotes_net_taxable_sum   check (net_taxable_clp = subtotal_taxable_clp - global_discount_taxable_clp),
  constraint quotes_net_exempt_sum    check (net_exempt_clp = subtotal_exempt_clp - global_discount_exempt_clp),
  constraint quotes_total_sum         check (total_clp = net_taxable_clp + net_exempt_clp + tax_clp),
  constraint quotes_total_max         check (total_clp <= 1000000000000),
  -- 'none' siempre con valor 0 (y el descuento en pesos nunca pasa del subtotal)
  constraint quotes_global_discount_shape check (
       (global_discount_kind = 'none'    and global_discount_value = 0)
    or (global_discount_kind = 'percent' and global_discount_value between 0 and 10000)
    or (global_discount_kind = 'amount'  and global_discount_value between 0 and subtotal_clp)),
  unique (tenant_id, id),
  unique (tenant_id, number_display, version),
  unique (tenant_id, root_quote_id, version),
  unique (tenant_id, created_by, creation_key),
  foreign key (tenant_id, customer_id)         references public.customers (tenant_id, id),
  foreign key (tenant_id, root_quote_id)       references public.quotes (tenant_id, id),
  foreign key (tenant_id, supersedes_quote_id) references public.quotes (tenant_id, id)
);
create index quotes_tenant_created   on public.quotes (tenant_id, created_at desc);
create index quotes_tenant_status    on public.quotes (tenant_id, status, created_at desc);
create index quotes_tenant_customer  on public.quotes (tenant_id, customer_id, created_at desc);
create index quotes_tenant_author    on public.quotes (tenant_id, created_by, created_at desc);
create index quotes_tenant_valid     on public.quotes (tenant_id, valid_until) where valid_until is not null;
create index quotes_number_trgm      on public.quotes using gin (tenant_id, number_display extensions.gin_trgm_ops);

-- 2. quote_items ----------------------------------------------------------------------------
create table public.quote_items (
  id                     uuid primary key,   -- lo genera el navegador: la línea conserva su identidad entre guardados
  tenant_id              uuid not null references public.tenants (tenant_id) on update cascade,
  quote_id               uuid not null,
  position               smallint not null check (position between 1 and 200),
  catalog_item_id        uuid,               -- solo referencia: el precio no se lee de ahí (§5)
  catalog_unit_price_clp bigint check (catalog_unit_price_clp is null or catalog_unit_price_clp >= 0),
  name                   text not null check (char_length(name) between 1 and 150),
  description            text check (description is null or char_length(description) <= 2000),
  unit                   text not null check (unit in ('service', 'hour', 'km', 'm2', 'day', 'unit')),
  tax_treatment          text not null check (tax_treatment in ('taxable', 'exempt')),
  quantity_milli         bigint not null check (quantity_milli between 1 and 1000000000),
  unit_price_clp         bigint not null check (unit_price_clp between 0 and 1000000000000),
  discount_kind          text not null check (discount_kind in ('none', 'percent', 'amount')),
  discount_value         bigint not null,
  gross_clp              bigint not null check (gross_clp between 0 and 1000000000000),
  discount_clp           bigint not null,
  line_total_clp         bigint not null,
  unit_cost_clp          bigint check (unit_cost_clp is null or unit_cost_clp >= 0),   -- M16: solo el equipo, nunca por la API
  calc_model             text,
  calc_model_version     text,
  calc_inputs            jsonb check (calc_inputs is null or pg_column_size(calc_inputs) <= 8192),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- 'none' siempre con valor 0
  constraint quote_items_discount_shape check (
       (discount_kind = 'none'    and discount_value = 0)
    or (discount_kind = 'percent' and discount_value between 0 and 10000)
    or (discount_kind = 'amount'  and discount_value between 0 and 1000000000000)),
  constraint quote_items_line_sum check (
    line_total_clp = gross_clp - discount_clp and discount_clp between 0 and gross_clp),
  constraint quote_items_catalog_pair check ((catalog_item_id is null) = (catalog_unit_price_clp is null)),
  unique (tenant_id, id),
  unique (tenant_id, quote_id, position),
  foreign key (tenant_id, quote_id)        references public.quotes (tenant_id, id),
  foreign key (tenant_id, catalog_item_id) references public.catalog_items (tenant_id, id)
);
create index quote_items_catalog on public.quote_items (tenant_id, catalog_item_id) where catalog_item_id is not null;

-- 3. quote_events (solo agregar) -------------------------------------------------------------
create table public.quote_events (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references public.tenants (tenant_id) on update cascade,
  quote_id      uuid not null,
  occurred_at   timestamptz not null default now(),
  type          text not null check (type ~ '^[a-z_]+$'),
  actor_type    text not null check (actor_type in ('user', 'system', 'public')),
  actor_user_id uuid,   -- sin FK: la historia sobrevive a la cuenta
  data          jsonb not null default '{}' check (pg_column_size(data) <= 4096),   -- nunca datos personales
  unique (tenant_id, id),
  foreign key (tenant_id, quote_id) references public.quotes (tenant_id, id)   -- sin cascada
);
create index quote_events_quote on public.quote_events (tenant_id, quote_id, occurred_at);

create trigger quote_events_no_update   before update   on public.quote_events for each row       execute function app.forbid_mutation();
create trigger quote_events_no_delete   before delete   on public.quote_events for each row       execute function app.forbid_mutation();
create trigger quote_events_no_truncate before truncate on public.quote_events for each statement execute function app.forbid_mutation();

-- 4. Disparadores comunes, RLS y permisos -----------------------------------------------------
create trigger quotes_meta       before insert or update on public.quotes      for each row execute function app.set_row_meta_by();
create trigger quote_items_meta  before insert or update on public.quote_items for each row execute function app.set_row_meta();
create trigger quotes_forbid_tenant_change        before update on public.quotes       for each row execute function app.forbid_tenant_change();
create trigger quote_items_forbid_tenant_change   before update on public.quote_items  for each row execute function app.forbid_tenant_change();
create trigger quote_events_forbid_tenant_change  before update on public.quote_events for each row execute function app.forbid_tenant_change();

alter table public.quotes       enable row level security;
alter table public.quote_items  enable row level security;
alter table public.quote_events enable row level security;

-- Todos los roles ven todas las cotizaciones de su organización (decisión 009).
create policy quotes_select       on public.quotes       for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));
create policy quote_items_select  on public.quote_items  for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));
create policy quote_events_select on public.quote_events for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));
-- Sin políticas ni permisos de escritura: solo create_quote y save_quote_draft.

grant select on public.quotes, public.quote_events to authenticated;
-- Lectura de líneas por columnas: todas menos unit_cost_clp (el costo es solo del equipo, §9.4).
grant select (id, tenant_id, quote_id, position, catalog_item_id, catalog_unit_price_clp, name, description,
              unit, tax_treatment, quantity_milli, unit_price_clp, discount_kind, discount_value,
              gross_clp, discount_clp, line_total_clp, calc_model, calc_model_version, calc_inputs,
              created_at, updated_at)
  on public.quote_items to authenticated;

-- 5. create_quote ---------------------------------------------------------------------------
create function public.create_quote(p_customer_id uuid, p_creation_key uuid)
returns table (quote_id uuid, number_display text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  v_id     uuid := gen_random_uuid();
  v_seq    bigint;
  v_disp   text;
  v_scope  text;
  v_mode   text;
  v_prev   uuid;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin', 'sales') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_customer_id is null or p_creation_key is null then
    raise exception 'missing_argument' using errcode = 'CP422';
  end if;

  -- Doble clic o reintento: la misma clave devuelve la misma cotización, sin gastar otro número.
  perform pg_advisory_xact_lock(
    hashtextextended('create_quote:' || v_tenant::text || v_uid::text || p_creation_key::text, 0));
  select q.id, q.number_display into v_prev, v_disp
    from public.quotes q
   where q.tenant_id = v_tenant and q.created_by = v_uid and q.creation_key = p_creation_key;
  if found then
    return query select v_prev, v_disp;
    return;
  end if;

  if not exists (select 1 from public.customers c
                  where c.tenant_id = v_tenant and c.id = p_customer_id and c.anonymized_at is null) then
    raise exception 'customer_not_found' using errcode = 'CP404';
  end if;

  select s.seq, s.display into v_seq, v_disp from app.allocate_quote_number(v_tenant) s;
  select ns.mode into v_mode from public.numbering_settings ns where ns.tenant_id = v_tenant;
  v_scope := app.numbering_scope(v_mode, app.current_business_year());

  insert into public.quotes (id, tenant_id, number_seq, number_scope, number_display, root_quote_id,
                             customer_id, creation_key, tax_rate_bp, created_by)
  values (v_id, v_tenant, v_seq, v_scope, v_disp, v_id,
          p_customer_id, p_creation_key, app.vat_rate_bp(), v_uid);

  insert into public.quote_events (tenant_id, quote_id, type, actor_type, actor_user_id, data)
  values (v_tenant, v_id, 'created', 'user', v_uid,
          jsonb_build_object('number_display', v_disp, 'version', 1));

  return query select v_id, v_disp;
end $$;
revoke all on function public.create_quote(uuid, uuid) from public, anon;
grant execute on function public.create_quote(uuid, uuid) to authenticated;

-- 6. save_quote_draft -----------------------------------------------------------------------
-- p_header:  {"customer_id": uuid, "global_discount": {"kind": "none|percent|amount", "value": n}}
--            (claves desconocidas se rechazan: H-027 y H-052 agregarán las suyas sin cambiar la firma)
-- p_items:   arreglo de {id, catalog_item_id?, name, description?, unit, tax_treatment,
--            quantity_milli, unit_price_clp, discount_kind, discount_value}, en el orden de la pantalla
-- p_expected_totals: el `totals` que calculó la aplicación; si la base no obtiene exactamente lo
--            mismo, no guarda nada (CP500).
create function public.save_quote_draft(
  p_quote_id uuid, p_expected_revision integer, p_save_id uuid,
  p_header jsonb, p_items jsonb, p_expected_totals jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c_max_lines constant integer := 200;
  c_units     constant text[] := array['service', 'hour', 'km', 'm2', 'day', 'unit'];
  v_tenant    uuid := app.current_tenant_id();
  v_uid       uuid := auth.uid();
  q           public.quotes;
  v_customer  uuid;
  v_gd        jsonb;
  v_gd_kind   text;
  v_gd_value  bigint;
  v_count     integer;
  v_elem      jsonb;
  v_rows      jsonb := '[]'::jsonb;   -- filas ya resueltas, para insertar
  v_eff       jsonb := '[]'::jsonb;   -- lo que entra al cálculo
  v_ids       uuid[] := '{}';
  v_id        uuid;
  v_cat_id    uuid;
  v_cat_price bigint;
  v_unit      text;
  v_tax       text;
  v_desc      jsonb;
  v_kind      text;
  v_exist     public.quote_items;
  v_cat       public.catalog_items;
  v_calc      jsonb;
  v_totals    jsonb;
  v_issues    text;
  v_row       jsonb;
  v_line      jsonb;
  v_rev       integer;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin', 'sales') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_quote_id is null or p_expected_revision is null or p_save_id is null
     or jsonb_typeof(p_header) is distinct from 'object'
     or jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_typeof(p_expected_totals) is distinct from 'object' then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;

  select * into q from public.quotes where tenant_id = v_tenant and id = p_quote_id for update;
  if not found then
    raise exception 'quote_not_found' using errcode = 'CP404';
  end if;
  -- Solo el autor edita su borrador (decisión 009).
  if q.created_by <> v_uid then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Un guardado repetido (reintento por mala conexión) no se aplica dos veces.
  if q.last_save_id = p_save_id then
    return jsonb_build_object('revision', q.revision, 'replayed', true);
  end if;
  if q.status not in ('draft', 'changes_requested') then
    raise exception 'not_editable' using errcode = 'CP423';
  end if;
  if q.revision <> p_expected_revision then
    raise exception 'revision_conflict' using errcode = 'CP409';
  end if;

  -- Encabezado ---------------------------------------------------------------------------
  if exists (select 1 from jsonb_object_keys(p_header) k where k not in ('customer_id', 'global_discount')) then
    raise exception 'unknown_header_key' using errcode = 'CP422';
  end if;
  if jsonb_typeof(p_header -> 'customer_id') is distinct from 'string'
     or not app.is_uuid_text(p_header ->> 'customer_id') then
    raise exception 'invalid_customer' using errcode = 'CP422';
  end if;
  v_customer := (p_header ->> 'customer_id')::uuid;
  -- Un cliente anonimizado después de crear la cotización no impide guardarla si no se cambia.
  if v_customer is distinct from q.customer_id
     and not exists (select 1 from public.customers c
                      where c.tenant_id = v_tenant and c.id = v_customer and c.anonymized_at is null) then
    raise exception 'customer_not_found' using errcode = 'CP422';
  end if;

  v_gd := p_header -> 'global_discount';
  if jsonb_typeof(v_gd) is distinct from 'object'
     or jsonb_typeof(v_gd -> 'kind') is distinct from 'string'
     or (v_gd ->> 'kind') not in ('none', 'percent', 'amount') then
    raise exception 'invalid_global_discount' using errcode = 'CP422';
  end if;
  v_gd_kind := v_gd ->> 'kind';
  -- 'none' siempre con valor 0; % hasta 100,00 (10.000 pb); $ hasta el tope (el subtotal lo revisa el cálculo)
  if not app.calc_jsonb_int_in_range(
       v_gd -> 'value', 0,
       case v_gd_kind when 'none' then 0 when 'percent' then 10000 else 1000000000000 end) then
    raise exception 'invalid_global_discount' using errcode = 'CP422';
  end if;
  v_gd_value := (v_gd ->> 'value')::numeric::bigint;

  -- Líneas -------------------------------------------------------------------------------
  v_count := jsonb_array_length(p_items);
  if v_count > c_max_lines then
    raise exception 'too_many_lines' using errcode = 'CP422';
  end if;

  for i in 0 .. v_count - 1 loop
    v_elem := p_items -> i;
    if jsonb_typeof(v_elem) is distinct from 'object' then
      raise exception 'invalid_item' using errcode = 'CP422';
    end if;
    if jsonb_typeof(v_elem -> 'id') is distinct from 'string' or not app.is_uuid_text(v_elem ->> 'id') then
      raise exception 'invalid_item_id' using errcode = 'CP422';
    end if;
    v_id := (v_elem ->> 'id')::uuid;
    if v_id = any (v_ids) then
      raise exception 'duplicate_item_id' using errcode = 'CP422';
    end if;
    v_ids := v_ids || v_id;

    if jsonb_typeof(v_elem -> 'name') is distinct from 'string'
       or char_length(btrim(v_elem ->> 'name')) not between 1 and 150 then
      raise exception 'invalid_item_name' using errcode = 'CP422';
    end if;
    v_desc := v_elem -> 'description';
    if v_desc is not null and jsonb_typeof(v_desc) <> 'null'
       and (jsonb_typeof(v_desc) <> 'string' or char_length(v_desc #>> '{}') > 2000) then
      raise exception 'invalid_item_description' using errcode = 'CP422';
    end if;
    if jsonb_typeof(v_elem -> 'unit') is distinct from 'string' or not ((v_elem ->> 'unit') = any (c_units)) then
      raise exception 'invalid_item_unit' using errcode = 'CP422';
    end if;
    if jsonb_typeof(v_elem -> 'tax_treatment') is distinct from 'string'
       or (v_elem ->> 'tax_treatment') not in ('taxable', 'exempt') then
      raise exception 'invalid_tax_treatment' using errcode = 'CP422';
    end if;
    v_unit := v_elem ->> 'unit';
    v_tax  := v_elem ->> 'tax_treatment';

    -- 'none' siempre con valor 0 (la restricción de la tabla lo exige igual)
    v_kind := case when jsonb_typeof(v_elem -> 'discount_kind') = 'string' then v_elem ->> 'discount_kind' end;
    if v_kind = 'none' and app.calc_jsonb_int_in_range(v_elem -> 'discount_value', 0, 0) is not true then
      raise exception 'invalid_discount' using errcode = 'CP422';
    end if;

    v_cat_id := null;
    if v_elem ? 'catalog_item_id' and jsonb_typeof(v_elem -> 'catalog_item_id') <> 'null' then
      if jsonb_typeof(v_elem -> 'catalog_item_id') <> 'string' or not app.is_uuid_text(v_elem ->> 'catalog_item_id') then
        raise exception 'invalid_catalog_item' using errcode = 'CP422';
      end if;
      v_cat_id := (v_elem ->> 'catalog_item_id')::uuid;
    end if;

    -- Precio congelado y trato tributario de las líneas del catálogo (§5, §4 paso 8)
    select * into v_exist from public.quote_items
     where tenant_id = v_tenant and quote_id = q.id and id = v_id;
    if found then
      -- Línea existente: conserva su origen, unidad y trato tributario.
      if v_cat_id is distinct from v_exist.catalog_item_id
         or v_unit <> v_exist.unit or v_tax <> v_exist.tax_treatment then
        raise exception 'catalog_item_changed' using errcode = 'CP422';
      end if;
      v_cat_price := v_exist.catalog_unit_price_clp;
    elsif v_cat_id is not null then
      -- Línea nueva del catálogo: el servicio debe existir, estar activo y coincidir.
      select * into v_cat from public.catalog_items
       where tenant_id = v_tenant and id = v_cat_id and is_active;
      if not found then
        raise exception 'catalog_item_unavailable' using errcode = 'CP422';
      end if;
      if v_unit <> v_cat.unit or v_tax <> v_cat.tax_treatment then
        raise exception 'catalog_item_changed' using errcode = 'CP422';
      end if;
      v_cat_price := v_cat.unit_price_clp;   -- del catálogo, nunca del navegador
    else
      v_cat_price := null;
    end if;

    v_rows := v_rows || jsonb_build_object(
      'id', v_id,
      'catalog_item_id', v_cat_id,
      'catalog_unit_price_clp', v_cat_price,
      'name', btrim(v_elem ->> 'name'),
      'description', case when v_desc is null or jsonb_typeof(v_desc) = 'null'
                          then null else nullif(btrim(v_desc #>> '{}'), '') end,
      'unit', v_unit,
      'tax_treatment', v_tax);
    v_eff := v_eff || jsonb_build_object(
      'quantity_milli', v_elem -> 'quantity_milli',
      'unit_price_clp', v_elem -> 'unit_price_clp',
      'tax_treatment', v_tax,
      'discount_kind', v_elem -> 'discount_kind',
      'discount_value', v_elem -> 'discount_value');
  end loop;

  -- Cálculo en la base (copia exacta del de la aplicación) y comparación -----------------
  v_calc := app.quote_calc_v1(v_eff, v_gd_kind, v_gd_value, q.tax_rate_bp);
  if (v_calc ->> 'ok')::boolean is not true then
    select string_agg((x ->> 'code') || coalesce('@' || (x ->> 'lineIndex'), ''), ',')
      into v_issues from jsonb_array_elements(v_calc -> 'issues') x;
    raise exception 'calc_invalid: %', v_issues using errcode = 'CP422';
  end if;
  v_totals := v_calc -> 'totals';
  if v_totals is distinct from p_expected_totals then
    raise exception 'calc_mismatch' using errcode = 'CP500';
  end if;

  -- Guardado ------------------------------------------------------------------------------
  update public.quotes set
    customer_id                 = v_customer,
    global_discount_kind        = v_gd_kind,
    global_discount_value       = v_gd_value,
    subtotal_taxable_clp        = (v_totals ->> 'subtotalTaxableClp')::bigint,
    subtotal_exempt_clp         = (v_totals ->> 'subtotalExemptClp')::bigint,
    subtotal_clp                = (v_totals ->> 'subtotalClp')::bigint,
    line_discounts_clp          = (v_totals ->> 'lineDiscountsClp')::bigint,
    global_discount_clp         = (v_totals ->> 'globalDiscountClp')::bigint,
    global_discount_taxable_clp = (v_totals ->> 'globalDiscountTaxableClp')::bigint,
    global_discount_exempt_clp  = (v_totals ->> 'globalDiscountExemptClp')::bigint,
    net_taxable_clp             = (v_totals ->> 'netTaxableClp')::bigint,
    net_exempt_clp              = (v_totals ->> 'netExemptClp')::bigint,
    tax_clp                     = (v_totals ->> 'taxClp')::bigint,
    total_clp                   = (v_totals ->> 'totalClp')::bigint,
    calc_version                = 'quote-calc-v1',
    revision                    = q.revision + 1,
    last_save_id                = p_save_id
  where tenant_id = v_tenant and id = q.id
  returning revision into v_rev;

  delete from public.quote_items where tenant_id = v_tenant and quote_id = q.id;
  begin
    for i in 0 .. v_count - 1 loop
      v_row  := v_rows -> i;
      v_elem := p_items -> i;
      v_line := v_totals -> 'lines' -> i;
      insert into public.quote_items (
        id, tenant_id, quote_id, position, catalog_item_id, catalog_unit_price_clp, name, description,
        unit, tax_treatment, quantity_milli, unit_price_clp, discount_kind, discount_value,
        gross_clp, discount_clp, line_total_clp)
      values (
        (v_row ->> 'id')::uuid, v_tenant, q.id, i + 1,
        (v_row ->> 'catalog_item_id')::uuid, (v_row ->> 'catalog_unit_price_clp')::bigint,
        v_row ->> 'name', v_row ->> 'description',
        v_row ->> 'unit', v_row ->> 'tax_treatment',
        (v_elem ->> 'quantity_milli')::numeric::bigint, (v_elem ->> 'unit_price_clp')::numeric::bigint,
        v_elem ->> 'discount_kind', (v_elem ->> 'discount_value')::numeric::bigint,
        (v_line ->> 'grossClp')::bigint, (v_line ->> 'discountClp')::bigint, (v_line ->> 'totalClp')::bigint);
    end loop;
  exception when unique_violation then
    -- Un id de línea que ya pertenece a otra cotización: no se dice a cuál.
    raise exception 'item_id_conflict' using errcode = 'CP422';
  end;

  return jsonb_build_object('revision', v_rev, 'totals', v_totals);
end $$;
revoke all on function public.save_quote_draft(uuid, integer, uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_quote_draft(uuid, integer, uuid, jsonb, jsonb, jsonb) to authenticated;
