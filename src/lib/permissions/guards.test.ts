// Guardias de código del sprint 5 (H-011): lo que impide que los permisos vuelvan a dispersarse.
// Leen los archivos de `src/`; no ejecutan nada.
//
// 1. Los nombres de los roles solo se escriben en `src/lib/permissions/`.
//    Excepciones, mínimas y explícitas: los archivos de prueba (`*.test.ts(x)`) y los ayudantes de
//    prueba de `src/test/` pueden escribir roles como datos de ejemplo (un falso miembro, un rol de
//    fixture). El código que se despliega no puede. Los directorios `e2e/`, `tests/` y `scripts/`
//    (semilla y fixtures de la base) quedan fuera de esta guardia: no se despliegan.
// 2. No hay memoria entre peticiones: ni `"use cache"` ni `unstable_cache`. Si el rol de alguien
//    quedara guardado, «quitar a un miembro» dejaría de ser al instante (diseño del sprint 5, §4).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "..");
const ROOT = path.resolve(SRC, "..");
const PERMISSIONS_DIR = path.join(SRC, "lib", "permissions");
const TEST_HELPERS_DIR = path.join(SRC, "test");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
const sourceFiles = walk(SRC).filter((file) => /\.(ts|tsx)$/.test(file));
const isTestFile = (file: string) =>
  /\.test\.(ts|tsx)$/.test(file) || file.startsWith(TEST_HELPERS_DIR);

// Armado por partes para que esta misma prueba no se marque a sí misma.
const ROLE_NAMES = ["owner", "admin", "approver", "sales", "viewer"];
const ROLE_LITERAL = new RegExp(`(["'\`])(${ROLE_NAMES.join("|")})\\1`);

describe("los nombres de los roles solo viven en src/lib/permissions/", () => {
  const deployed = sourceFiles.filter(
    (file) => !file.startsWith(PERMISSIONS_DIR) && !isTestFile(file),
  );

  it("hay código desplegable que revisar", () => {
    expect(deployed.length).toBeGreaterThan(100);
  });

  it("ningún archivo fuera de la carpeta de permisos escribe un rol entre comillas", () => {
    const offenders = deployed
      .filter((file) => ROLE_LITERAL.test(readFileSync(file, "utf8")))
      .map(rel);
    expect(offenders, "usa `can(...)`, `requirePermission(...)` o `pagePermission(...)`").toEqual(
      [],
    );
  });

  it("la guardia detecta un rol escrito a mano", () => {
    expect(ROLE_LITERAL.test(`if (role === "${ROLE_NAMES[0]}") {}`)).toBe(true);
    expect(ROLE_LITERAL.test(`const roles = ['${ROLE_NAMES[1]}', 'x']`)).toBe(true);
    expect(ROLE_LITERAL.test("const administrador = 1; // admin y owner en un comentario")).toBe(
      false,
    );
  });
});

describe("no hay memoria entre peticiones", () => {
  const FORBIDDEN = [/["']use cache(?::\s*\w+)?["']/, /\bunstable_cache\b/, /\bcacheComponents\b/];

  it("ni `use cache` ni `unstable_cache` en src/", () => {
    const offenders = sourceFiles
      .filter((file) => !/guards\.test\.ts$/.test(file))
      .filter((file) => FORBIDDEN.some((pattern) => pattern.test(readFileSync(file, "utf8"))))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("ni `cacheComponents` en la configuración de Next", () => {
    const config = readdirSync(ROOT)
      .filter((name) => /^next\.config\./.test(name))
      .map((name) => readFileSync(path.join(ROOT, name), "utf8"))
      .join("\n");
    expect(config).not.toMatch(/cacheComponents/);
  });
});
