-- Deshace 20261126100000_payments_transfer.sql (cobro por transferencia).
-- Borra las funciones del cobro, el disparador de la aceptación, las tablas `quote_payment_accounts`, `payment_milestones` y
-- `bank_accounts`, y devuelve `app.quotes_status_transition_guard` EXACTAMENTE a su texto de 20261006100000.
-- Se NIEGA a correr (y no cambia nada) si hay datos de cobro: una cuenta bancaria, un hito de pago, una cuenta congelada, un correo de
-- cobro anotado o una cotización en un estado de cobro. Esos son datos financieros y registros que no se pierden en silencio: primero
-- se respaldan y se decide a mano qué hacer con ellos.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'el deshacer 20261126100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

do $$ begin
  if exists (select 1 from public.bank_accounts)
     or exists (select 1 from public.payment_milestones)
     or exists (select 1 from public.quote_payment_accounts)
     or exists (select 1 from public.email_messages where kind in ('payment_1', 'payment_2'))
     or exists (select 1 from public.quotes
                 where status in ('pending_payment', 'pending_deposit', 'deposit_paid', 'pending_balance', 'paid')) then
    raise exception 'no se puede deshacer 20261126100000_payments_transfer: hay datos de cobro (cuentas, hitos, correos o cotizaciones en cobro); respaldelos y decida a mano antes de deshacer';
  end if;
end $$;

drop function public.share_payment_notice_record(uuid, uuid, uuid, text, text, text, text, text);
drop function public.share_payment_notice(uuid, uuid);
drop function public.share_link_payment(text);
drop function public.record_second_payment_email(uuid, uuid, text, text, text, text, text);
drop function public.request_second_payment(uuid);
drop function public.reverse_payment(uuid, text);
drop function public.record_payment(uuid, date, bigint, text);
drop function public.set_quote_payment_terms(uuid, text);
drop function public.tenant_has_bank_account();
drop function public.set_bank_account(uuid, text, text, integer);

drop trigger quote_responses_start_payments on public.quote_responses;
drop function app.quote_responses_start_payments();
drop function app.record_payment_email(uuid, uuid, text, uuid, text, text, text, text, text, text, uuid);
drop function app.payment_email_context(uuid, uuid);
drop function app.sync_quote_payment_status(uuid, uuid);

drop table public.quote_payment_accounts;
drop table public.payment_milestones;
drop table public.bank_accounts;

-- La lista de cambios de estado, tal como la dejó 20261006100000.
create or replace function app.quotes_status_transition_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status and not (
       (old.status = 'draft'  and new.status = 'sent')
    or (old.status = 'sent'   and new.status = 'viewed')
    or (old.status in ('sent', 'viewed') and new.status in ('accepted', 'rejected_by_customer', 'expired'))) then
    raise exception 'invalid quote status change % -> %', old.status, new.status using errcode = '42501';
  end if;
  return new;
end $$;
