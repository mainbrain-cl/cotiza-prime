-- Deshace 20261102100000_intake_daily_cap_column.sql: borra la función y devuelve la lectura de todas las
-- columnas de `intake_forms` a los miembros (como estaba). No toca datos.
drop function if exists public.intake_form_daily_caps(uuid);
revoke select on public.intake_forms from authenticated;
grant select on public.intake_forms to authenticated;
