-- Deshace 20261124100000_snippet_variable_in_link.sql
-- Devuelve `app.snippet_variables_problem` a su versión de 20261104110000_text_snippets.sql (H-048a), tal cual. Sin esa regla vuelve a ser posible guardar un
-- texto de correo con una variable dentro de la dirección de un enlace.
-- Se NIEGA a correr (y no cambia nada) si la función vigente no es EXACTAMENTE la de esta migración (se compara el md5 de su cuerpo con el del archivo;
-- la prueba lo recalcula): otra migración la redefinió, o ya se deshizo, y reponer la de H-048a pisaría ese cambio.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'el deshacer 20261124100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_proc p where p.oid = to_regprocedure('app.snippet_variables_problem(text, text)')::oid
                    and md5(p.prosrc) = 'ca60ed37a58d31bf631e8f58cb7dd9ae') then
    raise exception 'no se puede deshacer 20261124100000_snippet_variable_in_link: la funcion app.snippet_variables_problem vigente ya no es la de esta migracion: otra migracion la redefinio o ya se deshizo; revise el orden de los deshacer';
  end if;
end $$;

-- La versión anterior (20261104110000_text_snippets.sql), tal cual.
create or replace function app.snippet_variables_problem(p_kind text, p_body text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_name  text;
  v_count integer := 0;
  v_rest  text;
begin
  if p_kind <> 'email_body' then
    if position('{{' in p_body) > 0 or position('}}' in p_body) > 0 then
      return 'variables_not_allowed';
    end if;
    return null;
  end if;
  for v_name in
    select r.m[1] from regexp_matches(p_body, '\{\{([^{}]*)\}\}', 'g') as r(m)
  loop
    v_count := v_count + 1;
    if v_name <> all (app.snippet_variable_names()) then
      return 'unknown_variable';
    end if;
  end loop;
  -- Fuera de las variables completas no puede quedar ninguna llave: así lo que se inserte después en el lugar
  -- de una variable jamás puede formar una variable nueva.
  v_rest := regexp_replace(p_body, '\{\{[^{}]*\}\}', '', 'g');
  if position('{' in v_rest) > 0 or position('}' in v_rest) > 0 then
    return 'unknown_variable';
  end if;
  if v_count > app.snippet_max_variables() then
    return 'too_many_variables';
  end if;
  return null;
end $$;
