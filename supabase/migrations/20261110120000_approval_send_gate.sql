-- Sprint 5 · H-040b · Cuándo se exige aprobación: el control en el envío
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261110120000_approval_send_gate.down.sql
-- Especificación: docs/arquitectura/sprint-5-h-040-aprobaciones.md §2 (desde cuándo vale) y §7 (qué pasa hoy al enviar).
-- Va junto con 20261110110000_approval_rules (H-040a): las dos entran a `main` a la vez, para que nunca exista una pantalla
-- que guarda una regla que nadie aplica.
--
-- Qué agrega:
--   · `quote_packages.approval_rule_id`: la versión EXACTA de la regla que regía cuando se congeló el paquete. Obligatoria
--     e inmutable (el guardián de `quote_packages` ya impide cambiar toda columna que no sea de datos). Los paquetes
--     que ya existen toman la versión 1 de su organización; el guardián de solo agregar se apaga solo para esto, dentro de
--     esta transacción (como en la migración 26).
--   · El disparador `quote_packages_approval_gate` (ANTES de insertar un paquete): toma el candado COMPARTIDO de la regla de
--     la organización, llama a `app.quote_approval_check` (los totales salen de `quotes`, nunca del navegador) y:
--       · si la regla pide aprobación → `approval_required` (CP423) y el envío entero se deshace: sin paquete, sin enlace,
--         sin correo y sin candado de envío a medias (todo ocurre dentro de la transacción de `prepare_quote_send`);
--       · si no hay regla → también se rechaza (`approval_rule_missing`, CP423), no se deja pasar;
--       · una cotización que no existe en esa organización no se evalúa (la relación compuesta rechaza la fila, 23503);
--       · si no, completa `approval_rule_id` (siempre lo escribe el disparador: lo que traiga la fila se ignora).
--     Es un disparador y no un cambio a `prepare_quote_send` para no chocar con H-041, que reescribe esa función, y porque
--     así cubre cualquier camino que algún día inserte un paquete.
--   · Un reenvío (`prepare_quote_resend`) NO se evalúa: no crea un paquete nuevo, reenvía el que ya salió. Tampoco
--     `confirm_email_dispatch` (el correo ya salió) ni lo ya enviado: la regla vale para lo que se envíe DESDE AHORA.
--
-- Decisión D1 (José, 2026-11-04): la regla se aplica al enviar desde ya, aunque «Solicitar aprobación» llegue en el sprint 6.
-- Mientras tanto, lo que cumple la regla no sale; como la regla parte en «Nunca», nada cambia si nadie la toca.
--
-- PARA EL SPRINT 6 (la solicitud de aprobación): este disparador DEBE cambiar para dejar pasar el paquete de una solicitud
-- aprobada (hoy rechaza todo lo que la regla pide). Al hacerlo, `approval_rule_id` seguirá siendo la versión que regía.
-- La lógica de «a quién se le aplica la regla» vive SOLO en `app.quote_approval_check`; la excepción por persona se lee allí.
--
-- Guardia 15 (tests/db/schema-guards.test.ts): primera sentencia `set local lock_timeout = '3s'` y, justo después, la
-- verificación de que el valor quedó puesto (si la herramienta que aplica el archivo no lo respetara, se detiene).
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'la migracion 20261110120000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

-- 1. La versión de la regla que regía, en cada paquete -------------------------------------------------
alter table public.quote_packages add column approval_rule_id uuid;
-- Los paquetes que ya existen: la versión 1 de su organización («Nunca»), la única que pudo regirlos.
alter table public.quote_packages disable trigger quote_packages_guard;
update public.quote_packages p set approval_rule_id = r.id
  from public.approval_rules r where r.tenant_id = p.tenant_id and r.version = 1;
alter table public.quote_packages enable trigger quote_packages_guard;
alter table public.quote_packages alter column approval_rule_id set not null;
alter table public.quote_packages
  add constraint quote_packages_approval_rule_fkey
  foreign key (tenant_id, approval_rule_id) references public.approval_rules (tenant_id, id);
create index quote_packages_approval_rule on public.quote_packages (tenant_id, approval_rule_id);

-- 2. El control en el envío ----------------------------------------------------------------------------
create function app.quote_packages_approval_gate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_check jsonb;
begin
  -- Candado COMPARTIDO de la regla de la organización (el mismo que `set_approval_rule` toma exclusivo): los envíos no se
  -- esperan entre sí, pero un cambio de regla espera a que termine el envío en curso, y un envío que empieza después ve la
  -- regla nueva. Así la versión que queda anotada es siempre la que de verdad rigió.
  perform pg_advisory_xact_lock_shared(hashtextextended('approval_rule:' || new.tenant_id::text, 0));
  -- Una cotización que no es de esta organización (o no existe) no se evalúa: la relación compuesta rechaza la fila (23503),
  -- como ya hace `quote_packages_set_revision`. Se deja la versión vigente solo para que el campo obligatorio no estorbe.
  if not exists (select 1 from public.quotes q where q.tenant_id = new.tenant_id and q.id = new.quote_id) then
    select r.id into new.approval_rule_id from public.approval_rules r
     where r.tenant_id = new.tenant_id order by r.version desc limit 1;
    return new;
  end if;
  v_check := app.quote_approval_check(new.tenant_id, new.quote_id);
  if (v_check ->> 'required')::boolean then
    -- `detail` lleva los motivos (`amount`, `discount` o `always`); la aplicación arma su frase con la función de TypeScript.
    raise exception 'approval_required' using errcode = 'CP423',
      detail = array_to_string(array(select jsonb_array_elements_text(v_check -> 'reasons')), ',');
  end if;
  new.approval_rule_id := (v_check ->> 'rule_id')::uuid;
  return new;
end $$;
revoke all on function app.quote_packages_approval_gate() from public, anon, authenticated;
create trigger quote_packages_approval_gate before insert on public.quote_packages
  for each row execute function app.quote_packages_approval_gate();
