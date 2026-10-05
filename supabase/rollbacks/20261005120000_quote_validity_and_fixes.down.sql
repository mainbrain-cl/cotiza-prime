-- Deshace 20261005120000_quote_validity_and_fixes.sql
-- Vuelve a las definiciones de la migración 17 (create or replace conserva los permisos).
-- 5. create_quote ---------------------------------------------------------------------------
create or replace function public.create_quote(p_customer_id uuid, p_creation_key uuid)
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

-- 6. save_quote_draft -----------------------------------------------------------------------
-- p_header:  {"customer_id": uuid, "global_discount": {"kind": "none|percent|amount", "value": n}}
--            (claves desconocidas se rechazan: H-027 y H-052 agregarán las suyas sin cambiar la firma)
-- p_items:   arreglo de {id, catalog_item_id?, name, description?, unit, tax_treatment,
--            quantity_milli, unit_price_clp, discount_kind, discount_value}, en el orden de la pantalla
-- p_expected_totals: el `totals` que calculó la aplicación; si la base no obtiene exactamente lo
--            mismo, no guarda nada (CP500).
create or replace function public.save_quote_draft(
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

drop function if exists app.current_business_date();
alter table public.quotes drop constraint if exists quotes_validity_shape;
revoke update (default_validity_days) on public.tenants from authenticated;
alter table public.tenants drop column if exists default_validity_days;
