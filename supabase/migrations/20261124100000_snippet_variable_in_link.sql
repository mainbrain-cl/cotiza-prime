-- Menores de la revisión de Aarón al PR #67 (H-048b), punto 1: no poner una variable dentro de la dirección de un enlace
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261124100000_snippet_variable_in_link.down.sql
--
-- Qué cambia: `app.snippet_variables_problem` (H-048a, gemela de `checkSnippetVariables`) rechaza con el motivo nuevo `variable_in_link` un texto del
-- correo que ponga una variable dentro de la dirección de un enlace: `[texto]({{cliente}})` o `[texto](https://{{organizacion}}/x)`. El nombre del cliente
-- (que escribe quien llena el formulario público) quedaba como dirección real del enlace en el correo, p. ej. un cliente llamado
-- `https://evil.example/x`. H-048b es la primera historia que usa los textos guardados en un correo, por eso aparece ahora.
-- Es la ÚNICA función que cambia, con la misma firma y sin tocar permisos (`create or replace` los conserva); `create_text_snippet` y
-- `update_text_snippet` ya la llaman. Los textos ya guardados no se migran: la aplicación no ofrece en `/enviar` uno que tenga esta forma.
-- Huella md5 del cuerpo anterior (H-048a, `20261104110000_text_snippets.sql`): d9ab09cc9c0a71c9016485e7d6d6585a. Huella del nuevo: ca60ed37a58d31bf631e8f58cb7dd9ae.
--
-- Guardia 15 (tests/db/schema-guards.test.ts): primera sentencia `set local lock_timeout = '3s'` y, justo después, la verificación de que el
-- valor quedó puesto.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'la migracion 20261124100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

-- La versión anterior es la de 20261104110000_text_snippets.sql. Cambia solo lo que dice el encabezado.
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
  -- Una variable dentro de la dirección de un enlace (`[texto]({{cliente}})`): el nombre del cliente o de la organización lo escribe
  -- quien llena el formulario público y no puede decidir adónde lleva un enlace del correo. Gemela de `hasVariableInLinkTarget`.
  if p_body ~ '\]\([^)\n]*\{\{' then
    return 'variable_in_link';
  end if;
  return null;
end $$;
