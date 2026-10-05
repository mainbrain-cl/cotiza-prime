// H-025 · 50 personas creando cotizaciones a la vez en la misma organización reciben 50 números
// distintos y seguidos (PROYECTO.md §8.1). Usa 50 conexiones reales a Postgres, cada una en su propia
// transacción. Deja datos ficticios confirmados (no se borran: la historia es de solo agregar).
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TENANT_HEADER,
  actAs,
  connect,
  createTenantAs,
  createUser,
  type TestUser,
} from "./helpers";

const PARALLEL = 50;

let setup: Client;
let user: TestUser;
let tenantId: string;
let customerId: string;

beforeAll(async () => {
  setup = await connect();
  await setup.query("begin");
  user = await createUser(setup);
  tenantId = await createTenantAs(setup, user);
  customerId = randomUUID();
  await setup.query(
    `insert into public.customers (id, tenant_id, kind, display_name) values ($1, $2, 'company', 'Cliente de carga')`,
    [customerId, tenantId],
  );
  await setup.query("commit");
});
afterAll(async () => {
  await setup.end();
});

describe("H-025 · 50 creaciones simultáneas", () => {
  it("dan 50 cotizaciones con 50 números distintos y seguidos", async () => {
    const clients = await Promise.all(Array.from({ length: PARALLEL }, () => connect()));
    try {
      const results = await Promise.all(
        clients.map(async (client) => {
          await client.query("begin");
          await actAs(client, user, { [TENANT_HEADER]: tenantId });
          const { rows } = await client.query<{ quote_id: string; number_display: string }>(
            "select * from public.create_quote($1, $2)",
            [customerId, randomUUID()],
          );
          await client.query("commit");
          return rows[0];
        }),
      );
      expect(new Set(results.map((r) => r.number_display)).size).toBe(PARALLEL);
      expect(new Set(results.map((r) => r.quote_id)).size).toBe(PARALLEL);
      const { rows } = await setup.query<{ number_seq: string }>(
        "select number_seq from public.quotes where tenant_id = $1 order by number_seq",
        [tenantId],
      );
      expect(rows.map((r) => Number(r.number_seq))).toEqual(
        Array.from({ length: PARALLEL }, (_, i) => i + 1),
      );
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });

  it("el mismo reintento de 10 clics a la vez crea una sola cotización", async () => {
    const key = randomUUID();
    const clients = await Promise.all(Array.from({ length: 10 }, () => connect()));
    try {
      const results = await Promise.all(
        clients.map(async (client) => {
          await client.query("begin");
          await actAs(client, user, { [TENANT_HEADER]: tenantId });
          const { rows } = await client.query<{ quote_id: string }>(
            "select * from public.create_quote($1, $2)",
            [customerId, key],
          );
          await client.query("commit");
          return rows[0].quote_id;
        }),
      );
      expect(new Set(results).size).toBe(1);
      const { rows } = await setup.query(
        "select count(*)::int as n from public.quotes where creation_key = $1",
        [key],
      );
      expect(rows[0].n).toBe(1);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });
});
