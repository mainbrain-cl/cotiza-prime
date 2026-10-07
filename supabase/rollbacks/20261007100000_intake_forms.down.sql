-- Deshace 20261007100000_intake_forms.sql
-- Protección: no se deshace si ya hay formularios (los enlaces y códigos QR impresos dejarían de existir y
-- las solicitudes que lleguen por ellos perderían su formulario). Si hay datos, se archivan a mano antes.
do $$
begin
  if exists (select 1 from public.intake_forms) then
    raise exception 'no se puede deshacer: hay formularios publicos (se perderian enlaces y codigos QR ya entregados)';
  end if;
end $$;

drop function if exists public.regenerate_intake_form_public_id(uuid);
drop function if exists public.set_intake_form_status(uuid, text);
drop function if exists public.save_intake_form(uuid, integer, jsonb, jsonb);
drop function if exists public.create_intake_form(uuid, text);

drop table if exists public.intake_form_items;
drop table if exists public.intake_forms;

drop function if exists app.new_intake_public_id();
drop function if exists app.intake_text_unsafe(text, boolean);
drop function if exists app.intake_policy_url_valid(text);
drop function if exists app.embed_origins_valid(text[]);
drop function if exists app.intake_fields_valid(jsonb);
drop function if exists app.intake_default_fields();
drop function if exists app.intake_qty_max_milli();
drop function if exists app.intake_qty_min_milli();
drop function if exists app.intake_max_daily_cap();
drop function if exists app.intake_default_daily_cap();
drop function if exists app.intake_embed_origins_max();
drop function if exists app.intake_max_items_per_form();
drop function if exists app.intake_max_forms_per_tenant();
