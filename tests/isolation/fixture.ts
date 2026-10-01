// Fixture de la prueba de aislamiento (H-012): organizaciones, personas y datos ficticios.
//
// No usa Vitest, así que la comparten Vitest (montaje global) y Playwright (e2e/isolation.setup.ts).
// Todo se crea por los caminos reales: cuentas con la API de administración de Auth, organizaciones
// y datos con PostgREST y el pase de cada dueña o dueño. La llave maestra y `pg` solo sirven para
// montar lo que ningún camino legítimo permite (membresías ajenas, archivar) y para verificar.
// NUNCA se usan para atacar.
//
// No se borra nada al terminar (la auditoría es de solo agregar): cada ejecución usa su `runId`.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { buildCustomerInsertRow } from "@/lib/customers/record";
import type { CustomerInput } from "@/lib/customers/schemas";
import { PLATFORM_TENANT_ID, TENANT_HEADER } from "@/lib/tenant/constants";
import { connect } from "../db/helpers";
import { adminCreateUser, rest, rpc, signIn, type Session } from "../support/local-supabase";

export type PersonaKey = "ana" | "beto" | "carla" | "mixta" | "ex" | "dante";
export type OrgKey = "A" | "B" | "C";
export type Role = "owner" | "admin" | "approver" | "sales" | "viewer";

export const PERSONA_KEYS: PersonaKey[] = ["ana", "beto", "carla", "mixta", "ex", "dante"];
export const ORG_KEYS: OrgKey[] = ["A", "B", "C"];

/** RUT ficticio válido para las organizaciones y para el cliente que se repite en A y en B. */
const ORG_RUT = "76086428-5";
export const SHARED_CUSTOMER_RUT = "12345678-5";
const SHARED_CUSTOMER_EMAIL = "compartido@ejemplo.test";
/** RUT y correo que existen SOLO en un cliente de B (P23: registrarlos en A no debe avisar de duplicado). */
export const ONLY_B_CUSTOMER_RUT = "11111111-1";
export const ONLY_B_CUSTOMER_EMAIL = "solo-b@ejemplo.test";

/** Prefijo de numeración que identifica a cada organización en las pruebas. */
export const NUMBERING_PREFIX: Record<"A" | "B", string> = { A: "AAA", B: "BBB" };
const NUMBERING_START: Record<"A" | "B", number> = { A: 100, B: 500 };

export interface Persona {
  key: PersonaKey;
  email: string;
  userId: string;
  fullName: string;
  session: Session;
}

export interface OrgData {
  tenantId: string;
  name: string;
  /** Texto que solo aparece en datos de esa organización: si sale en otra respuesta, hay filtración. */
  canary: string;
  customerIds: string[];
  catalogIds: string[];
}

export interface IsolationFixture {
  runId: string;
  personas: Record<PersonaKey, Persona>;
  orgs: Record<OrgKey, OrgData>;
  /** Identificador de un registro de auditoría de la plataforma (nunca visible a una organización). */
  platformAuditId: number;
  /** Clave de la fila de `auth_rate_limits` que monta la fixture. */
  rateLimitKeyHash: string;
}

const SEED_CUSTOMERS = (org: OrgKey, canary: string): CustomerInput[] => [
  ...seedCustomers(org, canary),
  ...(org === "B"
    ? [
        {
          kind: "company" as const,
          displayName: `${canary} Cliente solo de B`,
          rut: ONLY_B_CUSTOMER_RUT,
          email: ONLY_B_CUSTOMER_EMAIL,
          phone: null,
          address: null,
        },
      ]
    : []),
];

const seedCustomers = (org: OrgKey, canary: string): CustomerInput[] => [
  {
    kind: "company",
    displayName: `${canary} Cliente compartido`,
    rut: SHARED_CUSTOMER_RUT,
    email: SHARED_CUSTOMER_EMAIL,
    phone: "+56912345678",
    address: `Calle ${canary} 123`,
  },
  {
    kind: "person",
    displayName: `${canary} Cliente ${org} dos`,
    rut: null,
    email: null,
    phone: null,
    address: null,
  },
];

const org = (tenantId: string) => ({ [TENANT_HEADER]: tenantId });

async function mustOk<T>(
  promise: Promise<{ status: number; json: unknown; text: string }>,
  what: string,
): Promise<T> {
  const res = await promise;
  if (res.status >= 300)
    throw new Error(`Fixture: falló ${what} (${res.status}): ${res.text.slice(0, 200)}`);
  return res.json as T;
}

/** Arma toda la fixture. Tarda unos segundos: se llama una vez por ejecución. */
export async function createIsolationFixture(runId: string): Promise<IsolationFixture> {
  const db = await connect();
  try {
    return await build(db, runId);
  } finally {
    await db.end();
  }
}

async function build(db: Client, runId: string): Promise<IsolationFixture> {
  // Versiones vigentes de términos y privacidad: así las cuentas entran sin la pantalla de aceptar.
  const { rows: docs } = await db.query<{ kind: string; version: string }>(
    `select kind, version from public.legal_documents where is_current`,
  );
  const acceptedLegal = Object.fromEntries(docs.map((d) => [d.kind, d.version]));

  const canary = (key: OrgKey) => `CANARIO-${key}-${runId}`;
  const names: Record<PersonaKey, string> = {
    ana: `Ana ${canary("A")}`,
    beto: `Beto ${canary("B")}`,
    carla: `Carla ${canary("C")}`,
    mixta: "Mixta Doble",
    ex: "Ex Miembro",
    dante: "Dante Lector",
  };

  const personas = {} as Record<PersonaKey, Persona>;
  for (const key of PERSONA_KEYS) {
    const email = `${key}-${runId}@ejemplo.test`;
    await adminCreateUser(email, { full_name: names[key], accepted_legal: acceptedLegal });
    const session = await signIn(email);
    personas[key] = { key, email, userId: session.userId, fullName: names[key], session };
  }

  // Organizaciones: cada dueña la crea con su propio pase (camino legítimo)
  const orgs = {} as Record<OrgKey, OrgData>;
  const owners: Record<OrgKey, PersonaKey> = { A: "ana", B: "beto", C: "carla" };
  for (const key of ORG_KEYS) {
    const name = key === "A" ? `Negocio A ${runId}` : `${canary(key)} Negocio ${key}`;
    const tenantId = await mustOk<string>(
      rpc(personas[owners[key]].session.accessToken, "create_tenant", {
        p_name: name,
        p_rut: ORG_RUT,
        p_industry: "services",
      }),
      `create_tenant ${key}`,
    );
    orgs[key] = {
      tenantId,
      name,
      canary: key === "A" ? canary("A") : canary(key),
      customerIds: [],
      catalogIds: [],
    };
  }

  // Membresías que ningún camino legítimo da todavía (invitaciones llegan en el sprint 4)
  const addMember = (tenantId: string, userId: string, role: Role) =>
    db.query(`insert into public.members (tenant_id, user_id, role) values ($1, $2, $3)`, [
      tenantId,
      userId,
      role,
    ]);
  await addMember(orgs.A.tenantId, personas.mixta.userId, "admin");
  await addMember(orgs.B.tenantId, personas.mixta.userId, "admin");
  await addMember(orgs.A.tenantId, personas.dante.userId, "viewer");
  await addMember(orgs.A.tenantId, personas.ex.userId, "sales");
  // Mixta usó B por última vez: es el dato que no debe filtrarse a sus compañeros de A (criterio 3)
  await db.query(`update public.profiles set last_tenant_id = $1 where user_id = $2`, [
    orgs.B.tenantId,
    personas.mixta.userId,
  ]);

  // Numeración, catálogo y clientes, por el camino legítimo (pase de la dueña y su cabecera)
  for (const key of ["A", "B"] as const) {
    const owner = personas[owners[key]];
    const token = owner.session.accessToken;
    const headers = org(orgs[key].tenantId);
    await mustOk(
      rpc(
        token,
        "set_numbering",
        {
          p_prefix: NUMBERING_PREFIX[key],
          p_mode: "yearly",
          p_start_number: NUMBERING_START[key],
        },
        headers,
      ),
      `set_numbering ${key}`,
    );
    for (let i = 1; i <= 2; i++) {
      const id = randomUUID();
      await mustOk(
        rest(token, "catalog_items", {
          method: "POST",
          headers,
          body: {
            id,
            tenant_id: orgs[key].tenantId,
            name: `${orgs[key].canary} Servicio ${i}`,
            description: `Descripción ${orgs[key].canary}`,
            unit: "service",
            unit_price_clp: 10_000 * i,
          },
        }),
        `catálogo ${key}`,
      );
      orgs[key].catalogIds.push(id);
    }
    for (const input of SEED_CUSTOMERS(key, orgs[key].canary)) {
      const id = randomUUID();
      const row = buildCustomerInsertRow(input, orgs[key].tenantId, id);
      await mustOk(
        rest(token, "customers", { method: "POST", headers, body: row }),
        `cliente ${key}`,
      );
      orgs[key].customerIds.push(id);
    }
  }
  // C: un cliente, y luego se archiva
  {
    const id = randomUUID();
    const row = buildCustomerInsertRow(SEED_CUSTOMERS("C", canary("C"))[1], orgs.C.tenantId, id);
    await mustOk(
      rest(personas.carla.session.accessToken, "customers", {
        method: "POST",
        headers: org(orgs.C.tenantId),
        body: row,
      }),
      "cliente C",
    );
    orgs.C.customerIds.push(id);
  }
  await db.query(
    `update public.tenants set status = 'archived', archived_at = now() where tenant_id = $1`,
    [orgs.C.tenantId],
  );

  // Un registro de auditoría de la plataforma y una fila del limitador de intentos
  const audit = await db.query<{ id: string }>(
    `insert into public.audit_log (tenant_id, actor_type, action, result, details)
     values ($1, 'system', 'test.platform_event', 'success', $2) returning id::text`,
    [PLATFORM_TENANT_ID, JSON.stringify({ runId })],
  );
  const rateLimitKeyHash = [
    ...randomUUID().replaceAll("-", ""),
    ...randomUUID().replaceAll("-", ""),
  ].join("");
  await db.query(
    `insert into public.auth_rate_limits (scope, key_hash, failures) values ('login_ip', $1, 1)`,
    [rateLimitKeyHash],
  );

  return {
    runId,
    personas,
    orgs,
    platformAuditId: Number(audit.rows[0].id),
    rateLimitKeyHash,
  };
}

/** Quita a "ex" de la organización A (el camino real todavía no existe: llega en el sprint 4). */
export async function removeExMember(fx: IsolationFixture): Promise<void> {
  const db = await connect();
  try {
    await db.query(
      `update public.members set status = 'removed', removed_at = now()
       where tenant_id = $1 and user_id = $2 and status = 'active'`,
      [fx.orgs.A.tenantId, fx.personas.ex.userId],
    );
  } finally {
    await db.end();
  }
}
