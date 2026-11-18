-- Sprint 5 · H-041 · Bloquear precios del catálogo y poner un tope al descuento de quien vende (etapa A: la base, sin pantallas)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261118100000_price_locks.down.sql
-- Especificación: docs/arquitectura/h-041-precios-bloqueados.md (§2.1 a §2.5 y §2.9; supuestos de las preguntas 16 a 19).
--
-- Qué agrega:
--   · `catalog_items.price_locked`: el servicio no se puede cotizar a otro precio (quien no tiene `catalog.price_lock.override`).
--     Se lee del catálogo DE HOY, nunca se copia a `quote_items`: así quitar el candado libera también las líneas ya guardadas.
--   · `tenants.max_discount_bp`: el tope de descuento de quien vende, en centésimas de punto (1.000 = 10 %); vacío = sin tope y 0 =
--     sin descuentos. Sin escritura directa: solo `public.set_quote_max_discount` (exige `catalog.manage`). Todo miembro lo lee.
--   · `app.can_quote_catalog_item(uuid)`: el GANCHO de H-042 (servicios por comercial). Hoy responde siempre «sí». H-042 la
--     reemplaza con `create or replace` sin tocar `save_quote_draft`; `tests/db/save-quote-draft-contract.test.ts` vigila que siga
--     conectada. Solo se llama para una línea NUEVA del catálogo, nunca para una que la cotización ya tenía.
--   · `app.line_rule_issues(líneas, descuento general, tope, ¿puede saltarse?)`: la regla, PURA (no lee tablas), gemela de
--     `src/lib/quotes/line-rules.ts` (`tests/db/line-rules-parity.test.ts` exige que respondan igual). Devuelve la lista de
--     problemas `price_locked@i`, `discount_over_cap@i` y `global_discount_over_cap` (i desde 0, como los de la calculadora).
--   · `app.quote_line_rules_check(organización, líneas, descuento general)`: la que lee el tope y los candados SIEMPRE por
--     (organización, id) y decide si la persona puede saltarse la regla (`app.can('catalog.price_lock.override')`, y solo si la
--     organización de la cotización es la activa). Devuelve `{issues, overrides}`.
--   · El disparador `quote_packages_a_line_rules_gate` (ANTES de insertar un paquete, y antes que el de aprobación: el tope duro
--     manda sobre la aprobación): al enviar vuelve a mirar la regla con las líneas guardadas. Cubre un tope bajado o un candado
--     puesto DESPUÉS de guardar, una carrera, y un Administrador que pasa a Comercial entre guardar y enviar. Es un disparador y no
--     un cambio a `prepare_quote_send` (que no se toca), igual que el de H-040. NO corre en el reenvío ni en
--     `confirm_email_dispatch`: no crean un paquete nuevo.
--   · `public.save_quote_draft` (misma firma): pasa de `has_role('owner','admin','sales')` a `app.can('quote.edit', true)` (mismo
--     resultado), llama al gancho para las líneas nuevas del catálogo, mira la regla antes de escribir y, si alguien con permiso
--     cambia DE VERDAD un precio bloqueado, deja un evento `locked_price_overridden` en la línea de tiempo y una auditoría
--     `quote.locked_price_overridden` (a lo más 20 líneas, sin nombres de línea).
--
-- Quién queda sujeto a la regla: toda persona sin `catalog.price_lock.override` (hoy el Comercial). Dueño y Administrador la
-- saltan; el Aprobador y el Observador no arman cotizaciones.
--
-- HUECO CONOCIDO (pregunta 18, riesgo aceptado): la regla mira líneas del catálogo. Una línea libre escrita a mano, cambiarle el
-- nombre a un servicio del catálogo o bajar la cantidad siguen siendo posibles; los cierra una historia posterior (H-041b).
--
-- Bloqueos: los `alter table` van al final para que el bloqueo exclusivo sobre `catalog_items` y `tenants` dure lo mínimo; el
-- disparador toma un bloqueo sobre `quote_packages` hasta el final de la transacción. Aplicar sobre la base vacía o en una ventana
-- tranquila (docs/arquitectura/modelo-datos.md §9.4).
--
-- Guardia 15 (tests/db/schema-guards.test.ts): primera sentencia `set local lock_timeout = '3s'` y, justo después, la
-- verificación de que el valor quedó puesto (si la herramienta que aplica el archivo no lo respetara, se detiene).
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'la migracion 20261118100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

-- 1. El gancho de H-042 -------------------------------------------------------------------------------
create function app.can_quote_catalog_item(p_catalog_item_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$ select true $$;
revoke all on function app.can_quote_catalog_item(uuid) from public, anon, authenticated;

-- 2. La regla, pura -----------------------------------------------------------------------------------
-- ¿La línea tiene el precio bloqueado y se cotiza a otro precio que el de catálogo que congeló? Subirlo tampoco vale.
create function app.line_price_lock_broken(p_line jsonb) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select coalesce((p_line ->> 'price_locked')::boolean, false)
     and (p_line ->> 'catalog_unit_price_clp') is not null
     and (p_line ->> 'unit_price_clp')::numeric <> (p_line ->> 'catalog_unit_price_clp')::numeric
$$;

-- ¿Este descuento pasa del tope? `p_base` es el bruto de la línea (o el subtotal, para el descuento general). En porcentaje se
-- compara el valor con el tope; en pesos, con el tope aplicado a la base (mitad hacia arriba, como todo el cálculo): así $1.005
-- al 10 % (= $101 redondeado) no se rechaza por el redondeo.
create function app.discount_over_cap(p_kind text, p_value numeric, p_base numeric, p_max_bp integer) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select case
    when p_max_bp is null then false
    when p_kind = 'percent' then p_value > p_max_bp
    when p_kind = 'amount' then p_value > app.round_half_up_div(p_base * p_max_bp, 10000)
    else false end
$$;

-- p_lines:  [{price_locked, catalog_unit_price_clp, unit_price_clp, discount_kind, discount_value, gross_clp}, …]
-- p_global: {kind, value, base_clp} (base = subtotal ya con los descuentos de línea) o null
-- Devuelve los problemas en orden: por línea `price_locked@i` y `discount_over_cap@i`, y al final `global_discount_over_cap`.
create function app.line_rule_issues(p_lines jsonb, p_global jsonb, p_max_bp integer, p_can_override boolean) returns text[]
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  v_issues text[] := '{}';
  v_line   jsonb;
begin
  if coalesce(p_can_override, false) then
    return v_issues;
  end if;
  for i in 0 .. coalesce(jsonb_array_length(p_lines), 0) - 1 loop
    v_line := p_lines -> i;
    if app.line_price_lock_broken(v_line) then
      v_issues := v_issues || ('price_locked@' || i);
    end if;
    if app.discount_over_cap(v_line ->> 'discount_kind', (v_line ->> 'discount_value')::numeric,
                             (v_line ->> 'gross_clp')::numeric, p_max_bp) then
      v_issues := v_issues || ('discount_over_cap@' || i);
    end if;
  end loop;
  if p_global is not null and jsonb_typeof(p_global) = 'object'
     and app.discount_over_cap(p_global ->> 'kind', (p_global ->> 'value')::numeric,
                               (p_global ->> 'base_clp')::numeric, p_max_bp) then
    v_issues := array_append(v_issues, 'global_discount_over_cap');
  end if;
  return v_issues;
end $$;

-- Las líneas con el precio bloqueado que se cotizan a otro precio (índices desde 0): lo que se anota cuando quien puede saltarse
-- el candado lo hace.
create function app.locked_price_override_lines(p_lines jsonb) returns integer[]
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  v_found integer[] := '{}';
begin
  for i in 0 .. coalesce(jsonb_array_length(p_lines), 0) - 1 loop
    if app.line_price_lock_broken(p_lines -> i) then
      v_found := v_found || i;
    end if;
  end loop;
  return v_found;
end $$;
revoke all on function
  app.line_price_lock_broken(jsonb),
  app.discount_over_cap(text, numeric, numeric, integer),
  app.line_rule_issues(jsonb, jsonb, integer, boolean),
  app.locked_price_override_lines(jsonb)
  from public, anon, authenticated;

-- 3. La regla, con los datos de la organización -------------------------------------------------------
-- p_lines: [{catalog_item_id, catalog_unit_price_clp, unit_price_clp, discount_kind, discount_value, gross_clp}, …]
-- El candado y el tope se leen SIEMPRE por (organización, id): un servicio de otra organización no existe aquí. Quien guarda o
-- envía nunca manda el candado (se leería del navegador). La persona se salta la regla solo si la organización es la activa Y su
-- rol lo permite; si no, vale para todos (por ejemplo, un envío hecho sin sesión de persona).
create function app.quote_line_rules_check(p_tenant uuid, p_lines jsonb, p_global jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_max_bp   integer;
  v_override boolean;
  v_lines    jsonb;
  v_issues   text[];
begin
  select t.max_discount_bp into v_max_bp from public.tenants t where t.tenant_id = p_tenant;
  v_override := p_tenant = app.current_tenant_id() and app.can('catalog.price_lock.override');
  select coalesce(jsonb_agg(l.line || jsonb_build_object('price_locked', coalesce(ci.price_locked, false)) order by l.ord),
                  '[]'::jsonb)
    into v_lines
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality as l(line, ord)
    left join public.catalog_items ci
      on ci.tenant_id = p_tenant
     and ci.id = case when jsonb_typeof(l.line -> 'catalog_item_id') = 'string' and app.is_uuid_text(l.line ->> 'catalog_item_id')
                      then (l.line ->> 'catalog_item_id')::uuid end;
  v_issues := app.line_rule_issues(v_lines, p_global, v_max_bp, v_override);
  return jsonb_build_object(
    'issues', to_jsonb(v_issues),
    'overrides', case when v_override then to_jsonb(app.locked_price_override_lines(v_lines)) else '[]'::jsonb end);
end $$;
revoke all on function app.quote_line_rules_check(uuid, jsonb, jsonb) from public, anon, authenticated;

-- 4. El tope de descuento -----------------------------------------------------------------------------
create function public.set_quote_max_discount(p_max_bp integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  v_cur    integer;
begin
  -- 1. ¿es miembro de la organización activa?
  if v_tenant is null or v_uid is null then
    raise exception 'not_found' using errcode = 'CP404';
  end if;
  -- 2. ¿puede manejar el catálogo?
  if not app.can('catalog.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- 3. forma de lo recibido: vacío (sin tope) o de 0 a 99,99 %
  if p_max_bp is not null and p_max_bp not between 0 and 9999 then
    raise exception 'invalid_max_discount' using errcode = 'CP422';
  end if;
  -- 4. la fila de la organización queda tomada: dos cambios a la vez no se pisan
  select t.max_discount_bp into v_cur from public.tenants t where t.tenant_id = v_tenant for no key update;
  if not found then
    raise exception 'not_found' using errcode = 'CP404';
  end if;
  -- 5. el mismo valor otra vez (doble clic): no se escribe nada, ni se audita
  if v_cur is not distinct from p_max_bp then
    return jsonb_build_object('changed', false, 'max_discount_bp', v_cur);
  end if;
  -- 6. la auditoría de `tenants` registra el valor anterior y el nuevo
  update public.tenants set max_discount_bp = p_max_bp where tenant_id = v_tenant;
  return jsonb_build_object('changed', true, 'max_discount_bp', p_max_bp);
end $$;
revoke all on function public.set_quote_max_discount(integer) from public, anon, authenticated;
grant execute on function public.set_quote_max_discount(integer) to authenticated;

-- 5. Guardar el borrador ------------------------------------------------------------------------------
-- La versión anterior es la de 20261005130000_brand_server_only_logo.sql. Cambia: el permiso (de `has_role` a la matriz), el
-- gancho de H-042 para las líneas nuevas del catálogo, la regla antes de escribir y el evento de un precio bloqueado cambiado.
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

-- 6. El control en el envío ---------------------------------------------------------------------------
create function app.quote_packages_line_rules_gate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  q       record;
  v_lines jsonb;
  v_check jsonb;
begin
  -- Una cotización que no es de esta organización (o no existe) no se evalúa: la relación compuesta rechaza la fila (23503),
  -- como ya hace `quote_packages_approval_gate`.
  select qt.global_discount_kind, qt.global_discount_value, qt.subtotal_clp into q
    from public.quotes qt where qt.tenant_id = new.tenant_id and qt.id = new.quote_id;
  if not found then
    return new;
  end if;
  -- Las líneas guardadas, en el orden de la pantalla (`position` 1..n ⇒ índice 0..n-1, el de los problemas que se informan).
  select coalesce(jsonb_agg(jsonb_build_object(
           'catalog_item_id', qi.catalog_item_id,
           'catalog_unit_price_clp', qi.catalog_unit_price_clp,
           'unit_price_clp', qi.unit_price_clp,
           'discount_kind', qi.discount_kind,
           'discount_value', qi.discount_value,
           'gross_clp', qi.gross_clp) order by qi.position), '[]'::jsonb)
    into v_lines
    from public.quote_items qi where qi.tenant_id = new.tenant_id and qi.quote_id = new.quote_id;
  v_check := app.quote_line_rules_check(
    new.tenant_id, v_lines,
    jsonb_build_object('kind', q.global_discount_kind, 'value', q.global_discount_value, 'base_clp', q.subtotal_clp));
  if jsonb_array_length(v_check -> 'issues') > 0 then
    -- Mismo formato que al guardar; todo se deshace dentro de la transacción de `prepare_quote_send` (sin paquete, enlace,
    -- correo ni candado de envío a medias).
    raise exception 'line_rules_invalid: %', array_to_string(array(select jsonb_array_elements_text(v_check -> 'issues')), ',')
      using errcode = 'CP422';
  end if;
  return new;
end $$;
revoke all on function app.quote_packages_line_rules_gate() from public, anon, authenticated;
-- El nombre empieza con «a_» a propósito: PostgreSQL dispara los disparadores del mismo momento en orden alfabético, y este tiene
-- que ir ANTES de `quote_packages_approval_gate` (primero el tope duro; después, si hace falta, la aprobación).
create trigger quote_packages_a_line_rules_gate before insert on public.quote_packages
  for each row execute function app.quote_packages_line_rules_gate();

-- 7. Las columnas (al final, para que el bloqueo dure lo mínimo) -------------------------------------
alter table public.catalog_items add column price_locked boolean not null default false;
-- La regla por fila de `catalog_items` ya exige `catalog.manage`; la auditoría de diferencias ya registra el cambio.
grant insert (price_locked), update (price_locked) on public.catalog_items to authenticated;

alter table public.tenants add column max_discount_bp integer;
alter table public.tenants add constraint tenants_max_discount_bp_range
  check (max_discount_bp is null or max_discount_bp between 0 and 9999);
-- Sin `grant update`: solo `public.set_quote_max_discount` lo escribe. Todo miembro lo lee (el `select` de `tenants` es de toda la tabla).
