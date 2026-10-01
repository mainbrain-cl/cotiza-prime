-- Deshace 20261001120100_foundation.sql (solo entorno de pruebas / local)
drop schema if exists app cascade;

-- Restaura los permisos por defecto de Supabase
alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated;
alter default privileges for role postgres grant execute on functions to public;
grant all on all tables    in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;
grant all on all functions in schema public to anon, authenticated;

drop extension if exists btree_gin;
drop extension if exists pg_trgm;
