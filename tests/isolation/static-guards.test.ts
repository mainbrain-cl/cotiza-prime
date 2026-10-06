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
    for (const route of discovered) {
      // Una ruta que no esté en el registro la atrapa G5; aquí solo cuentan las declaradas "none".
      if (withoutOrganization.has(routeKey(route))) continue;
      // Las del enlace del cliente tienen su propia guardia (8b).
      if (byToken.has(routeKey(route))) continue;
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

  it("8. el portero del enlace del cliente solo llama a sus tres funciones y nunca lee una tabla", () => {
    const allowedFunctions = new Set([
      "share_link_read",
      "share_link_record_view",
      "share_link_respond",
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

  it("8c. los POST públicos comprueban el Origin", () => {
    const view = read(
      path.join(SRC, "app", "api", "v1", "public", "quote-links", "[token]", "view", "route.ts"),
    );
    expect(view).toContain("isSameOriginPost(");
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
