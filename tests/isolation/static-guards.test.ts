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
    for (const route of discovered) {
      // Una ruta que no esté en el registro la atrapa G5; aquí solo cuentan las declaradas "none".
      if (withoutOrganization.has(routeKey(route))) continue;
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
