-- Deshace 20261127100000_privacy_without_sentry.sql
-- Borra la versión `2026-11-27-preliminar` de la privacidad y deja otra vez vigente la `2026-10-01-preliminar`.
-- Se NIEGA a correr (y no cambia nada) si alguien ya aceptó la versión nueva: esas aceptaciones son un registro legal y no se
-- borran. Después del deshacer, la aplicación también tiene que volver al texto y la versión anteriores (con Sentry), o
-- tests/db/legal-seed.test.ts falla.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'el deshacer de 20261127100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

do $$ begin
  if exists (select 1 from public.legal_acceptances a
               join public.legal_documents d on d.id = a.document_id
              where d.kind = 'privacy' and d.version = '2026-11-27-preliminar') then
    raise exception 'el deshacer de 20261127100000 se niega: hay aceptaciones de la privacidad 2026-11-27-preliminar (registro legal)';
  end if;
end $$;

delete from public.legal_documents where kind = 'privacy' and version = '2026-11-27-preliminar';
update public.legal_documents set is_current = true where kind = 'privacy' and version = '2026-10-01-preliminar';
