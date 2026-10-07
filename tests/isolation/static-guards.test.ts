// H-012 · Guardias estáticas: leen el código, sin red. Complementan (no repiten)
// `src/lib/tenant/guard-coverage.test.ts`, que ya exige `requireActiveTenant` en toda pantalla y
// acción de servidor. Aquí se vigilan los otros caminos por los que se puede romper el aislamiento.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ROUTES } from "./registry";
import { discoverAppRoutes, routeKey } from "./routes";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.join(ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
const isTest = (file: string) => /\.test\.(ts|tsx)$/.test(file);
const sourceFiles = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f) && !isTest(f));
const read = (file: string) => readFileSync(file, "utf8");
const sorted = (values: Iterable<string>) => [...values].sort();

/** Quita comentarios, para no confundir una explicación con código. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Cada llamada `serverLog( … )` completa (con paréntesis anidados y sin contar los de dentro de textos). */
function serverLogCalls(text: string): string[] {
  const calls: string[] = [];
  const start = /serverLog\(/g;
  for (let match = start.exec(text); match; match = start.exec(text)) {
    let depth = 0;
    let quote: string | null = null;
    let index = match.index + "serverLog".length;
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(text.slice(match.index, index + 1));
  }
  return calls;
}

describe("guardias estáticas del aislamiento", () => {
  it("1. el nombre de la cabecera de la organización solo está en constants.ts", () => {
    const offenders = sourceFiles
      .filter((f) => rel(f) !== "src/lib/tenant/constants.ts")
      .filter((f) => /x-cp-tenant-id/i.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("2. el cliente con la llave maestra solo se importa donde se permite", () => {
    const allowedPrefixes = [
      "src/lib/audit/",
      "src/lib/security/",
      "src/lib/brand/logo-storage.ts",
      "src/lib/quotes/send/document-storage.ts",
      "src/lib/share/gateway.ts",
      "src/lib/intake/gateway.ts",
      "src/lib/email/delivery-events-service.ts",
      "src/server/jobs/",
    ];
    const offenders = sourceFiles
      .filter((f) => /admin-client/.test(stripComments(read(f))))
      .map(rel)
      .filter((f) => f !== "src/lib/supabase/admin-client.ts")
      .filter((f) => !allowedPrefixes.some((p) => f.startsWith(p)));
    expect(offenders).toEqual([]);
  });

  it("2b. la llave maestra solo se nombra en admin-client.ts", () => {
    const offenders = sourceFiles
      .filter((f) => /SERVICE_ROLE|SUPABASE_SECRET_KEY/.test(stripComments(read(f))))
      .map(rel)
      .filter((f) => f !== "src/lib/supabase/admin-client.ts");
    expect(offenders).toEqual([]);
  });

  it("3. toda ruta de servidor (route.*) que no se declara sin organización resuelve requireActiveTenant", () => {
    const discovered = discoverAppRoutes(path.join(SRC, "app")).filter((r) => r.kind !== "page");
    expect(discovered.length).toBeGreaterThan(0);
    const withoutOrganization = new Set(
      APP_ROUTES.filter((r) => r.scope === "none").map((r) => routeKey(r)),
    );
    const byToken = new Set(APP_ROUTES.filter((r) => r.scope === "token").map((r) => routeKey(r)));
    const bySignature = new Set(
      APP_ROUTES.filter((r) => r.scope === "signed").map((r) => routeKey(r)),
    );
    const byForm = new Set(APP_ROUTES.filter((r) => r.scope === "form").map((r) => routeKey(r)));
    for (const route of discovered) {
      // Una ruta que no esté en el registro la atrapa G5; aquí solo cuentan las declaradas "none".
      if (withoutOrganization.has(routeKey(route))) continue;
      // Las del enlace del cliente tienen su propia guardia (8b).
      if (byToken.has(routeKey(route))) continue;
      // Las del formulario público tienen las suyas (10 a 10e).
      if (byForm.has(routeKey(route))) continue;
      // Las de avisos firmados por un proveedor tienen su propia guardia (8e).
      if (bySignature.has(routeKey(route))) continue;
      expect(
        read(route.absoluteFile),
        `src/app/${route.file} debe llamar a requireActiveTenant( o declararse sin organización en APP_ROUTES`,
      ).toContain("requireActiveTenant(");
    }
  });

  it("4. ningún código de servidor usa getSession() para decidir quién es la persona", () => {
    const offenders = sourceFiles
      .filter((f) => /\.getSession\s*\(/.test(stripComments(read(f))))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("5. la aplicación no abre conexiones SQL directas (pg / postgres)", () => {
    const offenders = sourceFiles
      .filter((f) => /from\s+["'](pg|postgres)["']|require\(["'](pg|postgres)["']\)/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("6. nunca se pide select('*') ni se lee last_tenant_id de `profiles`: eso va por my_last_tenant_id()", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = stripComments(read(file));
      for (const match of text.matchAll(
        /from\(\s*["']profiles["']\s*\)([\s\S]{0,200}?)\.select\(([^)]*)\)/g,
      )) {
        const columns = match[2].replace(/["'`\s]/g, "");
        if (columns === "" || columns === "*" || columns.includes("last_tenant_id")) {
          offenders.push(`${rel(file)}: select(${match[2]})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("8. el portero del enlace del cliente solo llama a sus seis funciones y nunca lee una tabla", () => {
    const allowedFunctions = new Set([
      "share_link_read",
      "share_link_record_view",
      "share_link_respond",
      // el aviso interno de la respuesta (H-031): destinatarios ya filtrados por la base, anotarlo y cerrarlo
      "share_notice_recipients",
      "internal_notice_register",
      "internal_notice_settle",
    ]);
    const gateway = stripComments(read(path.join(SRC, "lib", "share", "gateway.ts"))).replace(
      /\s+/g,
      " ",
    );
    const called = [...gateway.matchAll(/\.rpc\(\s*["'`]([a-z_0-9]+)["'`]/g)].map((m) => m[1]);
    expect(sorted(new Set(called))).toEqual(sorted(allowedFunctions));
    // `.rpc(` con un nombre que no es un texto fijo (variable) tampoco vale
    expect(gateway.match(/\.rpc\(/g)?.length).toBe(called.length);
    // `.from(` solo después de `.storage` (el bucket privado); nunca sobre una tabla
    // (`Buffer.from(` arma bytes, no toca la base.)
    const fromCalls = gateway.match(/(?<!Buffer)\.from\(/g)?.length ?? 0;
    const storageCalls =
      gateway.match(/\.storage\s*\.from\(\s*QUOTE_DOCUMENTS_BUCKET\s*\)/g)?.length ?? 0;
    expect(fromCalls).toBeGreaterThan(0);
    expect(fromCalls).toBe(storageCalls);
    // nada de otras formas de llegar a la base
    // (`.update(` no se vigila aquí: lo usa el sello `sha256` del PDF; sin `.from(` sobre una tabla no
    // hay forma de escribir en ella.)
    expect(/\.(insert|upsert|delete|select)\(/.test(gateway)).toBe(false);
    // ni la API de cuentas (`auth.admin...`): los correos de destino los entrega la base ya filtrados
    expect(/\.auth\b/.test(gateway)).toBe(false);
  });

  it("8b. toda ruta del enlace del cliente valida el token y aplica los límites antes de leer", () => {
    const tokenRoutes = discoverAppRoutes(path.join(SRC, "app")).filter((r) =>
      APP_ROUTES.some((a) => a.scope === "token" && routeKey(a) === routeKey(r)),
    );
    expect(tokenRoutes.length).toBeGreaterThanOrEqual(3);
    for (const route of tokenRoutes) {
      const text = stripComments(read(route.absoluteFile));
      const gate = text.indexOf("passTokenGate(");
      const firstRead = text.indexOf("readShareLink(");
      expect(gate, `src/app/${route.file} debe llamar a passTokenGate(`).toBeGreaterThan(-1);
      if (firstRead !== -1) {
        expect(gate, `${route.file}: passTokenGate va antes de leer`).toBeLessThan(firstRead);
      }
      // nunca la llave maestra ni la base directo desde la ruta
      expect(/admin-client|createClient|\.rpc\(/.test(text), route.file).toBe(false);
    }
  });

  it("8c. TODA ruta del enlace con POST comprueba el Origin antes de la puerta del token", () => {
    const postRoutes = discoverAppRoutes(path.join(SRC, "app")).filter(
      (r) =>
        APP_ROUTES.some((a) => a.scope === "token" && routeKey(a) === routeKey(r)) &&
        /export\s+(async\s+)?function\s+POST\b|export\s+const\s+POST\b/.test(
          stripComments(read(r.absoluteFile)),
        ),
    );
    // por lo menos: view, accept y reject
    expect(postRoutes.length).toBeGreaterThanOrEqual(3);
    for (const route of postRoutes) {
      const text = stripComments(read(route.absoluteFile));
      const origin = text.indexOf("isSameOriginPost(");
      const gate = text.indexOf("passTokenGate(");
      expect(origin, `${route.file} debe llamar a isSameOriginPost(`).toBeGreaterThan(-1);
      expect(gate, `${route.file} debe llamar a passTokenGate(`).toBeGreaterThan(-1);
      expect(origin, `${route.file}: el origen se comprueba antes que nada`).toBeLessThan(gate);
    }
  });

  it("8d. las rutas de respuesta del cliente solo hablan con la base por el portero", () => {
    const text = stripComments(read(path.join(SRC, "lib", "share", "respond-service.ts"))).replace(
      /\s+/g,
      " ",
    );
    expect(/admin-client|createClient|\.rpc\(|\.from\(/.test(text)).toBe(false);
    expect(text).toContain("respondShareLink(");
  });

  it("8e. los avisos del proveedor de correo: la firma se verifica antes de tocar la base, y el servicio solo llama a record_email_event", () => {
    const signedRoutes = discoverAppRoutes(path.join(SRC, "app")).filter((r) =>
      APP_ROUTES.some((a) => a.scope === "signed" && routeKey(a) === routeKey(r)),
    );
    expect(signedRoutes.length).toBeGreaterThanOrEqual(1);
    for (const route of signedRoutes) {
      const text = stripComments(read(route.absoluteFile));
      const verify = text.indexOf("verifyAndParseWebhook(");
      const record = text.indexOf("recordDeliveryEvent(");
      expect(verify, `${route.file} debe verificar la firma`).toBeGreaterThan(-1);
      expect(record, `${route.file} debe anotar el aviso`).toBeGreaterThan(verify);
      // la ruta no toca la base ni la llave maestra directo: solo por el servicio
      expect(/admin-client|createClient|\.rpc\(|\.from\(/.test(text), route.file).toBe(false);
    }
    const service = stripComments(
      read(path.join(SRC, "lib", "email", "delivery-events-service.ts")),
    ).replace(/\s+/g, " ");
    // una sola función de la base, nombrada con una constante; nunca una tabla
    expect([...service.matchAll(/\.rpc\(\s*([A-Za-z_]+)\s*,/g)].map((m) => m[1])).toEqual([
      "RECORD_FUNCTION",
    ]);
    expect(service).toContain('RECORD_FUNCTION = "record_email_event"');
    expect(/\.(from|insert|update|upsert|delete|select)\(/.test(service)).toBe(false);
  });

  it("9. el token no se escribe en los registros del servidor", () => {
    const offenders = sourceFiles
      .filter((f) => f.includes(`${path.sep}share${path.sep}`) || f.includes("quote-links"))
      .filter((f) => {
        const text = stripComments(read(f)).replace(/\s+/g, " ");
        return [...text.matchAll(/serverLog\([^)]*\)/g)].some((m) => /\btoken\b/i.test(m[0]));
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("10. el portero del formulario público solo llama a sus seis funciones y nunca lee una tabla ni la API de cuentas", () => {
    const allowedFunctions = new Set([
      "intake_form_read",
      "intake_request_submit",
      "intake_record_block",
      // los avisos al equipo: destinatarios ya filtrados por la base, anotarlo y cerrarlo
      "intake_notice_recipients",
      "intake_notice_register",
      "intake_notice_settle",
    ]);
    const gateway = stripComments(read(path.join(SRC, "lib", "intake", "gateway.ts"))).replace(
      /\s+/g,
      " ",
    );
    const called = [...gateway.matchAll(/\.rpc\(\s*["'`]([a-z_0-9]+)["'`]/g)].map((m) => m[1]);
    expect(sorted(new Set(called))).toEqual(sorted(allowedFunctions));
    // `.rpc(` con un nombre que no es un texto fijo (variable) tampoco vale
    expect(gateway.match(/\.rpc\(/g)?.length).toBe(called.length);
    // `.from(` solo después de `.storage` (el bucket privado de logos); nunca sobre una tabla
    const fromCalls = gateway.match(/(?<!Buffer)\.from\(/g)?.length ?? 0;
    const storageCalls = gateway.match(/\.storage\s*\.from\(\s*LOGO_BUCKET\s*\)/g)?.length ?? 0;
    expect(fromCalls).toBeGreaterThan(0);
    expect(fromCalls).toBe(storageCalls);
    expect(/\.(insert|upsert|delete|select|update)\(/.test(gateway)).toBe(false);
    // ni la API de cuentas (`auth.admin...`): los correos de destino los entrega la base ya filtrados
    expect(/\.auth\b/.test(gateway)).toBe(false);
    // nadie más en lo público habla con la base ni con Storage: ni la llave maestra (guardia 2), ni
    // `.rpc(`, ni `.storage`.
    const others = sourceFiles
      .filter((f) => rel(f).startsWith("src/lib/intake/") || rel(f).startsWith("src/app/f/"))
      .filter((f) => rel(f) !== "src/lib/intake/gateway.ts")
      .filter((f) => !/\/builder-(actions|queries)\.ts$/.test(rel(f)))
      .filter((f) => /\.rpc\(|createAdminClient|\.storage\b/.test(stripComments(read(f))))
      .map(rel);
    expect(others).toEqual([]);
  });

  it("10b. TODA ruta del formulario público con POST comprueba el Origin antes que cualquier otra cosa", () => {
    const formPostRoutes = discoverAppRoutes(path.join(SRC, "app")).filter(
      (r) =>
        APP_ROUTES.some((a) => a.scope === "form" && routeKey(a) === routeKey(r)) &&
        /export\s+(async\s+)?function\s+POST\b|export\s+const\s+POST\b/.test(
          stripComments(read(r.absoluteFile)),
        ),
    );
    expect(formPostRoutes.length).toBeGreaterThanOrEqual(1);
    for (const route of formPostRoutes) {
      const text = stripComments(read(route.absoluteFile));
      const origin = text.indexOf("isSameOriginPost(");
      expect(origin, `${route.file} debe llamar a isSameOriginPost(`).toBeGreaterThan(-1);
      // antes de leer los parámetros, el cuerpo o llamar a cualquier servicio
      for (const later of ["await ", "handleIntakeSubmit(", "request.json(", ".params"]) {
        const index = text.indexOf(later);
        if (index !== -1) {
          expect(origin, `${route.file}: el origen se comprueba antes de «${later}»`).toBeLessThan(
            index,
          );
        }
      }
      // nunca la llave maestra ni la base directo desde la ruta
      expect(/admin-client|createClient|\.rpc\(/.test(text), route.file).toBe(false);
    }
  });

  it("10c. el formulario público no importa nada de dinero, cálculo ni catálogo", () => {
    const publicFiles = sourceFiles.filter(
      (f) => rel(f).startsWith("src/app/f/") || rel(f).startsWith("src/components/intake/"),
    );
    expect(publicFiles.length).toBeGreaterThan(5);
    const offenders = publicFiles
      .filter((f) =>
        /from\s+["'][^"']*(@\/lib\/money|quotes\/calc|@\/lib\/catalog|\/catalog\/)[^"']*["']/.test(
          stripComments(read(f)),
        ),
      )
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("10d. nada de lo que escribe un visitante se pinta como HTML (sin dangerouslySetInnerHTML)", () => {
    const offenders = sourceFiles
      .filter(
        (f) =>
          rel(f).startsWith("src/app/f/") ||
          rel(f).startsWith("src/components/intake/") ||
          rel(f).startsWith("src/lib/intake/") ||
          rel(f).startsWith("src/app/o/[tenantId]/solicitudes/") ||
          rel(f).startsWith("src/app/o/[tenantId]/formularios/"),
      )
      .filter((f) => /dangerouslySetInnerHTML/.test(stripComments(read(f))))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("10e. serverLog en lo de solicitudes nunca recibe nombre, correo, teléfono, mensaje, IP ni el identificador del formulario", () => {
    const FORBIDDEN =
      /\b(name|email|phone|message|ip|clientIp|publicId|antibotToken|renderToken|token|contactName|contactEmail)\b/i;
    const offenders: string[] = [];
    let calls = 0;
    for (const file of sourceFiles.filter((f) => rel(f).startsWith("src/lib/intake/"))) {
      for (const call of serverLogCalls(stripComments(read(file)))) {
        calls += 1;
        // Se ignoran los textos y el `.message` de un error propio (solo trae un código, nunca datos).
        const code = call.replace(/"[^"]*"/g, '""').replace(/\b(cause|error|err)\.message\b/g, "");
        if (FORBIDDEN.test(code)) offenders.push(`${rel(file)}: ${call}`);
      }
    }
    expect(calls).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });

  it("10f. la guardia 10e detecta de verdad una violación", () => {
    const sample = 'serverLog("warn", "x", { email: data.email, ip: clientIp })';
    expect(serverLogCalls(sample)).toHaveLength(1);
    expect(/\b(email|ip)\b/i.test(serverLogCalls(sample)[0])).toBe(true);
    const balanced = 'serverLog("warn", "x", { code: String(cause) }); const other = (1)';
    expect(serverLogCalls(balanced)[0]).toBe('serverLog("warn", "x", { code: String(cause) })');
  });

  it("7. la guardia detecta de verdad: el texto de una violación sí coincide con las reglas", () => {
    // Evita que una regla quede inútil por un error en su expresión regular.
    expect(/x-cp-tenant-id/i.test('headers["X-CP-Tenant-Id"]')).toBe(true);
    expect(/\.getSession\s*\(/.test("await supabase.auth.getSession()")).toBe(true);
    const sample = 'supabase.from("profiles").select("*")';
    expect(/from\(\s*["']profiles["']\s*\)([\s\S]{0,200}?)\.select\(([^)]*)\)/.test(sample)).toBe(
      true,
    );
  });
});
