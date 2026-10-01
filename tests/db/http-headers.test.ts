// Prueba de verdad, con PostgREST y Auth reales (no simulada): la cabecera de la organización
// llega a la base de datos y app.current_tenant_id() la valida contra la membresía.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { TENANT_HEADER } from "@/lib/tenant/constants";
import {
  adminCreateUser,
  localEnv,
  rest,
  rpc,
  signIn,
  type ExtraHeaders,
} from "../support/local-supabase";

beforeAll(() => {
  expect(new URL(localEnv().apiUrl).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
});

async function createConfirmedUser(): Promise<{ email: string }> {
  const email = `http-${randomUUID().slice(0, 8)}@ejemplo.test`;
  await adminCreateUser(email);
  return { email };
}

const withTenant = (value: string | undefined): ExtraHeaders =>
  value === undefined ? {} : { [TENANT_HEADER]: value };

describe("la cabecera de la organización llega a la base de datos (PostgREST real)", () => {
  it("solo la organización de la que la persona es miembro se vuelve activa", async () => {
    const ana = await createConfirmedUser();
    const beto = await createConfirmedUser();
    const tokenAna = (await signIn(ana.email)).accessToken;
    const tokenBeto = (await signIn(beto.email)).accessToken;

    const createdA = await rpc(tokenAna, "create_tenant", {
      p_name: "Negocio Ana",
      p_rut: "76086428-5",
    });
    expect(createdA.status).toBe(200);
    const tenantA = createdA.json as string;
    const createdB = await rpc(tokenBeto, "create_tenant", {
      p_name: "Negocio Beto",
      p_rut: "76086428-5",
    });
    const tenantB = createdB.json as string;
    expect(tenantA).not.toBe(tenantB);

    // con su propia organización: ve el siguiente número
    const own = await rpc(tokenAna, "preview_next_quote_number", {}, withTenant(tenantA));
    expect(own.json).toMatch(/^COT-\d{4}-0001$/);

    // con la de otra persona, sin cabecera o con basura: no hay organización activa
    for (const header of [tenantB, undefined, "", "x", "1; drop table public.tenants"]) {
      const res = await rpc(tokenAna, "preview_next_quote_number", {}, withTenant(header));
      expect(res.status).toBe(200);
      expect(res.json).toBeNull();
    }

    // y no puede cambiar la numeración de la otra organización
    const attack = await rpc(
      tokenAna,
      "set_numbering",
      { p_prefix: "HACK", p_mode: "yearly", p_start_number: 99 },
      withTenant(tenantB),
    );
    expect(attack.status).toBeGreaterThanOrEqual(400);

    // el selector (tenants) muestra solo las organizaciones propias
    const list = await rest(tokenAna, "tenants?select=tenant_id");
    expect((list.json as { tenant_id: string }[]).map((r) => r.tenant_id)).toEqual([tenantA]);

    // sin sesión (solo la llave pública), no hay acceso a las RPC ni a las tablas
    const anonRpc = await rpc(null, "create_tenant", { p_name: "Anónimo", p_rut: "76086428-5" });
    expect(anonRpc.status).toBeGreaterThanOrEqual(400);
  });
});
