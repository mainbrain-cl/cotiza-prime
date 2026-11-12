// H-004a (ronda 1) · El segundo paso en la base. Una persona NUEVA de la organización A, con un factor TOTP verificado, entra
// solo con la contraseña (pase aal1, «sesión parcial») e intenta, por los mismos caminos del resto de la prueba de
// aislamiento, leer y llamar lo de su propia organización: todas las tablas del registro, todas las funciones del registro y
// los archivos. Debe recibir CERO filas o un rechazo en todo, salvo las excepciones de abajo, cada una justificada. El control:
// la MISMA persona con su pase aal2 (contraseña y código) sí lee y llama, para que un cero no pueda deberse a un ataque mal
// armado.
//
// La persona se crea aquí (no en la fixture global) para no sumar un miembro más a la organización A en los demás archivos; al
// terminar se la quita del equipo. JAMÁS se activa un factor en las personas de la fixture ni en la semilla.
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshTotp } from "../../src/test/totp";
import {
  adminCreateUser,
  localEnv,
  rest,
  rpc,
  signIn,
  storage,
  type HttpResult,
} from "../support/local-supabase";
import { fixture, openDb, tenantHeader } from "./context";
import { LOGO_BUCKET } from "./fixture";
import { ISOLATION_TABLES, RPC_CASES } from "./registry";

let db: Client;
let userId: string;
let gated: string; // pase aal1 (solo contraseña)
let full: string; // pase aal2 (contraseña y código)

async function auth(token: string, method: string, path: string, body?: unknown) {
  const { apiUrl, publishableKey } = localEnv();
  const res = await fetch(`${apiUrl}/auth/v1/${path}`, {
    method,
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as {
      id: string;
      access_token: string;
      totp: { secret: string };
    } | null,
  };
}

beforeAll(async () => {
  db = await openDb();
  const fx = fixture();
  const email = `segundo-paso-${randomBytes(4).toString("hex")}@ejemplo.test`;
  userId = await adminCreateUser(email);
  // Administradora de la organización A, activa (la membresía se monta por la base: es lo que ningún camino legítimo permite aquí).
  await db.query("insert into public.members (tenant_id, user_id, role) values ($1, $2, 'admin')", [
    fx.orgs.A.tenantId,
    userId,
  ]);
  // Activa y verifica el factor con un código de verdad.
  const first = await signIn(email);
  const enrolled = await auth(first.accessToken, "POST", "factors", {
    factor_type: "totp",
    issuer: "Cotiza Prime",
  });
  expect(enrolled.status).toBe(200);
  const factorId = enrolled.json!.id as string;
  const challenge = await auth(first.accessToken, "POST", `factors/${factorId}/challenge`, {});
  const { code } = await freshTotp(enrolled.json!.totp.secret);
  const verified = await auth(first.accessToken, "POST", `factors/${factorId}/verify`, {
    challenge_id: challenge.json!.id,
    code,
  });
  expect(verified.status).toBe(200);
  full = verified.json!.access_token as string;
  // Un pase NUEVO con la contraseña sola: es el de quien no tiene el teléfono.
  gated = (await signIn(email)).accessToken;
  expect(JSON.parse(Buffer.from(gated.split(".")[1], "base64url").toString()).aal).toBe("aal1");
});

afterAll(async () => {
  if (userId) {
    await db.query(
      "update public.members set status = 'removed', removed_at = now() where user_id = $1 and tenant_id = $2",
      [userId, fixture().orgs.A.tenantId],
    );
  }
  await db.end();
});

/** Excepciones: tablas que la sesión parcial puede leer, y por qué. */
const READABLE_BY_PARTIAL_SESSION: Record<string, string> = {
  legal_documents:
    "los términos y la política vigentes son públicos: los lee hasta quien no tiene sesión (pantalla de registro)",
};

const rejected = (res: HttpResult) => res.status >= 400;
const emptyList = (res: HttpResult) =>
  res.status === 200 && Array.isArray(res.json) && res.json.length === 0;

describe("S2-1 · tablas: con la contraseña sola, cero filas en todo el registro", () => {
  it("ninguna tabla entrega una fila al pase aal1 (con la cabecera de A, la de siempre)", async () => {
    const A = tenantHeader(fixture().orgs.A.tenantId);
    for (const spec of ISOLATION_TABLES) {
      const res = await rest(gated, `${spec.name}?select=${spec.readColumns}`, { headers: A });
      if (spec.name in READABLE_BY_PARTIAL_SESSION) {
        expect(res.status, spec.name).toBe(200);
        continue;
      }
      expect(
        rejected(res) || emptyList(res),
        `${spec.name}: ${res.status} ${res.text.slice(0, 120)}`,
      ).toBe(true);
    }
  });

  it("control: la MISMA persona con aal2 sí lee su organización (tenants, members, perfil y varias de negocio)", async () => {
    const A = tenantHeader(fixture().orgs.A.tenantId);
    const nonEmpty: string[] = [];
    for (const spec of ISOLATION_TABLES) {
      const res = await rest(full, `${spec.name}?select=${spec.readColumns}`, { headers: A });
      if (res.status === 200 && Array.isArray(res.json) && res.json.length > 0)
        nonEmpty.push(spec.name);
    }
    for (const name of ["tenants", "members", "profiles", "customers", "catalog_items"]) {
      expect(nonEmpty, name).toContain(name);
    }
    expect(nonEmpty.length).toBeGreaterThan(8);
  });

  it("la lista de excepciones no tiene tablas que ya no existen", () => {
    const known = new Set(ISOLATION_TABLES.map((spec) => spec.name));
    for (const name of Object.keys(READABLE_BY_PARTIAL_SESSION))
      expect(known.has(name), name).toBe(true);
  });
});

describe("S2-2 · funciones: con la contraseña sola, rechazo en todo el registro", () => {
  /**
   * Una respuesta 200 que no entrega NADA (cuerpo vacío o `null`) es tan buena como un rechazo: la función existe, pero para
   * una sesión parcial no encuentra organización y responde «nada». Hoy es el caso de `preview_next_quote_number` y
   * `my_last_tenant_id` (devuelven `null`). Todo lo demás tiene que rechazar con un error.
   */
  const nothing = (res: HttpResult) =>
    res.status === 200 && (res.text === "" || res.text === "null" || res.text === "[]");

  it("ninguna función del registro responde con datos al pase aal1", async () => {
    const A = tenantHeader(fixture().orgs.A.tenantId);
    const open: string[] = [];
    for (const [name, spec] of Object.entries(RPC_CASES)) {
      const res = await rpc(gated, name, spec.args, A);
      expect(
        rejected(res) || nothing(res),
        `${name} debe rechazar o no entregar nada: ${res.status} ${res.text.slice(0, 160)}`,
      ).toBe(true);
      if (nothing(res)) open.push(name);
    }
    // Las que responden «nada» son pocas y conocidas; una nueva se revisa a mano.
    expect(open.sort()).toEqual(["my_last_tenant_id", "preview_next_quote_number"].sort());
  });

  it("control: con aal2 las funciones de lectura de la organización responden", async () => {
    const A = tenantHeader(fixture().orgs.A.tenantId);
    const ok = await rpc(full, "preview_next_quote_number", {}, A);
    expect(ok.status, ok.text).toBe(200);
  });
});

describe("S2-3 · archivos: con la contraseña sola no se lee ni se lista el logo de la organización", () => {
  it("descargar y listar el bucket de logos", async () => {
    const fx = fixture();
    const A = tenantHeader(fx.orgs.A.tenantId);
    const path = `object/authenticated/${LOGO_BUCKET}/${fx.orgs.A.logoPath}`;
    const withCode = await storage(full, "GET", path, { headers: A });
    expect(withCode.status, "control: con aal2 el logo de A se descarga").toBe(200);

    const download = await storage(gated, "GET", path, { headers: A });
    expect(download.status, "descarga con aal1").toBeGreaterThanOrEqual(400);

    const list = await storage(gated, "POST", `object/list/${LOGO_BUCKET}`, {
      headers: A,
      body: { prefix: fx.orgs.A.tenantId, limit: 100, offset: 0 },
    });
    expect(rejected(list) || emptyList(list), `listado con aal1: ${list.status} ${list.text}`).toBe(
      true,
    );
  });
});
