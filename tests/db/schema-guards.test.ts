// Prueba de estructura (docs/arquitectura/modelo-datos.md §8.2).
// Recorre el catálogo de la base de datos y falla si alguna tabla o función no cumple las reglas.
// Protege también lo que todavía no existe: cuando se cree `quotes`, esta prueba ya la vigila.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "./helpers";

// Listas permitidas: cada excepción debe estar justificada aquí.
const ANON_POLICY_TABLES = new Set(["legal_documents"]); // los términos vigentes se leen sin sesión
const ANON_EXECUTABLE_PUBLIC_FUNCTIONS = new Set<string>(); // ninguna RPC es pública
const REALTIME_ALLOWED_TABLES = new Set<string>(); // Realtime apagado para todas las tablas

// H-004a (ronda 1 y 2): toda política que la API expone y que nombra `auth.uid()` tiene que nombrar `app.second_step_pending()`
// (aunque también nombre la organización activa: una rama `auth.uid() OR tenant_id = ...` deja pasar). Las FUNCIONES expuestas
// que nombran `auth.uid()` SIN pasar por la organización activa (`app.current_tenant_id()` / `app.my_tenant_ids()`) también:
// si no, una sesión parcial (contraseña sin el código del segundo paso) las atravesaría. Menor 2 de la revisión de Aarón al
// PR #44: la regla mira también `auth.email()`, `auth.jwt()` (salvo `aal`) y `request.jwt.claim`, las ayudas de `app` (menos
// las de trigger) y exige una LLAMADA de verdad, no la palabra. Excepciones, cada una justificada. Hoy no hay ninguna.
const UNGATED_AUTH_UID_ALLOWED: Record<string, string> = {};

// Guardia 16 (menor 2 de la revisión de Aarón al PR #44): el texto de una política o de una función se analiza aquí, en
// TypeScript, para que la regla se lea y se pruebe sola (16c) y no dependa de escapes dentro de SQL.
//
// Un recorrido de izquierda a derecha saca los comentarios (`--` y `/* */`) y, si se pide, vacía los textos entre comillas;
// así un `--` dentro de un texto no se confunde con un comentario, ni un comentario con comillas rompe el recorrido.
const SQL_TOKENS = /'(?:[^']|'')*'|\/\*[\s\S]*?\*\/|--[^\n]*/g;
function sqlCode(sql: string, keepLiterals: boolean): string {
  return sql.replace(SQL_TOKENS, (token) =>
    token.startsWith("'") ? (keepLiterals ? token : "''") : " ",
  );
}

/**
 * ¿El texto identifica a la persona de la sesión? `auth.uid()`, `auth.email()`, CUALQUIER uso de `auth.jwt()` salvo leer
 * `aal` (así también `auth.jwt() ->> 'sub'`, `-> 'email'` o `#>> '{sub}'`) y los ajustes `request.jwt.claim(s)`.
 */
function identifiesSessionPerson(sql: string): boolean {
  const code = sqlCode(sql, true).replace(
    /auth\s*\.\s*jwt\s*\(\s*\)\s*->>\s*'aal'(::text)?/gi,
    " ",
  );
  return (
    /auth\s*\.\s*(uid|email|jwt)\s*\(/i.test(sqlCode(code, false)) ||
    /request\s*\.\s*jwt\s*\.\s*claim/i.test(code)
  );
}

/**
 * ¿El texto LLAMA a alguna de estas ayudas de `app`? Una llamada de verdad, con `app.` y paréntesis, en el código: no cuenta
 * la palabra en un comentario o en un texto entre comillas, ni un nombre parecido (`mi_current_tenant_id()`).
 */
function callsAppFunction(sql: string, names: string[]): boolean {
  return new RegExp(`(^|[^\\w.])app\\s*\\.\\s*(${names.join("|")})\\s*\\(\\s*\\)`, "i").test(
    sqlCode(sql, false),
  );
}

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

// Menor 4 del PR #35 (2026-11-09): cuánto espera una migración (o un deshacer) por un bloqueo antes de rendirse. Sin esto,
// una migración que espera se queda en la fila y frena tras ella toda la aplicación. 3 s POR CADA bloqueo que se pide (una migración que pide dos
// seguidos puede esperar casi el doble) es menos que la espera de 5 s de las pantallas y que el límite de 8 s de la API. Mismo valor en todos los archivos desde la fecha de abajo.
const MIGRATION_LOCK_TIMEOUT = "3s";
/** La regla vale para las migraciones y los deshacer con fecha desde esta (las anteriores ya están integradas y no se editan). */
const LOCK_TIMEOUT_FROM = "20261109120000";
/**
 * Menor 5 del PR #37 (2026-11-10): desde esta fecha, justo después del `set local lock_timeout`, el archivo trae un bloque
 * `do $$ ... if current_setting('lock_timeout') <> '3s' then raise exception ...; end if; end $$;` que lo detiene si quien
 * lo aplica no lo hizo dentro de una transacción (sin ella `set local` no tiene efecto). `20261109120000` ya está integrada
 * y no lo trae: no se edita.
 */
const LOCK_TIMEOUT_VERIFIED_FROM = "20261109130000";
const SUPABASE_DIR = path.resolve(import.meta.dirname, "..", "..", "supabase");

/**
 * Un trozo del SQL ya leído: `code` (sin comentarios), `string` (un texto entre comillas simples, con sus comillas) o
 * `body` (lo que hay entre `$tag$ ... $tag$`, que a su vez es código y se lee de nuevo).
 */
type Token =
  | { kind: "code"; text: string }
  | { kind: "string"; text: string }
  | { kind: "body"; tag: string; inner: Token[] };

/** La etiqueta de cuerpo que empieza en `at` (`$$`, `$fn$`, `$fn1$`), o null. `$1` no es una etiqueta. */
const dollarTagAt = (sql: string, at: number): string | null =>
  /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(at, at + 64))?.[0] ?? null;

/**
 * Lee el SQL de UNA sola pasada: quita los comentarios de línea (`--`) y los de bloque (que pueden anidarse), separa los textos
 * entre comillas simples y los cuerpos `$tag$ ... $tag$`, y vuelve a leer cada cuerpo con las mismas reglas (así un
 * apóstrofo suelto dentro de un comentario de un cuerpo no desempareja nada de lo demás).
 */
function lex(sql: string): Token[] {
  const tokens: Token[] = [];
  let code = "";
  const flush = () => {
    if (code !== "") tokens.push({ kind: "code", text: code });
    code = "";
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      code += " ";
    } else if (c === "'") {
      flush();
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      tokens.push({ kind: "string", text: sql.slice(i, j + 1) });
      i = j + 1;
    } else if (c === '"') {
      // Un identificador entre comillas dobles se deja como código (puede traer comillas simples adentro).
      const end = sql.indexOf('"', i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      code += sql.slice(i, stop);
      i = stop;
    } else if (c === "$" && dollarTagAt(sql, i) !== null) {
      const tag = dollarTagAt(sql, i)!;
      const close = sql.indexOf(tag, i + tag.length);
      const stop = close === -1 ? sql.length : close;
      flush();
      tokens.push({ kind: "body", tag, inner: lex(sql.slice(i + tag.length, stop)) });
      i = close === -1 ? sql.length : close + tag.length;
    } else {
      code += c;
      i++;
    }
  }
  flush();
  return tokens;
}

/** El SQL sin comentarios, con los textos y los cuerpos completos (cada cuerpo también sin comentarios). */
function renderFull(tokens: Token[]): string {
  return tokens
    .map((t) => (t.kind === "body" ? `${t.tag}${renderFull(t.inner)}${t.tag}` : t.text))
    .join("");
}

/**
 * Las sentencias de primer nivel, sin el `;` final: sin comentarios, con los textos entre comillas tal cual (un `;` dentro
 * de un texto no corta) y con cada cuerpo `$tag$ ... $tag$` vaciado (`$$`).
 */
function topLevelStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  for (const t of lex(sql)) {
    if (t.kind === "code") {
      const parts = t.text.split(";");
      current += parts[0];
      for (const part of parts.slice(1)) {
        statements.push(current);
        current = part;
      }
    } else current += t.kind === "string" ? t.text : "$$";
  }
  statements.push(current);
  return statements
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => statement !== "");
}

/** La primera sentencia de un archivo SQL, sin los comentarios de `--` ni las líneas vacías que la preceden. */
function firstStatement(sql: string): string {
  return topLevelStatements(sql)[0] ?? "";
}

/** ¿Empieza con `set local lock_timeout = '3s'`? (`set local`: vale hasta el fin de la transacción de la migración.) */
function startsWithLockTimeout(sql: string): boolean {
  return firstStatement(sql) === `set local lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`;
}

/** Cuántas veces aparece la palabra `lock_timeout` en el CÓDIGO de estos trozos (también dentro de los cuerpos). */
function mentionsIn(tokens: Token[]): number {
  let count = 0;
  for (const t of tokens) {
    if (t.kind === "code") count += (t.text.match(/\block_timeout\b/gi) ?? []).length;
    else if (t.kind === "body") count += mentionsIn(t.inner);
  }
  return count;
}

/**
 * Cuántas veces aparece `lock_timeout` como palabra fuera de comentarios y de textos entre comillas, incluso dentro de
 * un cuerpo `$$` (el archivo se lee de una pasada, así que un apóstrofo o un `--` dentro de un cuerpo no esconde nada).
 * Tiene que ser UNA: la primera sentencia. `current_setting('lock_timeout')` de la verificación va entre comillas y no
 * cuenta. `set_config('lock_timeout', ...)` también se rechaza, porque su nombre sí va entre comillas.
 */
function lockTimeoutMentions(sql: string): number {
  const tokens = lex(sql);
  if (/set_config\s*\(\s*'lock_timeout'/i.test(renderFull(tokens))) return Number.POSITIVE_INFINITY;
  return mentionsIn(tokens);
}

/**
 * Sentencias de primer nivel que cortan la transacción del archivo o devuelven el valor: `begin`, `commit`, `rollback`,
 * `end`, `start transaction`, `savepoint`, `release` y `reset` (también `reset role` y `reset all`). (Un `begin` dentro
 * de un cuerpo `$$` de plpgsql no cuenta.)
 */
function transactionControl(sql: string): string[] {
  return topLevelStatements(sql).filter((statement) =>
    /^(begin|commit|rollback|abort|end|start transaction|savepoint|release|reset)\b/i.test(
      statement,
    ),
  );
}

/**
 * ¿La SEGUNDA sentencia es el bloque `do $$ ... if current_setting('lock_timeout') <> '3s' then raise exception ...; end
 * if; end $$`? Se lee del texto sin comentarios.
 */
function hasLockTimeoutVerification(sql: string): boolean {
  const code = renderFull(lex(sql)).replace(/\s+/g, " ").trim();
  const afterFirst = code.slice(code.indexOf(";") + 1).trim();
  const block = /^do (\$([A-Za-z_][A-Za-z_0-9]*)?\$)([\s\S]*?)\1/i.exec(afterFirst);
  if (!block) return false;
  return new RegExp(
    `if current_setting\\('lock_timeout'\\) <> '${MIGRATION_LOCK_TIMEOUT}' then raise exception [\\s\\S]*?; end if;`,
    "i",
  ).test(block[3]);
}

function filesFrom(dir: "migrations" | "rollbacks"): string[] {
  return readdirSync(path.join(SUPABASE_DIR, dir))
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => name.slice(0, 14) >= LOCK_TIMEOUT_FROM)
    .sort();
}

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
  /**
   * Políticas y funciones que identifican a la persona de la sesión sin pasar por el segundo paso (menor 2 de la revisión de
   * Aarón al PR #44). Qué es «identificar» y qué es «llamar a la puerta», en `identifiesSessionPerson` y `callsAppFunction`.
   * - POLÍTICAS (de `public` y `storage`): solo vale `app.second_step_pending()`. Mencionar la organización activa no basta:
   *   una rama `user_id = auth.uid() OR tenant_id = current_tenant_id()` deja pasar a la persona con la contraseña sola por la
   *   primera.
   * - FUNCIONES de `public` que `authenticated` puede ejecutar, y TODAS las ayudas de `app` (las usan las políticas y las
   *   funciones públicas): también exime llamar a `app.current_tenant_id()` o `app.my_tenant_ids()` (la función falla sola
   *   sin ella). Quedan fuera las funciones de trigger (no se llaman a mano ni desde una política: corren después de que la
   *   política o la función ya dejó pasar) y `app.second_step_pending`, que es la puerta misma.
   */
  async function ungatedAuthUid(): Promise<string[]> {
    const policies = await db.query<{ id: string; text: string }>(
      `select 'policy ' || schemaname || '.' || tablename || '.' || policyname as id,
              coalesce(qual, '') || ' ' || coalesce(with_check, '') as text
         from pg_policies
        where schemaname in ('public', 'storage')`,
    );
    const functions = await db.query<{ id: string; text: string }>(
      `select 'function ' || n.nspname || '.' || p.proname as id, p.prosrc as text
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prokind = 'f'
          and p.prorettype <> 'pg_catalog.trigger'::regtype
          and ((n.nspname = 'app' and p.proname <> 'second_step_pending')
               or (n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')))`,
    );
    const ungatedPolicies = policies.rows.filter(
      (row) =>
        identifiesSessionPerson(row.text) && !callsAppFunction(row.text, ["second_step_pending"]),
    );
    const ungatedFunctions = functions.rows.filter(
      (row) =>
        identifiesSessionPerson(row.text) &&
        !callsAppFunction(row.text, ["second_step_pending", "current_tenant_id", "my_tenant_ids"]),
    );
    return [...ungatedPolicies, ...ungatedFunctions].map((row) => row.id).sort();
  }

  it("16. (H-004a) toda política, función expuesta o ayuda de app que identifica a la persona (auth.uid(), auth.email(), auth.jwt() fuera de `aal`, request.jwt.claim) sin pasar por la organización activa (en una política, siempre) llama también a app.second_step_pending(), o está en la lista justificada", async () => {
    const found = (await ungatedAuthUid()).filter((id) => !(id in UNGATED_AUTH_UID_ALLOWED));
    expect(found).toEqual([]);
    // Y la lista de excepciones no guarda entradas que ya no existen.
    const all = new Set(await ungatedAuthUid());
    for (const id of Object.keys(UNGATED_AUTH_UID_ALLOWED)) {
      expect(all.has(id), `${id} ya no existe: quítala de la lista`).toBe(true);
    }
  });

  it("16b. la guardia 16 MUERDE: una política y una función nuevas que solo miran auth.uid() se detectan; con el segundo paso o con la organización activa, no", async () => {
    await db.query("begin");
    try {
      await db.query("create table public.tmp_guard16 (user_id uuid)");
      await db.query("alter table public.tmp_guard16 enable row level security");
      await db.query(
        "create policy tmp_guard16_own on public.tmp_guard16 for select to authenticated using (user_id = (select auth.uid()))",
      );
      await db.query(
        `create function public.tmp_guard16_fn() returns uuid language sql stable security definer set search_path = '' as $$ select auth.uid() $$`,
      );
      await db.query("grant execute on function public.tmp_guard16_fn() to authenticated");
      expect(await ungatedAuthUid()).toEqual([
        "function public.tmp_guard16_fn",
        "policy public.tmp_guard16.tmp_guard16_own",
      ]);
      // Una política con la organización activa en otra rama (`or`) sigue marcada: la rama de `auth.uid()` deja pasar.
      await db.query(
        "alter policy tmp_guard16_own on public.tmp_guard16 using (user_id = (select auth.uid()) or user_id = (select app.current_tenant_id()))",
      );
      expect(await ungatedAuthUid()).toEqual([
        "function public.tmp_guard16_fn",
        "policy public.tmp_guard16.tmp_guard16_own",
      ]);
      // Con el segundo paso (y, en la función, con la organización activa) ya no se marcan.
      await db.query(
        "alter policy tmp_guard16_own on public.tmp_guard16 using ((user_id = (select auth.uid()) or user_id = (select app.current_tenant_id())) and not (select app.second_step_pending()))",
      );
      await db.query(
        `create or replace function public.tmp_guard16_fn() returns uuid language sql stable security definer set search_path = '' as $$ select auth.uid() where app.current_tenant_id() is not null $$`,
      );
      expect(await ungatedAuthUid()).toEqual([]);
    } finally {
      await db.query("rollback");
    }
  });

  it("16c. (menor 2 del PR #44) la guardia 16 también muerde con los otros modos de identificar a la persona, con las ayudas de `app`, y no se deja engañar por una palabra suelta", async () => {
    const policyOn = (name: string, using: string) =>
      db.query(
        `create policy ${name} on public.tmp_guard16 for select to authenticated using (${using})`,
      );
    const fn = (schema: string, name: string, body: string, returns = "text") =>
      db.query(
        `create function ${schema}.${name}() returns ${returns} language plpgsql stable security definer set search_path = '' as $$ begin ${body} end $$`,
      );
    await db.query("begin");
    try {
      await db.query("create table public.tmp_guard16 (user_id uuid, email text)");
      await db.query("alter table public.tmp_guard16 enable row level security");

      // (a) Otros modos de identificar a la persona: la política y la función se marcan igual que con auth.uid().
      await policyOn("tmp_g16_sub", "user_id::text = (select auth.jwt() ->> 'sub')");
      await policyOn("tmp_g16_email_fn", "email = (select auth.email())");
      await policyOn(
        "tmp_g16_email_jwt",
        "email = (select auth.jwt() -> 'user_metadata' ->> 'email')",
      );
      await policyOn("tmp_g16_claim", "email = current_setting('request.jwt.claim.email', true)");
      await fn("public", "tmp_g16_f_sub", "return auth.jwt() ->> 'sub'; ");
      await fn("public", "tmp_g16_f_email", "return auth.email(); ");
      await fn(
        "public",
        "tmp_g16_f_claims",
        "return current_setting('request.jwt.claims', true); ",
      );
      await fn("public", "tmp_g16_f_path", "return auth.jwt() #>> '{sub}'; ");
      for (const name of ["sub", "email", "claims", "path"]) {
        await db.query(`grant execute on function public.tmp_g16_f_${name}() to authenticated`);
      }
      const bites = [
        "function public.tmp_g16_f_claims",
        "function public.tmp_g16_f_email",
        "function public.tmp_g16_f_path",
        "function public.tmp_g16_f_sub",
        "policy public.tmp_guard16.tmp_g16_claim",
        "policy public.tmp_guard16.tmp_g16_email_fn",
        "policy public.tmp_guard16.tmp_g16_email_jwt",
        "policy public.tmp_guard16.tmp_g16_sub",
      ];
      expect(await ungatedAuthUid()).toEqual(bites);

      // Leer solo `aal` no identifica a nadie (es lo que hace la puerta): no se marca.
      await fn("public", "tmp_g16_f_aal", "return auth.jwt() ->> 'aal'; ");
      await db.query("grant execute on function public.tmp_g16_f_aal() to authenticated");
      expect(await ungatedAuthUid()).toEqual(bites);

      // (b) Las ayudas de `app` (las usan las políticas): una nueva que mira a la persona sin puerta se marca; una de
      // trigger no (no se llama a mano); con la puerta o con la organización activa, tampoco.
      await fn("app", "tmp_g16_helper", "return auth.uid()::text; ");
      await fn("app", "tmp_g16_trigger", "new.user_id := auth.uid(); return new; ", "trigger");
      await fn(
        "app",
        "tmp_g16_gated",
        "if not app.second_step_pending() then return auth.uid()::text; end if; return null; ",
      );
      await fn(
        "app",
        "tmp_g16_tenant",
        "if app.current_tenant_id() is not null then return auth.uid()::text; end if; return null; ",
      );
      expect(await ungatedAuthUid()).toEqual([...bites, "function app.tmp_g16_helper"].sort());
    } finally {
      await db.query("rollback");
    }
  });

  it("16d. (menor 2 del PR #44) la puerta cuenta si se LLAMA a la ayuda, no si aparece la palabra: un comentario, un texto entre comillas o un nombre parecido no eximen", async () => {
    const gated = (extra: string) =>
      db.query(
        `create function public.tmp_g16d() returns text language plpgsql stable security definer set search_path = '' as $$ begin ${extra} return auth.uid()::text; end $$`,
      );
    await db.query("begin");
    try {
      const cases: Array<[string, string]> = [
        ["comentario de línea", "-- app.current_tenant_id() lo comprueba otro\n"],
        ["comentario de bloque", "/* app.second_step_pending() */"],
        ["texto entre comillas", "raise notice 'app.current_tenant_id()';"],
        ["nombre parecido sin app.", "perform my_current_tenant_id();"],
        ["nombre parecido con app.", "perform app.current_tenant_id_old();"],
        ["la palabra sin llamar", "perform 1 as current_tenant_id;"],
      ];
      for (const [label, extra] of cases) {
        await db.query("drop function if exists public.tmp_g16d()");
        await gated(extra);
        await db.query("grant execute on function public.tmp_g16d() to authenticated");
        expect(await ungatedAuthUid(), label).toEqual(["function public.tmp_g16d"]);
      }
      // Una llamada de verdad, en cambio, sí exime.
      await db.query("drop function if exists public.tmp_g16d()");
      await gated("perform app.current_tenant_id();");
      await db.query("grant execute on function public.tmp_g16d() to authenticated");
      expect(await ungatedAuthUid()).toEqual([]);
    } finally {
      await db.query("rollback");
    }
  });

  it("16e. (menor 2 del PR #44) el análisis de texto de la guardia 16: lo que identifica a la persona y lo que cuenta como llamar a la puerta", () => {
    for (const text of [
      "user_id = (select auth.uid())",
      "(user_id)::text = (auth.jwt() ->> 'sub'::text)",
      "email = auth.email()",
      "auth.jwt() #>> '{sub}'",
      "auth.jwt() -> 'user_metadata'",
      "current_setting('request.jwt.claim.sub', true)",
      "select auth . uid ( )",
      "select 'x--y', auth.uid()",
    ]) {
      expect(identifiesSessionPerson(text), text).toBe(true);
    }
    for (const text of [
      "(auth.jwt() ->> 'aal'::text) <> 'aal2'",
      "coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2'",
      "-- auth.uid() aquí no\nselect 1",
      "/* auth.email() */ select 1",
      "raise notice 'auth.uid()'",
      "select 1",
    ]) {
      expect(identifiesSessionPerson(text), text).toBe(false);
    }
    const names = ["second_step_pending", "current_tenant_id"];
    for (const text of [
      "( SELECT app.second_step_pending() AS second_step_pending)",
      "where app.current_tenant_id() is not null",
      "perform app.current_tenant_id ( )",
      "select 'x--y', app.current_tenant_id()",
    ]) {
      expect(callsAppFunction(text, names), text).toBe(true);
    }
    for (const text of [
      "-- app.current_tenant_id()\nselect 1",
      "/* app.second_step_pending() */",
      "raise notice 'app.current_tenant_id()'",
      "my_app.current_tenant_id()",
      "xapp.current_tenant_id()",
      "app.current_tenant_id_old()",
      "current_tenant_id()",
      "app.current_tenant_id",
    ]) {
      expect(callsAppFunction(text, names), text).toBe(false);
    }
  });

  // Esta guardia es ESTÁTICA: lee los archivos y comprueba que el texto traiga `set local lock_timeout = '3s'` y, desde
  // 20261109130000, el bloque que lo verifica. NO mide que el valor quede puesto al aplicar: eso lo hace el propio bloque
  // `do $$ ... current_setting('lock_timeout') ...` cuando la migración corre de verdad (y las pruebas MC6 de cada archivo, con
  // dos conexiones). Menor 6 del PR #38.
  it("15. (estática: lee los archivos, no los aplica) menores 4 del PR #35 y 5 y 6 del PR #37: el texto de toda migración y todo deshacer con fecha desde 20261109120000 empieza con `set local lock_timeout = '3s'`, lo menciona una sola vez y no trae begin/commit/reset; desde 20261109130000, además, trae el bloque que lo verifica al aplicarse", () => {
    const covered: string[] = [];
    for (const dir of ["migrations", "rollbacks"] as const) {
      for (const name of filesFrom(dir)) {
        covered.push(`${dir}/${name}`);
        const sql = readFileSync(path.join(SUPABASE_DIR, dir, name), "utf8");
        expect(
          startsWithLockTimeout(sql),
          `${dir}/${name} debe empezar con set local lock_timeout = '${MIGRATION_LOCK_TIMEOUT}' (antes solo van comentarios)`,
        ).toBe(true);
        expect(
          lockTimeoutMentions(sql),
          `${dir}/${name} debe mencionar lock_timeout una sola vez (fuera de comentarios y de textos entre comillas)`,
        ).toBe(1);
        expect(
          transactionControl(sql),
          `${dir}/${name} no puede traer begin, commit, rollback, end, savepoint ni reset (tampoco «reset role» ni «reset all») a nivel de archivo: la CLI aplica cada archivo en su transacción`,
        ).toEqual([]);
        if (name.slice(0, 14) >= LOCK_TIMEOUT_VERIFIED_FROM) {
          expect(
            hasLockTimeoutVerification(sql),
            `${dir}/${name} debe traer, justo después, do $$ if current_setting('lock_timeout') <> '${MIGRATION_LOCK_TIMEOUT}' then raise exception ...; end if; end $$;`,
          ).toBe(true);
        }
      }
    }
    // La guardia no es vacía: cubre al menos la migración que la introdujo y su deshacer, y la primera que verifica.
    expect(covered).toEqual(
      expect.arrayContaining([
        "migrations/20261109120000_member_invitation_creator.sql",
        "rollbacks/20261109120000_member_invitation_creator.down.sql",
        `migrations/${LOCK_TIMEOUT_VERIFIED_FROM}_invitation_audit_active_only.sql`,
        `rollbacks/${LOCK_TIMEOUT_VERIFIED_FROM}_invitation_audit_active_only.down.sql`,
      ]),
    );
    // Cada migración con fecha desde entonces tiene su deshacer (así la regla vale también para él).
    const ups = covered.filter((f) => f.startsWith("migrations/")).map((f) => f.slice(11, -4));
    const downs = covered.filter((f) => f.startsWith("rollbacks/")).map((f) => f.slice(10, -9));
    expect(downs).toEqual(ups);
  });

  it("15b. la guardia 15 detecta lo que debe: sin `lock_timeout`, con otro valor, fuera de lugar, sin `local`, en un comentario, repetido, con begin/commit/reset o sin verificación", () => {
    const verification = `do $$ begin\n  if current_setting('lock_timeout') <> '3s' then\n    raise exception 'lock_timeout vale %', current_setting('lock_timeout');\n  end if;\nend $$;\n`;
    const good = `-- Encabezado\n-- más encabezado\n\nset local lock_timeout = '3s';\n${verification}alter table public.x add column y int;\n`;
    // Primera sentencia
    expect(startsWithLockTimeout(good)).toBe(true);
    expect(startsWithLockTimeout("set  local  lock_timeout = '3s' ;")).toBe(true);
    expect(startsWithLockTimeout("alter table public.x add column y int;\n")).toBe(false);
    expect(
      startsWithLockTimeout(
        "-- set local lock_timeout = '3s';\nalter table public.x add column y int;",
      ),
    ).toBe(false);
    expect(startsWithLockTimeout("set local lock_timeout = '10s';\nselect 1;")).toBe(false);
    expect(startsWithLockTimeout("set lock_timeout = '3s';\nselect 1;")).toBe(false);
    expect(startsWithLockTimeout("select 1;\nset local lock_timeout = '3s';")).toBe(false);
    expect(startsWithLockTimeout("")).toBe(false);
    // Una sola mención: la verificación (entre comillas) y los comentarios no cuentan; una segunda orden sí.
    expect(lockTimeoutMentions(good)).toBe(1);
    expect(lockTimeoutMentions(`${good}-- set local lock_timeout = '1s';\n`)).toBe(1);
    expect(lockTimeoutMentions(`${good}set local lock_timeout = '1s';\n`)).toBe(2);
    expect(lockTimeoutMentions(`${good}set lock_timeout = 0;\n`)).toBe(2);
    expect(lockTimeoutMentions(`${good}select set_config('lock_timeout', '0', true);\n`)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(lockTimeoutMentions(`${good}alter role authenticator set lock_timeout = 0;\n`)).toBe(2);
    expect(lockTimeoutMentions("select 1;")).toBe(0);
    // begin / commit / reset a nivel de archivo, sí; el `begin` de plpgsql dentro de `$$`, no.
    expect(transactionControl(good)).toEqual([]);
    expect(
      transactionControl(
        `${good}create function app.f() returns void language plpgsql as $$ begin null; end $$;\n`,
      ),
    ).toEqual([]);
    expect(transactionControl(`-- begin;\n${good}`)).toEqual([]);
    expect(transactionControl(`begin;\n${good}`)).toEqual(["begin"]);
    expect(transactionControl(`${good}commit;\n`)).toEqual(["commit"]);
    expect(transactionControl(`${good}COMMIT;\n`)).toEqual(["COMMIT"]);
    expect(transactionControl(`${good}end;\n`)).toEqual(["end"]);
    expect(transactionControl(`${good}rollback;\n`)).toEqual(["rollback"]);
    expect(transactionControl(`${good}start transaction;\n`)).toEqual(["start transaction"]);
    expect(transactionControl(`${good}savepoint a;\n`)).toEqual(["savepoint a"]);
    expect(transactionControl(`${good}reset lock_timeout;\n`)).toEqual(["reset lock_timeout"]);
    expect(transactionControl(`${good}reset all;\n`)).toEqual(["reset all"]);
    // Lectura de una pasada: un apóstrofo suelto en un comentario DENTRO de un cuerpo `$$` no esconde una segunda mención.
    const apostrophe = `${good}create function app.f() returns void language plpgsql as $$\nbegin\n  -- no rompas esto: d'accord\n  null;\nend $$;\nset lock_timeout = '0';\n`;
    expect(lockTimeoutMentions(apostrophe)).toBe(2);
    expect(
      lockTimeoutMentions(
        `${good}create function app.f() returns void language plpgsql as $$\nbegin\n  -- it's here\n  set local lock_timeout = '0';\nend $$;\n`,
      ),
    ).toBe(2);
    // Un \`--\` dentro de un texto no es un comentario; un comentario de bloque tampoco esconde nada a su alrededor.
    expect(lockTimeoutMentions(`${good}select '-- x'; set lock_timeout = '0';\n`)).toBe(2);
    expect(
      lockTimeoutMentions(`${good}/* it's a comment, set lock_timeout = '0'; */ select 1;\n`),
    ).toBe(1);
    // Etiquetas de cuerpo con dígitos y con nombre (\`$fn1$\`): el \`begin\` de adentro no cuenta, el \`commit;\` de afuera sí.
    const tagged = `${good}create function app.g() returns void language plpgsql as $fn1$ begin null; end $fn1$;\n`;
    expect(transactionControl(tagged)).toEqual([]);
    expect(transactionControl(`${tagged}commit;\n`)).toEqual(["commit"]);
    expect(transactionControl(`${good}reset role;\n`)).toEqual(["reset role"]);
    expect(
      lockTimeoutMentions(
        `${good}create function app.g() returns void language plpgsql as $fn1$ begin set local lock_timeout = '0'; end $fn1$;\n`,
      ),
    ).toBe(2);
    // Un parámetro \`$1\` no es una etiqueta.
    expect(topLevelStatements("select $1; select 2;")).toEqual(["select $1", "select 2"]);
    // Verificación: la segunda sentencia tiene que ser el bloque que compara con '3s' y lanza la excepción.
    expect(hasLockTimeoutVerification(good)).toBe(true);
    expect(hasLockTimeoutVerification("set local lock_timeout = '3s';\nselect 1;")).toBe(false);
    expect(
      hasLockTimeoutVerification(`set local lock_timeout = '3s';\nselect 1;\n${verification}`),
    ).toBe(false);
    expect(hasLockTimeoutVerification(good.replace("<> '3s'", "<> '5s'"))).toBe(false);
    expect(hasLockTimeoutVerification(good.replace("raise exception", "raise notice"))).toBe(false);
    expect(
      hasLockTimeoutVerification(
        `set local lock_timeout = '3s';\n${verification.replace(/^/gm, "-- ")}select 1;\n`,
      ),
    ).toBe(false);
  });
});
