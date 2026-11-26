// 🟢 PRUEBAS · Supabase local, datos ficticios.
// H-042 · dos guardados de la regla de servicios por comercial a la vez, con dos conexiones reales que SE SOLAPAN (la segunda llamada empieza
// mientras la primera sigue abierta). Revisión Opus I-1: sobre un miembro que todavía no tiene fila, no hay nada que bloquear con `for update`,
// y las dos llamadas intentaban crear la fila: la segunda fallaba con un error crudo de llave duplicada. Con el candado por miembro, la
// segunda espera, ve lo que guardó la primera y responde «unchanged» (lo mismo) o `CP409` (otra lista).
// Deja datos ficticios confirmados (las reglas de la prueba se borran al final; la auditoría es de solo agregar y se queda).
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TENANT_HEADER, actAs, actAsPostgres, connect, type TestUser } from "./helpers";
import { addCatalogItem } from "./approval-helpers";
import { buildWorld, type World } from "./send-helpers";

let setup: Client;
let w: World;
let carla: string;
let a: string;
let b: string;

beforeAll(async () => {
  setup = await connect();
  w = await buildWorld(setup);
  await actAsPostgres(setup);
  carla = (
    await setup.query<{ id: string }>(
      "select id from public.members where tenant_id = $1 and user_id = $2",
      [w.tenantA, w.sales.id],
    )
  ).rows[0].id;
  a = await addCatalogItem(setup, w.tenantA, 10_000);
  b = await addCatalogItem(setup, w.tenantA, 10_000);
});
afterAll(async () => {
  await actAsPostgres(setup);
  await setup.query("delete from public.member_catalog_scopes where tenant_id = $1", [w.tenantA]);
  await setup.end();
});
// cada prueba parte sin regla
async function reset() {
  await actAsPostgres(setup);
  await setup.query("delete from public.member_catalog_scopes where member_id = $1", [carla]);
}

type Outcome = { ok: true; result: string } | { ok: false; code?: string; message: string };
const SET = "select public.set_member_catalog_scope($1, $2, $3::uuid[], $4) as r";

/** Abre una transacción, entra como `user` y llama; deja la transacción ABIERTA (el que llama decide cuándo confirmar). */
async function open(user: TestUser, mode: string, ids: string[] | null, revision: number) {
  const client = await connect();
  await client.query("begin");
  await actAs(client, user, { [TENANT_HEADER]: w.tenantA });
  const run = async (): Promise<Outcome> => {
    try {
      const { rows } = await client.query<{ r: { result: string } }>(SET, [
        carla,
        mode,
        ids,
        revision,
      ]);
      return { ok: true, result: rows[0].r.result };
    } catch (error) {
      const e = error as { code?: string; message: string };
      return { ok: false, code: e.code, message: e.message };
    }
  };
  return { client, run };
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** La primera llamada queda abierta; la segunda empieza (y espera); luego se confirma la primera y se espera la respuesta de la segunda. */
async function overlap(
  first: { user: TestUser; mode: string; ids: string[] | null; revision: number },
  second: { user: TestUser; mode: string; ids: string[] | null; revision: number },
) {
  const one = await open(first.user, first.mode, first.ids, first.revision);
  const two = await open(second.user, second.mode, second.ids, second.revision);
  try {
    const firstOutcome = await one.run();
    // la segunda empieza con la primera todavía sin confirmar: tiene que esperar, no fallar por su cuenta
    const pending = two.run();
    await pause(400);
    await one.client.query("commit");
    const secondOutcome = await pending;
    await two.client.query("commit").catch(() => two.client.query("rollback"));
    return { firstOutcome, secondOutcome };
  } finally {
    await one.client.end();
    await two.client.end();
  }
}
async function state() {
  await actAsPostgres(setup);
  const scope = await setup.query<{ mode: string; revision: number }>(
    "select mode, revision from public.member_catalog_scopes where member_id = $1",
    [carla],
  );
  const items = await setup.query<{ catalog_item_id: string }>(
    "select catalog_item_id from public.member_catalog_scope_items where member_id = $1 order by 1",
    [carla],
  );
  const audits = await setup.query<{ n: string }>(
    "select count(*) as n from public.audit_log where resource_id = $1 and action = 'member.catalog_scope_changed'",
    [carla],
  );
  return {
    scope: scope.rows,
    items: items.rows.map((r) => r.catalog_item_id),
    audits: Number(audits.rows[0].n),
  };
}

describe("dos guardados de la regla a la vez (miembro sin fila)", () => {
  it("el mismo guardado dos veces (doble clic): el primero guarda y el segundo responde «unchanged», sin error y con un solo registro", async () => {
    await reset();
    const before = (await state()).audits;
    const { firstOutcome, secondOutcome } = await overlap(
      { user: w.owner, mode: "list", ids: [a], revision: 0 },
      { user: w.owner, mode: "list", ids: [a], revision: 0 },
    );
    expect(firstOutcome).toEqual({ ok: true, result: "changed" });
    expect(secondOutcome).toEqual({ ok: true, result: "unchanged" });
    const after = await state();
    expect(after.scope).toEqual([{ mode: "list", revision: 1 }]);
    expect(after.items).toEqual([a]);
    expect(after.audits - before).toBe(1);
  });

  it("dos Administradores con listas distintas: el segundo recibe `CP409` (no un error de llave duplicada) y gana la primera lista", async () => {
    await reset();
    const { firstOutcome, secondOutcome } = await overlap(
      { user: w.owner, mode: "list", ids: [a], revision: 0 },
      { user: w.admin, mode: "list", ids: [b], revision: 0 },
    );
    expect(firstOutcome).toEqual({ ok: true, result: "changed" });
    expect(secondOutcome).toMatchObject({ ok: false, code: "CP409", message: "revision_changed" });
    const after = await state();
    expect(after.scope).toEqual([{ mode: "list", revision: 1 }]);
    expect(after.items).toEqual([a]);
  });

  it("control: sin solaparse (uno después del otro) el comportamiento es el mismo", async () => {
    await reset();
    const one = await open(w.owner, "list", [a], 0);
    expect(await one.run()).toEqual({ ok: true, result: "changed" });
    await one.client.query("commit");
    await one.client.end();
    const two = await open(w.admin, "list", [b], 0);
    expect(await two.run()).toMatchObject({ ok: false, code: "CP409" });
    await two.client.query("rollback");
    await two.client.end();
    expect((await state()).items).toEqual([a]);
  });
});
