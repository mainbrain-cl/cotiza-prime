// Guardia del registro (G1–G5): la prueba de aislamiento no puede quedarse atrás del sistema.
// Si alguien agrega una tabla con `tenant_id`, una función expuesta o una ruta y no la anota en
// `registry.ts`, esta prueba falla y obliga a decidir quién puede verla antes de integrar.
// Complementa `tests/db/schema-guards.test.ts` (estructura) y `src/lib/tenant/guard-coverage.test.ts`
// (código de pantallas y acciones); no los repite.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aRowOfB, fixture, openDb } from "./context";
import { APP_ROUTES, ISOLATION_TABLES, RPC_CASES, SERVER_ONLY_FUNCTIONS } from "./registry";

const SRC = path.resolve(import.meta.dirname, "..", "..", "src");

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sorted = (values: Iterable<string>) => [...values].sort();

describe("guardia del registro de aislamiento", () => {
  it("G1. las tablas de public con tenant_id son exactamente las del registro", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select c.relname as table_name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
         and exists (select 1 from pg_attribute a
                     where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)`,
    );
    expect(sorted(rows.map((r) => r.table_name))).toEqual(
      sorted(ISOLATION_TABLES.map((t) => t.name)),
    );
  });

  it("G2. toda tabla de negocio tiene al menos una fila de B en la fixture (no pasa por estar vacía)", async () => {
    for (const spec of ISOLATION_TABLES.filter((t) => t.hasFixtureRowsInB)) {
      expect(
        await aRowOfB(db, spec),
        `${spec.name} no tiene filas de B en la fixture`,
      ).not.toBeNull();
    }
    // y las tablas que la fixture declara sin filas de B no deben ser tablas de negocio
    for (const spec of ISOLATION_TABLES.filter((t) => !t.hasFixtureRowsInB)) {
      expect(["public", "server-only"]).toContain(spec.visibility);
    }
    expect(fixture().orgs.B.customerIds.length).toBeGreaterThan(0);
  });

  it("G3. toda función de public que un pase puede ejecutar está en RPC_CASES (o es solo del servidor)", async () => {
    const { rows } = await db.query<{
      name: string;
      auth: boolean;
      anon: boolean;
      service: boolean;
    }>(
      `select p.proname as name,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as service
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f'`,
    );
    const callableByPass = rows.filter((r) => r.auth || r.anon).map((r) => r.name);
    expect(sorted(new Set(callableByPass))).toEqual(sorted(Object.keys(RPC_CASES)));
    // las del servidor existen y nadie con pase las puede ejecutar
    for (const name of SERVER_ONLY_FUNCTIONS) {
      const row = rows.find((r) => r.name === name);
      expect(row, `${name} ya no existe: quítala de SERVER_ONLY_FUNCTIONS`).toBeDefined();
      expect(row?.auth || row?.anon, `${name} no debe ser ejecutable con un pase`).toBe(false);
    }
  });

  it("G4. ninguna función de public recibe la organización como parámetro", async () => {
    const { rows } = await db.query<{ name: string; arg: string }>(
      `select p.proname as name, a.arg
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       cross join lateral unnest(coalesce(p.proargnames, '{}')) as a(arg)
       where n.nspname = 'public' and p.prokind = 'f' and a.arg ilike '%tenant%'`,
    );
    expect(rows).toEqual([]);
  });

  it("G5. toda ruta de la API y toda pantalla de una organización está en APP_ROUTES", () => {
    const routes: string[] = [];
    for (const file of walk(path.join(SRC, "app"))) {
      const rel = path.relative(path.join(SRC, "app"), file).split(path.sep).join("/");
      let match = rel.match(/^(api\/v1(?:\/.*)?)\/route\.ts$/);
      if (match) routes.push(`/${match[1]}`);
      match = rel.match(/^(o\/\[tenantId\](?:\/.*)?)\/page\.tsx$/);
      if (match) routes.push(`/${match[1]}`);
    }
    expect(sorted(new Set(routes))).toEqual(sorted(APP_ROUTES.map((r) => r.path)));
  });
});
