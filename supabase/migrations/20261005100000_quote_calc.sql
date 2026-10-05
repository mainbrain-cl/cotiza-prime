-- Migración 15 — Copia en la base del cálculo de cotizaciones (H-025/H-026, Q1)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261005100000_quote_calc.down.sql
--
-- Es la copia exacta de src/lib/quotes/calc.ts y src/lib/money/rounding.ts
-- (docs/arquitectura/cotizaciones-y-calculo.md §3). Si cambia una regla allá, cámbiala aquí y sube
-- QUOTE_CALC_VERSION. La prueba tests/db/quote-calc-parity.test.ts exige que den el mismo JSON.
-- Pasos intermedios en `numeric` (cantidad × precio llega a 10^21, más que `bigint`); nunca `float`.
-- Son funciones internas del esquema `app`: sin permisos para anon ni authenticated; las usarán
-- las funciones de la migración siguiente (save_quote_draft), que corren con permisos de su dueño.

-- Redondeo de dinero: medio peso hacia arriba. Solo para n >= 0 y d > 0.
create function app.round_half_up_div(n numeric, d numeric) returns numeric
language plpgsql immutable parallel safe set search_path = '' as $$
begin
  if n is null or n < 0 then
    raise exception 'round_half_up_div solo acepta numeradores mayores o iguales a 0' using errcode = '22003';
  end if;
  if d is null or d <= 0 then
    raise exception 'round_half_up_div solo acepta denominadores mayores que 0' using errcode = '22012';
  end if;
  return div(2 * n + d, 2 * d);
end $$;

-- IVA vigente en Chile, en puntos base (19% = 1900). Valor por defecto de las cotizaciones nuevas.
create function app.vat_rate_bp() returns integer
language sql immutable parallel safe set search_path = '' as $$
  select 1900
$$;

-- ¿El valor JSON es un número entero dentro de [p_min, p_max]? (equivale a isIntInRange de calc.ts)
create function app.calc_jsonb_int_in_range(p jsonb, p_min numeric, p_max numeric) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select coalesce(
    jsonb_typeof(p) = 'number'
    and (p::numeric) = trunc(p::numeric)
    and (p::numeric) between p_min and p_max,
    false)
$$;

-- Cálculo de la cotización. Orden de evaluación de errores (idéntico a calc.ts):
--  1. Más de 200 líneas: solo too_many_lines.
--  2. Tasa de IVA fuera de 0..10.000: invalid_tax_rate (sin posición); no corta.
--  3. Por línea, en orden: invalid_quantity, invalid_price, invalid_discount, invalid_tax_treatment.
--  4. Si la línea quedó bien de forma: line_gross_too_large o, si no, line_discount_exceeds_gross.
--  5. Si hay algún problema hasta aquí, se devuelven todos juntos.
--  6. Descuento global con forma mala: solo invalid_discount (lineIndex null).
--  7. Descuento global mayor que el subtotal: solo global_discount_exceeds_subtotal.
--  8. Total sobre el tope: solo total_too_large.
-- p_items: arreglo de {quantity_milli, unit_price_clp, tax_treatment, discount_kind, discount_value}
--          (cantidad en milésimas; descuento en puntos base si es percent, en pesos si es amount).
-- Devuelve {"ok": true, "totals": {...}} o {"ok": false, "issues": [{"code", "lineIndex"}]},
-- con los mismos nombres de campo que QuoteTotals / CalcResult de calc.ts.
create function app.quote_calc_v1(
  p_items jsonb, p_global_kind text, p_global_value bigint, p_tax_rate_bp int
) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  c_max_lines     constant integer := 200;
  c_qty_min_milli constant numeric := 1;
  c_qty_max_milli constant numeric := 1000000000;
  c_max_clp       constant numeric := 1000000000000;
  c_percent_max   constant numeric := 10000;   -- 100% en puntos base
  c_tax_rate_max  constant numeric := 10000;
  c_milli         constant numeric := 1000;

  v_count     integer;
  v_issues    jsonb := '[]'::jsonb;
  v_item      jsonb;
  v_valid     boolean;
  v_kind      text;
  v_gross     numeric;
  v_discount  numeric;
  v_lines     jsonb := '[]'::jsonb;
  v_sub_t     numeric := 0;
  v_sub_e     numeric := 0;
  v_line_disc numeric := 0;
  v_sub       numeric;
  v_global    numeric;
  v_global_t  numeric;
  v_global_e  numeric;
  v_net_t     numeric;
  v_net_e     numeric;
  v_tax       numeric;
  v_total     numeric;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'quote_calc_v1: p_items debe ser un arreglo JSON' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_items);

  if v_count > c_max_lines then
    return jsonb_build_object('ok', false,
      'issues', jsonb_build_array(jsonb_build_object('code', 'too_many_lines', 'lineIndex', null)));
  end if;

  if p_tax_rate_bp is null or p_tax_rate_bp < 0 or p_tax_rate_bp > c_tax_rate_max then
    v_issues := v_issues || jsonb_build_object('code', 'invalid_tax_rate', 'lineIndex', null);
  end if;

  for i in 0 .. v_count - 1 loop
    v_item := p_items -> i;
    v_valid := true;

    if not app.calc_jsonb_int_in_range(v_item -> 'quantity_milli', c_qty_min_milli, c_qty_max_milli) then
      v_issues := v_issues || jsonb_build_object('code', 'invalid_quantity', 'lineIndex', i);
      v_valid := false;
    end if;
    if not app.calc_jsonb_int_in_range(v_item -> 'unit_price_clp', 0, c_max_clp) then
      v_issues := v_issues || jsonb_build_object('code', 'invalid_price', 'lineIndex', i);
      v_valid := false;
    end if;

    v_kind := case when jsonb_typeof(v_item -> 'discount_kind') = 'string'
                   then v_item ->> 'discount_kind' end;
    if not coalesce(
         v_kind = 'none'
         or (v_kind = 'percent' and app.calc_jsonb_int_in_range(v_item -> 'discount_value', 0, c_percent_max))
         or (v_kind = 'amount'  and app.calc_jsonb_int_in_range(v_item -> 'discount_value', 0, c_max_clp)),
         false) then
      v_issues := v_issues || jsonb_build_object('code', 'invalid_discount', 'lineIndex', i);
      v_valid := false;
    end if;

    if not coalesce(
         jsonb_typeof(v_item -> 'tax_treatment') = 'string'
         and (v_item ->> 'tax_treatment') in ('taxable', 'exempt'),
         false) then
      v_issues := v_issues || jsonb_build_object('code', 'invalid_tax_treatment', 'lineIndex', i);
      v_valid := false;
    end if;

    if not v_valid then
      continue;
    end if;

    -- ① bruto: cantidad (milésimas) × precio / 1000
    v_gross := app.round_half_up_div(
      (v_item ->> 'quantity_milli')::numeric * (v_item ->> 'unit_price_clp')::numeric, c_milli);
    if v_gross > c_max_clp then
      v_issues := v_issues || jsonb_build_object('code', 'line_gross_too_large', 'lineIndex', i);
      continue;
    end if;
    -- ② descuento de línea (% redondeado; $ exacto)
    v_discount := case v_kind
      when 'percent' then app.round_half_up_div(v_gross * (v_item ->> 'discount_value')::numeric, c_percent_max)
      when 'amount'  then (v_item ->> 'discount_value')::numeric
      else 0 end;
    if v_discount > v_gross then
      v_issues := v_issues || jsonb_build_object('code', 'line_discount_exceeds_gross', 'lineIndex', i);
      continue;
    end if;

    if (v_item ->> 'tax_treatment') = 'taxable' then
      v_sub_t := v_sub_t + (v_gross - v_discount);
    else
      v_sub_e := v_sub_e + (v_gross - v_discount);
    end if;
    v_line_disc := v_line_disc + v_discount;
    v_lines := v_lines || jsonb_build_object(
      'grossClp', v_gross::bigint,
      'discountClp', v_discount::bigint,
      'totalClp', (v_gross - v_discount)::bigint);
  end loop;

  if jsonb_array_length(v_issues) > 0 then
    return jsonb_build_object('ok', false, 'issues', v_issues);
  end if;

  v_sub := v_sub_t + v_sub_e;

  -- descuento global: forma
  if not coalesce(
       p_global_kind = 'none'
       or (p_global_kind = 'percent' and p_global_value between 0 and c_percent_max)
       or (p_global_kind = 'amount'  and p_global_value between 0 and c_max_clp),
       false) then
    return jsonb_build_object('ok', false,
      'issues', jsonb_build_array(jsonb_build_object('code', 'invalid_discount', 'lineIndex', null)));
  end if;

  -- ② descuento global
  v_global := case p_global_kind
    when 'percent' then app.round_half_up_div(v_sub * p_global_value::numeric, c_percent_max)
    when 'amount'  then p_global_value::numeric
    else 0 end;
  if v_global > v_sub then
    return jsonb_build_object('ok', false,
      'issues', jsonb_build_array(jsonb_build_object('code', 'global_discount_exceeds_subtotal', 'lineIndex', null)));
  end if;

  -- ③ reparto proporcional entre afecto y exento; el resto va al exento
  v_global_t := case when v_sub = 0 then 0 else app.round_half_up_div(v_global * v_sub_t, v_sub) end;
  v_global_e := v_global - v_global_t;
  v_net_t := v_sub_t - v_global_t;
  v_net_e := v_sub_e - v_global_e;
  -- ④ IVA, una sola vez, sobre el neto afecto
  v_tax := app.round_half_up_div(v_net_t * p_tax_rate_bp::numeric, c_percent_max);
  v_total := v_net_t + v_net_e + v_tax;
  if v_total > c_max_clp then
    return jsonb_build_object('ok', false,
      'issues', jsonb_build_array(jsonb_build_object('code', 'total_too_large', 'lineIndex', null)));
  end if;

  return jsonb_build_object('ok', true, 'totals', jsonb_build_object(
    'lines', v_lines,
    'subtotalTaxableClp', v_sub_t::bigint,
    'subtotalExemptClp', v_sub_e::bigint,
    'subtotalClp', v_sub::bigint,
    'lineDiscountsClp', v_line_disc::bigint,
    'globalDiscountClp', v_global::bigint,
    'globalDiscountTaxableClp', v_global_t::bigint,
    'globalDiscountExemptClp', v_global_e::bigint,
    'netTaxableClp', v_net_t::bigint,
    'netExemptClp', v_net_e::bigint,
    'taxClp', v_tax::bigint,
    'totalClp', v_total::bigint));
end $$;
