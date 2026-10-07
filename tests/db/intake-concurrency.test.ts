// Sprint 4 · migración 31 · envíos al formulario público a la vez (H-087, H-092): el tope diario y la
// clave de envío se respetan aunque lleguen muchas peticiones juntas. Usa conexiones reales a Postgres, cada
// una en su propia transacción. Deja datos ficticios confirmados.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "./helpers";
import { actAsService, asUser } from "./send-helpers";
import {
  buildIntakeWorld,
  insertRequest,
  makeForm,
  submitParams,
  SUBMIT_SQL,
  type IntakeWorld,
  type MadeForm,
} from "./intake-helpers";

let setup: Client;
let w: IntakeWorld;
beforeAll(async () => {
  setup = await connect();
  w = await buildIntakeWorld(setup);
});
afterAll(async () => {
  await setup.end();
});

type Result = { result: string; replayed?: boolean; notify_cap?: boolean; request_id?: string };

/** Corre una función como el servidor, en su propia conexión y transacción. */
async function inOwnTx<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect();
  try {
    await client.query("begin");
    const out = await work(client);
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

function submit(form: MadeForm, over: { submitKey?: string } = {}): Promise<Result> {
  return inOwnTx(async (client) => {
    await actAsService(client);
    const { rows } = await client.query<{ r: Result }>(
      SUBMIT_SQL,
      submitParams({
        publicId: form.publicId,
        revision: form.revision,
        items: [{ form_item_id: form.itemIds[0], quantity_milli: null }],
        submitKey: over.submitKey,
      }),
    );
    return rows[0].r;
  });
}

async function formWithCap(cap: number): Promise<MadeForm> {
  await setup.query("begin");
  const form = await makeForm(setup, w.owner, w.tenantA, { form: { daily_cap: cap } });
  await setup.query("commit");
  return form;
}

const counters = async (formId: string) =>
  (await setup.query("select * from public.intake_daily_counters where form_id = $1", [formId]))
    .rows[0];
const requestCount = async (formId: string) =>
  (
    await setup.query("select count(*)::int as n from public.intake_requests where form_id = $1", [
      formId,
    ])
  ).rows[0].n as number;

describe("envíos simultáneos", () => {
  it("60 envíos a la vez con tope 50: exactamente 50 solicitudes, 10 rechazos contados y un solo aviso del tope", async () => {
    const form = await formWithCap(50);
    const results = await Promise.all(Array.from({ length: 60 }, () => submit(form)));
    expect(results.filter((r) => r.result === "ok")).toHaveLength(50);
    expect(results.filter((r) => r.result === "cap_reached")).toHaveLength(10);
    expect(results.filter((r) => r.notify_cap === true)).toHaveLength(1);
    expect(await requestCount(form.formId)).toBe(50);
    expect(await counters(form.formId)).toMatchObject({ accepted: 50, blocked_cap: 10 });
    expect((await counters(form.formId)).cap_notified_at).toBeTruthy();
    // cada solicitud tiene su propia clave y su propio id
    const { rows } = await setup.query(
      "select count(distinct id)::int as ids, count(distinct submit_key)::int as keys from public.intake_requests where form_id = $1",
      [form.formId],
    );
    expect(rows[0]).toEqual({ ids: 50, keys: 50 });
  });

  it("la misma clave de envío 20 veces a la vez: una sola solicitud y todas reciben 'ok'", async () => {
    const form = await formWithCap(50);
    const submitKey = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => submit(form, { submitKey })),
    );
    expect(results.every((r) => r.result === "ok")).toBe(true);
    expect(results.filter((r) => r.replayed === false)).toHaveLength(1);
    expect(new Set(results.map((r) => r.request_id)).size).toBe(1);
    expect(await requestCount(form.formId)).toBe(1);
    expect((await counters(form.formId)).accepted).toBe(1);
  });

  it("dos formularios de la misma organización a la vez no se pasan del tope de la organización (300)", async () => {
    const one = await formWithCap(200);
    const two = await formWithCap(200);
    const filler = await formWithCap(200);
    // 297 ya aceptadas hoy en la organización (otras pruebas de este archivo suman las suyas)
    const { rows } = await setup.query<{ n: string }>(
      "select coalesce(sum(accepted), 0)::text as n from public.intake_daily_counters where tenant_id = $1 and day = app.current_business_date()",
      [w.tenantA],
    );
    const already = Number(rows[0].n);
    const missing = 297 - already;
    expect(missing).toBeGreaterThan(0);
    await setup.query(
      "insert into public.intake_daily_counters (tenant_id, form_id, day, accepted) values ($1, $2, app.current_business_date(), $3)",
      [w.tenantA, filler.formId, missing],
    );
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, n) => submit(n % 2 ? one : two)),
    );
    expect(results.filter((r) => r.result === "ok")).toHaveLength(3);
    expect(results.filter((r) => r.result === "cap_reached")).toHaveLength(7);
    const { rows: total } = await setup.query<{ n: string }>(
      "select sum(accepted)::text as n from public.intake_daily_counters where tenant_id = $1 and day = app.current_business_date()",
      [w.tenantA],
    );
    expect(Number(total[0].n)).toBe(300);
  });
});

describe("conversiones simultáneas", () => {
  it("10 conversiones a la vez de la misma solicitud: una sola cotización y todas reciben la misma", async () => {
    await setup.query("begin");
    const form = await makeForm(setup, w.owner, w.tenantA);
    const requestId = await insertRequest(setup, w.tenantA, form.formId);
    await setup.query("commit");
    const quotesBefore = (
      await setup.query("select count(*)::int as n from public.quotes where tenant_id = $1", [
        w.tenantA,
      ])
    ).rows[0].n as number;

    const people = [w.owner, w.admin];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        inOwnTx(async (client) => {
          await asUser(client, people[n % people.length], w.tenantA);
          const { rows } = await client.query<{
            r: { quote_id: string; number_display: string; converted: boolean };
          }>("select public.convert_intake_request($1, $2, $3) as r", [
            requestId,
            w.customerA,
            randomUUID(),
          ]);
          return rows[0].r;
        }),
      ),
    );
    expect(results.filter((r) => r.converted)).toHaveLength(1);
    expect(new Set(results.map((r) => r.quote_id)).size).toBe(1);
    expect(new Set(results.map((r) => r.number_display)).size).toBe(1);
    const quotesAfter = (
      await setup.query("select count(*)::int as n from public.quotes where tenant_id = $1", [
        w.tenantA,
      ])
    ).rows[0].n as number;
    expect(quotesAfter).toBe(quotesBefore + 1);
    const { rows } = await setup.query(
      "select count(*)::int as n from public.quotes where source_request_id = $1",
      [requestId],
    );
    expect(rows[0].n).toBe(1);
    const events = await setup.query(
      "select count(*)::int as n from public.quote_events where quote_id = $1 and type = 'created_from_request'",
      [results[0].quote_id],
    );
    expect(events.rows[0].n).toBe(1);
  });
});
