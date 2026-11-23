-- Deshace 20261123100000_quote_text_fields.sql
-- Borra las columnas `quotes.exclusions` y `quotes.footer_note` y la función `app.quote_text_max_length()`, y devuelve `public.save_quote_draft`
-- a su versión de 20261118100000_price_locks.sql (la de H-041), tal cual; los permisos de la función se conservan.
-- SE PIERDE SOLO LO ESCRITO EN ESOS DOS CAMPOS (exclusiones y notas al pie de los borradores): las cotizaciones, líneas, paquetes y la copia
-- sellada de lo ya enviado (que lleva los textos adentro) no se tocan.
-- Se NIEGA a correr (y no cambia nada) si: (a) `public.save_quote_draft` no es EXACTAMENTE la de esta migración (se compara el md5 de su cuerpo con
-- el del archivo; la prueba lo recalcula): otra migración la redefinió (p. ej. H-042 o H-041b) o ya se deshizo, y reponer la de H-041 pisaría ese
-- cambio; o (b) ALGUNA OTRA función de `public` o `app` nombra las columnas (`exclusions`, `footer_note`: sueltas o con alias, como `q.exclusions` o en un
-- `insert into public.quotes (…)`) o nombra `quote_text_max_length` (borrarlos la rompería). Cuenta la palabra suelta que NO esté entre comillas simples:
-- los textos 'exclusions' y 'footer_note' de `app.snippet_kinds()` (H-048a) son nombres de tipo de texto guardado, no estas columnas.
-- ADVERTENCIA. Con la aplicación de H-048b funcionando, los dos campos dejan de existir al deshacer: aplicarlo solo con la aplicación en
-- mantenimiento o ya vuelta atrás a la etapa anterior. Va ANTES del deshacer de 20261118100000_price_locks.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'el deshacer 20261123100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

do $$
declare
  c_known constant regprocedure[] := array[
    to_regprocedure('app.quote_text_max_length()'),
    to_regprocedure('public.save_quote_draft(uuid, integer, uuid, jsonb, jsonb, jsonb)')];
begin
  -- (a) guardar el borrador es el de esta migración
  if not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.save_quote_draft(uuid, integer, uuid, jsonb, jsonb, jsonb)')::oid
                    and md5(p.prosrc) = '0cd4b44ff2c3c6128672b9469fc37c91') then
    raise exception 'no se puede deshacer 20261123100000_quote_text_fields: la funcion public.save_quote_draft vigente ya no es la de esta migracion: otra migracion la redefinio o ya se deshizo; revise el orden de los deshacer';
  end if;
  -- (b) nadie más nombra lo que se va a quitar
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('public', 'app')
                and p.oid <> all (c_known::oid[])
                and (p.prosrc ~ 'quote_text_max_length' or p.prosrc ~ '(^|[^''[:alnum:]_])(footer_note|exclusions)($|[^''[:alnum:]_])')) then
    raise exception 'no se puede deshacer 20261123100000_quote_text_fields: otra funcion nombra las columnas exclusions o footer_note o la funcion quote_text_max_length; la romperia; revise el orden de los deshacer';
  end if;
end $$;

-- La versión anterior de guardar el borrador (20261118100000_price_locks.sql), tal cual.
create or replace function public.save_quote_draft(
  p_quote_id uuid, p_expected_revision integer, p_save_id uuid,
  p_header jsonb, p_items jsonb, p_expected_totals jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c_max_lines constant integer := 200;
  -- Caracteres de control, salvo tabulación, salto de línea y retorno de carro.
  c_control_chars constant text := '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]';
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
  v_val       jsonb;
  v_val_mode  text;
  v_val_days  smallint;
  v_val_until date;
  v_obs       text;
  v_cond      text;
  c_max_override_lines constant integer := 20;   -- líneas que lleva el evento de un precio bloqueado cambiado
  v_prev      jsonb := '[]'::jsonb;   -- por línea: el precio que tenía (null si la línea es nueva)
  v_denied    text[] := '{}';         -- líneas nuevas del catálogo que la organización no deja cotizar a esta persona (H-042)
  v_check_in  jsonb := '[]'::jsonb;   -- lo que mira la regla: precio, descuento y bruto de cada línea
  v_check     jsonb;
  v_problems  text[];
  v_changes   jsonb := '[]'::jsonb;   -- líneas con precio bloqueado cambiado DE VERDAD en este guardado
  v_idx       integer;
  v_data      jsonb;
begin
  if v_tenant is null or v_uid is null or not app.can('quote.edit', true) then
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
  if exists (select 1 from jsonb_object_keys(p_header) k where k not in
       ('customer_id', 'global_discount', 'validity', 'observations', 'conditions')) then
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

  -- Vigencia: sin la clave, queda como estaba.
  v_val_mode  := q.validity_mode;
  v_val_days  := q.validity_days;
  v_val_until := q.valid_until;
  if p_header ? 'validity' then
    v_val := p_header -> 'validity';
    if jsonb_typeof(v_val) is distinct from 'object' or jsonb_typeof(v_val -> 'mode') is distinct from 'string' then
      raise exception 'invalid_validity' using errcode = 'CP422';
    end if;
    if (v_val ->> 'mode') = 'days' then
      if not app.calc_jsonb_int_in_range(v_val -> 'days', 1, 365) then
        raise exception 'invalid_validity' using errcode = 'CP422';
      end if;
      v_val_mode := 'days';
      v_val_days := (v_val ->> 'days')::numeric::smallint;
      v_val_until := null;   -- se fija al enviar
    elsif (v_val ->> 'mode') = 'date' then
      if jsonb_typeof(v_val -> 'date') is distinct from 'string'
         or (v_val ->> 'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'invalid_validity' using errcode = 'CP422';
      end if;
      begin
        v_val_until := (v_val ->> 'date')::date;
      exception when others then
        raise exception 'invalid_validity' using errcode = 'CP422';
      end;
      -- La fecha ya guardada puede haber quedado en el pasado sin que se toque; una nueva no.
      if v_val_until < app.current_business_date() and v_val_until is distinct from q.valid_until then
        raise exception 'validity_in_past' using errcode = 'CP422';
      end if;
      if v_val_until > date '2100-01-01' then
        raise exception 'invalid_validity' using errcode = 'CP422';
      end if;
      v_val_mode := 'date';
      v_val_days := null;
    else
      raise exception 'invalid_validity' using errcode = 'CP422';
    end if;
  end if;

  -- Observaciones y condiciones: texto simple (se guarda tal cual; la pantalla lo escapa al mostrarlo).
  v_obs  := q.observations;
  v_cond := q.conditions;
  if p_header ? 'observations' then
    if jsonb_typeof(p_header -> 'observations') = 'null' then v_obs := null;
    elsif jsonb_typeof(p_header -> 'observations') = 'string'
          and char_length(p_header ->> 'observations') <= 4000
          and (p_header ->> 'observations') !~ c_control_chars then
      v_obs := nullif(btrim(p_header ->> 'observations'), '');
    else raise exception 'invalid_observations' using errcode = 'CP422';
    end if;
  end if;
  if p_header ? 'conditions' then
    if jsonb_typeof(p_header -> 'conditions') = 'null' then v_cond := null;
    elsif jsonb_typeof(p_header -> 'conditions') = 'string'
          and char_length(p_header ->> 'conditions') <= 4000
          and (p_header ->> 'conditions') !~ c_control_chars then
      v_cond := nullif(btrim(p_header ->> 'conditions'), '');
    else raise exception 'invalid_conditions' using errcode = 'CP422';
    end if;
  end if;

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
      -- Línea existente: conserva su origen (y, si es del catálogo, su unidad y trato tributario).
      -- Una línea libre sí puede cambiar de unidad y de trato tributario; la del catálogo no.
      if v_cat_id is distinct from v_exist.catalog_item_id
         or (v_exist.catalog_item_id is not null
             and (v_unit <> v_exist.unit or v_tax <> v_exist.tax_treatment)) then
        raise exception 'catalog_item_changed' using errcode = 'CP422';
      end if;
      v_cat_price := v_exist.catalog_unit_price_clp;
      v_prev := v_prev || to_jsonb(v_exist.unit_price_clp);
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
      v_prev := v_prev || 'null'::jsonb;
      -- Gancho de H-042 (servicios por comercial): solo para una línea NUEVA del catálogo; una que ya estaba se sigue guardando.
      if not app.can_quote_catalog_item(v_cat_id) then
        v_denied := v_denied || ('catalog_item_not_allowed@' || i);
      end if;
    else
      v_cat_price := null;
      v_prev := v_prev || 'null'::jsonb;
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

  -- Reglas de precio y descuento (H-041): se miran ANTES de escribir; si algo no cumple, no se guarda nada. La regla vive en
  -- `app.line_rule_issues`; aquí se arma lo que mira con el precio de catálogo congelado y el bruto que acaba de calcular la base.
  for i in 0 .. v_count - 1 loop
    v_check_in := v_check_in || jsonb_build_object(
      'catalog_item_id', (v_rows -> i) ->> 'catalog_item_id',
      'catalog_unit_price_clp', (v_rows -> i) -> 'catalog_unit_price_clp',
      'unit_price_clp', (p_items -> i) -> 'unit_price_clp',
      'discount_kind', (p_items -> i) -> 'discount_kind',
      'discount_value', (p_items -> i) -> 'discount_value',
      'gross_clp', (v_totals -> 'lines' -> i) -> 'grossClp');
  end loop;
  v_check := app.quote_line_rules_check(
    v_tenant, v_check_in,
    jsonb_build_object('kind', v_gd_kind, 'value', v_gd_value, 'base_clp', v_totals -> 'subtotalClp'));
  v_problems := array(select jsonb_array_elements_text(v_check -> 'issues')) || v_denied;
  if cardinality(v_problems) > 0 then
    raise exception 'line_rules_invalid: %', array_to_string(v_problems, ',') using errcode = 'CP422';
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
    validity_mode               = v_val_mode,
    validity_days               = v_val_days,
    valid_until                 = v_val_until,
    observations                = v_obs,
    conditions                  = v_cond,
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

  -- Un precio bloqueado cambiado por quien puede saltarse el candado: queda en la línea de tiempo y en la auditoría, pero SOLO si
  -- el guardado lo cambió de verdad (línea nueva con otro precio, o precio distinto del que ya tenía). Sin nombres de línea. Cada línea
  -- lleva solo su posición, el servicio y el precio anterior y el nuevo: con 20 líneas de montos de 12 cifras el evento mide ~3.200 de
  -- los 4.096 bytes que permite su restricción (con el precio de catálogo también serían 3.968: demasiado justo).
  for v_idx in select (e.value)::integer from jsonb_array_elements_text(v_check -> 'overrides') e loop
    if jsonb_typeof(v_prev -> v_idx) = 'null'
       or (v_prev ->> v_idx)::numeric <> (((p_items -> v_idx) ->> 'unit_price_clp'))::numeric then
      v_changes := v_changes || jsonb_build_object(
        'position', v_idx + 1,
        'catalog_item_id', (v_rows -> v_idx) ->> 'catalog_item_id',
        'old_price_clp', v_prev -> v_idx,
        -- normalizado a entero: el JSON crudo podría traer ceros decimales (8000.0000) y desviar la medida del evento
        'new_price_clp', ((p_items -> v_idx) ->> 'unit_price_clp')::numeric::bigint);
    end if;
  end loop;
  if jsonb_array_length(v_changes) > 0 then
    v_data := jsonb_build_object(
      'count', jsonb_array_length(v_changes),
      'lines', (select coalesce(jsonb_agg(c.value order by c.ordinality), '[]'::jsonb)
                  from jsonb_array_elements(v_changes) with ordinality c(value, ordinality)
                 where c.ordinality <= c_max_override_lines));
    perform app.write_quote_event(v_tenant, q.id, 'locked_price_overridden', 'user', v_uid, v_data);
    perform app.write_audit(v_tenant, 'user', v_uid, 'quote.locked_price_overridden', 'quote', q.id, 'success', v_data);
  end if;

  return jsonb_build_object('revision', v_rev, 'totals', v_totals);
end $$;

alter table public.quotes drop column exclusions, drop column footer_note;
drop function app.quote_text_max_length();
