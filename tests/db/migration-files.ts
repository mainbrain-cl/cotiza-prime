// Ayudas para las pruebas que leen los archivos de migraciones (solo las pruebas de Vitest las usan).
// Van aparte de `helpers.ts` a propósito: ese archivo también lo carga Playwright (las pruebas e2e de aislamiento), que
// compila a CommonJS y no entiende `import.meta`.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "..", "..", "supabase", "migrations");

export type Migration = { name: string; sql: string };

/** Todas las migraciones del repositorio, en orden de nombre. */
export function readMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(MIGRATIONS_DIR, name), "utf8") }));
}

/**
 * La ÚLTIMA migración (por nombre) cuyo texto cumple `defines`: así una prueba compara la función de la base con la
 * definición que vale hoy, aunque una migración posterior la haya redefinido, y no con una versión vieja fija.
 */
export function latestMigrationDefining(
  migrations: Migration[],
  defines: RegExp,
): Migration | null {
  const defining = migrations
    .filter((m) => defines.test(m.sql))
    .sort((a, b) => a.name.localeCompare(b.name));
  return defining.at(-1) ?? null;
}

/** Lo que hay entre los `$$` de la función `qualifiedName` en `sql` (tal como lo guarda `pg_proc.prosrc`). */
export function functionBodyIn(sql: string, qualifiedName: string): string {
  const start = sql.indexOf(`function ${qualifiedName}(`);
  if (start === -1) throw new Error(`no encontré ${qualifiedName}`);
  const open = sql.indexOf("$$", start) + 2;
  return sql.slice(open, sql.indexOf("$$", open));
}
