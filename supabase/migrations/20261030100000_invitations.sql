-- Sprint 5 · H-008 · Invitar a un miembro con su rol
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261030100000_invitations.down.sql
-- Especificación: docs/arquitectura/sprint-5-equipo-y-permisos.md §2 (tabla, funciones, topes y flujo de H-008).
--
-- Qué agrega:
--   · `public.invitations`: una fila por invitación. El correo del invitado (dato personal) va CIFRADO desde la
--     aplicación (sello `invitations.email|tenant|id`) con su huella para saber si ya hay una invitación para ese
--     correo. El código secreto del enlace NUNCA se guarda: solo su huella (`token_sha256`) y un «vínculo»
--     (`email_binding` = sha256(huella del código + «|» + correo normalizado)) con el que la base, sola,
--     comprobará que quien acepta usa el mismo correo al que se envió (H-009).
--   · Tres funciones para miembros, con el pase de la persona: `create_invitation`, `resend_invitation` y
--     `revoke_invitation`. Solo las ejecuta quien tiene el permiso `team.manage` (matriz de H-011).
--   · `invitation_email_settle` (solo servidor): cierra el envío del correo, igual que `internal_notice_settle`.
--   · `app.normalize_email` (gemela de `src/lib/normalize/email.ts`) y `app.invitation_binding`.
--   · `email_messages` gana el tipo `invitation` y la columna `invitation_id`.
--   · Aviso al Dueño cuando alguien que NO es el Dueño invita a un Administrador (kind `invitation_notice`).
--     Es ROBUSTO en la base: `create_invitation` deja anotado, en la misma transacción, que hay un
--     aviso pendiente (`invitations.owner_notice_state = 'pending'`), aunque se la llame directo sin pasar por la
--     pantalla; una tarea (`src/server/jobs/send-invitation-notices.ts`) envía los pendientes y reintenta los
--     fallidos con tope e intervalo. EN PRODUCCIÓN eso vale solo cuando se resuelva la decisión #17 (cómo se
--     programa la tarea de avisos); mientras tanto, solo corre el intento inmediato. Funciones solo del servidor: `invitation_notices_pending`,
--     `invitation_notice_recipients`, `invitation_notice_register` y el mismo `invitation_email_settle`.
--     El aviso no lleva el correo del invitado.
--   · Tarea diaria `app.purge_invitations()`: nada se guarda indefinidamente (LEGAL.md §1.3).
--
-- `accept_invitation` e `invitation_preview` son de H-009: no existen todavía, pero la tabla ya trae las
-- columnas de aceptación (`accepted_*`, `member_id`) y el vínculo del correo.
--
-- Códigos de error propios (SQLSTATE): CP404 no encontrada · CP422 dato inválido · CP423 el estado ya no lo
-- permite · CP429 tope alcanzado · 42501 sin permiso.
--
-- Orden de revisiones (para no revelar nada a quien no corresponde):
--   1. ¿es miembro de la organización activa?  no → CP404 «No encontrado»
--   2. ¿tiene permiso de equipo?               no → 42501 «No tienes permiso para esto»
--   3. forma de los argumentos y rol permitido → CP422
--   4. topes (con candado por organización)    → CP429
--   5. ¿ya es miembro activo de ESTA organización? → resultado `already_member`
--   6. ¿ya hay una invitación pendiente?           → resultado `already_pending`
--   7. crear. El resultado es idéntico tenga o no cuenta ese correo en Cotiza Prime: nunca se consulta un
--      correo fuera de los miembros de esta organización.

-- 0. Constantes con nombre -------------------------------------------------------------------------
create function app.invitation_ttl_days()             returns integer language sql immutable as $$ select 7 $$;
create function app.invitation_max_per_user_hour()    returns integer language sql immutable as $$ select 20 $$;
create function app.invitation_max_per_tenant_day()   returns integer language sql immutable as $$ select 50 $$;
create function app.invitation_max_pending()          returns integer language sql immutable as $$ select 50 $$;
create function app.invitation_max_resends()          returns integer language sql immutable as $$ select 5 $$;
create function app.invitation_resend_min_minutes()   returns integer language sql immutable as $$ select 10 $$;
-- Aviso al Dueño: intentos como máximo, minutos mínimos entre un intento y el siguiente, y minutos tras los que un
-- intento que nunca se cerró (el servidor se cayó a medias) se da por fallido.
create function app.invitation_notice_max_attempts()  returns integer language sql immutable as $$ select 5 $$;
create function app.invitation_notice_retry_minutes() returns integer language sql immutable as $$ select 10 $$;
create function app.invitation_notice_stale_minutes() returns integer language sql immutable as $$ select 5 $$;
-- Un correo que lleva más de esto «pendiente de enviar» se da por no enviado (el servidor se cayó a medias).
create function app.invitation_mail_grace_minutes()   returns integer language sql immutable as $$ select 2 $$;
-- Una invitación no aceptada se borra 30 días después de vencer o cancelarse (supuesto 7 del sprint 5).
create function app.invitation_retention_days()       returns integer language sql immutable as $$ select 30 $$;
revoke all on function
  app.invitation_ttl_days(), app.invitation_max_per_user_hour(), app.invitation_max_per_tenant_day(),
  app.invitation_max_pending(), app.invitation_max_resends(), app.invitation_resend_min_minutes(),
  app.invitation_mail_grace_minutes(), app.invitation_retention_days(),
  app.invitation_notice_max_attempts(), app.invitation_notice_retry_minutes(), app.invitation_notice_stale_minutes()
  from public, anon, authenticated;

-- 1. Correo normalizado y vínculo ------------------------------------------------------------------
-- Gemela de `normalizeEmail` (src/lib/normalize/email.ts): recorta, NFC y minúsculas. El recorte quita los
-- mismos caracteres que `String.prototype.trim` de JavaScript (espacios, tabuladores, saltos de línea, espacio
-- de no separación, BOM y los espacios Unicode). No toca puntos ni `+`. `tests/db/normalize-email-parity.test.ts`
-- comprueba que las dos digan lo mismo.
create function app.normalize_email(p_email text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select lower(normalize(
    regexp_replace(
      p_email,
      '^[\t\n\v\f\r    -     　﻿]+|[\t\n\v\f\r    -     　﻿]+$',
      '', 'g'),
    nfc))
$$;

-- El vínculo de una invitación con su correo: sha256 en hexadecimal de «huella del código | correo normalizado».
-- La aplicación calcula lo mismo en `src/lib/team/invitation-code.ts`.
create function app.invitation_binding(p_token_sha256 text, p_email text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select encode(sha256(convert_to(p_token_sha256 || '|' || app.normalize_email(p_email), 'UTF8')), 'hex')
$$;
revoke all on function app.normalize_email(text), app.invitation_binding(text, text)
  from public, anon, authenticated;

-- Los roles que se pueden dar al invitar. El Dueño es único (se traspasa con H-111): nunca se invita como Dueño.
-- Es un dominio y no una lista escrita dentro de las funciones: así los nombres de los roles siguen viviendo
-- solo en la matriz y en este tipo (guardia 14 de tests/db/schema-guards.test.ts).
create domain app.invitation_role as text check (value in ('admin', 'approver', 'sales', 'viewer'));

-- 2. La tabla ----------------------------------------------------------------------------------------
create table public.invitations (
  id            uuid primary key,   -- lo genera la aplicación ANTES de cifrar (va en el sello del correo)
  tenant_id     uuid not null references public.tenants (tenant_id) on update cascade,
  email_enc     text check (email_enc is null or char_length(email_enc) between 1 and 2000),
  email_hash    text check (email_hash is null or email_hash ~ '^[0-9a-f]{64}$'),
  email_binding text check (email_binding is null or email_binding ~ '^[0-9a-f]{64}$'),
  role          app.invitation_role not null,
  token_sha256  text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  expires_at    timestamptz not null,
  invited_by    uuid not null references auth.users (id),
  send_count    integer not null default 1 check (send_count between 1 and 6),   -- envíos en total: el primero + hasta 5 reenvíos
  last_sent_at  timestamptz not null default now(),
  revoked_at    timestamptz,
  revoked_by    uuid references auth.users (id),
  revoke_reason text check (revoke_reason in ('cancelled', 'inviter_removed')),
  accepted_at   timestamptz,
  accepted_by   uuid references auth.users (id),
  member_id     uuid,
  -- Aviso al Dueño (ver 7b): `none` no corresponde; `pending` falta enviarlo (o reintentarlo); `sent`; `exhausted`
  -- se agotaron los intentos (queda a la vista en el log con el código `invitation_notice_exhausted`).
  owner_notice_state           text not null default 'none'
                               check (owner_notice_state in ('none', 'pending', 'sent', 'exhausted')),
  owner_notice_attempts        integer not null default 0 check (owner_notice_attempts between 0 and 20),
  owner_notice_last_attempt_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, member_id) references public.members (tenant_id, id),
  -- Mientras se espera, el correo y su huella están completos; al aceptar se vacían (el correo ya vive en la cuenta).
  constraint invitations_email_shape check (
    (email_enc is null) = (email_hash is null)
    and (email_enc is null) = (email_binding is null)
    and (email_enc is null) = (status = 'accepted')),
  constraint invitations_pending_shape check (
    status <> 'pending'
    or (revoked_at is null and revoked_by is null and revoke_reason is null
        and accepted_at is null and accepted_by is null and member_id is null)),
  constraint invitations_accepted_shape check (
    status <> 'accepted'
    or (accepted_at is not null and accepted_by is not null
        and revoked_at is null and revoked_by is null and revoke_reason is null)),
  constraint invitations_revoked_shape check (
    status <> 'revoked'
    or (revoked_at is not null and revoke_reason is not null
        and accepted_at is null and accepted_by is null and member_id is null))
);
-- Una sola invitación pendiente por correo y organización, aunque dos administradores inviten al mismo tiempo.
create unique index invitations_one_pending_per_email on public.invitations (tenant_id, email_hash)
  where status = 'pending';
create index invitations_tenant_status  on public.invitations (tenant_id, status, created_at desc);
create index invitations_tenant_inviter on public.invitations (tenant_id, invited_by, created_at);
create index invitations_tenant_member  on public.invitations (tenant_id, member_id) where member_id is not null;
-- La cola de la tarea de avisos al Dueño mira solo las que están pendientes, de la más antigua a la más nueva
-- (excepción justificada a «los índices empiezan por tenant_id»: la tarea recorre todas las organizaciones).
create index invitations_notice_queue on public.invitations (created_at) where owner_notice_state = 'pending';

create trigger invitations_meta before insert or update on public.invitations
  for each row execute function app.set_row_meta();
create trigger invitations_forbid_tenant_change before update on public.invitations
  for each row execute function app.forbid_tenant_change();
-- Datos personales: la auditoría guarda solo los NOMBRES de los campos que cambiaron, nunca el correo. Es el
-- mismo criterio de `app.audit_row_change('keys_only', ...)`, con una diferencia: al crear una invitación
-- queda también el rol (no es un dato personal), que es lo que importa saber de «invitation.created».
create function app.audit_invitation_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_actor   text := case when auth.uid() is null then 'system' else 'user' end;
  v_changed text[];
begin
  if tg_op = 'INSERT' then
    perform app.write_audit(new.tenant_id, v_actor, v_uid, 'invitation.created', 'invitation', new.id,
      'success', jsonb_build_object('role', new.role));
    return null;
  end if;
  select array_agg(n.key order by n.key) into v_changed
    from jsonb_each(to_jsonb(new)) n
   where n.value is distinct from to_jsonb(old) -> n.key
     and n.key not in ('created_at', 'updated_at', 'owner_notice_state', 'owner_notice_attempts',
                       'owner_notice_last_attempt_at');   -- el avance del aviso queda en email_messages
  if v_changed is null then
    return null;   -- no cambió nada relevante
  end if;
  perform app.write_audit(new.tenant_id, v_actor, v_uid, 'invitation.updated', 'invitation', new.id,
    'success', jsonb_build_object('changed', to_jsonb(v_changed)));
  return null;
end $$;
revoke all on function app.audit_invitation_change() from public, anon, authenticated;
create trigger invitations_audit after insert or update on public.invitations
  for each row execute function app.audit_invitation_change();

alter table public.invitations enable row level security;
-- Solo quien maneja el equipo ve las invitaciones de SU organización.
create policy invitations_select on public.invitations for select to authenticated
  using (tenant_id = (select app.current_tenant_id()) and (select app.can('team.manage')));
-- Lectura por columnas: nadie con un pase lee `token_sha256`, `email_binding` ni `email_hash`.
-- Sin permisos ni políticas de escritura: solo las funciones.
grant select (id, tenant_id, email_enc, role, status, expires_at, invited_by, send_count, last_sent_at,
              revoked_at, revoked_by, revoke_reason, accepted_at, accepted_by, member_id, created_at, updated_at)
  on public.invitations to authenticated;

-- 3. email_messages: el correo de la invitación -------------------------------------------------------
alter table public.email_messages drop constraint email_messages_kind_check;
alter table public.email_messages add constraint email_messages_kind_check
  check (kind in ('quote', 'quote_resend', 'internal_notice', 'payment_1', 'payment_2',
                  'request_assigned', 'request_received', 'intake_cap_reached', 'invitation',
                  'invitation_notice'));
alter table public.email_messages
  add column invitation_id uuid,
  add foreign key (tenant_id, invitation_id) references public.invitations (tenant_id, id);
alter table public.email_messages drop constraint email_messages_target_shape;
alter table public.email_messages add constraint email_messages_target_shape check (
     (kind in ('quote', 'quote_resend', 'internal_notice', 'payment_1', 'payment_2')
      and quote_id is not null and package_id is not null
      and intake_request_id is null and intake_form_id is null and invitation_id is null)
  or (kind in ('request_assigned', 'request_received')
      and intake_request_id is not null
      and quote_id is null and package_id is null and intake_form_id is null and invitation_id is null)
  or (kind = 'intake_cap_reached'
      and intake_form_id is not null
      and quote_id is null and package_id is null and intake_request_id is null and invitation_id is null)
  or (kind in ('invitation', 'invitation_notice')
      and invitation_id is not null
      and quote_id is null and package_id is null and intake_request_id is null and intake_form_id is null));
create index email_messages_invitation on public.email_messages (tenant_id, invitation_id, created_at)
  where invitation_id is not null;
-- Un solo aviso al Dueño por invitación que no haya fallado: un intento fallido NO impide el reintento, pero uno
-- pendiente o enviado sí (nunca dos avisos vivos para la misma invitación).
create unique index email_messages_one_invitation_notice on public.email_messages (tenant_id, invitation_id)
  where kind = 'invitation_notice' and status <> 'failed';

-- El correo de una invitación lleva el correo del invitado (cifrado): solo lo ve quien maneja el equipo. El aviso
-- al Dueño es del Dueño: lo ve quien puede transferir la organización (`tenant.transfer`), no el Administrador
-- (así no ve si el aviso sobre lo que él mismo hizo salió o falló).
alter policy email_messages_select on public.email_messages
  using (tenant_id = (select app.current_tenant_id())
         and (kind not in ('invitation', 'invitation_notice')
              or (kind = 'invitation' and (select app.can('team.manage')))
              or (kind = 'invitation_notice' and (select app.can('tenant.transfer')))));

-- Registro de correos de solo agregar. Salidas: la limpieza por plazo de los avisos de solicitud (como antes,
-- amarrada al vencimiento de la solicitud) y ahora la de los correos de una invitación vencida, cancelada o
-- aceptada hace más de `app.invitation_retention_days()`.
create or replace function app.email_messages_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  c_moving constant text[] := array['status', 'status_at', 'sent_at', 'delivered_at', 'bounced_at',
                                    'bounce_type', 'error_code', 'provider', 'provider_message_id'];
  v_new jsonb;
  v_old jsonb;
  v_key text;
  v_rank_old integer;
  v_rank_new integer;
begin
  if tg_op = 'DELETE' then
    if current_setting('app.retention_purge', true) is not distinct from 'on' then
      -- Solo el aviso de una solicitud que ya venció (la misma regla con que se borra la solicitud).
      if old.kind in ('request_assigned', 'request_received')
         and exists (
           select 1 from public.intake_requests r
            where r.tenant_id = old.tenant_id and r.id = old.intake_request_id
              and ((r.status in ('new', 'assigned')
                    and r.created_at <= now() - make_interval(months => app.intake_unconverted_retention_months()))
                or (r.status = 'discarded'
                    and r.discarded_at <= now() - make_interval(days => app.intake_discarded_retention_days())))) then
        return old;
      end if;
      -- Solo el correo de una invitación vencida, cancelada o aceptada hace más del plazo.
      if old.kind in ('invitation', 'invitation_notice')
         and exists (
           select 1 from public.invitations i
            where i.tenant_id = old.tenant_id and i.id = old.invitation_id
              and ((i.status = 'pending'
                    and i.expires_at <= now() - make_interval(days => app.invitation_retention_days()))
                or (i.status = 'revoked'
                    and i.revoked_at <= now() - make_interval(days => app.invitation_retention_days()))
                or (i.status = 'accepted'
                    and i.accepted_at <= now() - make_interval(days => app.invitation_retention_days())))) then
        return old;
      end if;
    end if;
    raise exception 'email_messages is append-only' using errcode = '42501';
  end if;
  v_new := to_jsonb(new);
  v_old := to_jsonb(old);
  for v_key in select k from jsonb_object_keys(v_new) k loop
    if v_key = any (c_moving) then
      continue;
    end if;
    if v_new -> v_key is distinct from v_old -> v_key then
      raise exception 'email_messages.% is immutable', v_key using errcode = '42501';
    end if;
  end loop;
  -- El proveedor se conoce al enviar: nace como 'pending' y se fija una sola vez.
  if old.provider <> 'pending' and new.provider is distinct from old.provider then
    raise exception 'provider is fixed once known' using errcode = '42501';
  end if;
  if old.provider_message_id is not null and new.provider_message_id is distinct from old.provider_message_id then
    raise exception 'provider_message_id is fixed once known' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    v_rank_old := case old.status when 'pending' then 0 when 'sent' then 1 when 'delivered' then 2
                    when 'bounced' then 3 when 'complained' then 3 else 9 end;
    v_rank_new := case new.status when 'pending' then 0 when 'sent' then 1 when 'delivered' then 2
                    when 'bounced' then 3 when 'complained' then 3 else 9 end;
    if not (
         (new.status = 'failed' and old.status = 'pending')
      or (new.status <> 'failed' and v_rank_old < 3 and v_rank_new > v_rank_old)) then
      raise exception 'invalid email status change % -> %', old.status, new.status using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- 4. create_invitation --------------------------------------------------------------------------------
-- Crea la invitación y el registro de su correo (pendiente de enviar) en una sola transacción. La aplicación
-- envía el correo DESPUÉS y lo cierra con `invitation_email_settle`.
-- p_invitation_id / p_email_message_id: los genera la aplicación (van en el sello de lo cifrado).
-- p_email_enc: correo cifrado de la invitación; p_to_email_enc: el mismo correo cifrado para el registro de correos.
-- p_email_hash: huella del correo normalizado. p_email_binding: ver arriba. p_token_sha256: huella del código.
-- result: created | already_member | already_pending (con invitation_id)
create function public.create_invitation(
  p_invitation_id uuid, p_email_enc text, p_email_hash text, p_email_binding text, p_token_sha256 text,
  p_role text, p_email_message_id uuid, p_to_email_enc text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant  uuid := app.current_tenant_id();
  v_uid     uuid := auth.uid();
  v_role    app.invitation_role;
  v_pending uuid;
  v_expires timestamptz := now() + make_interval(days => app.invitation_ttl_days());
begin
  -- 1. ¿es miembro de la organización activa?
  if v_tenant is null or v_uid is null then
    raise exception 'not_found' using errcode = 'CP404';
  end if;
  -- 2. ¿puede manejar el equipo?
  if not app.can('team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- 3. forma de lo recibido y rol permitido (el Dueño no se invita)
  if p_invitation_id is null or p_email_message_id is null or p_role is null
     or p_email_enc is null or char_length(p_email_enc) not between 1 and 2000
     or p_to_email_enc is null or char_length(p_to_email_enc) not between 1 and 2000
     or p_email_hash is null or p_email_hash !~ '^[0-9a-f]{64}$'
     or p_email_binding is null or p_email_binding !~ '^[0-9a-f]{64}$'
     or p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  begin
    v_role := p_role;
  exception when check_violation then
    raise exception 'invalid_role' using errcode = 'CP422';
  end;

  -- 4. topes, contados con un candado por organización: dos invitaciones a la vez no pasan el tope juntas.
  perform pg_advisory_xact_lock(hashtextextended('invitations:' || v_tenant::text, 0));
  if (select count(*) from public.invitations i
       where i.tenant_id = v_tenant and i.invited_by = v_uid
         and i.created_at > now() - interval '1 hour') >= app.invitation_max_per_user_hour() then
    raise exception 'limit_user_hour' using errcode = 'CP429';
  end if;
  if (select count(*) from public.invitations i
       where i.tenant_id = v_tenant and i.created_at > now() - interval '1 day') >= app.invitation_max_per_tenant_day() then
    raise exception 'limit_tenant_day' using errcode = 'CP429';
  end if;
  if (select count(*) from public.invitations i
       where i.tenant_id = v_tenant and i.status = 'pending' and i.expires_at > now()) >= app.invitation_max_pending() then
    raise exception 'limit_pending' using errcode = 'CP429';
  end if;

  -- 5. ¿ya es miembro activo de ESTA organización? Se compara el vínculo con el de cada miembro activo; así
  --    jamás se consulta un correo que no sea de esta organización.
  if exists (
    select 1
      from public.members m join auth.users u on u.id = m.user_id
     where m.tenant_id = v_tenant and m.status = 'active' and u.email is not null
       and app.invitation_binding(p_token_sha256, u.email) = p_email_binding) then
    return jsonb_build_object('result', 'already_member');
  end if;

  -- 6. ¿ya tiene una invitación pendiente (vencida o no)? Se ofrece reenviarla.
  select i.id into v_pending from public.invitations i
   where i.tenant_id = v_tenant and i.email_hash = p_email_hash and i.status = 'pending';
  if found then
    return jsonb_build_object('result', 'already_pending', 'invitation_id', v_pending);
  end if;

  -- 7. crear
  begin
    insert into public.invitations
      (id, tenant_id, email_enc, email_hash, email_binding, role, token_sha256, status, expires_at, invited_by,
       owner_notice_state)
    values
      (p_invitation_id, v_tenant, p_email_enc, p_email_hash, p_email_binding, v_role, p_token_sha256,
       'pending', v_expires, v_uid,
       -- El aviso al Dueño queda anotado AQUÍ, en la misma operación: aunque alguien llame la función directo,
       -- sin pasar por la pantalla, la tarea lo enviará (ver 7b).
       case when app.invitation_notice_applies(v_role, v_uid, v_tenant) then 'pending' else 'none' end);
    insert into public.email_messages
      (id, tenant_id, invitation_id, kind, to_email_enc, to_email_hash, provider, status, created_by)
    values
      (p_email_message_id, v_tenant, p_invitation_id, 'invitation', p_to_email_enc, p_email_hash,
       'pending', 'pending', v_uid);
  exception when unique_violation then
    -- Otra invitación pendiente para el mismo correo ganó la carrera.
    select i.id into v_pending from public.invitations i
     where i.tenant_id = v_tenant and i.email_hash = p_email_hash and i.status = 'pending';
    if found then
      return jsonb_build_object('result', 'already_pending', 'invitation_id', v_pending);
    end if;
    raise exception 'id_in_use' using errcode = 'CP422';
  end;
  -- `notify_owner`: la pantalla intentará el aviso al Dueño de inmediato. La garantía no es ese intento sino la
  -- tarea: el aviso ya quedó anotado como pendiente. Un fallo del aviso nunca deshace la invitación.
  return jsonb_build_object('result', 'created', 'invitation_id', p_invitation_id,
                            'email_message_id', p_email_message_id, 'expires_at', v_expires,
                            'notify_owner', app.invitation_notice_applies(v_role, v_uid, v_tenant));
end $$;
revoke all on function public.create_invitation(uuid, text, text, text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_invitation(uuid, text, text, text, text, text, uuid, text)
  to authenticated;

-- 5. resend_invitation ---------------------------------------------------------------------------------
-- Reenvía una invitación pendiente (también una vencida: eso extiende su vigencia). Genera un código NUEVO:
-- el enlace anterior deja de servir. Respeta el tope de reenvíos y el intervalo mínimo entre uno y otro.
-- El intervalo mínimo existe para no llenarle el buzón a la persona invitada: si el último correo NUNCA salió
-- (falló, o quedó «pendiente» más de 2 minutos), se puede reintentar de inmediato. El tope de reenvíos sigue valiendo.
-- result: resent
create function public.resend_invitation(
  p_invitation_id uuid, p_email_binding text, p_token_sha256 text, p_email_message_id uuid, p_to_email_enc text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant  uuid := app.current_tenant_id();
  v_uid     uuid := auth.uid();
  v_inv     public.invitations;
  v_mail    public.email_messages;
  v_expires timestamptz := now() + make_interval(days => app.invitation_ttl_days());
begin
  if v_tenant is null or v_uid is null then
    raise exception 'not_found' using errcode = 'CP404';
  end if;
  if not app.can('team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_invitation_id is null or p_email_message_id is null
     or p_to_email_enc is null or char_length(p_to_email_enc) not between 1 and 2000
     or p_email_binding is null or p_email_binding !~ '^[0-9a-f]{64}$'
     or p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('invitations:' || v_tenant::text, 0));
  select * into v_inv from public.invitations i where i.tenant_id = v_tenant and i.id = p_invitation_id for update;
  if not found then
    raise exception 'invitation_not_found' using errcode = 'CP404';
  end if;
  if v_inv.status <> 'pending' then
    raise exception 'not_pending' using errcode = 'CP423';
  end if;
  if v_inv.send_count - 1 >= app.invitation_max_resends() then
    raise exception 'limit_resends' using errcode = 'CP429';
  end if;
  -- Reenviar una vencida la deja vigente otra vez: cuenta para el tope de pendientes igual que invitar.
  if v_inv.expires_at <= now()
     and (select count(*) from public.invitations i
           where i.tenant_id = v_tenant and i.status = 'pending' and i.expires_at > now())
         >= app.invitation_max_pending() then
    raise exception 'limit_pending' using errcode = 'CP429';
  end if;
  select * into v_mail from public.email_messages e
   where e.tenant_id = v_tenant and e.invitation_id = v_inv.id and e.kind = 'invitation'
   order by e.created_at desc, e.id limit 1;
  if v_inv.last_sent_at > now() - make_interval(mins => app.invitation_resend_min_minutes())
     and not (found and (v_mail.status = 'failed'
                         or (v_mail.status = 'pending'
                             and v_mail.created_at < now() - make_interval(mins => app.invitation_mail_grace_minutes())))) then
    raise exception 'resend_too_soon' using errcode = 'CP429';
  end if;

  begin
    update public.invitations
       set token_sha256 = p_token_sha256, email_binding = p_email_binding, expires_at = v_expires,
           send_count = v_inv.send_count + 1, last_sent_at = now()
     where tenant_id = v_tenant and id = v_inv.id;
    insert into public.email_messages
      (id, tenant_id, invitation_id, kind, to_email_enc, to_email_hash, provider, status, created_by)
    values
      (p_email_message_id, v_tenant, v_inv.id, 'invitation', p_to_email_enc, v_inv.email_hash,
       'pending', 'pending', v_uid);
  exception when unique_violation then
    raise exception 'id_in_use' using errcode = 'CP422';
  end;
  perform app.write_audit(v_tenant, 'user', v_uid, 'invitation.resent', 'invitation', v_inv.id, 'success',
    jsonb_build_object('role', v_inv.role, 'send_count', v_inv.send_count + 1));
  return jsonb_build_object('result', 'resent', 'invitation_id', v_inv.id, 'email_message_id', p_email_message_id,
                            'expires_at', v_expires, 'send_count', v_inv.send_count + 1);
end $$;
revoke all on function public.resend_invitation(uuid, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.resend_invitation(uuid, text, text, uuid, text) to authenticated;

-- 6. revoke_invitation ---------------------------------------------------------------------------------
-- Cancela una invitación pendiente: su enlace deja de servir al instante. Repetir no hace nada.
-- result: revoked | already_revoked
create function public.revoke_invitation(p_invitation_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  v_inv    public.invitations;
begin
  if v_tenant is null or v_uid is null then
    raise exception 'not_found' using errcode = 'CP404';
  end if;
  if not app.can('team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_invitation_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('invitations:' || v_tenant::text, 0));
  select * into v_inv from public.invitations i where i.tenant_id = v_tenant and i.id = p_invitation_id for update;
  if not found then
    raise exception 'invitation_not_found' using errcode = 'CP404';
  end if;
  if v_inv.status = 'revoked' then
    return jsonb_build_object('result', 'already_revoked');
  end if;
  if v_inv.status <> 'pending' then
    raise exception 'not_pending' using errcode = 'CP423';
  end if;
  update public.invitations
     set status = 'revoked', revoked_at = now(), revoked_by = v_uid, revoke_reason = 'cancelled',
         -- Una invitación cancelada no genera aviso: si había uno por enviar, sale de la cola.
         owner_notice_state = case when owner_notice_state = 'pending' then 'none' else owner_notice_state end
   where tenant_id = v_tenant and id = v_inv.id;
  perform app.write_audit(v_tenant, 'user', v_uid, 'invitation.revoked', 'invitation', v_inv.id, 'success',
    jsonb_build_object('role', v_inv.role, 'reason', 'cancelled'));
  return jsonb_build_object('result', 'revoked');
end $$;
revoke all on function public.revoke_invitation(uuid) from public, anon, authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;

-- 7. Cerrar el envío del correo (solo el servidor) ----------------------------------------------------
-- Igual que `internal_notice_settle`: enviado (con lo que informó el proveedor) o fallido (solo un código,
-- sin datos personales). La organización sale de la fila del correo, nunca de un argumento.
create function public.invitation_email_settle(
  p_email_id uuid, p_provider text, p_provider_message_id text, p_error_code text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_mail public.email_messages;
  v_rows integer;
begin
  if p_email_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into v_mail from public.email_messages
   where id = p_email_id and kind in ('invitation', 'invitation_notice') for update;
  if not found then
    raise exception 'email_not_found' using errcode = 'CP404';
  end if;
  if v_mail.status <> 'pending' then
    return jsonb_build_object('status', 'already_settled');
  end if;
  if p_error_code is not null then
    if p_error_code !~ '^[A-Za-z0-9_.:-]{1,60}$' then
      raise exception 'invalid_error_code' using errcode = 'CP422';
    end if;
    update public.email_messages set status = 'failed', error_code = p_error_code, status_at = now()
     where tenant_id = v_mail.tenant_id and id = v_mail.id;
    if v_mail.kind = 'invitation_notice' then
      -- Si ya se usaron todos los intentos, el aviso se da por agotado (la aplicación lo deja en el log).
      update public.invitations
         set owner_notice_state = 'exhausted'
       where tenant_id = v_mail.tenant_id and id = v_mail.invitation_id
         and owner_notice_state = 'pending' and owner_notice_attempts >= app.invitation_notice_max_attempts();
      get diagnostics v_rows = row_count;
      return jsonb_build_object('status', 'failed', 'exhausted', v_rows > 0);
    end if;
    return jsonb_build_object('status', 'failed');
  end if;
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,30}$' or p_provider = 'pending'
     or p_provider_message_id is null or char_length(p_provider_message_id) not between 1 and 200 then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  update public.email_messages
     set provider = p_provider, provider_message_id = p_provider_message_id,
         status = 'sent', status_at = now(), sent_at = now()
   where tenant_id = v_mail.tenant_id and id = v_mail.id;
  if v_mail.kind = 'invitation_notice' then
    -- «Enviado» solo quiere decir que el proveedor aceptó el correo: si después rebota, el estado sigue en `sent`.
    -- (También pasa de `exhausted` a `sent`: un último intento lento que igual salió.)
    update public.invitations set owner_notice_state = 'sent'
     where tenant_id = v_mail.tenant_id and id = v_mail.invitation_id
       and owner_notice_state in ('pending', 'exhausted');
  end if;
  return jsonb_build_object('status', 'sent');
end $$;
revoke all on function public.invitation_email_settle(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.invitation_email_settle(uuid, text, text, text) to service_role;

-- 7b. Aviso al Dueño (solo el servidor) -----------------------------------------------------------------
-- Cuando alguien que NO es el Dueño invita a un rol que puede manejar el equipo (hoy: Administrador), el Dueño
-- recibe un correo: quién invitó, con qué rol, cuándo y un enlace a «Tu equipo». NUNCA lleva el correo del
-- invitado. Se decide con la matriz y no con nombres de rol: «el rol puede manejar el equipo» y «el Dueño es
-- quien puede transferir la organización» (`tenant.transfer`).
--
-- Es ROBUSTO en la base: `create_invitation` anota el aviso como pendiente en la misma operación
-- (`owner_notice_state`). En producción, el envío y los reintentos de la tarea valen solo cuando se resuelva la
-- decisión #17 (cómo se programa la tarea de avisos); mientras tanto, solo corre el intento inmediato.
-- Cada intento se RESERVA antes de hacerse (`invitation_notices_pending`): reservar gasta un intento.
-- Lo envía la tarea `src/server/jobs/send-invitation-notices.ts`, que también REINTENTA los fallidos hasta
-- `app.invitation_notice_max_attempts()` veces, separados al menos `app.invitation_notice_retry_minutes()`
-- minutos. Cada intento es una fila de `email_messages` (`invitation_notice`); el índice único deja una sola
-- viva (pendiente o enviada). «Al menos una vez»: si el servidor se cae justo después de enviar y antes de
-- anotarlo, el intento se da por fallido y se reintenta, y el Dueño podría recibir el aviso dos veces.
-- El destinatario sale SIEMPRE de la organización de la invitación, nunca de un parámetro.

-- ¿Corresponde avisar al Dueño de una invitación con este rol, hecha por esta persona en esta organización?
create function app.invitation_notice_applies(p_role text, p_inviter uuid, p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.role_can(p_role, 'team.manage')
     and not exists (
       select 1 from public.members m
        where m.tenant_id = p_tenant and m.user_id = p_inviter and m.status = 'active'
          and app.role_can(m.role, 'tenant.transfer'))
$$;
revoke all on function app.invitation_notice_applies(text, uuid, uuid) from public, anon, authenticated;

-- ¿Se puede RESERVAR un intento ahora? Anotada como pendiente, la invitación no se canceló (sigue pendiente o ya
-- se aceptó: que un Administrador invitó a otro ya ocurrió, y aceptarla no cancela el aviso; tampoco importa que
-- haya vencido), quedan intentos, pasó el intervalo desde el último y no hay un intento vivo (pendiente o enviado).
create function app.invitation_notice_ready(p_invitation_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.invitations i
     where i.id = p_invitation_id and i.status in ('pending', 'accepted')
       and i.owner_notice_state = 'pending'
       and i.owner_notice_attempts < app.invitation_notice_max_attempts()
       and (i.owner_notice_last_attempt_at is null
            or i.owner_notice_last_attempt_at <= now() - make_interval(mins => app.invitation_notice_retry_minutes()))
       and not exists (
         select 1 from public.email_messages e
          where e.tenant_id = i.tenant_id and e.invitation_id = i.id and e.kind = 'invitation_notice'
            and e.status <> 'failed'))
$$;
revoke all on function app.invitation_notice_ready(uuid) from public, anon, authenticated;

-- ¿Hay un intento RESERVADO sin usar? Cada reserva (`owner_notice_attempts`) permite anotar exactamente un correo.
create function app.invitation_notice_reserved(p_invitation_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.invitations i
     where i.id = p_invitation_id and i.status in ('pending', 'accepted')
       and i.owner_notice_state = 'pending'
       -- Una reserva solo sirve si es reciente: una que nadie usó no queda como saldo para siempre.
       and i.owner_notice_last_attempt_at > now() - make_interval(mins => app.invitation_notice_stale_minutes())
       and i.owner_notice_attempts > (
         select count(*) from public.email_messages e
          where e.tenant_id = i.tenant_id and e.invitation_id = i.id and e.kind = 'invitation_notice')
       and not exists (
         select 1 from public.email_messages e
          where e.tenant_id = i.tenant_id and e.invitation_id = i.id and e.kind = 'invitation_notice'
            and e.status <> 'failed'))
$$;
revoke all on function app.invitation_notice_reserved(uuid) from public, anon, authenticated;

-- RESERVA los avisos que la tarea (o el intento inmediato, con `p_invitation_id`) va a atender. Reservar es
-- gastar un intento: se anota la hora y se cuenta ANTES de enviar, con `for update skip locked`, de modo que
-- dos tareas a la vez no toman el mismo aviso y un aviso que falla sin llegar a anotarse (no hay Dueño con
-- correo, el servidor se cae, algo se rompe) igual gasta sus intentos y termina agotándose; nunca se queda
-- tapando la cola. Antes, da por fallidos los intentos que nunca se cerraron (el servidor se cayó a medias) y
-- por agotados los avisos sin intentos (pasado el intervalo, para no pisar un último intento en curso).
-- `exhausted` cuenta los que acaban de agotarse (la aplicación los deja en el log).
create function public.invitation_notices_pending(p_limit integer default 20, p_invitation_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ids       jsonb;
  v_exhausted integer;
begin
  update public.email_messages
     set status = 'failed', error_code = 'abandoned', status_at = now()
   where kind = 'invitation_notice' and status = 'pending'
     and created_at < now() - make_interval(mins => app.invitation_notice_stale_minutes());
  update public.invitations i
     set owner_notice_state = 'exhausted'
   where i.owner_notice_state = 'pending' and i.status in ('pending', 'accepted')
     and i.owner_notice_attempts >= app.invitation_notice_max_attempts()
     and i.owner_notice_last_attempt_at <= now() - make_interval(mins => app.invitation_notice_retry_minutes())
     and not exists (select 1 from public.email_messages e
                      where e.tenant_id = i.tenant_id and e.invitation_id = i.id and e.kind = 'invitation_notice'
                        and e.status = 'pending');
  get diagnostics v_exhausted = row_count;
  with picked as (
    select i.id, i.created_at from public.invitations i
     where i.owner_notice_state = 'pending'
       and (p_invitation_id is null or i.id = p_invitation_id)
       and app.invitation_notice_ready(i.id)
     order by i.created_at
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
       for update skip locked
  ), reserved as (
    update public.invitations i
       set owner_notice_attempts = i.owner_notice_attempts + 1, owner_notice_last_attempt_at = now()
      from picked
     where i.id = picked.id
       -- Las condiciones se REPITEN aquí como columnas: `app.invitation_notice_ready` lee la foto del inicio de la
       -- consulta, y si otra reserva confirmó justo en medio, esta vuelve a mirar la fila ya actualizada y no la toma.
       and i.owner_notice_state = 'pending'
       and i.owner_notice_attempts < app.invitation_notice_max_attempts()
       and (i.owner_notice_last_attempt_at is null
            or i.owner_notice_last_attempt_at <= now() - make_interval(mins => app.invitation_notice_retry_minutes()))
    returning i.id, picked.created_at
  )
  select coalesce(jsonb_agg(r.id order by r.created_at), '[]'::jsonb) into v_ids from reserved r;
  return jsonb_build_object('invitation_ids', v_ids, 'exhausted', v_exhausted);
end $$;
revoke all on function public.invitation_notices_pending(integer, uuid) from public, anon, authenticated;
grant execute on function public.invitation_notices_pending(integer, uuid) to service_role;

-- A quién avisar y con qué datos (ya filtrados por la base), para un intento RESERVADO. Sin reserva, la lista de
-- destinatarios viene vacía. Si hay reserva pero la organización no tiene un Dueño activo con correo, el aviso
-- no tiene a quién llegar nunca: se da por agotado aquí mismo y se avisa con `exhausted = 'no_recipient'` para
-- que la aplicación lo deje en el log (sin datos personales).
create function public.invitation_notice_recipients(p_invitation_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i             public.invitations;
  v_tenant_name text;
  v_inviter     text;
  v_recipients  jsonb;
begin
  if p_invitation_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into i from public.invitations where id = p_invitation_id for update;
  if not found or not app.invitation_notice_reserved(i.id) then
    return jsonb_build_object('recipients', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('user_id', u.id, 'email', u.email::text) order by u.email), '[]'::jsonb)
    into v_recipients
    from public.members m join auth.users u on u.id = m.user_id
   where m.tenant_id = i.tenant_id and m.status = 'active' and app.role_can(m.role, 'tenant.transfer')
     and u.email is not null;
  if jsonb_array_length(v_recipients) = 0 then
    update public.invitations set owner_notice_state = 'exhausted' where tenant_id = i.tenant_id and id = i.id;
    return jsonb_build_object('recipients', '[]'::jsonb, 'exhausted', 'no_recipient');
  end if;
  select t.name into v_tenant_name from public.tenants t where t.tenant_id = i.tenant_id;
  select nullif(btrim(p.full_name), '') into v_inviter from public.profiles p where p.user_id = i.invited_by;
  return jsonb_build_object(
    'tenant_id', i.tenant_id, 'tenant_name', v_tenant_name, 'inviter_name', v_inviter,
    'role', i.role, 'invited_at', i.created_at, 'invitation_status', i.status, 'recipients', v_recipients);
end $$;
revoke all on function public.invitation_notice_recipients(uuid) from public, anon, authenticated;
grant execute on function public.invitation_notice_recipients(uuid) to service_role;

-- Anota el correo de un intento RESERVADO (antes de enviarlo): bloquea la invitación y comprueba que haya una
-- reserva sin usar. El destinatario tiene que ser el Dueño activo de la organización de ESA invitación. No gasta
-- un intento: ya se gastó al reservar.
create function public.invitation_notice_register(
  p_email_id uuid, p_invitation_id uuid, p_to_user_id uuid, p_to_email_enc text, p_to_email_hash text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.invitations;
begin
  if p_email_id is null or p_invitation_id is null or p_to_user_id is null
     or p_to_email_enc is null or char_length(p_to_email_enc) not between 1 and 2000
     or p_to_email_hash is null or p_to_email_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into i from public.invitations where id = p_invitation_id for update;
  if not found or not app.invitation_notice_reserved(i.id) then
    return jsonb_build_object('registered', false);
  end if;
  if not exists (select 1 from public.members m
                  where m.tenant_id = i.tenant_id and m.user_id = p_to_user_id and m.status = 'active'
                    and app.role_can(m.role, 'tenant.transfer')) then
    raise exception 'recipient_not_owner' using errcode = '42501';
  end if;
  begin
    insert into public.email_messages
      (id, tenant_id, invitation_id, kind, to_email_enc, to_email_hash, provider, status)
    values
      (p_email_id, i.tenant_id, i.id, 'invitation_notice', p_to_email_enc, p_to_email_hash, 'pending', 'pending');
  exception when unique_violation then
    return jsonb_build_object('registered', false);
  end;
  return jsonb_build_object('registered', true);
end $$;
revoke all on function public.invitation_notice_register(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.invitation_notice_register(uuid, uuid, uuid, text, text) to service_role;

-- 8. Limpieza por plazo -----------------------------------------------------------------------------------
-- Una vez al día, app.purge_invitations():
--   * borra las invitaciones pendientes vencidas hace más de 30 días y las canceladas hace más de 30 días,
--     junto con los correos que se enviaron por ellas;
--   * de las aceptadas (que se conservan como historia: quién invitó, con qué rol, cuándo y quién aceptó, sin
--     el correo) borra los registros de correo 30 días después de aceptarse.
-- Igual que las solicitudes del formulario: solo lo hace esta función, fijando app.retention_purge = 'on'
-- dentro de su transacción; la guarda de `email_messages` deja pasar únicamente lo vencido.
create function app.purge_invitations() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_previous text := current_setting('app.retention_purge', true);
  v_cutoff   timestamptz := now() - make_interval(days => app.invitation_retention_days());
  v_emails   integer;
  v_invites  integer;
begin
  perform set_config('app.retention_purge', 'on', true);

  delete from public.email_messages e
   using public.invitations i
   where e.tenant_id = i.tenant_id and e.invitation_id = i.id and e.kind in ('invitation', 'invitation_notice')
     and ((i.status = 'pending' and i.expires_at <= v_cutoff)
          or (i.status = 'revoked' and i.revoked_at <= v_cutoff)
          or (i.status = 'accepted' and i.accepted_at <= v_cutoff));
  get diagnostics v_emails = row_count;

  delete from public.invitations i
   where (i.status = 'pending' and i.expires_at <= v_cutoff)
      or (i.status = 'revoked' and i.revoked_at <= v_cutoff);
  get diagnostics v_invites = row_count;

  -- Se deja el interruptor como estaba (la transacción de quien llama puede seguir).
  perform set_config('app.retention_purge', coalesce(v_previous, ''), true);
  return jsonb_build_object('invitations_deleted', v_invites, 'emails_deleted', v_emails);
end $$;
revoke all on function app.purge_invitations() from public, anon, authenticated;

-- Programación diaria, a las 03:40. Si pg_cron no estuviera disponible, NO falla: deja la función y avisa.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('purge-invitations', '40 3 * * *', 'select app.purge_invitations()');
  else
    raise notice 'pg_cron no está disponible: llamar app.purge_invitations() cada día desde un trabajo del servidor';
  end if;
end $$;
