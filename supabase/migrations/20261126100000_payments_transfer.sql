-- Fase 4 · Cobro por transferencia (H-050, H-052, H-053, H-054, H-055, H-056 y H-057)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261126100000_payments_transfer.down.sql
-- Diseño corto y decisiones aplicadas: docs/arquitectura/cobro-transferencia.md (decisión 022: producto funcional primero).
--
-- Qué agrega:
--   · `public.bank_accounts`: UNA cuenta por organización (supuesto de la decisión pendiente 6). Todo lo bancario va cifrado por la
--     aplicación en `details_enc` (sello `bank_accounts.details|organización|id`); en claro solo quedan los últimos 4 caracteres del
--     número, para la auditoría. La leen y la cambian solo el Dueño y el Administrador (`bank_account.manage`), en la RLS y en la función.
--   · `public.payment_milestones`: cada pago esperado es una fila (decisión 011). Se crean UNA vez, al aceptar el cliente, con enteros:
--     100 % = un hito; 50/50 = anticipo `total / 2` (división entera) y saldo `total - anticipo` (el peso sobrante va al saldo).
--   · `public.quote_payment_accounts`: los datos bancarios congelados en la cotización al aceptar (PROYECTO.md §13.2): copia del texto
--     cifrado y de la revisión de la cuenta, de solo agregar. Los correos de cobro usan esta copia, nunca la cuenta de hoy.
--   · Funciones con sesión: `set_bank_account`, `tenant_has_bank_account`, `set_quote_payment_terms`, `record_payment`,
--     `reverse_payment`, `request_second_payment` y `record_second_payment_email`. Todas toman la organización de
--     `app.current_tenant_id()` y deciden con `app.can(...)`.
--   · Funciones solo del servidor (el portero del enlace del cliente): `share_link_payment`, `share_payment_notice` y
--     `share_payment_notice_record`.
--   · El disparador diferido `quote_responses_start_payments`: al aceptar, si la cotización tiene condición de pago, crea los hitos,
--     congela la cuenta y pasa la cotización a «Pendiente de pago» o «Pendiente de anticipo». Va al confirmar la transacción para
--     que la línea de tiempo quede en orden (primero «aceptada», después el cobro) sin reescribir `share_link_respond`.
--   · La lista cerrada de cambios de estado de la cotización suma los del cobro (§7) y los de deshacer un pago (H-055).
--
-- Guardia 15 (tests/db/schema-guards.test.ts): primera sentencia y su verificación.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'la migracion 20261126100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

-- 1. La cuenta bancaria de la organización ----------------------------------------------------------
create table public.bank_accounts (
  id            uuid primary key,   -- lo genera la aplicación (va en el sello de lo cifrado)
  tenant_id     uuid not null references public.tenants (tenant_id) on update cascade,
  details_enc   text not null check (char_length(details_enc) between 1 and 4000),
  account_last4 text not null check (account_last4 ~ '^[0-9A-Za-z]{1,4}$'),
  revision      integer not null default 1 check (revision >= 1),
  created_by    uuid references auth.users (id),
  updated_by    uuid references auth.users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id),          -- una sola cuenta por organización
  unique (tenant_id, id)
);
create trigger bank_accounts_meta before insert or update on public.bank_accounts
  for each row execute function app.set_row_meta_by();
create trigger bank_accounts_forbid_tenant_change before update on public.bank_accounts
  for each row execute function app.forbid_tenant_change();
create trigger bank_accounts_no_delete before delete on public.bank_accounts
  for each row execute function app.forbid_mutation();
create trigger bank_accounts_no_truncate before truncate on public.bank_accounts
  for each statement execute function app.forbid_mutation();

-- 2. Los hitos de pago ------------------------------------------------------------------------------
create table public.payment_milestones (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (tenant_id) on update cascade,
  quote_id        uuid not null,
  seq             smallint not null check (seq in (1, 2)),
  kind            text not null check (kind in ('full', 'deposit', 'balance')),
  amount_clp      bigint not null check (amount_clp between 0 and 1000000000000),
  status          text not null default 'pending' check (status in ('pending', 'requested', 'paid')),
  requested_at    timestamptz,
  requested_by    uuid references auth.users (id),
  paid_on         date,
  paid_amount_clp bigint check (paid_amount_clp is null or paid_amount_clp between 0 and 1000000000000),
  paid_note       text check (paid_note is null or char_length(paid_note) between 1 and 500),
  paid_by         uuid references auth.users (id),
  paid_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint payment_milestones_kind_seq check (
    (seq = 1 and kind in ('full', 'deposit')) or (seq = 2 and kind = 'balance')),
  constraint payment_milestones_requested_only_balance check (status <> 'requested' or kind = 'balance'),
  constraint payment_milestones_requested_pair check ((requested_at is null) = (requested_by is null)),
  constraint payment_milestones_paid_shape check (
    ((status = 'paid') = (paid_at is not null))
    and ((paid_at is null) = (paid_on is null))
    and ((paid_at is null) = (paid_amount_clp is null))
    and ((paid_at is null) = (paid_by is null))),
  unique (tenant_id, quote_id, seq),
  unique (tenant_id, id),
  foreign key (tenant_id, quote_id) references public.quotes (tenant_id, id)
);
create index payment_milestones_open on public.payment_milestones (tenant_id, status) where status <> 'paid';
create trigger payment_milestones_forbid_tenant_change before update on public.payment_milestones
  for each row execute function app.forbid_tenant_change();
create trigger payment_milestones_no_delete before delete on public.payment_milestones
  for each row execute function app.forbid_mutation();
create trigger payment_milestones_no_truncate before truncate on public.payment_milestones
  for each statement execute function app.forbid_mutation();

-- 3. La cuenta congelada en cada cotización aceptada (solo agregar) --------------------------------
create table public.quote_payment_accounts (
  tenant_id       uuid not null references public.tenants (tenant_id) on update cascade,
  quote_id        uuid not null,
  bank_account_id uuid not null,
  bank_revision   integer not null check (bank_revision >= 1),
  details_enc     text not null check (char_length(details_enc) between 1 and 4000),
  account_last4   text not null check (account_last4 ~ '^[0-9A-Za-z]{1,4}$'),
  captured_at     timestamptz not null default now(),
  primary key (tenant_id, quote_id),
  foreign key (tenant_id, quote_id) references public.quotes (tenant_id, id),
  foreign key (tenant_id, bank_account_id) references public.bank_accounts (tenant_id, id)
);
create trigger quote_payment_accounts_no_update before update on public.quote_payment_accounts
  for each row execute function app.forbid_mutation();
create trigger quote_payment_accounts_no_delete before delete on public.quote_payment_accounts
  for each row execute function app.forbid_mutation();
create trigger quote_payment_accounts_no_truncate before truncate on public.quote_payment_accounts
  for each statement execute function app.forbid_mutation();
create trigger quote_payment_accounts_forbid_tenant_change before update on public.quote_payment_accounts
  for each row execute function app.forbid_tenant_change();

-- 4. RLS: nadie escribe directo; leer, según la matriz -------------------------------------------------
alter table public.bank_accounts          enable row level security;
alter table public.payment_milestones     enable row level security;
alter table public.quote_payment_accounts enable row level security;

create policy bank_accounts_select on public.bank_accounts for select to authenticated
  using (tenant_id = (select app.current_tenant_id()) and (select app.can('bank_account.manage')));
create policy payment_milestones_select on public.payment_milestones for select to authenticated
  using (tenant_id = (select app.current_tenant_id()) and (select app.can('org.view')));
create policy quote_payment_accounts_select on public.quote_payment_accounts for select to authenticated
  using (tenant_id = (select app.current_tenant_id()) and (select app.can('bank_account.manage')));

grant select on public.bank_accounts, public.payment_milestones, public.quote_payment_accounts to authenticated;

-- 5. Los cambios de estado del cobro (§7) y de deshacer un pago (H-055) --------------------------------
create or replace function app.quotes_status_transition_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status and not (
       (old.status = 'draft'  and new.status = 'sent')
    or (old.status = 'sent'   and new.status = 'viewed')
    or (old.status in ('sent', 'viewed') and new.status in ('accepted', 'rejected_by_customer', 'expired'))
    -- Cobro: al aceptar, al registrar pagos y al pedir el saldo.
    or (old.status = 'accepted'        and new.status in ('pending_payment', 'pending_deposit'))
    or (old.status = 'pending_payment' and new.status = 'paid')
    or (old.status = 'pending_deposit' and new.status = 'deposit_paid')
    or (old.status = 'deposit_paid'    and new.status in ('pending_balance', 'paid'))
    or (old.status = 'pending_balance' and new.status = 'paid')
    -- Deshacer un pago marcado por error: vuelve al estado anterior.
    or (old.status = 'paid'            and new.status in ('pending_payment', 'deposit_paid', 'pending_balance'))
    or (old.status = 'deposit_paid'    and new.status = 'pending_deposit')
    -- Deshacer el anticipo con el saldo ya pedido (no pagado): el pedido del saldo se anula y vuelve a «Pendiente de anticipo».
    or (old.status = 'pending_balance' and new.status = 'pending_deposit')) then
    raise exception 'invalid quote status change % -> %', old.status, new.status using errcode = '42501';
  end if;
  return new;
end $$;

-- 6. Ayudas internas ---------------------------------------------------------------------------------
-- El estado de la cotización sale de sus hitos (la única fuente). No hace nada si no hay hitos.
create function app.sync_quote_payment_status(p_tenant uuid, p_quote_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  m1    public.payment_milestones;
  m2    public.payment_milestones;
  v_new text;
begin
  select * into m1 from public.payment_milestones where tenant_id = p_tenant and quote_id = p_quote_id and seq = 1;
  if not found then
    return null;
  end if;
  select * into m2 from public.payment_milestones where tenant_id = p_tenant and quote_id = p_quote_id and seq = 2;
  v_new := case
    when m2.id is null then case when m1.status = 'paid' then 'paid' else 'pending_payment' end
    when m1.status <> 'paid' then 'pending_deposit'
    when m2.status = 'paid' then 'paid'
    when m2.status = 'requested' then 'pending_balance'
    else 'deposit_paid'
  end;
  update public.quotes set status = v_new
   where tenant_id = p_tenant and id = p_quote_id and status is distinct from v_new;
  return v_new;
end $$;
revoke all on function app.sync_quote_payment_status(uuid, uuid) from public, anon, authenticated;

-- Todo lo que hace falta para escribirle al cliente sobre un pago: el correo al que aceptó (cifrado, con el id de su fila para el
-- sello), el nombre del cliente (cifrado en el paquete), la marca y el nombre congelados, los hitos y la cuenta congelada.
create function app.payment_email_context(p_tenant uuid, p_quote_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  q     public.quotes;
  r     public.quote_responses;
  l     public.share_links;
  e     public.email_messages;
  p     public.quote_packages;
  pa    public.quote_payment_accounts;
  v_rev integer;
  v_ms  jsonb;
begin
  select * into q from public.quotes where tenant_id = p_tenant and id = p_quote_id;
  select * into r from public.quote_responses
   where tenant_id = p_tenant and quote_id = p_quote_id and decision = 'accepted';
  if q.id is null or r.id is null then
    return null;
  end if;
  select * into l from public.share_links where tenant_id = p_tenant and id = r.share_link_id;
  select * into e from public.email_messages where tenant_id = p_tenant and id = l.email_message_id;
  select * into p from public.quote_packages where tenant_id = p_tenant and id = r.package_id;
  select * into pa from public.quote_payment_accounts where tenant_id = p_tenant and quote_id = p_quote_id;
  select b.revision into v_rev from public.bank_accounts b where b.tenant_id = p_tenant;
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'seq', m.seq, 'kind', m.kind, 'amount_clp', m.amount_clp,
                                               'status', m.status) order by m.seq), '[]'::jsonb)
    into v_ms
    from public.payment_milestones m where m.tenant_id = p_tenant and m.quote_id = p_quote_id;
  return jsonb_build_object(
    'tenant_id', p_tenant,
    'quote_id', q.id,
    'number_display', q.number_display,
    'version', q.version,
    'payment_terms', q.payment_terms,
    'total_clp', q.total_clp,
    'milestones', v_ms,
    'bank', case when pa.quote_id is null then null
                 else jsonb_build_object('bank_account_id', pa.bank_account_id, 'details_enc', pa.details_enc,
                                         'changed', v_rev is distinct from pa.bank_revision) end,
    'to_email_enc', e.to_email_enc,
    'email_message_id', e.id,
    'package_id', p.id,
    'customer_snapshot_enc', p.customer_snapshot_enc,
    'organization_name', p.document_snapshot #>> '{organization,name}',
    'brand', p.document_snapshot -> 'brand');
end $$;
revoke all on function app.payment_email_context(uuid, uuid) from public, anon, authenticated;

-- Deja anotado un correo de cobro ya intentado (salió o falló) y su evento en la línea de tiempo. Repetir con el mismo id no hace nada.
create function app.record_payment_email(
  p_tenant uuid, p_quote_id uuid, p_kind text, p_email_id uuid, p_to_email_enc text, p_to_email_hash text,
  p_provider text, p_provider_message_id text, p_error_code text, p_actor_type text, p_actor uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  q      public.quotes;
  v_sent boolean := p_error_code is null;
begin
  if p_kind is null or p_kind not in ('payment_1', 'payment_2') or p_email_id is null
     or p_to_email_enc is null or char_length(p_to_email_enc) not between 1 and 2000
     or p_to_email_hash is null or p_to_email_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  if v_sent then
    if p_provider is null or p_provider !~ '^[a-z0-9_]{2,30}$' or p_provider = 'pending'
       or p_provider_message_id is null or char_length(p_provider_message_id) not between 1 and 200 then
      raise exception 'invalid_arguments' using errcode = 'CP422';
    end if;
  elsif p_error_code !~ '^[A-Za-z0-9_.:-]{1,60}$' then
    raise exception 'invalid_error_code' using errcode = 'CP422';
  end if;
  select * into q from public.quotes where tenant_id = p_tenant and id = p_quote_id;
  if not found or q.current_package_id is null then
    raise exception 'quote_not_found' using errcode = 'CP404';
  end if;
  if exists (select 1 from public.email_messages where id = p_email_id) then
    return;
  end if;
  insert into public.email_messages
    (id, tenant_id, quote_id, package_id, share_link_id, kind, to_email_enc, to_email_hash, provider,
     provider_message_id, status, status_at, sent_at, error_code, created_by)
  values
    (p_email_id, p_tenant, p_quote_id, q.current_package_id, null, p_kind, p_to_email_enc, p_to_email_hash,
     case when v_sent then p_provider else 'pending' end, case when v_sent then p_provider_message_id end,
     case when v_sent then 'sent' else 'failed' end, now(), case when v_sent then now() end, p_error_code, p_actor);
  perform app.write_quote_event(p_tenant, p_quote_id,
    case when v_sent then 'payment_email_sent' else 'payment_email_failed' end, p_actor_type, p_actor,
    jsonb_build_object('kind', p_kind) || case when v_sent then '{}'::jsonb else jsonb_build_object('code', p_error_code) end);
end $$;
revoke all on function app.record_payment_email(uuid, uuid, text, uuid, text, text, text, text, text, text, uuid)
  from public, anon, authenticated;

-- 7. Al aceptar: hitos, cuenta congelada y estado (disparador diferido) -------------------------------
create function app.quote_responses_start_payments() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  q       public.quotes;
  b       public.bank_accounts;
  v_first bigint;
begin
  if new.decision <> 'accepted' then
    return null;
  end if;
  select * into q from public.quotes where tenant_id = new.tenant_id and id = new.quote_id for update;
  if q.payment_terms is null or q.status <> 'accepted'
     or exists (select 1 from public.payment_milestones m where m.tenant_id = q.tenant_id and m.quote_id = q.id) then
    return null;   -- sin condición de pago (cotizaciones de antes del cobro) o ya creados
  end if;
  if q.payment_terms = 'full' then
    insert into public.payment_milestones (tenant_id, quote_id, seq, kind, amount_clp)
    values (q.tenant_id, q.id, 1, 'full', q.total_clp);
  else
    -- 50/50: el anticipo es la mitad entera; el peso sobrante va al saldo y la suma es siempre el total (§13.7).
    v_first := q.total_clp / 2;
    insert into public.payment_milestones (tenant_id, quote_id, seq, kind, amount_clp)
    values (q.tenant_id, q.id, 1, 'deposit', v_first),
           (q.tenant_id, q.id, 2, 'balance', q.total_clp - v_first);
  end if;
  select * into b from public.bank_accounts where tenant_id = q.tenant_id;
  if found then
    insert into public.quote_payment_accounts
      (tenant_id, quote_id, bank_account_id, bank_revision, details_enc, account_last4)
    values (q.tenant_id, q.id, b.id, b.revision, b.details_enc, b.account_last4);
  end if;
  perform app.sync_quote_payment_status(q.tenant_id, q.id);
  perform app.write_quote_event(q.tenant_id, q.id, 'payment_pending', 'system', null,
    jsonb_build_object('terms', q.payment_terms, 'bank_captured', b.id is not null));
  return null;
end $$;
revoke all on function app.quote_responses_start_payments() from public, anon, authenticated;
create constraint trigger quote_responses_start_payments after insert on public.quote_responses
  deferrable initially deferred
  for each row execute function app.quote_responses_start_payments();

-- 8. Funciones con sesión -----------------------------------------------------------------------------

-- Crear o cambiar la cuenta bancaria (H-050). `p_expected_revision` = 0 para crearla; si otra persona la cambió entremedio, CP409.
-- Exige el segundo paso (pase aal2); sin él responde `second_step_required` (42501), como el resto de la base desde H-004a.
create function public.set_bank_account(
  p_bank_account_id uuid, p_details_enc text, p_account_last4 text, p_expected_revision integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  b        public.bank_accounts;
  v_before text;
begin
  if v_tenant is null or v_uid is null or not app.can('bank_account.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Hacia dónde va el dinero (§13.2): solo con una sesión que pasó el segundo paso (pase aal2). Sin él, ni con la contraseña.
  if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'second_step_required' using errcode = '42501';
  end if;
  if p_bank_account_id is null or p_details_enc is null or char_length(p_details_enc) not between 1 and 4000
     or p_account_last4 is null or p_account_last4 !~ '^[0-9A-Za-z]{1,4}$'
     or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into b from public.bank_accounts where tenant_id = v_tenant for update;
  if not found then
    if p_expected_revision <> 0 then
      raise exception 'revision_conflict' using errcode = 'CP409';
    end if;
    insert into public.bank_accounts (id, tenant_id, details_enc, account_last4)
    values (p_bank_account_id, v_tenant, p_details_enc, p_account_last4)
    on conflict (tenant_id) do nothing
    returning * into b;
    if b.id is null then
      raise exception 'revision_conflict' using errcode = 'CP409';
    end if;
    perform app.write_audit(v_tenant, 'user', v_uid, 'bank_account.created', 'bank_account', b.id, 'success',
      jsonb_build_object('account_last4', b.account_last4));
  else
    if b.id <> p_bank_account_id or b.revision <> p_expected_revision then
      raise exception 'revision_conflict' using errcode = 'CP409';
    end if;
    v_before := b.account_last4;
    update public.bank_accounts
       set details_enc = p_details_enc, account_last4 = p_account_last4, revision = revision + 1
     where tenant_id = v_tenant and id = b.id
    returning * into b;
    perform app.write_audit(v_tenant, 'user', v_uid, 'bank_account.changed', 'bank_account', b.id, 'success',
      jsonb_build_object('account_last4_before', v_before, 'account_last4', b.account_last4, 'revision', b.revision));
  end if;
  return jsonb_build_object('id', b.id, 'revision', b.revision, 'account_last4_before', v_before);
end $$;
revoke all on function public.set_bank_account(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.set_bank_account(uuid, text, text, integer) to authenticated;

-- ¿La organización activa tiene datos de transferencia? Lo puede preguntar cualquier miembro (para el envío), sin ver los datos.
create function public.tenant_has_bank_account() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return exists (select 1 from public.bank_accounts where tenant_id = v_tenant);
end $$;
revoke all on function public.tenant_has_bank_account() from public, anon, authenticated;
grant execute on function public.tenant_has_bank_account() to authenticated;

-- La condición de pago de un borrador (H-052): la elige quien lo envía. No cambia la revisión (no choca con el editor ni con el envío
-- en curso de la misma persona). Con condición, exige que la organización tenga datos de transferencia; `null` = sin cobro.
create function public.set_quote_payment_terms(p_quote_id uuid, p_terms text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  q        public.quotes;
begin
  if v_tenant is null or v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_quote_id is null or (p_terms is not null and p_terms not in ('full', 'split_50_50')) then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into q from public.quotes where tenant_id = v_tenant and id = p_quote_id for update;
  if not found then
    raise exception 'quote_not_found' using errcode = 'CP404';
  end if;
  if not app.can('quote.send', q.created_by = v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if q.status <> 'draft' then
    raise exception 'not_draft' using errcode = 'CP423';
  end if;
  if q.send_lock_until is not null and q.send_lock_until > now() then
    raise exception 'quote_is_being_sent' using errcode = 'CP423';
  end if;
  if p_terms is not null and not exists (select 1 from public.bank_accounts where tenant_id = v_tenant) then
    raise exception 'no_bank_account' using errcode = 'CP422';
  end if;
  if q.payment_terms is distinct from p_terms then
    update public.quotes set payment_terms = p_terms where tenant_id = v_tenant and id = q.id;
  end if;
  return jsonb_build_object('payment_terms', p_terms);
end $$;
revoke all on function public.set_quote_payment_terms(uuid, text) from public, anon, authenticated;
grant execute on function public.set_quote_payment_terms(uuid, text) to authenticated;

-- Marcar un pago como recibido (H-054): solo el Dueño y el Administrador (`payment.confirm`). El saldo, después del anticipo.
create function public.record_payment(
  p_milestone_id uuid, p_paid_on date, p_amount_clp bigint, p_note text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  m        public.payment_milestones;
  v_quote  uuid;
  v_status text;
begin
  if v_tenant is null or v_uid is null or not app.can('payment.confirm') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_milestone_id is null or p_paid_on is null or p_amount_clp is null
     or p_amount_clp not between 0 and 1000000000000
     or p_paid_on < date '2000-01-01' or p_paid_on > app.current_business_date() + 1
     or (p_note is not null and char_length(p_note) not between 1 and 500) then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select quote_id into v_quote from public.payment_milestones where tenant_id = v_tenant and id = p_milestone_id;
  if v_quote is null then
    raise exception 'milestone_not_found' using errcode = 'CP404';
  end if;
  -- Siempre en el mismo orden: la cotización y después el hito.
  perform 1 from public.quotes where tenant_id = v_tenant and id = v_quote for update;
  select * into m from public.payment_milestones where tenant_id = v_tenant and id = p_milestone_id for update;
  if m.status = 'paid' then
    raise exception 'already_paid' using errcode = 'CP423';
  end if;
  if m.seq = 2 and not exists (select 1 from public.payment_milestones x
                                where x.tenant_id = v_tenant and x.quote_id = v_quote and x.seq = 1 and x.status = 'paid') then
    raise exception 'deposit_first' using errcode = 'CP423';
  end if;
  update public.payment_milestones
     set status = 'paid', paid_on = p_paid_on, paid_amount_clp = p_amount_clp, paid_note = p_note,
         paid_by = v_uid, paid_at = now(), updated_at = now()
   where tenant_id = v_tenant and id = m.id;
  v_status := app.sync_quote_payment_status(v_tenant, v_quote);
  perform app.write_quote_event(v_tenant, v_quote, 'payment_recorded', 'user', v_uid,
    jsonb_build_object('seq', m.seq, 'kind', m.kind, 'amount_clp', p_amount_clp, 'expected_clp', m.amount_clp,
                       'paid_on', p_paid_on));
  perform app.write_audit(v_tenant, 'user', v_uid, 'payment.recorded', 'quote', v_quote, 'success',
    jsonb_build_object('milestone_id', m.id, 'seq', m.seq, 'kind', m.kind, 'amount_clp', p_amount_clp,
                       'expected_clp', m.amount_clp, 'paid_on', p_paid_on));
  return jsonb_build_object('quote_status', v_status);
end $$;
revoke all on function public.record_payment(uuid, date, bigint, text) from public, anon, authenticated;
grant execute on function public.record_payment(uuid, date, bigint, text) to authenticated;

-- Deshacer un pago marcado por error (H-055): con motivo; el registro original queda en la línea de tiempo y en la auditoría.
-- Se deshace en orden: el anticipo solo si el saldo no está pagado. Si el saldo ya se había pedido, el pedido se anula en la misma
-- transacción (vuelve a «por pagar»): se pidió dando por recibido un anticipo que no llegó.
create function public.reverse_payment(p_milestone_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  m        public.payment_milestones;
  v_quote  uuid;
  v_status text;
  v_cleared boolean := false;
begin
  if v_tenant is null or v_uid is null or not app.can('payment.confirm') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_milestone_id is null or p_reason is null or char_length(btrim(p_reason)) not between 3 and 200 then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select quote_id into v_quote from public.payment_milestones where tenant_id = v_tenant and id = p_milestone_id;
  if v_quote is null then
    raise exception 'milestone_not_found' using errcode = 'CP404';
  end if;
  perform 1 from public.quotes where tenant_id = v_tenant and id = v_quote for update;
  select * into m from public.payment_milestones where tenant_id = v_tenant and id = p_milestone_id for update;
  if m.status <> 'paid' then
    raise exception 'not_paid' using errcode = 'CP423';
  end if;
  if m.seq = 1 and exists (select 1 from public.payment_milestones x
                            where x.tenant_id = v_tenant and x.quote_id = v_quote and x.seq = 2 and x.status = 'paid') then
    raise exception 'reverse_balance_first' using errcode = 'CP423';
  end if;
  if m.seq = 1 then
    update public.payment_milestones
       set status = 'pending', requested_at = null, requested_by = null, updated_at = now()
     where tenant_id = v_tenant and quote_id = v_quote and seq = 2 and status = 'requested';
    v_cleared := found;
  end if;
  update public.payment_milestones
     set status = case when requested_at is not null then 'requested' else 'pending' end,
         paid_on = null, paid_amount_clp = null, paid_note = null, paid_by = null, paid_at = null, updated_at = now()
   where tenant_id = v_tenant and id = m.id;
  v_status := app.sync_quote_payment_status(v_tenant, v_quote);
  perform app.write_quote_event(v_tenant, v_quote, 'payment_reversed', 'user', v_uid,
    jsonb_build_object('seq', m.seq, 'kind', m.kind, 'amount_clp', m.paid_amount_clp, 'reason', btrim(p_reason),
                       'balance_request_cleared', v_cleared));
  perform app.write_audit(v_tenant, 'user', v_uid, 'payment.reversed', 'quote', v_quote, 'success',
    jsonb_build_object('milestone_id', m.id, 'seq', m.seq, 'kind', m.kind, 'amount_clp', m.paid_amount_clp,
                       'paid_on', m.paid_on, 'reason', btrim(p_reason), 'balance_request_cleared', v_cleared));
  return jsonb_build_object('quote_status', v_status);
end $$;
revoke all on function public.reverse_payment(uuid, text) from public, anon, authenticated;
grant execute on function public.reverse_payment(uuid, text) to authenticated;

-- Pedir el segundo pago (H-056): el Comercial en las suyas, el Dueño y el Administrador en todas. La primera vez pasa a
-- «Pendiente de saldo»; repetirla no cambia nada y sirve para reenviar el correo. Devuelve lo necesario para escribirle al cliente
-- (los datos bancarios van cifrados: solo el servidor los abre).
create function public.request_second_payment(p_milestone_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  m        public.payment_milestones;
  q        public.quotes;
  v_first  boolean := false;
begin
  if v_tenant is null or v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_milestone_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into m from public.payment_milestones where tenant_id = v_tenant and id = p_milestone_id;
  if not found then
    raise exception 'milestone_not_found' using errcode = 'CP404';
  end if;
  select * into q from public.quotes where tenant_id = v_tenant and id = m.quote_id for update;
  if not app.can('payment.second.request', q.created_by = v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into m from public.payment_milestones where tenant_id = v_tenant and id = p_milestone_id for update;
  if m.kind <> 'balance' then
    raise exception 'not_balance' using errcode = 'CP422';
  end if;
  if m.status = 'paid' then
    raise exception 'already_paid' using errcode = 'CP423';
  end if;
  if not exists (select 1 from public.payment_milestones x
                  where x.tenant_id = v_tenant and x.quote_id = q.id and x.seq = 1 and x.status = 'paid') then
    raise exception 'deposit_not_paid' using errcode = 'CP423';
  end if;
  if m.status = 'pending' then
    v_first := true;
    update public.payment_milestones
       set status = 'requested', requested_at = now(), requested_by = v_uid, updated_at = now()
     where tenant_id = v_tenant and id = m.id;
    perform app.sync_quote_payment_status(v_tenant, q.id);
    perform app.write_quote_event(v_tenant, q.id, 'second_payment_requested', 'user', v_uid,
      jsonb_build_object('amount_clp', m.amount_clp));
    perform app.write_audit(v_tenant, 'user', v_uid, 'payment.second_requested', 'quote', q.id, 'success',
      jsonb_build_object('milestone_id', m.id, 'amount_clp', m.amount_clp));
  end if;
  return jsonb_build_object('first_request', v_first, 'milestone_id', m.id, 'amount_clp', m.amount_clp)
         || jsonb_build_object('context', app.payment_email_context(v_tenant, q.id));
end $$;
revoke all on function public.request_second_payment(uuid) from public, anon, authenticated;
grant execute on function public.request_second_payment(uuid) to authenticated;

-- Anotar el correo del segundo pago (salió o falló), con quien lo pidió como autor.
create function public.record_second_payment_email(
  p_milestone_id uuid, p_email_id uuid, p_to_email_enc text, p_to_email_hash text,
  p_provider text, p_provider_message_id text, p_error_code text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  m        public.payment_milestones;
  q        public.quotes;
begin
  if v_tenant is null or v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into m from public.payment_milestones where tenant_id = v_tenant and id = p_milestone_id;
  if not found then
    raise exception 'milestone_not_found' using errcode = 'CP404';
  end if;
  select * into q from public.quotes where tenant_id = v_tenant and id = m.quote_id;
  if not app.can('payment.second.request', q.created_by = v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if m.kind <> 'balance' or m.status = 'pending' then
    raise exception 'not_requested' using errcode = 'CP423';
  end if;
  perform app.record_payment_email(v_tenant, q.id, 'payment_2', p_email_id, p_to_email_enc, p_to_email_hash,
    p_provider, p_provider_message_id, p_error_code, 'user', v_uid);
  return jsonb_build_object('recorded', true);
end $$;
revoke all on function public.record_second_payment_email(uuid, uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_second_payment_email(uuid, uuid, text, text, text, text, text) to authenticated;

-- 9. Funciones solo del servidor (el portero del enlace del cliente) ------------------------------------

-- Lo que el enlace muestra para pagar: solo si el enlace está activo, no revocado, es el vigente y el cliente ACEPTÓ. Antes de
-- aceptar no devuelve nada (los datos bancarios nunca aparecen antes, §6.5).
create function public.share_link_payment(p_token_sha256 text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  l public.share_links;
  q public.quotes;
  v_ctx jsonb;
begin
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select * into l from public.share_links where token_sha256 = p_token_sha256;
  if not found or l.activated_at is null or l.revoked_at is not null then
    return null;
  end if;
  if not exists (select 1 from public.tenants t where t.tenant_id = l.tenant_id and t.status = 'active') then
    return null;
  end if;
  select * into q from public.quotes where tenant_id = l.tenant_id and id = l.quote_id;
  if q.current_package_id is distinct from l.package_id
     or not exists (select 1 from public.quote_responses r
                     where r.tenant_id = l.tenant_id and r.quote_id = l.quote_id and r.decision = 'accepted') then
    return null;
  end if;
  v_ctx := app.payment_email_context(l.tenant_id, l.quote_id);
  if v_ctx is null or jsonb_array_length(v_ctx -> 'milestones') = 0 then
    return null;
  end if;
  return jsonb_build_object('tenant_id', l.tenant_id, 'payment_terms', v_ctx -> 'payment_terms',
                            'milestones', v_ctx -> 'milestones', 'bank', v_ctx -> 'bank');
end $$;
revoke all on function public.share_link_payment(text) from public, anon, authenticated;
grant execute on function public.share_link_payment(text) to service_role;

-- Los datos del correo con los datos para pagar, justo después de aceptar (H-053). La respuesta tiene que ser la que la base acaba
-- de registrar (aceptada) para esa cotización.
create function public.share_payment_notice(p_quote_id uuid, p_response_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.quote_responses;
begin
  if p_quote_id is null or p_response_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into r from public.quote_responses where id = p_response_id and quote_id = p_quote_id;
  if not found or r.decision <> 'accepted' then
    raise exception 'response_not_found' using errcode = 'CP404';
  end if;
  return app.payment_email_context(r.tenant_id, r.quote_id);
end $$;
revoke all on function public.share_payment_notice(uuid, uuid) from public, anon, authenticated;
grant execute on function public.share_payment_notice(uuid, uuid) to service_role;

create function public.share_payment_notice_record(
  p_quote_id uuid, p_response_id uuid, p_email_id uuid, p_to_email_enc text, p_to_email_hash text,
  p_provider text, p_provider_message_id text, p_error_code text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.quote_responses;
begin
  if p_quote_id is null or p_response_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into r from public.quote_responses where id = p_response_id and quote_id = p_quote_id;
  if not found or r.decision <> 'accepted' then
    raise exception 'response_not_found' using errcode = 'CP404';
  end if;
  -- El correo ni se intentó (sin destinatario, datos ilegibles, configuración…): sin fila de correo, pero queda el rastro en la
  -- línea de tiempo para que el equipo sepa que el cliente no recibió los datos para pagar.
  if p_email_id is null then
    if p_error_code is null or p_error_code !~ '^[A-Za-z0-9_.:-]{1,60}$' then
      raise exception 'invalid_error_code' using errcode = 'CP422';
    end if;
    perform app.write_quote_event(r.tenant_id, r.quote_id, 'payment_email_failed', 'system', null,
      jsonb_build_object('kind', 'payment_1', 'code', p_error_code));
    return jsonb_build_object('recorded', true);
  end if;
  perform app.record_payment_email(r.tenant_id, r.quote_id, 'payment_1', p_email_id, p_to_email_enc, p_to_email_hash,
    p_provider, p_provider_message_id, p_error_code, 'system', null);
  return jsonb_build_object('recorded', true);
end $$;
revoke all on function public.share_payment_notice_record(uuid, uuid, uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.share_payment_notice_record(uuid, uuid, uuid, text, text, text, text, text)
  to service_role;
