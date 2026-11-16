-- Deshace 20261116100000_mfa_recovery_codes.sql
-- Borra las siete funciones de los códigos de respaldo (`mfa_recovery_codes_replace`, `mfa_recovery_code_claim`,
-- `mfa_recovery_code_complete`, `mfa_recovery_code_release`, `mfa_recovery_codes_acknowledge`, `mfa_recovery_codes_status`,
-- `mfa_recovery_codes_revoke`) y la tabla `public.mfa_recovery_codes`. No toca factores, sesiones, cuentas ni otras tablas.
-- Se NIEGA a correr (y no cambia nada) si: (a) alguna de las siete funciones no es EXACTAMENTE la de esta migración (se compara el
-- md5 del cuerpo con el del archivo; la prueba lo recalcula): otra migración la redefinió o ya se deshizo; (b) ALGUNA OTRA función de
-- `public` o `app` nombra estas funciones o la tabla (borrarlas la rompería); (c) hay códigos TOMADOS ahora mismo (un uso en
-- curso: borrarlos haría perder el código a quien lo está usando); o (d) hay juegos VIGENTES (códigos sin usar cuyo factor sigue
-- verificado): borrarlos dejaría sin respaldo a personas que no lo saben.
-- ADVERTENCIA. Con la aplicación de H-004b funcionando, entrar con un código de respaldo y crear o generar códigos dejan de
-- servir; aplicarlo solo con la aplicación en mantenimiento o ya vuelta atrás a la etapa anterior.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'el deshacer 20261116100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

do $$
declare
  c_known constant regprocedure[] := array[
    to_regprocedure('public.mfa_recovery_codes_replace(uuid, uuid, text[])'), to_regprocedure('public.mfa_recovery_code_claim(uuid, text)'),
    to_regprocedure('public.mfa_recovery_code_complete(uuid)'), to_regprocedure('public.mfa_recovery_code_release(uuid)'),
    to_regprocedure('public.mfa_recovery_codes_acknowledge(uuid, uuid)'), to_regprocedure('public.mfa_recovery_codes_status(uuid)'),
    to_regprocedure('public.mfa_recovery_codes_revoke(uuid)')];
begin
  -- (a) las siete funciones son las de esta migración
  if not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.mfa_recovery_codes_replace(uuid, uuid, text[])')::oid
                    and md5(p.prosrc) = '7aa1a52e10d260b25a9c31c8310518cc')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.mfa_recovery_code_claim(uuid, text)')::oid
                    and md5(p.prosrc) = '735736fd6598c27848d92174fe94a455')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.mfa_recovery_code_complete(uuid)')::oid
                    and md5(p.prosrc) = '669834e0b1fedee7a8c6d83f54add449')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.mfa_recovery_code_release(uuid)')::oid
                    and md5(p.prosrc) = '91ed462638526042ab1b27ac97cae897')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.mfa_recovery_codes_acknowledge(uuid, uuid)')::oid
                    and md5(p.prosrc) = '2955d13dca9ce389852bc7dd6d72e326')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.mfa_recovery_codes_status(uuid)')::oid
                    and md5(p.prosrc) = '8eba6e12048213d9fb660dc9cf1e9474')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.mfa_recovery_codes_revoke(uuid)')::oid
                    and md5(p.prosrc) = 'da5d8ecadf86fd0ddaa40936cd563f44') then
    raise exception 'no se puede deshacer 20261116100000_mfa_recovery_codes: alguna de las funciones (public.mfa_recovery_codes_replace, public.mfa_recovery_code_claim, public.mfa_recovery_code_complete, public.mfa_recovery_code_release, public.mfa_recovery_codes_acknowledge, public.mfa_recovery_codes_status, public.mfa_recovery_codes_revoke) ya no es la de esta migracion: otra migracion la redefinio o ya se deshizo; revise el orden de los deshacer';
  end if;
  -- (b) nadie mas nombra las funciones ni la tabla
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where p.prosrc like '%mfa_recovery_code%'
                and p.oid <> all (c_known::oid[])
                and n.nspname in ('public', 'app')) then
    raise exception 'no se puede deshacer 20261116100000_mfa_recovery_codes: otra funcion nombra las funciones o la tabla de los codigos de respaldo (mfa_recovery_code*); desharia o rompe lo que la usa; revise el orden de los deshacer';
  end if;
  -- (c) un uso en curso
  if exists (select 1 from public.mfa_recovery_codes c where c.used_at is null and c.claimed_until > now()) then
    raise exception 'no se puede deshacer 20261116100000_mfa_recovery_codes: hay codigos de respaldo tomados ahora mismo (un uso en curso); espere 2 minutos y repita';
  end if;
  -- (d) juegos vigentes: quedarian sin respaldo personas que no lo saben
  if exists (select 1 from public.mfa_recovery_codes c
              where c.used_at is null
                and exists (select 1 from auth.mfa_factors f
                             where f.id = c.factor_id and f.user_id = c.user_id
                               and f.factor_type = 'totp' and f.status = 'verified')) then
    raise exception 'no se puede deshacer 20261116100000_mfa_recovery_codes: hay juegos de codigos de respaldo vigentes; borrarlos dejaria sin respaldo a personas que no lo saben';
  end if;
end $$;

drop function public.mfa_recovery_codes_revoke(uuid);
drop function public.mfa_recovery_codes_status(uuid);
drop function public.mfa_recovery_codes_acknowledge(uuid, uuid);
drop function public.mfa_recovery_code_release(uuid);
drop function public.mfa_recovery_code_complete(uuid);
drop function public.mfa_recovery_code_claim(uuid, text);
drop function public.mfa_recovery_codes_replace(uuid, uuid, text[]);
drop table public.mfa_recovery_codes;
