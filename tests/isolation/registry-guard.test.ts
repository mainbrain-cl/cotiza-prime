// Guardia del registro (G1–G6): la prueba de aislamiento no puede quedarse atrás del sistema.
// Si alguien agrega una tabla con `tenant_id`, una función expuesta o una ruta y no la anota en
// `registry.ts`, esta prueba falla y obliga a decidir quién puede verla antes de integrar.
// Complementa `tests/db/schema-guards.test.ts` (estructura) y `src/lib/tenant/guard-coverage.test.ts`
// (código de pantallas y acciones); no los repite.
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aRowOfB, fixture, openDb } from "./context";
import {
  APP_ROUTES,
  ISOLATION_TABLES,
  NON_BUSINESS_VISIBILITY,
  RPC_CASES,
  SERVER_ONLY_FUNCTIONS,
  visibilityDeclarationErrors,
} from "./registry";
import { discoverAppRoutes, routeKey } from "./routes";

const SRC = path.resolve(import.meta.dirname, "..", "..", "src");

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

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

  it("G5. toda pantalla (page.*) y toda ruta de servidor (route.*) bajo src/app está en APP_ROUTES, y al revés", () => {
    const discovered = discoverAppRoutes(path.join(SRC, "app"));
    expect(discovered.length).toBeGreaterThan(0);
    expect(
      sorted(new Set(discovered.map(routeKey))),
      "Una ruta nueva debe agregarse a APP_ROUTES (tests/isolation/registry.ts) diciendo si es de una organización o 'none'",
    ).toEqual(sorted(APP_ROUTES.map(routeKey)));
  });

  it("G5b. el alcance declarado de cada ruta calza con su dirección", () => {
    for (const route of APP_ROUTES) {
      // Pantallas de una organización (/o/[tenantId]/...) y rutas de la API que llevan la organización
      // en la dirección (/api/v1/tenants/[tenantId]/...).
      const isPage = route.path === "/o/[tenantId]" || route.path.startsWith("/o/[tenantId]/");
      const isApi = route.path.startsWith("/api/v1/tenants/[tenantId]/");
      // El enlace del cliente (sin cuenta): la pantalla `/c/[token]` y la API pública por token.
      const isTokenPage = route.path === "/c/[token]";
      const isTokenApi = route.path.startsWith("/api/v1/public/quote-links/[token]/");
      expect(route.scope === "tenant", `${route.path}: alcance ${route.scope}`).toBe(
        isPage || isApi,
      );
      expect(route.scope === "token", `${route.path}: alcance ${route.scope}`).toBe(
        isTokenPage || isTokenApi,
      );
      // Los avisos firmados de proveedores externos (sin sesión ni token).
      expect(route.scope === "signed", `${route.path}: alcance ${route.scope}`).toBe(
        route.path.startsWith("/api/v1/webhooks/"),
      );
      // El formulario público (sin cuenta): la pantalla `/f/[publicId]` y la API pública por formulario.
      const isFormPage = route.path === "/f/[publicId]";
      const isFormApi = route.path.startsWith("/api/v1/public/forms/[publicId]/");
      expect(route.scope === "form", `${route.path}: alcance ${route.scope}`).toBe(
        isFormPage || isFormApi,
      );
      if (route.scope === "form") expect(route.kind).toBe(isFormPage ? "page" : "api");
      if (route.scope === "tenant") expect(route.kind).toBe(isPage ? "page" : "api");
      if (route.scope === "token") expect(route.kind).toBe(isTokenPage ? "page" : "api");
    }
  });

  it("G6. la visibilidad declarada de cada tabla calza con la lista cerrada de excepciones", () => {
    expect(visibilityDeclarationErrors(ISOLATION_TABLES)).toEqual([]);
    // toda excepción de la lista cerrada existe de verdad en el registro
    for (const name of Object.keys(NON_BUSINESS_VISIBILITY)) {
      expect(
        ISOLATION_TABLES.some((t) => t.name === name),
        `${name} ya no está en el registro: quítala de NON_BUSINESS_VISIBILITY`,
      ).toBe(true);
    }
  });

  it("G6b. la guardia detecta una tabla de negocio declarada con menos rigor", () => {
    const tampered = ISOLATION_TABLES.map((t) =>
      t.name === "customers" ? { ...t, visibility: "public" as const } : t,
    );
    expect(visibilityDeclarationErrors(tampered)).toEqual([
      "customers: declarada public, debe ser business",
    ]);
    const loosened = ISOLATION_TABLES.map((t) =>
      t.name === "tenants" ? { ...t, visibility: "business" as const } : t,
    );
    expect(visibilityDeclarationErrors(loosened)).toHaveLength(1);
    // y una tabla nueva no declarada "business" tampoco pasa
    expect(
      visibilityDeclarationErrors([{ name: "quotes", visibility: "own-user" as const }]),
    ).toEqual(["quotes: declarada own-user, debe ser business"]);
  });
});
