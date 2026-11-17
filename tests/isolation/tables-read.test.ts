// H-012 · Lectura. Una persona con un pase REAL intenta leer, por todos los caminos que existen
// hoy, datos que no son de su organización activa. Ataques de docs/arquitectura/h-012-aislamiento.md
// §1: A01–A05, A10, A19 y los caminos X1–X4 y X8.
//
// Se ataca solo con `fetch` directo a /rest/v1 y /graphql/v1 y con pases de personas reales. La base
// (`pg`) solo se usa para saber, en vivo, qué DEBERÍA ver cada persona y comparar.
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can } from "@/lib/permissions/matrix";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";
import { graphql, rest, type HttpResult } from "../support/local-supabase";
import {
  aRowOfB,
  expectedActive,
  fixture,
  liveMemberships,
  openDb,
  peopleOfOrgs,
  tenantHeader,
  tokenOf,
} from "./context";
import { allColumnsOf, canReadRole, ISOLATION_TABLES, type TableSpec } from "./registry";
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

/** El estado de una fila de `members` (las columnas pedidas pueden no traerlo: se lee de la base). */
async function memberStatus(row: Row): Promise<unknown> {
  if (row.status !== undefined) return row.status;
  const { rows } = await db.query<{ status: string }>(
    "select status from public.members where id = $1",
    [row.id],
  );
  return rows[0]?.status;
}

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
    case "selector-members": {
      if (row.user_id === ctx.me) return true;
      if (ctx.active === null || row.tenant_id !== ctx.active.tenantId) return false;
      // Desde H-010, las filas de quien ya se fue solo las ve quien maneja el equipo.
      return (await memberStatus(row)) === "active" || can(ctx.active.role, "team.manage");
    }
    case "profiles": {
      if (row.user_id === ctx.me) return true;
      if (!ctx.active) return false;
      // Desde H-010 también se lee el nombre de quien tuvo una fila en `members` de la organización activa y ya se fue.
      // Se usa lo calculado junto a ESTA lectura (`ctx.visiblePeople`), no una consulta aparte hecha después.
      return ctx.visiblePeople.has(row.user_id as string);
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
  // El correo de una persona que SÍ puede verse (p. ej. un ex miembro, o Carla desde H-010) tampoco puede aparecer en la
  // lectura de ninguna tabla: ninguna columna legible de estas tablas lleva correos (`members` guarda el id, no el correo;
  // el correo solo lo entrega `list_members()` a quien maneja el equipo, y eso no es una lectura de tabla). Lo único que se
  // perdona es el propio correo de quien lee.
  for (const key of PERSONA_KEYS) {
    const persona = fx.personas[key];
    if (persona.userId === ctx.me || !ctx.visiblePeople.has(persona.userId)) continue;
    texts.push(persona.email);
  }
  texts.push("test.platform_event");
  return texts;
}

interface Evaluated {
  res: HttpResult;
  rows: Row[];
  ctx: Context;
}

/** Una firma comparable de todo lo que se espera ver, para saber si cambió entre dos momentos. */
const signatureOf = (ctx: Context): string =>
  JSON.stringify({
    me: ctx.me,
    active: ctx.active,
    legit: [...ctx.legitOrgs].sort(),
    people: [...ctx.visiblePeople].sort(),
    member: [...ctx.memberOrgs].sort(),
  });

/**
 * Pide la tabla y calcula lo que se debe ver AL MOMENTO DE LEER, no con una foto tomada antes: se calcula lo esperado
 * antes y después de pedir, y solo se acepta la lectura si no cambió entre las dos (si otra prueba, o un ciclo de vida,
 * agregó o quitó una membresía justo en medio, se vuelve a leer). Así la respuesta y lo esperado son del mismo instante y
 * el resultado no depende del orden de los archivos. La regla no se relaja: sigue siendo la de quien tiene o tuvo una fila
 * en `members` de la organización activa.
 */
async function readAtASteadyMoment(
  spec: TableSpec,
  s: Scenario,
  select: string,
): Promise<{ res: HttpResult; ctx: Context }> {
  const token = s.persona ? await tokenOf(s.persona) : null;
  let before = await contextOf(spec, s);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await rest(token, `${spec.name}?select=${select}`, {
      headers: { Prefer: "count=exact", ...tenantHeader(s.header) },
    });
    const after = await contextOf(spec, s);
    if (signatureOf(after) === signatureOf(before)) return { res, ctx: after };
    before = after;
  }
  throw new Error(
    `${spec.name} · ${s.label}: las membresías siguen cambiando mientras se lee; otra prueba está escribiendo a la vez`,
  );
}

/**
 * El nombre completo de una persona que SÍ puede verse (p. ej. Carla, Dueña de C y ex miembro de A: desde H-010
 * `app.current_tenant_people()` deja a A leer su nombre) lleva dentro el canario de su organización (`Carla CANARIO-C-…`).
 * La exención es lo más estrecha posible: solo en una fila de `profiles` de ESA persona (`user_id`), solo en la columna
 * `full_name` y solo si el valor es exactamente su nombre. Un nombre copiado en cualquier otra columna, en otra tabla,
 * en un texto libre o en un JSON de auditoría (`details`) no se perdona y sigue fallando.
 */
function withoutLegitimateName(spec: TableSpec, row: Row, ctx: Context): Row {
  if (spec.visibility !== "profiles" || typeof row.user_id !== "string") return row;
  if (!ctx.visiblePeople.has(row.user_id)) return row;
  const persona = PERSONA_KEYS.map((key) => fixture().personas[key]).find(
    (p) => p.userId === row.user_id,
  );
  if (!persona?.fullName || row.full_name !== persona.fullName) return row;
  return { ...row, full_name: "" };
}

/** Pide una tabla y verifica TODO lo que no se puede negociar. Devuelve lo leído para más pruebas. */
async function readAndCheck(spec: TableSpec, s: Scenario, select: string): Promise<Evaluated> {
  const { res, ctx } = await readAtASteadyMoment(spec, s, select);
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
  const text = JSON.stringify(toScan.map((row) => withoutLegitimateName(spec, row, ctx)));
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
      const res = await rest(token, `${spec.name}?select=${allColumnsOf(spec)}`, {
        headers: tenantHeader(A),
      });
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
      const res = await rest(token, `${spec.name}?select=${allColumnsOf(spec)}`, {
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
      // Mixta es Administradora en A y en B, y el registro de actividad es solo del Dueño (H-011a, supuesto
      // 13): ni en la organización activa ve filas. Lo que importa es que tampoco ve las de la otra.
      expect(tenant.audit_log.length).toBe(0);
    }
  });

  it("Ana (Dueña) con A activa: el registro de actividad incrustado SÍ trae filas de A y ninguna de B (control positivo de X2)", async () => {
    const fx = fixture();
    const res = await rest(await tokenOf("ana"), "tenants?select=tenant_id,audit_log(tenant_id)", {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    expect(res.status).toBe(200);
    const tenants = res.json as { tenant_id: string; audit_log: { tenant_id: string }[] }[];
    const orgA = tenants.find((t) => t.tenant_id === fx.orgs.A.tenantId);
    expect(orgA, "Ana ve su organización A").toBeDefined();
    expect(orgA?.audit_log.length, "la Dueña sí lee el registro de actividad de A").toBeGreaterThan(
      0,
    );
    for (const tenant of tenants) {
      for (const row of tenant.audit_log) expect(row.tenant_id).toBe(fx.orgs.A.tenantId);
    }
    expect(res.text).not.toContain(fx.orgs.B.tenantId);
    expect(res.text).not.toContain(fx.orgs.B.canary);
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
        const res = await rest(token, `${spec.name}?select=${allColumnsOf(spec)}`, {
          headers: tenantHeader(mine),
        });
        const rows = res.json as Row[];
        // Mixta es Administradora en las dos: de las tablas que el Administrador no lee (p. ej. el registro de
        // actividad, solo del Dueño) no debe ver ninguna fila, ni de la organización activa ni de la otra.
        if (canReadRole(spec, "admin")) {
          expect(rows.length, `${spec.name} con ${mine}`).toBeGreaterThan(0);
        } else {
          expect(rows.length, `${spec.name} con ${mine}`).toBe(0);
        }
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

  /**
   * GraphQL no existe en Cotiza Prime (migración 13 quita pg_graphql y config.toml no expone
   * `graphql_public`). La prueba exige la respuesta explícita de "no está habilitado": un rechazo
   * sin datos. Si alguien reactivara GraphQL, responder 200 con `data` rompe esta prueba, aunque
   * el contenido fuera inofensivo.
   */
  function expectGraphqlDisabled(res: HttpResult, label: string) {
    expect(
      res.status,
      `${label}: GraphQL debe estar deshabilitado (${res.text.slice(0, 160)})`,
    ).toBeGreaterThanOrEqual(400);
    const body = (res.json ?? {}) as Record<string, unknown>;
    expect(body, `${label}: GraphQL no debe devolver datos`).not.toHaveProperty("data");
    // PostgREST: "Invalid schema: graphql_public" (PGRST106) o ruta inexistente (PGRST125)
    expect(res.text, `${label}: se esperaba la respuesta de "no habilitado"`).toMatch(
      /PGRST106|PGRST125|Invalid schema|not exposed|Not Found|not found/i,
    );
  }

  it("con sesión, /graphql/v1 responde 'no habilitado' con cualquier cabecera de organización", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    for (const [header, label] of [
      [fx.orgs.B.tenantId, "B"],
      [fx.orgs.A.tenantId, "A"],
      [undefined, "ninguna"],
    ] as const) {
      const res = await graphql(token, query, tenantHeader(header));
      expectGraphqlDisabled(res, `con ${label}`);
      for (const key of ["B", "C"] as OrgKey[]) {
        expect(res.text).not.toContain(fx.orgs[key].tenantId);
        expect(res.text).not.toContain(fx.orgs[key].canary);
      }
      expect(res.text).not.toContain(fx.personas.beto.userId);
    }
  });

  it("sin sesión, /graphql/v1 también responde 'no habilitado'", async () => {
    const fx = fixture();
    const res = await graphql(null, query, tenantHeader(fx.orgs.B.tenantId));
    expectGraphqlDisabled(res, "sin sesión");
    for (const key of ORG_KEYS) {
      expect(res.text).not.toContain(fx.orgs[key].canary);
    }
    expect(res.text).not.toContain(fx.orgs.B.tenantId);
  });
});

describe("A19 · sin sesión no se entrega nada de negocio", () => {
  it("las tablas con permisos solo para personas rechazan a quien viene solo con la llave pública", async () => {
    for (const spec of ISOLATION_TABLES.filter((t) => t.visibility !== "public")) {
      const res = await rest(null, `${spec.name}?select=${allColumnsOf(spec)}`, {
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

  it("mfa_enrollment_alerts y mfa_annul_links no son legibles por nadie con pase (H-118a): ni la huella del enlace ni los avisos", async () => {
    const fx = fixture();
    for (const key of PERSONA_KEYS) {
      for (const table of ["mfa_enrollment_alerts", "mfa_annul_links"]) {
        const res = await rest(await tokenOf(key), `${table}?select=*`, {
          headers: { Prefer: "count=exact", ...tenantHeader(fx.orgs.A.tenantId) },
        });
        expect(res.status, `${key} ${table}`).toBeGreaterThanOrEqual(400);
        expect(res.text).not.toContain(fx.mfaLinkTokenSha);
      }
    }
  });

  it("mfa_recovery_codes no es legible por nadie con pase (H-004b): ni las huellas de los códigos de respaldo ni los juegos", async () => {
    const fx = fixture();
    for (const key of PERSONA_KEYS) {
      const res = await rest(await tokenOf(key), `mfa_recovery_codes?select=*`, {
        headers: { Prefer: "count=exact", ...tenantHeader(fx.orgs.A.tenantId) },
      });
      expect(res.status, key).toBeGreaterThanOrEqual(400);
      expect(res.text).not.toContain(fx.mfaRecoveryCodeHash);
    }
  });
});
