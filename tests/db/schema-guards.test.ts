// Prueba de estructura (docs/arquitectura/modelo-datos.md §8.2).
// Recorre el catálogo de la base de datos y falla si alguna tabla o función no cumple las reglas.
// Protege también lo que todavía no existe: cuando se cree `quotes`, esta prueba ya la vigila.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "./helpers";

// Listas permitidas: cada excepción debe estar justificada aquí.
const ANON_POLICY_TABLES = new Set(["legal_documents"]); // los términos vigentes se leen sin sesión
const ANON_EXECUTABLE_PUBLIC_FUNCTIONS = new Set<string>(); // ninguna RPC es pública
const REALTIME_ALLOWED_TABLES = new Set<string>(); // Realtime apagado para todas las tablas

// H-011a: las funciones que TODAVÍA llaman a `app.has_role(...)` con su lista de roles escrita a mano
// (heredan el rol efectivo, así que funcionan, pero la matriz vive en `app.role_can`). La lista está
// congelada: SOLO PUEDE ACHICARSE. Una función nueva decide con `app.can('acción')`; si una de estas pasa a
// `app.can(...)`, se quita de aquí (la prueba falla mientras siga la entrada vieja, para que no quede
// basura). Las que quedan se convierten cuando se toque cada una (docs/arquitectura/sprint-5-*.md §3).
const FROZEN_HAS_ROLE_FUNCTIONS = [
  "public.anonymize_intake_request",
  "public.assign_intake_request",
  "public.attach_quote_package_document",
  "public.confirm_email_dispatch",
  "public.convert_intake_request",
  "public.create_intake_form",
  "public.create_quote",
  "public.discard_intake_request",
  "public.fail_email_dispatch",
  "public.prepare_quote_resend",
  "public.prepare_quote_send",
  "public.regenerate_intake_form_public_id",
  "public.restore_intake_request",
  "public.revoke_quote_links",
  "public.save_intake_form",
  "public.save_quote_draft",
  "public.save_tenant_brand",
  "public.set_intake_form_status",
  "public.set_numbering",
];

// H-011a: lo MISMO pero para las otras formas de decidir por rol sin pasar por `app.can(...)`:
// `app.current_member_role()`, comparar `app.effective_role()` y escribir un rol entre comillas
// ('owner', 'admin', 'approver', 'sales', 'viewer'). Las llamadas a `has_role(...)` ya las vigila la lista
// de arriba y aquí se ignoran. Lista congelada PROPIA: solo puede achicarse. Cada una se queda por esto:
const FROZEN_ROLE_LITERAL_FUNCTIONS = [
  // Aviso de correo a quienes gestionan solicitudes: el rol es el DESTINO del correo, no un permiso.
  "app.intake_managers",
  // Valida que la persona a quien se asigna la solicitud sea Dueño, Administrador o Comercial activo:
  // son los roles destino de una asignación (quién puede recibirla), no quién puede asignar.
  "public.assign_intake_request",
  // Crea la organización y deja a quien la crea como Dueño (`role = 'owner'`): es un dato que se
  // escribe, no un permiso que se revisa, y además cuenta cuántas organizaciones tiene como Dueño.
  "public.create_tenant",
  // Aviso de cotización vista o respondida: el rol elige los destinatarios (Dueño y Administradores
  // cuando el autor ya no puede recibirlo), no autoriza ninguna acción.
  "public.share_notice_recipients",
];

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

async function publicTables(): Promise<string[]> {
  const { rows } = await db.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`,
  );
  return rows.map((r) => r.relname);
}

describe("controles de estructura de la base de datos (§8.2)", () => {
  it("hay tablas que revisar", async () => {
    const tables = await publicTables();
    expect(tables).toEqual(
      expect.arrayContaining([
        "tenants",
        "profiles",
        "members",
        "audit_log",
        "legal_documents",
        "legal_acceptances",
        "numbering_settings",
        "numbering_sequences",
        "catalog_items",
        "customers",
        "auth_rate_limits",
        "quote_packages",
        "share_links",
        "share_link_views",
        "email_messages",
        "quote_responses",
        "intake_forms",
        "intake_form_items",
        "intake_requests",
        "intake_daily_counters",
      ]),
    );
  });

  it("1. toda tabla de public tiene tenant_id uuid not null", async () => {
    const { rows } = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
         and not exists (
           select 1 from pg_attribute a
           where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
             and a.attnotnull and a.atttypid = 'uuid'::regtype)`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("2. toda tabla tiene la RLS activa y al menos una política", async () => {
    const { rows } = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
         and (not c.relrowsecurity
              or not exists (select 1 from pg_policy p where p.polrelid = c.oid))`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("3. ninguna política apunta a anon (ni a PUBLIC) fuera de la lista permitida", async () => {
    const { rows } = await db.query<{ relname: string; polname: string }>(
      `select c.relname, p.polname
       from pg_policy p join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and (p.polroles = '{0}'::oid[]
              or exists (select 1 from pg_roles r where r.oid = any (p.polroles) and r.rolname = 'anon'))`,
    );
    const offenders = rows.filter((r) => !ANON_POLICY_TABLES.has(r.relname));
    expect(offenders).toEqual([]);
  });

  it("4. nadie tiene TRUNCATE y anon no tiene permisos sobre tablas de negocio", async () => {
    const tables = await publicTables();
    const problems: string[] = [];
    for (const t of tables) {
      const { rows } = await db.query<Record<string, boolean>>(
        `select
           has_table_privilege('anon', format('public.%I', $1::text), 'TRUNCATE')          as anon_truncate,
           has_table_privilege('authenticated', format('public.%I', $1::text), 'TRUNCATE') as auth_truncate,
           (has_table_privilege('anon', format('public.%I', $1::text), 'SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER')
            or exists (select 1 from pg_attribute a
                       where a.attrelid = format('public.%I', $1::text)::regclass and a.attnum > 0
                         and has_column_privilege('anon', a.attrelid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES'))
           ) as anon_any`,
        [t],
      );
      const r = rows[0];
      if (r.anon_truncate || r.auth_truncate) problems.push(`${t}: TRUNCATE`);
      if (r.anon_any && !ANON_POLICY_TABLES.has(t)) problems.push(`${t}: permisos para anon`);
      if (ANON_POLICY_TABLES.has(t)) {
        const { rows: w } = await db.query<{ w: boolean }>(
          `select has_table_privilege('anon', format('public.%I', $1::text), 'INSERT, UPDATE, DELETE') as w`,
          [t],
        );
        if (w[0].w) problems.push(`${t}: anon puede escribir`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("5. toda función SECURITY DEFINER tiene search_path fijo", async () => {
    const { rows } = await db.query<{ name: string }>(
      `select n.nspname || '.' || p.proname as name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'app') and p.prosecdef
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
    );
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("6. ninguna función de public ni de app es ejecutable por anon, salvo la lista permitida", async () => {
    const { rows } = await db.query<{ name: string }>(
      `select n.nspname || '.' || p.proname as name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'app') and p.prokind = 'f'
         and has_function_privilege('anon', p.oid, 'EXECUTE')`,
    );
    const offenders = rows
      .map((r) => r.name)
      .filter((n) => !ANON_EXECUTABLE_PUBLIC_FUNCTIONS.has(n));
    expect(offenders).toEqual([]);
  });

  it("7. toda vista de public tiene security_invoker = true", async () => {
    const { rows } = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('v', 'm')
         and not ('security_invoker=true' = any (coalesce(c.reloptions, '{}'))
                  or 'security_invoker=on' = any (coalesce(c.reloptions, '{}')))`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("8. ninguna tabla está en la publicación de Realtime sin estar permitida", async () => {
    const { rows } = await db.query<{ tablename: string }>(
      `select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'`,
    );
    expect(rows.map((r) => r.tablename).filter((t) => !REALTIME_ALLOWED_TABLES.has(t))).toEqual([]);
  });

  it("9. toda tabla con tenant_id tiene el trigger app.forbid_tenant_change", async () => {
    const { rows } = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
         and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
         and not exists (
           select 1 from pg_trigger t
           where t.tgrelid = c.oid and not t.tgisinternal
             and t.tgfoid = 'app.forbid_tenant_change'::regproc
             and (t.tgtype & 16) = 16)   -- dispara en UPDATE`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("10. toda relación hacia una tabla con tenant_id incluye el tenant_id (relación compuesta)", async () => {
    const { rows } = await db.query<{ fk: string }>(
      `select c.conrelid::regclass || '.' || c.conname as fk
       from pg_constraint c
       join pg_class child  on child.oid  = c.conrelid
       join pg_class parent on parent.oid = c.confrelid
       join pg_namespace cn on cn.oid = child.relnamespace
       join pg_namespace pn on pn.oid = parent.relnamespace
       where c.contype = 'f' and cn.nspname = 'public' and pn.nspname = 'public'
         and exists (select 1 from pg_attribute a where a.attrelid = parent.oid and a.attname = 'tenant_id' and not a.attisdropped)
         and not exists (
           select 1
           from unnest(c.conkey, c.confkey) as k(child_col, parent_col)
           join pg_attribute ca on ca.attrelid = c.conrelid  and ca.attnum = k.child_col
           join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = k.parent_col
           where ca.attname = 'tenant_id' and pa.attname = 'tenant_id')`,
    );
    expect(rows.map((r) => r.fk)).toEqual([]);
  });

  it("11. GraphQL no existe: pg_graphql no está instalada y graphql_public no se expone (H-012)", async () => {
    const { rows } = await db.query<{ extname: string }>(
      `select extname from pg_extension where extname = 'pg_graphql'`,
    );
    expect(rows.map((r) => r.extname)).toEqual([]);
    const config = readFileSync(
      path.resolve(import.meta.dirname, "..", "..", "supabase", "config.toml"),
      "utf8",
    );
    const schemas = config.match(/^schemas\s*=\s*\[([^\]]*)\]/m);
    expect(schemas, "falta `schemas` en [api] de supabase/config.toml").not.toBeNull();
    expect(schemas?.[1]).not.toContain("graphql_public");
  });

  it("12. H-011a: las funciones que usan has_role(...) directo son solo las congeladas, y la lista solo se achica", async () => {
    const { rows } = await db.query<{ name: string }>(
      `select n.nspname || '.' || p.proname as name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'app') and p.prokind = 'f'
         and p.proname <> 'has_role'
         and p.prosrc ~ 'has_role[[:space:]]*\\('
       order by 1`,
    );
    expect(rows.map((r) => r.name)).toEqual([...FROZEN_HAS_ROLE_FUNCTIONS].sort());
  });

  it("13. H-011a: ninguna política de la base escribe una lista de roles a mano: todas usan app.can(...)", async () => {
    const { rows } = await db.query<{ name: string }>(
      `select schemaname || '.' || tablename || '.' || policyname as name
       from pg_policies
       where coalesce(qual, '') || coalesce(with_check, '')
             ~ 'has_role|current_member_role|''(owner|admin|approver|sales|viewer)'''
       order by 1`,
    );
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("14. H-011a: las funciones que deciden por rol sin app.can(...) (current_member_role, effective_role o un rol entre comillas) son solo las congeladas", async () => {
    const { rows } = await db.query<{ name: string }>(
      `select n.nspname || '.' || p.proname as name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'app') and p.prokind = 'f'
         and p.proname not in ('has_role', 'role_can', 'can', 'effective_role', 'current_member_role')
         and regexp_replace(p.prosrc, 'has_role[[:space:]]*\\([^)]*\\)', '', 'g')
             ~ 'current_member_role[[:space:]]*\\(|effective_role[[:space:]]*\\([[:space:]]*\\)[[:space:]]*(=|<>|!=|in[[:space:]]|not[[:space:]]+in)|''(owner|admin|approver|sales|viewer)'''
       order by 1`,
    );
    expect(rows.map((r) => r.name)).toEqual([...FROZEN_ROLE_LITERAL_FUNCTIONS].sort());
  });
});
