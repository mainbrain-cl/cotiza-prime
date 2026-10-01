// H-012 · Lectura. Una persona con un pase REAL intenta leer, por todos los caminos que existen
// hoy, datos que no son de su organización activa. Ataques de docs/arquitectura/h-012-aislamiento.md
// §1: A01–A05, A10, A19 y los caminos X1–X4 y X8.
//
// Se ataca solo con `fetch` directo a /rest/v1 y /graphql/v1 y con pases de personas reales. La base
// (`pg`) solo se usa para saber, en vivo, qué DEBERÍA ver cada persona y comparar.
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";
import { graphql, rest, type HttpResult } from "../support/local-supabase";
import {
  activeMembersOf,
  aRowOfB,
  expectedActive,
  fixture,
  liveMemberships,
  openDb,
  peopleOfOrgs,
  tenantHeader,
  tokenOf,
} from "./context";
import { canReadRole, ISOLATION_TABLES, type TableSpec } from "./registry";
import { ORG_KEYS, PERSONA_KEYS, type OrgKey, type PersonaKey } from "./fixture";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

interface Scenario {
  label: string;
  /** `null` = anónimo (solo la llave pública). */
  persona: PersonaKey | null;
  /** Valor de la cabecera de la organización; `undefined` = no se manda. */
  header: string | undefined;
}

function scenarios(): Scenario[] {
  const fx = fixture();
  const A = fx.orgs.A.tenantId;
  const B = fx.orgs.B.tenantId;
  const C = fx.orgs.C.tenantId;
  const ana = (label: string, header: string | undefined): Scenario => ({
    label: `ana · ${label}`,
    persona: "ana",
    header,
  });
  return [
    ana("con su organización A (control)", A),
    ana("con la cabecera de B (A02)", B),
    ana("sin cabecera (A03)", undefined),
    ana("cabecera vacía (A04)", ""),
    ana("cabecera 'null' (A04)", "null"),
    ana("cabecera 'undefined' (A04)", "undefined"),
    ana("B en mayúsculas (A04)", B.toUpperCase()),
    ana("B sin guiones (A04)", B.replaceAll("-", "")),
    ana("B entre llaves (A04)", `{${B}}`),
    ana("B con espacios (A04)", ` ${B} `),
    ana("valor de 2 KB (A04)", "x".repeat(2048)),
    ana("la plataforma (A04)", PLATFORM_TENANT_ID),
    ana("cabecera duplicada 'A, B' (A04)", `${A}, ${B}`),
    ana("cabecera duplicada 'B, A' (A04)", `${B}, ${A}`),
    ana("texto de inyección (A04)", "1; drop table public.customers --"),
    ana("A en mayúsculas (equivale a A)", A.toUpperCase()),
    { label: "beto · con su organización B (control)", persona: "beto", header: B },
    { label: "beto · con la cabecera de A", persona: "beto", header: A },
    { label: "mixta · con A (A10)", persona: "mixta", header: A },
    { label: "mixta · con B (A10)", persona: "mixta", header: B },
    { label: "mixta · duplicada 'A, B' (A10)", persona: "mixta", header: `${A}, ${B}` },
    { label: "mixta · duplicada 'B, A' (A10)", persona: "mixta", header: `${B}, ${A}` },
    { label: "mixta · sin cabecera (A10)", persona: "mixta", header: undefined },
    { label: "dante (lector de A) · con A", persona: "dante", header: A },
    { label: "dante (lector de A) · con B", persona: "dante", header: B },
    { label: "ex · con A", persona: "ex", header: A },
    { label: "carla (C archivada) · con C", persona: "carla", header: C },
    { label: "carla · con A", persona: "carla", header: A },
    { label: "carla · con B", persona: "carla", header: B },
    { label: "anónimo · con A (A19)", persona: null, header: A },
    { label: "anónimo · con B (A19)", persona: null, header: B },
    { label: "anónimo · sin cabecera (A19)", persona: null, header: undefined },
  ];
}

interface Context {
  me: string | null;
  active: { tenantId: string; role: string } | null;
  /** Organizaciones cuyo identificador y datos puede mostrar legítimamente la tabla. */
  legitOrgs: Set<string>;
  /** Personas que pueden aparecer legítimamente en la respuesta. */
  visiblePeople: Set<string>;
  memberOrgs: Set<string>;
}

async function contextOf(spec: TableSpec, s: Scenario): Promise<Context> {
  const fx = fixture();
  const me = s.persona ? fx.personas[s.persona].userId : null;
  const active = await expectedActive(db, me, s.header);
  const memberships = me ? await liveMemberships(db, me) : [];
  const memberOrgs = new Set(memberships.map((m) => m.tenantId));
  const selector = spec.visibility === "selector-tenants" || spec.visibility === "selector-members";
  const legitOrgs = new Set<string>(selector ? memberOrgs : []);
  if (spec.visibility === "selector-members" && me) {
    // sus propias filas de `members` siguen siendo suyas aunque la membresía ya esté quitada
    const own = await db.query<{ tenant_id: string }>(
      `select tenant_id from public.members where user_id = $1`,
      [me],
    );
    for (const row of own.rows) legitOrgs.add(row.tenant_id);
  }
  if (active) legitOrgs.add(active.tenantId);
  const people = await peopleOfOrgs(db, [...legitOrgs]);
  if (me) people.add(me);
  return { me, active, legitOrgs, visiblePeople: people, memberOrgs };
}

type Row = Record<string, unknown>;

/** ¿Esta fila le corresponde a esta persona en esta tabla? Es la regla de cada tipo de visibilidad. */
async function allowed(spec: TableSpec, row: Row, ctx: Context): Promise<boolean> {
  switch (spec.visibility) {
    case "business":
      return (
        ctx.active !== null &&
        row.tenant_id === ctx.active.tenantId &&
        canReadRole(spec, ctx.active.role as never)
      );
    case "selector-tenants":
      return ctx.memberOrgs.has(row.tenant_id as string);
    case "selector-members":
      return (
        row.user_id === ctx.me || (ctx.active !== null && row.tenant_id === ctx.active.tenantId)
      );
    case "profiles": {
      if (row.user_id === ctx.me) return true;
      if (!ctx.active) return false;
      return (await activeMembersOf(db, ctx.active.tenantId)).has(row.user_id as string);
    }
    case "own-user":
      return ctx.me !== null && row.user_id === ctx.me;
    case "public":
      return true;
    case "server-only":
      return false;
  }
}

/** Textos que NO pueden aparecer: identificadores y marcas de organizaciones y personas ajenas. */
function forbiddenTexts(ctx: Context): string[] {
  const fx = fixture();
  const texts: string[] = [];
  for (const key of ORG_KEYS) {
    if (ctx.legitOrgs.has(fx.orgs[key].tenantId)) continue;
    texts.push(fx.orgs[key].tenantId, fx.orgs[key].canary);
  }
  for (const key of PERSONA_KEYS) {
    const persona = fx.personas[key];
    if (ctx.visiblePeople.has(persona.userId)) continue;
    texts.push(persona.userId, persona.email);
    if (persona.fullName.includes("CANARIO")) texts.push(persona.fullName);
  }
  texts.push("test.platform_event");
  return texts;
}

interface Evaluated {
  res: HttpResult;
  rows: Row[];
  ctx: Context;
}

/** Pide una tabla y verifica TODO lo que no se puede negociar. Devuelve lo leído para más pruebas. */
async function readAndCheck(spec: TableSpec, s: Scenario, select: string): Promise<Evaluated> {
  const token = s.persona ? await tokenOf(s.persona) : null;
  const res = await rest(token, `${spec.name}?select=${select}`, {
    headers: { Prefer: "count=exact", ...tenantHeader(s.header) },
  });
  const ctx = await contextOf(spec, s);
  const rows = (Array.isArray(res.json) ? res.json : []) as Row[];

  if (res.status >= 400) {
    // Un rechazo no puede traer datos.
    expect(rows, "un rechazo no debe traer filas").toEqual([]);
    for (const text of forbiddenTexts(ctx)) expect(res.text).not.toContain(text);
    return { res, rows, ctx };
  }
  expect([200, 206]).toContain(res.status);

  // X1: el total que informa la base coincide con lo que se devolvió (no esconde filas ajenas).
  const total = res.headers.get("content-range")?.split("/")[1];
  if (total && total !== "*") expect(Number(total), "Content-Range").toBe(rows.length);

  for (const row of rows) {
    expect(
      await allowed(spec, row, ctx),
      `${spec.name}: fila no permitida ${JSON.stringify(row)}`,
    ).toBe(true);
  }

  // X8: ningún texto delatador, salvo en las filas propias de las tablas de personas
  const ownRowsExempt = spec.visibility === "profiles" || spec.visibility === "own-user";
  const toScan = ownRowsExempt ? rows.filter((r) => r.user_id !== ctx.me) : rows;
  const text = JSON.stringify(toScan);
  for (const forbidden of forbiddenTexts(ctx)) {
    expect(text, `${spec.name}: aparece "${forbidden}"`).not.toContain(forbidden);
  }
  return { res, rows, ctx };
}

/** ¿Debe haber al menos una fila para esta persona? (control positivo: la prueba no puede pasar por estar vacía) */
function expectRows(spec: TableSpec, ctx: Context): boolean {
  switch (spec.visibility) {
    case "business":
      return ctx.active !== null && canReadRole(spec, ctx.active.role as never);
    case "selector-tenants":
    case "selector-members":
      return ctx.memberOrgs.size > 0;
    case "profiles":
    case "own-user":
      return ctx.me !== null;
    case "public":
      return true;
    case "server-only":
      return false;
  }
}

describe.each(ISOLATION_TABLES)("lectura de $name", (spec) => {
  it.each(scenarios().map((s) => [s.label, s] as const))("%s", async (_label, s) => {
    // Con todas las columnas: es lo que pediría un atacante.
    await readAndCheck(spec, s, "*");
    // Con las columnas legibles: aquí sí debe haber datos para quien corresponde (control positivo).
    const { rows, ctx } = await readAndCheck(spec, s, spec.readColumns);
    if (expectRows(spec, ctx) && s.persona !== null) {
      expect(
        rows.length,
        `${spec.name}: ${s.label} debería ver filas y no vio ninguna`,
      ).toBeGreaterThan(0);
    }
    if (s.persona === null && spec.visibility !== "public") {
      expect(rows).toEqual([]);
    }
  });

  if (spec.visibility !== "public") {
    // A05: leer por identificador una fila de B, con la cabecera que sea
    it("A05 · una fila de B pedida por su identificador no se entrega", async () => {
      const fx = fixture();
      const id = await aRowOfB(db, spec);
      expect(id, `${spec.name}: falta una fila de B para atacar`).not.toBeNull();
      for (const persona of ["ana", "dante", "carla", null] as const) {
        const token = persona ? await tokenOf(persona) : null;
        for (const header of [fx.orgs.A.tenantId, fx.orgs.B.tenantId, undefined]) {
          const res = await rest(token, `${spec.name}?${spec.idColumn}=eq.${id}&select=*`, {
            headers: tenantHeader(header),
          });
          // El identificador puede coincidir con una fila propia (p. ej. el alcance 'Y2026' de la
          // numeración): lo que no puede salir es nada de B.
          for (const forbidden of [fx.orgs.B.tenantId, fx.orgs.B.canary, fx.personas.beto.userId]) {
            expect(res.text, `${spec.name} · ${persona ?? "anónimo"}`).not.toContain(forbidden);
          }
        }
      }
    });

    // X3: filtrar por la organización ajena no la revela
    it("X3 · filtrar por tenant_id de B no devuelve nada a Ana", async () => {
      const fx = fixture();
      const B = fx.orgs.B.tenantId;
      const token = await tokenOf("ana");
      const queries = [
        `${spec.name}?tenant_id=eq.${B}&select=*`,
        `${spec.name}?or=(tenant_id.eq.${B})&select=*`,
        `${spec.name}?tenant_id=in.(${B},${fx.orgs.C.tenantId})&select=*`,
      ];
      for (const q of queries) {
        for (const header of [fx.orgs.A.tenantId, B]) {
          const res = await rest(token, q, { headers: tenantHeader(header) });
          const rows = (Array.isArray(res.json) ? res.json : []) as Row[];
          expect(res.status >= 400 || rows.length === 0, `${q} con ${header}`).toBe(true);
        }
      }
    });
  }
});

describe("a Ana con su organización A, nada que no sea de A", () => {
  it("las tablas de negocio solo traen filas de A, y A tiene datos (control positivo)", async () => {
    const A = fixture().orgs.A.tenantId;
    const token = await tokenOf("ana");
    for (const spec of ISOLATION_TABLES.filter((t) => t.visibility === "business")) {
      const res = await rest(token, `${spec.name}?select=*`, { headers: tenantHeader(A) });
      const rows = res.json as Row[];
      expect(rows.length, spec.name).toBeGreaterThan(0);
      expect(
        rows.every((r) => r.tenant_id === A),
        spec.name,
      ).toBe(true);
    }
  });
});

describe("X1 · el conteo exacto no delata filas ajenas", () => {
  it("con la cabecera de B, Ana recibe un total de 0 en toda tabla de negocio", async () => {
    const B = fixture().orgs.B.tenantId;
    const token = await tokenOf("ana");
    for (const spec of ISOLATION_TABLES.filter((t) => t.visibility === "business")) {
      const res = await rest(token, `${spec.name}?select=*`, {
        method: "HEAD",
        headers: { Prefer: "count=exact", ...tenantHeader(B) },
      });
      expect(res.headers.get("content-range"), spec.name).toMatch(/^(\*|0-0)\/0$/);
    }
  });
});

describe("X2 · lo embebido respeta la misma regla", () => {
  const embeds = [
    "customers?select=*,tenants(*)",
    "catalog_items?select=*,tenants(*)",
    "members?select=*,tenants(*)",
    "audit_log?select=*,tenants(*)",
    "numbering_settings?select=*,tenants(*)",
    "tenants?select=*,customers(*)",
    "tenants?select=*,catalog_items(*)",
    "tenants?select=*,members(*)",
    "tenants?select=*,audit_log(*)",
    "tenants?select=*,numbering_settings(*),numbering_sequences(*)",
    "customers?select=id,tenants(members(*))",
  ];

  it.each(embeds)("Ana con A: %s solo trae lo de A", async (query) => {
    const fx = fixture();
    const res = await rest(await tokenOf("ana"), query, {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    expect(res.status, res.text.slice(0, 200)).toBe(200);
    for (const key of ["B", "C"] as OrgKey[]) {
      expect(res.text).not.toContain(fx.orgs[key].tenantId);
      expect(res.text).not.toContain(fx.orgs[key].canary);
    }
    expect(res.text).not.toContain(fx.personas.beto.userId);
  });

  it.each(embeds)("Ana con la cabecera de B: %s no trae datos de B", async (query) => {
    const fx = fixture();
    const res = await rest(await tokenOf("ana"), query, {
      headers: tenantHeader(fx.orgs.B.tenantId),
    });
    for (const key of ["B", "C"] as OrgKey[]) {
      expect(res.text).not.toContain(fx.orgs[key].tenantId);
      expect(res.text).not.toContain(fx.orgs[key].canary);
    }
  });

  it("Mixta con A: bajo la organización B (que sí es suya) no hay clientes ni auditoría mientras trabaja en A (A10)", async () => {
    const fx = fixture();
    const res = await rest(
      await tokenOf("mixta"),
      "tenants?select=tenant_id,customers(tenant_id),catalog_items(tenant_id),audit_log(tenant_id)",
      { headers: tenantHeader(fx.orgs.A.tenantId) },
    );
    expect(res.status).toBe(200);
    const tenants = res.json as {
      tenant_id: string;
      customers: { tenant_id: string }[];
      catalog_items: { tenant_id: string }[];
      audit_log: { tenant_id: string }[];
    }[];
    expect(tenants.length).toBe(2); // el selector muestra A y B: es legítimo
    for (const tenant of tenants) {
      const isActive = tenant.tenant_id === fx.orgs.A.tenantId;
      expect(tenant.customers.length > 0).toBe(isActive);
      expect(tenant.catalog_items.length > 0).toBe(isActive);
      expect(tenant.audit_log.length > 0).toBe(isActive);
    }
  });
});

describe("A10 · quien está en dos organizaciones no mezcla datos", () => {
  it("con A solo ve A y con B solo ve B, en todas las tablas de negocio", async () => {
    const fx = fixture();
    const token = await tokenOf("mixta");
    for (const spec of ISOLATION_TABLES.filter((t) => t.visibility === "business")) {
      for (const [mine, other] of [
        [fx.orgs.A.tenantId, fx.orgs.B.tenantId],
        [fx.orgs.B.tenantId, fx.orgs.A.tenantId],
      ]) {
        const res = await rest(token, `${spec.name}?select=*`, { headers: tenantHeader(mine) });
        const rows = res.json as Row[];
        expect(rows.length, `${spec.name} con ${mine}`).toBeGreaterThan(0);
        expect(
          rows.every((r) => r.tenant_id === mine),
          spec.name,
        ).toBe(true);
        expect(res.text).not.toContain(other);
      }
    }
  });
});

describe("criterio 3 · el dato de 'última organización usada' no se filtra a los compañeros", () => {
  it("Ana no puede leer last_tenant_id de nadie (canario sobre profiles)", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const peek = await rest(token, "profiles?select=user_id,last_tenant_id", {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    // Debe ser un rechazo, o filas sin el dato de B
    if (peek.status < 400) {
      expect(peek.text).not.toContain(fx.orgs.B.tenantId);
    }
    expect(peek.text).not.toContain(fx.orgs.B.tenantId);
    // y tampoco por la puerta de atrás: filtrar por esa columna
    const probe = await rest(
      token,
      `profiles?last_tenant_id=eq.${fx.orgs.B.tenantId}&select=user_id`,
      {
        headers: tenantHeader(fx.orgs.A.tenantId),
      },
    );
    expect(probe.status >= 400 || (probe.json as Row[]).length === 0).toBe(true);
    // con select=* tampoco sale el identificador de B
    const all = await rest(token, "profiles?select=*", {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    expect(all.text).not.toContain(fx.orgs.B.tenantId);
  });

  it("Mixta sí conoce su propia última organización, por la función, no por la tabla", async () => {
    const token = await tokenOf("mixta");
    const res = await rest(token, "rpc/my_last_tenant_id", { method: "POST", body: {} });
    expect(res.status).toBe(200);
    expect(res.json).toBe(fixture().orgs.B.tenantId);
  });
});

describe("X4 · GraphQL aplica las mismas reglas", () => {
  const query = `{
    customersCollection { edges { node { id tenant_id display_name } } }
    catalog_itemsCollection { edges { node { id tenant_id name } } }
    tenantsCollection { edges { node { tenant_id name } } }
    membersCollection { edges { node { tenant_id user_id } } }
    audit_logCollection { edges { node { id tenant_id } } }
    profilesCollection { edges { node { user_id full_name } } }
  }`;

  it("con la cabecera de B, Ana no ve nada de B; con A solo lo de A", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    for (const [header, label] of [
      [fx.orgs.B.tenantId, "B"],
      [fx.orgs.A.tenantId, "A"],
      [undefined, "ninguna"],
    ] as const) {
      const res = await graphql(token, query, tenantHeader(header));
      for (const key of ["B", "C"] as OrgKey[]) {
        expect(res.text, `GraphQL con ${label}`).not.toContain(fx.orgs[key].tenantId);
        expect(res.text, `GraphQL con ${label}`).not.toContain(fx.orgs[key].canary);
      }
      expect(res.text).not.toContain(fx.personas.beto.userId);
    }
  });

  it("sin sesión, GraphQL no entrega datos de negocio", async () => {
    const fx = fixture();
    const res = await graphql(null, query, tenantHeader(fx.orgs.B.tenantId));
    for (const key of ORG_KEYS) {
      expect(res.text).not.toContain(fx.orgs[key].canary);
    }
    expect(res.text).not.toContain(fx.orgs.B.tenantId);
  });
});

describe("A19 · sin sesión no se entrega nada de negocio", () => {
  it("las tablas con permisos solo para personas rechazan a quien viene solo con la llave pública", async () => {
    for (const spec of ISOLATION_TABLES.filter((t) => t.visibility !== "public")) {
      const res = await rest(null, `${spec.name}?select=*`, {
        headers: tenantHeader(fixture().orgs.A.tenantId),
      });
      expect(res.status, spec.name).toBeGreaterThanOrEqual(400);
    }
  });

  it("lo único que ve alguien sin sesión son los términos vigentes", async () => {
    const res = await rest(null, "legal_documents?select=kind,version,is_current");
    expect(res.status).toBe(200);
    expect((res.json as Row[]).length).toBeGreaterThan(0);
  });
});

describe("las tablas del servidor", () => {
  it("auth_rate_limits no es legible por nadie con pase (ni para consultas de conteo)", async () => {
    const fx = fixture();
    for (const key of PERSONA_KEYS) {
      const res = await rest(await tokenOf(key), `auth_rate_limits?select=*`, {
        headers: { Prefer: "count=exact", ...tenantHeader(fx.orgs.A.tenantId) },
      });
      expect(res.status, key).toBeGreaterThanOrEqual(400);
      expect(res.text).not.toContain(fx.rateLimitKeyHash);
    }
  });
});
