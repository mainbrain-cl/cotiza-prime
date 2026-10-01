// Prueba de verdad, con PostgREST y Auth reales (no simulada): la cabecera x-cp-tenant-id
// llega a la base de datos y app.current_tenant_id() la valida contra la membresía.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "./helpers";

interface LocalEnv {
  apiUrl: string;
  publishableKey: string;
  secretKey: string;
}

function localEnv(): LocalEnv {
  testDatabaseUrl(); // se niega a seguir si la base no es local
  const fromEnv = {
    apiUrl: process.env.SUPABASE_URL,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    secretKey: process.env.SUPABASE_SECRET_KEY,
  };
  if (fromEnv.apiUrl && fromEnv.publishableKey && fromEnv.secretKey) return fromEnv as LocalEnv;
  const out = execSync("npx supabase status -o json", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const json = JSON.parse(out.slice(out.indexOf("{"))) as Record<string, string>;
  return { apiUrl: json.API_URL, publishableKey: json.PUBLISHABLE_KEY, secretKey: json.SECRET_KEY };
}

const PASSWORD = "contrasena-ficticia-123"; // mínimo de 10 caracteres (config.toml)

let env: LocalEnv;
beforeAll(() => {
  env = localEnv();
  expect(new URL(env.apiUrl).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
});

async function createConfirmedUser(): Promise<{ email: string }> {
  const email = `http-${randomUUID().slice(0, 8)}@ejemplo.test`;
  const res = await fetch(`${env.apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: env.secretKey,
      authorization: `Bearer ${env.secretKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  expect(res.status).toBe(200);
  return { email };
}

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${env.apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: env.publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function rpc(
  token: string,
  name: string,
  args: object,
  tenantHeader?: string,
): Promise<Response> {
  return fetch(`${env.apiUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: env.publishableKey,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(tenantHeader === undefined ? {} : { "x-cp-tenant-id": tenantHeader }),
    },
    body: JSON.stringify(args),
  });
}

describe("la cabecera x-cp-tenant-id llega a la base de datos (PostgREST real)", () => {
  it("solo la organización de la que la persona es miembro se vuelve activa", async () => {
    const ana = await createConfirmedUser();
    const beto = await createConfirmedUser();
    const tokenAna = await signIn(ana.email);
    const tokenBeto = await signIn(beto.email);

    const createdA = await rpc(tokenAna, "create_tenant", {
      p_name: "Negocio Ana",
      p_rut: "76086428-5",
    });
    expect(createdA.status).toBe(200);
    const tenantA = (await createdA.json()) as string;
    const createdB = await rpc(tokenBeto, "create_tenant", {
      p_name: "Negocio Beto",
      p_rut: "76086428-5",
    });
    const tenantB = (await createdB.json()) as string;
    expect(tenantA).not.toBe(tenantB);

    // con su propia organización: ve el siguiente número
    const own = await rpc(tokenAna, "preview_next_quote_number", {}, tenantA);
    expect(await own.json()).toMatch(/^COT-\d{4}-0001$/);

    // con la de otra persona, sin cabecera o con basura: no hay organización activa
    for (const header of [tenantB, undefined, "", "x", "1; drop table public.tenants"]) {
      const res = await rpc(tokenAna, "preview_next_quote_number", {}, header);
      expect(res.status).toBe(200);
      expect(await res.json()).toBeNull();
    }

    // y no puede cambiar la numeración de la otra organización
    const attack = await rpc(
      tokenAna,
      "set_numbering",
      { p_prefix: "HACK", p_mode: "yearly", p_start_number: 99 },
      tenantB,
    );
    expect(attack.status).toBeGreaterThanOrEqual(400);

    // el selector (tenants) muestra solo las organizaciones propias
    const list = await fetch(`${env.apiUrl}/rest/v1/tenants?select=tenant_id`, {
      headers: { apikey: env.publishableKey, authorization: `Bearer ${tokenAna}` },
    });
    expect(((await list.json()) as { tenant_id: string }[]).map((r) => r.tenant_id)).toEqual([
      tenantA,
    ]);

    // sin sesión (solo la llave pública), no hay acceso a las RPC ni a las tablas
    const anonRpc = await fetch(`${env.apiUrl}/rest/v1/rpc/create_tenant`, {
      method: "POST",
      headers: { apikey: env.publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ p_name: "Anónimo", p_rut: "76086428-5" }),
    });
    expect(anonRpc.status).toBeGreaterThanOrEqual(400);
  });
});
