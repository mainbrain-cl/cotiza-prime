-- Política de privacidad sin Sentry (decisión 023, §3: Sentry no va en el MVP; se quita su mención de la política).
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261127100000_privacy_without_sentry.down.sql
-- Publica la versión `2026-11-27-preliminar` de la privacidad (texto en src/content/legal/privacy.md; versión y huella SHA-256
-- salen de src/lib/legal/documents.ts, y tests/db/legal-seed.test.ts compara las dos). Los términos no cambian.
-- Quien aceptó la versión anterior la conserva en `legal_acceptances` y, al volver a entrar, pasa por «Acepta la nueva versión»
-- (`/aceptar-terminos`): es el mismo camino de siempre al cambiar de versión.
-- Bloqueos: solo filas de `legal_documents` (tabla chica).
--
-- Guardia 15 (tests/db/schema-guards.test.ts): primera sentencia `set local lock_timeout = '3s'` y, justo después, la verificación de
-- que el valor quedó puesto.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'la migracion 20261127100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

-- Primero se apaga la vigente (el índice `legal_one_current` admite una sola vigente por tipo).
update public.legal_documents set is_current = false where kind = 'privacy' and is_current;

-- La condición sobre la organización «plataforma» solo es falsa en la base que vacía `npm run test:db:rollbacks` (trunca todo
-- `public`, incluida esa organización, antes de deshacer y reaplicar la última migración). En cualquier base real existe desde
-- 20261001120200 (si no, la siembra 20261001130000 ya habría fallado), y tests/db/legal-seed.test.ts comprueba que la fila quedó.
insert into public.legal_documents (kind, version, content_sha256, published_at, is_current)
select 'privacy', '2026-11-27-preliminar', 'c27a13fb907d7860b498c4b5c438759e6640286a972c959709c3ab744e27d920', '2026-11-27 00:00:00-03', true
 where exists (select 1 from public.tenants t where t.tenant_id = app.platform_tenant_id());
