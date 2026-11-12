-- Deshace 20261113100000_mfa_enrollment_alerts.sql
-- Quita el disparador de `auth.mfa_factors`, las cinco funciones nuevas, las dos tablas (`mfa_annul_links`, que depende de la
-- otra, y `mfa_enrollment_alerts`) y devuelve la lista de alcances del límite de intentos a la de 20261112100000_mfa_session_gate.sql
-- (los contadores `mfa_annul_ip` y `mfa_annul_token` se borran: son efímeros y solo guardan huellas). No toca factores,
-- sesiones ni cuentas.
-- Se NIEGA a correr (y no cambia nada) si: (a) alguna de las cinco funciones no es EXACTAMENTE la de esta migración (se compara el
-- md5 del cuerpo con el del archivo; la prueba lo recalcula): otra migración la redefinió o ya se deshizo; (b) ALGUNA OTRA función
-- nombra las funciones o las tablas nuevas (borrarlas la rompería; precedente: 20261112100000); o (c) hay enlaces de anulación
-- ABIERTOS (sin usar y sin vencer): borrarlos dejaría a quien recibió el correo sin su salida, sin que nadie se lo diga.
--
-- ADVERTENCIA. Este deshacer REABRE el camino de activar el segundo paso hablando directo con Supabase (sin que salga el aviso
-- ni exista el enlace para anularlo): quien conozca la contraseña de una cuenta sin el segundo paso puede activar su propio
-- teléfono y dejar fuera a la dueña. Mientras la aplicación de H-118 esté funcionando, no se deshace con tráfico abierto.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'el deshacer 20261113100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

do $$
declare
  c_known constant regprocedure[] := array[
    to_regprocedure('public.mfa_alert_expect(uuid, uuid)'), to_regprocedure('public.mfa_alerts_reserve(uuid, text)'),
    to_regprocedure('public.mfa_alert_settle(uuid, text, text, text)'), to_regprocedure('public.mfa_alert_revert(uuid, uuid, text)'),
    to_regprocedure('app.mfa_factor_verify_gate()')];
begin
  -- (a) las cinco funciones son las de esta migración
  if not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.mfa_alert_expect(uuid, uuid)')::oid
                    and md5(p.prosrc) = '4f00ff3e81da5785a1f924feaa64a62d')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.mfa_alerts_reserve(uuid, text)')::oid
                    and md5(p.prosrc) = '3aa245c93cedf988b0943b81ad89c172')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.mfa_alert_settle(uuid, text, text, text)')::oid
                    and md5(p.prosrc) = 'bc311bf90d6671dac6b2911577de8625')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.mfa_alert_revert(uuid, uuid, text)')::oid
                    and md5(p.prosrc) = '07b9da3c3893b022b20cb0ecb74362de')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('app.mfa_factor_verify_gate()')::oid
                    and md5(p.prosrc) = '51107711d03dd152ab30080be1b29ff1') then
    raise exception 'no se puede deshacer 20261113100000_mfa_enrollment_alerts: alguna de las funciones (public.mfa_alert_expect, public.mfa_alerts_reserve, public.mfa_alert_settle, public.mfa_alert_revert, app.mfa_factor_verify_gate) ya no es la de esta migracion: otra migracion la redefinio o ya se deshizo; revise el orden de los deshacer';
  end if;
  -- (b) nadie mas nombra las funciones ni las tablas nuevas: borrarlas romperia esa funcion
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (p.prosrc like '%mfa_alert_expect%' or p.prosrc like '%mfa_alerts_reserve%'
                     or p.prosrc like '%mfa_alert_settle%' or p.prosrc like '%mfa_alert_revert%'
                     or p.prosrc like '%mfa_factor_verify_gate%' or p.prosrc like '%mfa_enrollment_alerts%'
                     or p.prosrc like '%mfa_annul_links%')
                and p.oid <> all (c_known::oid[])
                and n.nspname in ('public', 'app')) then
    raise exception 'no se puede deshacer 20261113100000_mfa_enrollment_alerts: otra funcion nombra las funciones o las tablas de H-118 (mfa_alert_*, mfa_annul_links, mfa_enrollment_alerts); desharia o rompe lo que la usa; revise el orden de los deshacer';
  end if;
  -- (c) enlaces de anulacion abiertos: quien recibio el correo perderia su salida
  if exists (select 1 from public.mfa_annul_links l where l.used_at is null and l.expires_at > now()) then
    raise exception 'no se puede deshacer 20261113100000_mfa_enrollment_alerts: hay enlaces de anulacion abiertos (sin usar y sin vencer); borrarlos dejaria sin salida a quien recibio el aviso';
  end if;
end $$;

drop trigger mfa_factor_verify_gate on auth.mfa_factors;
drop function app.mfa_factor_verify_gate();
drop function public.mfa_alert_revert(uuid, uuid, text);
drop function public.mfa_alert_settle(uuid, text, text, text);
drop function public.mfa_alerts_reserve(uuid, text);
drop function public.mfa_alert_expect(uuid, uuid);
drop table public.mfa_annul_links;
drop table public.mfa_enrollment_alerts;

delete from public.auth_rate_limits where scope in ('mfa_annul_ip', 'mfa_annul_token');
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user', 'pdf_user', 'pdf_tenant',
                   'share_ip', 'share_token', 'share_respond_ip', 'quote_send_user',
                   'intake_read_ip', 'intake_submit_ip', 'intake_submit_ip_day', 'intake_submit_form',
                   'invite_accept_user', 'invite_link_ip',
                   'mfa_verify_user', 'mfa_verify_user_day', 'mfa_code_used'));
