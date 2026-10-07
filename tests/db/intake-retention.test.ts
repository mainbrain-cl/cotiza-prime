// Sprint 4 · migración 33 · limpieza por plazo de las solicitudes del formulario público (Ley 21.719).
// Nuevas o asignadas: 12 meses. Descartadas: 30 días. Convertidas: se anonimizan a los 12 meses y conservan
// servicios, fechas y vínculo. Contadores: 90 días. Cada prueba corre en una transacción que se deshace.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, expectSqlError, withTx } from "./helpers";
import {
  buildIntakeWorld,
  insertRequest,
  makeForm,
  sha256Hex,
  type IntakeWorld,
  type MadeForm,
} from "./intake-helpers";
import { createQuote } from "./send-helpers";

let setup: Client;
let w: IntakeWorld;
beforeAll(async () => {
  setup = await connect();
  w = await buildIntakeWorld(setup);
});
afterAll(async () => {
  await setup.end();
});

type Counts = {
  requests_deleted: number;
  notices_deleted: number;
  requests_anonymized: number;
  counters_deleted: number;
};

const ago = (interval: string) => `now() - interval '${interval}'`;
const purge = async () =>
  (await setup.query<{ r: Counts }>("select app.purge_intake_data() as r")).rows[0].r;
const exists = async (id: string) =>
  ((await setup.query("select 1 from public.intake_requests where id = $1", [id])).rowCount ?? 0) >
  0;
const rowOf = async (id: string) =>
  (await setup.query("select * from public.intake_requests where id = $1", [id])).rows[0];

/** Inserta una solicitud con la fecha de llegada pedida (solo al insertar se puede fijar). */
async function requestAged(form: MadeForm, interval: string, over: Record<string, unknown> = {}) {
  const id = randomUUID();
  const created = (await setup.query<{ at: Date }>(`select ${ago(interval)} as at`)).rows[0].at;
  return insertRequest(setup, w.tenantA, form.formId, { id, created_at: created, ...over });
}

async function discarded(id: string, interval: string) {
  await setup.query(
    `update public.intake_requests set status = 'discarded', discard_reason = 'spam', discarded_by = $2,
       discarded_at = ${ago(interval)} where id = $1`,
    [id, w.owner.id],
  );
}

async function convert(id: string) {
  const quote = await createQuote(setup, w.sales, w.tenantA, w.customerA, false);
  await actAsPostgres(setup);
  await setup.query(
    `update public.intake_requests set status = 'converted', quote_id = $2, converted_by = $3, converted_at = now(),
       assigned_to = $3, assigned_at = now(), assigned_by = $3 where id = $1`,
    [id, quote, w.sales.id],
  );
  return quote;
}

describe("quién la ejecuta", () => {
  it("nadie con pase ni anon la ejecuta; la tarea programada existe y corre cada día", async () => {
    const { rows } = await setup.query(
      `select has_function_privilege('anon', 'app.purge_intake_data()', 'EXECUTE') as anon,
              has_function_privilege('authenticated', 'app.purge_intake_data()', 'EXECUTE') as auth`,
    );
    expect(rows[0]).toEqual({ anon: false, auth: false });
    const job = await setup.query(
      "select schedule, command from cron.job where jobname = 'purge-intake-data'",
    );
    expect(job.rows).toEqual([
      { schedule: "30 3 * * *", command: "select app.purge_intake_data()" },
    ]);
  });
});

describe("solicitudes que nunca se concretaron", () => {
  it("nuevas y asignadas se borran a los 12 meses, no antes", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      await actAsPostgres(setup);
      const oldNew = await requestAged(form, "12 months 1 day");
      const oldAssigned = await requestAged(form, "13 months");
      await setup.query(
        "update public.intake_requests set status = 'assigned', assigned_to = $2, assigned_at = now(), assigned_by = $2 where id = $1",
        [oldAssigned, w.sales.id],
      );
      const youngNew = await requestAged(form, "11 months 29 days");
      const today = await requestAged(form, "1 minute");
      const counts = await purge();
      expect(counts.requests_deleted).toBeGreaterThanOrEqual(2);
      expect(await exists(oldNew)).toBe(false);
      expect(await exists(oldAssigned)).toBe(false);
      expect(await exists(youngNew)).toBe(true);
      expect(await exists(today)).toBe(true);
    });
  });

  it("descartadas: a los 30 días (cuenta desde que se descartaron, no desde que llegaron)", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      await actAsPostgres(setup);
      const oldOne = await requestAged(form, "2 months");
      await discarded(oldOne, "31 days");
      const recentlyDiscarded = await requestAged(form, "2 months");
      await discarded(recentlyDiscarded, "29 days");
      const brandNew = await requestAged(form, "1 minute");
      await discarded(brandNew, "1 minute");
      await purge();
      expect(await exists(oldOne)).toBe(false);
      expect(await exists(recentlyDiscarded)).toBe(true);
      expect(await exists(brandNew)).toBe(true);
    });
  });

  it("junto con la solicitud se borran sus avisos por correo; los de otras solicitudes y los del tope se quedan", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      await actAsPostgres(setup);
      const gone = await requestAged(form, "13 months");
      const kept = await requestAged(form, "1 day");
      const goneMail = randomUUID();
      const goneAssigned = randomUUID();
      const keptMail = randomUUID();
      const capMail = randomUUID();
      await setup.query(
        "insert into public.email_messages (id, tenant_id, kind, to_email_enc, to_email_hash, provider, intake_request_id) values ($1, $2, 'request_received', 'v1.d.d', $3, 'pending', $4)",
        [goneMail, w.tenantA, sha256Hex("a"), gone],
      );
      await setup.query(
        "insert into public.email_messages (id, tenant_id, kind, to_email_enc, to_email_hash, provider, intake_request_id) values ($1, $2, 'request_assigned', 'v1.d.d', $3, 'pending', $4)",
        [goneAssigned, w.tenantA, sha256Hex("b"), gone],
      );
      await setup.query(
        "insert into public.email_messages (id, tenant_id, kind, to_email_enc, to_email_hash, provider, intake_request_id) values ($1, $2, 'request_received', 'v1.d.d', $3, 'pending', $4)",
        [keptMail, w.tenantA, sha256Hex("c"), kept],
      );
      await setup.query(
        "insert into public.email_messages (id, tenant_id, kind, to_email_enc, to_email_hash, provider, intake_form_id) values ($1, $2, 'intake_cap_reached', 'v1.d.d', $3, 'pending', $4)",
        [capMail, w.tenantA, sha256Hex("d"), form.formId],
      );
      const counts = await purge();
      expect(counts.notices_deleted).toBeGreaterThanOrEqual(2);
      const left = await setup.query<{ id: string }>(
        "select id from public.email_messages where id = any($1::uuid[])",
        [[goneMail, goneAssigned, keptMail, capMail]],
      );
      expect(left.rows.map((r) => r.id).sort()).toEqual([keptMail, capMail].sort());
    });
  });
});

describe("solicitudes convertidas", () => {
  it("a los 12 meses se anonimizan: sin datos de contacto, con los servicios, las fechas y la cotización", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      await actAsPostgres(setup);
      const old = await requestAged(form, "12 months 1 day", {
        contact_phone_enc: "v1.tel.tel",
        company_enc: "v1.emp.emp",
        comuna_enc: "v1.com.com",
        service_address_enc: "v1.dir.dir",
        message_enc: "v1.msg.msg",
        consent_ip_enc: "v1.ip.ip",
        desired_date: "2030-05-05",
      });
      const before = await rowOf(old);
      const quote = await convert(old);
      const young = await requestAged(form, "11 months 29 days");
      await convert(young);
      const counts = await purge();
      expect(counts.requests_anonymized).toBeGreaterThanOrEqual(1);
      const row = await rowOf(old);
      for (const column of [
        "contact_name_enc",
        "contact_email_enc",
        "contact_phone_enc",
        "company_enc",
        "comuna_enc",
        "service_address_enc",
        "message_enc",
        "contact_email_hash",
        "consent_ip_enc",
      ]) {
        expect(row[column], column).toBeNull();
      }
      expect(row.anonymized_at).not.toBeNull();
      expect(row).toMatchObject({
        status: "converted",
        quote_id: quote,
        items: before.items,
        form_revision: before.form_revision,
      });
      expect(row.desired_date).toEqual(before.desired_date);
      expect(row.consent_text_sha256).toBe(before.consent_text_sha256);
      // la reciente conserva todo
      const keep = await rowOf(young);
      expect(keep.anonymized_at).toBeNull();
      expect(keep.contact_name_enc).not.toBeNull();
    });
  });

  it("no se borra una convertida vieja, y anonimizar es de una sola vez", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      await actAsPostgres(setup);
      const old = await requestAged(form, "5 years");
      await convert(old);
      await purge();
      const first = await rowOf(old);
      expect(first.anonymized_at).not.toBeNull();
      const again = await purge();
      expect(again.requests_anonymized).toBe(0);
      expect((await rowOf(old)).anonymized_at).toEqual(first.anonymized_at);
    });
  });

  it("la cotización conserva su vínculo con la solicitud anonimizada", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      await actAsPostgres(setup);
      const old = await requestAged(form, "13 months");
      const quote = await convert(old);
      await setup.query("update public.quotes set source_request_id = $2 where id = $1", [
        quote,
        old,
      ]);
      await purge();
      const { rows } = await setup.query(
        "select q.source_request_id, r.anonymized_at is not null as anonymized from public.quotes q join public.intake_requests r on r.id = q.source_request_id where q.id = $1",
        [quote],
      );
      expect(rows).toEqual([{ source_request_id: old, anonymized: true }]);
    });
  });
});

describe("contadores y la función misma", () => {
  it("los contadores se borran a los 90 días, no antes, usando el día de Chile", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      await actAsPostgres(setup);
      // 91 y 200 días se van; 90, 89 y hoy se quedan
      for (const offset of [91, 200, 90, 89, 0]) {
        await setup.query(
          "insert into public.intake_daily_counters (tenant_id, form_id, day, accepted) values ($1, $2, app.business_date_of(now()) - $3::integer, 1)",
          [w.tenantA, form.formId, offset],
        );
      }
      const counts = await purge();
      expect(counts.counters_deleted).toBeGreaterThanOrEqual(2);
      const { rows } = await setup.query<{ age: number }>(
        "select (app.business_date_of(now()) - day)::integer as age from public.intake_daily_counters where form_id = $1 order by day",
        [form.formId],
      );
      expect(rows.map((r) => r.age).sort((a, b) => b - a)).toEqual([90, 89, 0]);
    });
  });

  it("devuelve el recuento, repetirla no hace nada, y el interruptor queda apagado al terminar", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      await actAsPostgres(setup);
      const old = await requestAged(form, "13 months");
      const first = await purge();
      expect(first.requests_deleted).toBeGreaterThanOrEqual(1);
      expect(await exists(old)).toBe(false);
      const second = await purge();
      expect(second).toEqual({
        requests_deleted: 0,
        notices_deleted: 0,
        requests_anonymized: 0,
        counters_deleted: 0,
      });
      const setting = (
        await setup.query<{ v: string | null }>(
          "select current_setting('app.retention_purge', true) as v",
        )
      ).rows[0].v;
      expect(setting === null || setting === "" || setting === "off").toBe(true);
      // y con el interruptor apagado, una solicitud vencida sigue sin poder borrarse a mano
      const another = await requestAged(form, "13 months");
      const error = await expectSqlError(
        setup,
        "delete from public.intake_requests where id = $1",
        [another],
      );
      expect(error.code).toBe("42501");
    });
  });

  it("respeta el interruptor que ya traía la transacción de quien la llama", async () => {
    await withTx(setup, async () => {
      await setup.query("select set_config('app.retention_purge', 'on', true)");
      await purge();
      expect(
        (
          await setup.query<{ v: string }>(
            "select current_setting('app.retention_purge', true) as v",
          )
        ).rows[0].v,
      ).toBe("on");
    });
  });
});
