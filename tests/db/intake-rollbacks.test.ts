// Sprint 4 · los «deshacer» de las migraciones 29 a 34 se niegan a correr si hay formularios o solicitudes
// (borrarlas perdería lo que alguien pidió). Se prueba ejecutando el archivo real dentro de una transacción
// que se deshace. El deshacer completo y en orden lo prueba `npm run test:db:rollbacks`.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, expectSqlError, withTx } from "./helpers";
import { buildIntakeWorld, insertRequest, makeForm, type IntakeWorld } from "./intake-helpers";

let setup: Client;
let w: IntakeWorld;
beforeAll(async () => {
  setup = await connect();
  w = await buildIntakeWorld(setup);
});
afterAll(async () => {
  await setup.end();
});

const down = (name: string) =>
  readFileSync(
    path.resolve(import.meta.dirname, "..", "..", "supabase", "rollbacks", `${name}.down.sql`),
    "utf8",
  );

const ROLLBACKS = [
  "20261007100000_intake_forms",
  "20261007110000_intake_requests",
  "20261007120000_intake_public_rpcs",
  "20261007130000_intake_request_rpcs",
  "20261007140000_intake_retention",
  "20261007150000_intake_review_fixes",
];

describe("los deshacer del sprint 4 protegen lo que alguien pidió", () => {
  it.each(ROLLBACKS)("%s se niega con un formulario y una solicitud", async (name) => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      await insertRequest(setup, w.tenantA, form.formId);
      const error = await expectSqlError(setup, down(name));
      expect(error.message).toContain("no se puede deshacer");
    });
  });

  it("cada migración tiene su deshacer", () => {
    for (const name of ROLLBACKS) expect(down(name).length, name).toBeGreaterThan(100);
  });
});
