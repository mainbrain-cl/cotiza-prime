// H-012 · A20. Varias personas cotizando a la vez en la misma organización nunca reciben el mismo
// número (PROYECTO.md §8.1). Usa 20 conexiones reales a Postgres, cada una en su propia transacción.
// Deja datos ficticios confirmados (no se borran: la auditoría es de solo agregar).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  actAs,
  connect,
  createTenantAs,
  createUser,
  TENANT_HEADER,
  type TestUser,
} from "./helpers";

const PARALLEL = 20;

let setup: Client;
let user: TestUser;
let tenantId: string;

beforeAll(async () => {
  setup = await connect();
  await setup.query("begin");
  user = await createUser(setup);
  tenantId = await createTenantAs(setup, user);
  await setup.query("commit");
});
afterAll(async () => {
  await setup.end();
});

describe("A20 · numeración con 20 conexiones a la vez", () => {
  it("20 asignaciones simultáneas dan 20 números distintos y seguidos, sin repetir ni saltar", async () => {
    const clients = await Promise.all(Array.from({ length: PARALLEL }, () => connect()));
    try {
      const results = await Promise.all(
        clients.map(async (client) => {
          await client.query("begin");
          await actAs(client, user, { [TENANT_HEADER]: tenantId }, "postgres");
          const { rows } = await client.query<{ seq: string; display: string }>(
            "select seq, display from app.allocate_quote_number($1)",
            [tenantId],
          );
          await client.query("commit");
          return rows[0];
        }),
      );
      const seqs = results.map((r) => Number(r.seq)).sort((a, b) => a - b);
      expect(new Set(results.map((r) => r.display)).size).toBe(PARALLEL);
      expect(seqs).toEqual(Array.from({ length: PARALLEL }, (_, i) => i + 1));
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });
});
