-- Deshace 20261113110000_mfa_annul.sql
-- Borra las cuatro funciones de H-118b (`mfa_annul_claim`, `mfa_annul_complete`, `mfa_annul_release`, `mfa_revoke_sessions`).
-- No toca tablas, avisos, enlaces, factores ni sesiones: las tablas son de 20261113100000 y su deshacer va DESPUÉS de éste.
-- Se NIEGA a correr (y no cambia nada) si: (a) alguna de las cuatro funciones no es EXACTAMENTE la de esta migración (se compara
-- el md5 del cuerpo con el del archivo; la prueba lo recalcula): otra migración la redefinió o ya se deshizo; (b) ALGUNA OTRA
-- función nombra estas funciones (borrarlas la rompería); o (c) hay enlaces de anulación TOMADOS ahora mismo (una anulación en
-- curso): borrar la función de soltarlos dejaría a esa persona sin poder abrir su enlace por 2 minutos.
-- ADVERTENCIA. Con la aplicación de H-118b funcionando, la página para anular deja de servir; aplicarlo solo con la aplicación
-- en mantenimiento o ya vuelta a la etapa A.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'el deshacer 20261113110000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

do $$
declare
  c_known constant regprocedure[] := array[
    to_regprocedure('public.mfa_annul_claim(text)'), to_regprocedure('public.mfa_annul_complete(uuid)'),
    to_regprocedure('public.mfa_annul_release(uuid)'), to_regprocedure('public.mfa_revoke_sessions(uuid)')];
begin
  -- (a) las cuatro funciones son las de esta migración
  if not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.mfa_annul_claim(text)')::oid
                    and md5(p.prosrc) = 'de5c184e755792ee11cb1226b835d926')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.mfa_annul_complete(uuid)')::oid
                    and md5(p.prosrc) = 'f419bf38474772ee5c9dd3578a761ed7')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.mfa_annul_release(uuid)')::oid
                    and md5(p.prosrc) = '83cb8e7ddce301a564ac17292bc790f2')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.mfa_revoke_sessions(uuid)')::oid
                    and md5(p.prosrc) = '8213983c1bafef9d6c78bf8a2a5bbba5') then
    raise exception 'no se puede deshacer 20261113110000_mfa_annul: alguna de las funciones (public.mfa_annul_claim, public.mfa_annul_complete, public.mfa_annul_release, public.mfa_revoke_sessions) ya no es la de esta migracion: otra migracion la redefinio o ya se deshizo; revise el orden de los deshacer';
  end if;
  -- (b) nadie mas nombra estas funciones
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (p.prosrc like '%mfa_annul_claim%' or p.prosrc like '%mfa_annul_complete%'
                     or p.prosrc like '%mfa_annul_release%' or p.prosrc like '%mfa_revoke_sessions%')
                and p.oid <> all (c_known::oid[])
                and n.nspname in ('public', 'app')) then
    raise exception 'no se puede deshacer 20261113110000_mfa_annul: otra funcion nombra las funciones de H-118b (mfa_annul_*, mfa_revoke_sessions); desharia o rompe lo que la usa; revise el orden de los deshacer';
  end if;
  -- (c) una anulacion en curso
  if exists (select 1 from public.mfa_annul_links l where l.used_at is null and l.claimed_until > now()) then
    raise exception 'no se puede deshacer 20261113110000_mfa_annul: hay enlaces de anulacion tomados ahora mismo (una anulacion en curso); espere 2 minutos y repita';
  end if;
end $$;

drop function public.mfa_revoke_sessions(uuid);
drop function public.mfa_annul_release(uuid);
drop function public.mfa_annul_complete(uuid);
drop function public.mfa_annul_claim(text);
