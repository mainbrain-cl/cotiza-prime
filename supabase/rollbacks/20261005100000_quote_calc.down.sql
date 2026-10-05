-- Deshace 20261005100000_quote_calc.sql
drop function if exists app.quote_calc_v1(jsonb, text, bigint, integer);
drop function if exists app.calc_jsonb_int_in_range(jsonb, numeric, numeric);
drop function if exists app.vat_rate_bp();
drop function if exists app.round_half_up_div(numeric, numeric);
