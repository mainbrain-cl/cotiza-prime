-- Deshace 20261104110000_text_snippets.sql
-- Los textos guardados son configuración de la organización (no datos personales de terceros): no hay protección
-- que pedir. Se pierden los textos; los registros de auditoría `text_snippet.*` se conservan (la auditoría es de
-- solo agregar).

-- Funciones que escriben
drop function if exists public.delete_text_snippet(uuid);
drop function if exists public.update_text_snippet(uuid, integer, text, text, boolean);
drop function if exists public.create_text_snippet(uuid, text, text, text, boolean);

-- La tabla (con sus disparadores, índices y política)
drop table if exists public.text_snippets;

-- Ayudas y constantes (la tabla las usaba en sus revisiones: por eso van después)
drop function if exists app.snippet_variables_problem(text, text);
drop function if exists app.snippet_normalize_body(text);
drop function if exists app.snippet_normalize_name(text);
drop function if exists app.snippet_variable_names();
drop function if exists app.snippet_kinds();
drop function if exists app.snippet_variable_value_max_length();
drop function if exists app.snippet_max_variables();
drop function if exists app.snippet_body_max_length();
drop function if exists app.snippet_name_max_length();
drop function if exists app.snippets_max_per_tenant();
