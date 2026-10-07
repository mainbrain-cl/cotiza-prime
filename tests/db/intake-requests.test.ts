// Sprint 4 · migración 30 · solicitudes del formulario público, contadores del día y avisos (H-087, H-089).
// Forma de cada estado, contenido que no cambia, lista cerrada de cambios de estado, copia de servicios
// sin precios, borrado solo por plazo, privacidad de columnas y roles. Cada prueba corre en una
// transacción que se deshace.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, expectSqlError, withTx } from "./helpers";
import {
  asUser,
  buildIntakeWorld,
  CONSENT_TEXT,
  CONSENT_VERSION,
  expectFails,
  insertRequest,
  makeForm,
  requestItem,
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

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const INSUFFICIENT_PRIVILEGE = "42501";

async function formA(): Promise<MadeForm> {
  return makeForm(setup, w.owner, w.tenantA);
}

const statusOf = async (id: string) =>
  (await setup.query("select * from public.intake_requests where id = $1", [id])).rows[0];

async function quoteOfA(): Promise<string> {
  return createQuote(setup, w.sales, w.tenantA, w.customerA, false);
}

describe("la forma de cada estado", () => {
  it("una solicitud nueva queda sin responsable, con su consentimiento y sin precios", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      const id = await insertRequest(setup, w.tenantA, form.formId);
      const row = await statusOf(id);
      expect(row).toMatchObject({
        status: "new",
        assigned_to: null,
        discard_reason: null,
        quote_id: null,
        anonymized_at: null,
        consent_template_version: CONSENT_VERSION,
        consent_text: CONSENT_TEXT,
        consent_text_sha256: sha256Hex(CONSENT_TEXT),
        consent_text_unavailable: false,
      });
      expect(row.consented_at).not.toBeNull();
      expect(row.created_at).not.toBeNull();
    });
  });

  it("nueva con responsable, asignada sin responsable, descartada sin motivo y convertida sin cotización: rechazadas", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      for (const over of [
        { status: "assigned" },
        { assigned_to: w.sales.id, assigned_at: new Date(), assigned_by: w.owner.id },
        { assigned_to: w.sales.id },
        { discard_reason: "spam" },
        { discard_note: "nota sola" },
        { quote_id: randomUUID() },
        { status: "converted" },
        { status: "discarded" },
      ]) {
        const error = await expectFails(setup, () =>
          insertRequest(setup, w.tenantA, form.formId, over),
        );
        // el estado inicial lo exige un disparador (42501); la forma de cada estado, una restricción
        expect([CHECK_VIOLATION, INSUFFICIENT_PRIVILEGE], JSON.stringify(over)).toContain(
          error.code,
        );
      }
    });
  });

  it("sin nombre ni correo no hay solicitud, salvo que esté anonimizada (y eso no se hace al crear)", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      for (const over of [
        { contact_name_enc: null },
        { contact_email_enc: null },
        { contact_email_hash: null },
      ]) {
        const error = await expectFails(setup, () =>
          insertRequest(setup, w.tenantA, form.formId, over),
        );
        expect(error.code, JSON.stringify(over)).toBe(CHECK_VIOLATION);
      }
      const error = await expectFails(setup, () =>
        insertRequest(setup, w.tenantA, form.formId, {
          contact_name_enc: null,
          contact_email_enc: null,
          contact_email_hash: null,
          anonymized_at: new Date(),
        }),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it("los datos cifrados y las huellas tienen formato y largo acotados", async () => {
    const bad: [string, unknown][] = [
      ["contact_name_enc", ""],
      ["contact_name_enc", "x".repeat(2001)],
      ["message_enc", "x".repeat(12001)],
      ["contact_email_hash", "no-es-huella"],
      ["consent_text_sha256", "ABC"],
      // la huella tiene que ser la del texto, y el texto tiene largo y caracteres acotados
      ["consent_text_sha256", sha256Hex("otro texto")],
      ["consent_text", "otro texto"],
      ["consent_text", ""],
      ["consent_text", null],
      ["consent_template_version", ""],
      ["consent_template_version", "v1"],
      ["consent_template_version", "intake-v"],
      ["consent_template_version", "intake-v1 "],
      ["consent_template_version", "v".repeat(41)],
      ["consent_ip_enc", ""],
      ["form_revision", 0],
    ];
    for (const [column, value] of bad) {
      await withTx(setup, async () => {
        const form = await formA();
        await expect(
          insertRequest(setup, w.tenantA, form.formId, { [column]: value }),
          `${column}`,
        ).rejects.toMatchObject({ code: CHECK_VIOLATION });
      });
    }
    await withTx(setup, async () => {
      const form = await formA();
      await insertRequest(setup, w.tenantA, form.formId, {
        message_enc: "x".repeat(12000),
        contact_phone_enc: "v1.t.t",
        company_enc: "v1.c.c",
        comuna_enc: "v1.m.m",
        service_address_enc: "v1.d.d",
        consent_ip_enc: "v1.i.i",
        desired_date: "2026-12-24",
      });
    });
  });

  it("el formulario y la cotización tienen que ser de la MISMA organización (relación compuesta)", async () => {
    await withTx(setup, async () => {
      const otherForm = await makeForm(setup, w.ownerB, w.tenantB);
      await expect(insertRequest(setup, w.tenantA, otherForm.formId)).rejects.toMatchObject({
        code: FOREIGN_KEY_VIOLATION,
      });
    });
    await withTx(setup, async () => {
      const form = await formA();
      const id = await insertRequest(setup, w.tenantA, form.formId);
      const quoteB = await createQuote(setup, w.ownerB, w.tenantB, w.customerB, false);
      await expect(
        setup.query(
          `update public.intake_requests set status = 'converted', quote_id = $2, converted_by = $3, converted_at = now()
            where id = $1`,
          [id, quoteB, w.owner.id],
        ),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    });
  });

  it("la misma clave de envío no se repite en un formulario, pero sí en otro; una cotización sale de una sola solicitud", async () => {
    await withTx(setup, async () => {
      const one = await formA();
      const two = await formA();
      const key = randomUUID();
      await insertRequest(setup, w.tenantA, one.formId, { submit_key: key });
      await insertRequest(setup, w.tenantA, two.formId, { submit_key: key });
      await expect(
        insertRequest(setup, w.tenantA, one.formId, { submit_key: key }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });
    await withTx(setup, async () => {
      const form = await formA();
      const quote = await quoteOfA();
      const a = await insertRequest(setup, w.tenantA, form.formId);
      const b = await insertRequest(setup, w.tenantA, form.formId);
      const convert = (id: string) =>
        setup.query(
          `update public.intake_requests set status = 'converted', quote_id = $2, converted_by = $3, converted_at = now() where id = $1`,
          [id, quote, w.owner.id],
        );
      await convert(a);
      await expect(convert(b)).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });
  });
});

describe("copia congelada de los servicios (sin precios)", () => {
  const ok = () => [
    requestItem(randomUUID(), { catalog_item_id: randomUUID(), quantity_milli: 2500 }),
  ];
  const tryItems = async (items: unknown) =>
    withTx(setup, async () => {
      const form = await formA();
      return insertRequest(setup, w.tenantA, form.formId, { items });
    });

  it("acepta de 1 a 30 servicios con claves de la lista; la cantidad y el catálogo son opcionales", async () => {
    await tryItems(ok());
    await tryItems([requestItem(randomUUID(), { quantity_milli: null, catalog_item_id: null })]);
    await tryItems([{ form_item_id: randomUUID(), name: "Solo lo mínimo", unit: "km" }]);
    await tryItems(Array.from({ length: 30 }, () => requestItem(randomUUID())));
  });

  it.each([
    ["unit_price_clp", { unit_price_clp: 1000 }],
    ["price", { price: 1 }],
    ["estimate_clp", { estimate_clp: 1 }],
    ["estimado", { estimado: 1 }],
    ["cost", { cost: 1 }],
    ["tarifa", { tarifa: 1 }],
    ["margin", { margin: 1 }],
    ["total", { total: 1 }],
    ["tenant_id", { tenant_id: randomUUID() }],
  ])("rechaza la clave extra %s", async (_name, extra) => {
    await expect(tryItems([{ ...ok()[0], ...extra }])).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it("rechaza lo que no es una lista de 1 a 30 servicios, de hasta 16 kB, con valores válidos", async () => {
    const bad: unknown[] = [
      [],
      {},
      "texto",
      null,
      Array.from({ length: 31 }, () => requestItem(randomUUID())),
      ["texto"],
      [null],
      [[]],
      [requestItem("no-es-uuid")],
      [requestItem(randomUUID(), { catalog_item_id: "no-es-uuid" })],
      [requestItem(randomUUID(), { name: "" })],
      [requestItem(randomUUID(), { name: "x".repeat(151) })],
      [requestItem(randomUUID(), { name: 5 })],
      [requestItem(randomUUID(), { unit: "litro" })],
      [requestItem(randomUUID(), { quantity_milli: 0 })],
      [requestItem(randomUUID(), { quantity_milli: 1000000001 })],
      [requestItem(randomUUID(), { quantity_milli: 1.5 })],
      [requestItem(randomUUID(), { quantity_milli: "10" })],
      // 28 servicios con nombres de 150 emojis (4 bytes cada uno) superan los 16 kB
      Array.from({ length: 28 }, () =>
        requestItem(randomUUID(), { name: "\u{1F600}".repeat(150) }),
      ),
    ];
    for (const items of bad) {
      await expect(tryItems(items), JSON.stringify(items).slice(0, 80)).rejects.toMatchObject({
        code: CHECK_VIOLATION,
      });
    }
  });
});

describe("el contenido no cambia; los estados siguen una lista cerrada", () => {
  it("ninguna columna de contenido se puede editar, ni siquiera como dueño de la base", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      const id = await insertRequest(setup, w.tenantA, form.formId);
      for (const [column, value] of [
        ["contact_name_enc", "'v1.otro.otro'"],
        ["contact_email_enc", "'v1.otro.otro'"],
        ["contact_email_hash", `'${sha256Hex("otro")}'`],
        ["message_enc", "'v1.otro.otro'"],
        ["items", `'[{"form_item_id":"${randomUUID()}","name":"otro","unit":"unit"}]'::jsonb`],
        ["form_revision", "9"],
        ["submit_key", "gen_random_uuid()"],
        ["consent_template_version", "'v2'"],
        ["consent_text_sha256", `'${sha256Hex("otro")}'`],
        ["consent_text", "'otro texto'"],
        ["consent_text_unavailable", "true"],
        ["consented_at", "now() - interval '1 day'"],
        ["consent_ip_enc", "'v1.ip.ip'"],
        ["created_at", "now() - interval '1 year'"],
        ["desired_date", "'2030-01-01'"],
        ["form_id", "gen_random_uuid()"],
        ["anonymized_at", "now()"],
        ["id", "gen_random_uuid()"],
      ]) {
        const error = await expectSqlError(
          setup,
          `update public.intake_requests set ${column} = ${value} where id = $1`,
          [id],
        );
        expect(error.code, column).toBe(INSUFFICIENT_PRIVILEGE);
      }
      const error = await expectSqlError(
        setup,
        "update public.intake_requests set tenant_id = $2 where id = $1",
        [id, w.tenantB],
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it("nueva → asignada → (reasignada) → descartada → nueva; el resto de los cambios, no", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      const id = await insertRequest(setup, w.tenantA, form.formId);
      const assign = (who: string) =>
        setup.query(
          "update public.intake_requests set status = 'assigned', assigned_to = $2, assigned_at = now(), assigned_by = $3 where id = $1",
          [id, who, w.owner.id],
        );
      const sql = (text: string, params: unknown[] = [id]) => expectSqlError(setup, text, params);

      // desde nueva: no se puede pasar a nueva, ni cambiar nada sin cambiar de estado
      expect(
        (await sql("update public.intake_requests set discard_note = 'x' where id = $1")).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);

      await assign(w.sales.id);
      expect((await statusOf(id)).status).toBe("assigned");
      await assign(w.sales2.id); // reasignar
      expect((await statusOf(id)).assigned_to).toBe(w.sales2.id);
      // asignada no vuelve a nueva
      expect(
        (
          await sql(
            "update public.intake_requests set status = 'new', assigned_to = null, assigned_at = null, assigned_by = null where id = $1",
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);

      // descartar
      await setup.query(
        `update public.intake_requests set status = 'discarded', discard_reason = 'spam', discard_note = 'basura',
           discarded_by = $2, discarded_at = now() where id = $1`,
        [id, w.sales2.id],
      );
      // descartada no se reasigna ni se convierte ni se vuelve a descartar con otro motivo
      expect(
        (
          await sql(
            "update public.intake_requests set status = 'assigned', assigned_to = $2, assigned_at = now(), assigned_by = $2 where id = $1",
            [id, w.sales.id],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        (await sql("update public.intake_requests set discard_reason = 'other' where id = $1"))
          .code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      // restaurar: vuelve a nueva sin responsable ni motivo
      await setup.query(
        `update public.intake_requests set status = 'new', assigned_to = null, assigned_at = null, assigned_by = null,
           discard_reason = null, discard_note = null, discarded_by = null, discarded_at = null where id = $1`,
        [id],
      );
      expect(await statusOf(id)).toMatchObject({
        status: "new",
        assigned_to: null,
        discard_reason: null,
      });
    });
  });

  it("convertida es definitiva: no se descarta, no se reasigna y no cambia de cotización", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      const quote = await quoteOfA();
      const other = await quoteOfA();
      const id = await insertRequest(setup, w.tenantA, form.formId);
      await setup.query(
        `update public.intake_requests set status = 'converted', quote_id = $2, converted_by = $3, converted_at = now(),
           assigned_to = $3, assigned_at = now(), assigned_by = $3 where id = $1`,
        [id, quote, w.owner.id],
      );
      for (const sql of [
        `update public.intake_requests set status = 'new', quote_id = null, converted_by = null, converted_at = null where id = $1`,
        `update public.intake_requests set status = 'discarded', discard_reason = 'spam', discarded_by = '${w.owner.id}', discarded_at = now() where id = $1`,
        `update public.intake_requests set status = 'assigned' where id = $1`,
        `update public.intake_requests set quote_id = '${other}' where id = $1`,
        `update public.intake_requests set converted_by = '${w.admin.id}' where id = $1`,
        `update public.intake_requests set assigned_to = '${w.sales.id}' where id = $1`,
      ]) {
        const error = await expectSqlError(setup, sql, [id]);
        expect([INSUFFICIENT_PRIVILEGE, CHECK_VIOLATION], sql).toContain(error.code);
      }
    });
  });

  it("nada se borra ni se vacía con TRUNCATE; solo la limpieza por plazo borra, y solo lo vencido", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      const id = await insertRequest(setup, w.tenantA, form.formId);
      expect(
        (await expectSqlError(setup, "delete from public.intake_requests where id = $1", [id]))
          .code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await expectSqlError(setup, "truncate public.intake_requests cascade")).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      // con el interruptor de la limpieza pero sin estar vencida: tampoco
      await setup.query("select set_config('app.retention_purge', 'on', true)");
      expect(
        (await expectSqlError(setup, "delete from public.intake_requests where id = $1", [id]))
          .code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it("vencidas: nuevas o asignadas a los 12 meses y descartadas a los 30 días se pueden borrar; antes, no", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      const old = await insertRequest(setup, w.tenantA, form.formId, {
        created_at: new Date(Date.now() - 13 * 31 * 86_400_000),
      });
      const young = await insertRequest(setup, w.tenantA, form.formId, {
        created_at: new Date(Date.now() - 10 * 31 * 86_400_000),
      });
      const discard = async (id: string, daysAgo: number) =>
        setup.query(
          `update public.intake_requests set status = 'discarded', discard_reason = 'spam', discarded_by = $2,
             discarded_at = now() - make_interval(days => $3) where id = $1`,
          [id, w.owner.id, daysAgo],
        );
      const discardedOld = await insertRequest(setup, w.tenantA, form.formId);
      const discardedYoung = await insertRequest(setup, w.tenantA, form.formId);
      await discard(discardedOld, 31);
      await discard(discardedYoung, 10);
      await setup.query("select set_config('app.retention_purge', 'on', true)");
      const count = async (id: string) =>
        (await setup.query("select 1 from public.intake_requests where id = $1", [id])).rowCount;
      await setup.query("delete from public.intake_requests where id = any($1::uuid[])", [
        [old, discardedOld],
      ]);
      expect(await count(old)).toBe(0);
      expect(await count(discardedOld)).toBe(0);
      for (const id of [young, discardedYoung]) {
        expect(
          (await expectSqlError(setup, "delete from public.intake_requests where id = $1", [id]))
            .code,
        ).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });
  });

  it("anonimizar (vaciar los datos de contacto) solo en la limpieza, solo convertidas de más de 12 meses y solo vaciando", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      const quote = await quoteOfA();
      const id = await insertRequest(setup, w.tenantA, form.formId, {
        created_at: new Date(Date.now() - 13 * 31 * 86_400_000),
        message_enc: "v1.mensaje.mensaje",
        consent_ip_enc: "v1.ip.ip",
      });
      const youngQuote = await quoteOfA();
      const young = await insertRequest(setup, w.tenantA, form.formId);
      await setup.query(
        `update public.intake_requests set status = 'converted', quote_id = $2, converted_by = $3, converted_at = now() where id = $1`,
        [id, quote, w.owner.id],
      );
      await setup.query(
        `update public.intake_requests set status = 'converted', quote_id = $2, converted_by = $3, converted_at = now() where id = $1`,
        [young, youngQuote, w.owner.id],
      );
      const anonymize = `update public.intake_requests set contact_name_enc = null, contact_email_enc = null,
        contact_phone_enc = null, company_enc = null, comuna_enc = null, service_address_enc = null, message_enc = null,
        contact_email_hash = null, consent_ip_enc = null, anonymized_at = now() where id = $1`;
      // sin el interruptor, no
      expect((await expectSqlError(setup, anonymize, [id])).code).toBe(INSUFFICIENT_PRIVILEGE);
      await setup.query("select set_config('app.retention_purge', 'on', true)");
      // una convertida reciente, no
      expect((await expectSqlError(setup, anonymize, [young])).code).toBe(INSUFFICIENT_PRIVILEGE);
      // cambiar otra cosa mientras se anonimiza, no
      expect(
        (
          await expectSqlError(
            setup,
            `update public.intake_requests set contact_name_enc = 'v1.nuevo.nuevo', anonymized_at = now() where id = $1`,
            [id],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        (
          await expectSqlError(
            setup,
            `update public.intake_requests set contact_name_enc = null, contact_email_enc = null, contact_email_hash = null,
               items = '[{"form_item_id":"${randomUUID()}","name":"otro","unit":"unit"}]'::jsonb, anonymized_at = now() where id = $1`,
            [id],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      // la legítima
      await setup.query(anonymize, [id]);
      const row = await statusOf(id);
      expect(row.anonymized_at).not.toBeNull();
      expect(row.contact_name_enc).toBeNull();
      expect(row.message_enc).toBeNull();
      expect(row.items).toHaveLength(1); // los servicios y las fechas se conservan
      expect(row.status).toBe("converted");
      // y no se vuelve a anonimizar ni a rellenar
      expect(
        (
          await expectSqlError(
            setup,
            `update public.intake_requests set contact_name_enc = 'v1.x.x' where id = $1`,
            [id],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });
});

describe("quién lee qué", () => {
  it("todos los miembros leen las solicitudes de su organización y nadie las de otra; la IP del consentimiento, nadie", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      const id = await insertRequest(setup, w.tenantA, form.formId, { consent_ip_enc: "v1.ip.ip" });
      for (const user of [w.owner, w.admin, w.sales, w.approver, w.viewer]) {
        await asUser(setup, user, w.tenantA);
        const { rows } = await setup.query(
          "select id, contact_name_enc, contact_email_enc, items, consent_text_sha256 from public.intake_requests where id = $1",
          [id],
        );
        expect(rows, user.email).toHaveLength(1);
        expect(
          (await expectSqlError(setup, "select consent_ip_enc from public.intake_requests")).code,
        ).toBe(INSUFFICIENT_PRIVILEGE);
        expect((await expectSqlError(setup, "select * from public.intake_requests")).code).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        expect(
          (
            await expectSqlError(
              setup,
              "select id from public.intake_requests where consent_ip_enc is not null",
            )
          ).code,
        ).toBe(INSUFFICIENT_PRIVILEGE);
      }
      for (const header of [w.tenantA, w.tenantB]) {
        await asUser(setup, w.ownerB, header);
        expect((await setup.query("select id from public.intake_requests")).rows).toEqual([]);
      }
      await actAsPostgres(setup);
    });
  });

  it("los contadores del día los ven solo el Dueño y el Administrador", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      await setup.query(
        "insert into public.intake_daily_counters (tenant_id, form_id, day, accepted) values ($1, $2, current_date, 3)",
        [w.tenantA, form.formId],
      );
      for (const [user, expected] of [
        [w.owner, 1],
        [w.admin, 1],
        [w.sales, 0],
        [w.approver, 0],
        [w.viewer, 0],
      ] as const) {
        await asUser(setup, user, w.tenantA);
        const { rows } = await setup.query("select accepted from public.intake_daily_counters");
        expect(rows, user.email).toHaveLength(expected);
      }
      await asUser(setup, w.ownerB, w.tenantB);
      expect((await setup.query("select 1 from public.intake_daily_counters")).rows).toEqual([]);
      await actAsPostgres(setup);
    });
  });

  it("nadie con pase escribe en solicitudes ni contadores", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      const id = await insertRequest(setup, w.tenantA, form.formId);
      await setup.query(
        "insert into public.intake_daily_counters (tenant_id, form_id, day) values ($1, $2, current_date)",
        [w.tenantA, form.formId],
      );
      await asUser(setup, w.owner, w.tenantA);
      for (const sql of [
        `update public.intake_requests set status = 'discarded' where id = '${id}'`,
        `delete from public.intake_requests where id = '${id}'`,
        `insert into public.intake_requests (id, tenant_id) values (gen_random_uuid(), '${w.tenantA}')`,
        `update public.intake_daily_counters set accepted = 0`,
        `delete from public.intake_daily_counters`,
        `insert into public.intake_daily_counters (tenant_id, form_id, day) values ('${w.tenantA}', '${form.formId}', current_date + 1)`,
      ]) {
        expect((await expectSqlError(setup, sql)).code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });
  });

  it("un contador de otro formulario u organización no existe (relación compuesta)", async () => {
    await withTx(setup, async () => {
      const otherForm = await makeForm(setup, w.ownerB, w.tenantB);
      await expect(
        setup.query(
          "insert into public.intake_daily_counters (tenant_id, form_id, day) values ($1, $2, current_date)",
          [w.tenantA, otherForm.formId],
        ),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    });
  });
});

describe("límites de intentos y avisos por correo", () => {
  it("los cuatro alcances nuevos del limitador existen y uno inventado, no", async () => {
    await withTx(setup, async () => {
      for (const scope of [
        "intake_read_ip",
        "intake_submit_ip",
        "intake_submit_ip_day",
        "intake_submit_form",
      ]) {
        await setup.query("insert into public.auth_rate_limits (scope, key_hash) values ($1, $2)", [
          scope,
          sha256Hex(scope),
        ]);
      }
      await expect(
        setup.query(
          "insert into public.auth_rate_limits (scope, key_hash) values ('intake_otro', $1)",
          [sha256Hex("x")],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  const insertMail = (over: Record<string, unknown>) => {
    const columns: Record<string, unknown> = {
      id: randomUUID(),
      tenant_id: w.tenantA,
      to_email_enc: "v1.to.to",
      to_email_hash: sha256Hex("destino"),
      provider: "pending",
      ...over,
    };
    const names = Object.keys(columns);
    return setup.query(
      `insert into public.email_messages (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      names.map((n) => columns[n]),
    );
  };

  it("cada tipo de correo exige lo suyo: cotización y paquete, la solicitud, o el formulario", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      const request = await insertRequest(setup, w.tenantA, form.formId);
      // los de solicitud
      await insertMail({ kind: "request_received", intake_request_id: request });
      await insertMail({ kind: "request_assigned", intake_request_id: request });
      await insertMail({ kind: "intake_cap_reached", intake_form_id: form.formId });
      for (const over of [
        { kind: "request_received" },
        { kind: "request_received", intake_request_id: request, intake_form_id: form.formId },
        { kind: "request_assigned", intake_form_id: form.formId },
        { kind: "intake_cap_reached", intake_request_id: request },
        { kind: "intake_cap_reached" },
        { kind: "quote" },
        { kind: "internal_notice", intake_request_id: request },
        { kind: "otro_tipo", intake_request_id: request },
      ]) {
        const error = await expectFails(setup, () => insertMail(over));
        expect(error.code, JSON.stringify(over)).toBe(CHECK_VIOLATION);
      }
    });
  });

  it("los avisos de solicitud solo apuntan a solicitudes y formularios de su propia organización", async () => {
    await withTx(setup, async () => {
      const otherForm = await makeForm(setup, w.ownerB, w.tenantB);
      const otherRequest = await insertRequest(setup, w.tenantB, otherForm.formId);
      await expect(
        insertMail({ kind: "request_received", intake_request_id: otherRequest }),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    });
    await withTx(setup, async () => {
      const otherForm = await makeForm(setup, w.ownerB, w.tenantB);
      await expect(
        insertMail({ kind: "intake_cap_reached", intake_form_id: otherForm.formId }),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    });
  });

  it("el registro de correos sigue siendo de solo agregar; solo la limpieza borra avisos de solicitud", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      const request = await insertRequest(setup, w.tenantA, form.formId);
      const mailId = randomUUID();
      await insertMail({ id: mailId, kind: "request_received", intake_request_id: request });
      const capId = randomUUID();
      await insertMail({ id: capId, kind: "intake_cap_reached", intake_form_id: form.formId });
      expect(
        (await expectSqlError(setup, "delete from public.email_messages where id = $1", [mailId]))
          .code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      await setup.query("select set_config('app.retention_purge', 'on', true)");
      // con la limpieza encendida, un aviso de una solicitud que NO venció tampoco se borra (menor 9)
      expect(
        (await expectSqlError(setup, "delete from public.email_messages where id = $1", [mailId]))
          .code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      // el de una solicitud vencida, sí
      const oldRequest = await insertRequest(setup, w.tenantA, form.formId, {
        created_at: new Date(Date.now() - 13 * 31 * 86_400_000),
      });
      const oldMailId = randomUUID();
      await insertMail({ id: oldMailId, kind: "request_assigned", intake_request_id: oldRequest });
      await setup.query("delete from public.email_messages where id = $1", [oldMailId]);
      expect(
        (await setup.query("select 1 from public.email_messages where id = $1", [oldMailId])).rows,
      ).toHaveLength(0);
      // una descartada hace más de 30 días, también
      const discarded = await insertRequest(setup, w.tenantA, form.formId);
      await setup.query(
        `update public.intake_requests set status = 'discarded', discard_reason = 'spam', discarded_by = $2,
           discarded_at = now() - interval '31 days' where id = $1`,
        [discarded, w.owner.id],
      );
      const discardedMail = randomUUID();
      await insertMail({
        id: discardedMail,
        kind: "request_received",
        intake_request_id: discarded,
      });
      await setup.query("delete from public.email_messages where id = $1", [discardedMail]);
      // el del tope no es de una solicitud: tampoco se borra en la limpieza de solicitudes
      expect(
        (await expectSqlError(setup, "delete from public.email_messages where id = $1", [capId]))
          .code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it("los estados del correo siguen avanzando solo hacia adelante para los avisos nuevos", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      const request = await insertRequest(setup, w.tenantA, form.formId);
      const id = randomUUID();
      await insertMail({ id, kind: "request_assigned", intake_request_id: request });
      await setup.query(
        "update public.email_messages set status = 'sent', provider = 'memory', provider_message_id = 'p1' where id = $1",
        [id],
      );
      expect(
        (
          await expectSqlError(
            setup,
            "update public.email_messages set status = 'pending' where id = $1",
            [id],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        (
          await expectSqlError(
            setup,
            "update public.email_messages set intake_request_id = null where id = $1",
            [id],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });
});

describe("la tabla de solicitudes no guarda dinero", () => {
  it("ninguna columna de las tablas del formulario público ni de las solicitudes parece de precio o costo", async () => {
    const { rows } = await setup.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public'
          and table_name in ('intake_forms', 'intake_form_items', 'intake_requests', 'intake_daily_counters')`,
    );
    expect(rows.length).toBeGreaterThan(40);
    for (const { table_name, column_name } of rows) {
      expect(`${table_name}.${column_name}`).not.toMatch(
        /price|cost|clp|tarif|amount|margin|estimate/i,
      );
    }
  });
});

describe("el consentimiento se puede comprobar después", () => {
  // Una fila rechazada aborta la transacción: cada intento va en la suya.
  const rejected = (over: Record<string, unknown>) =>
    withTx(setup, async () => {
      const form = await formA();
      await expect(insertRequest(setup, w.tenantA, form.formId, over)).rejects.toMatchObject({
        code: CHECK_VIOLATION,
      });
    });

  it("el texto guardado tiene que ser el que da la huella, con largo y caracteres acotados", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      const long = "a".repeat(3000);
      const id = await insertRequest(setup, w.tenantA, form.formId, {
        consent_text: long,
        consent_text_sha256: sha256Hex(long),
      });
      expect((await statusOf(id)).consent_text).toBe(long);
    });
    const tooLong = "a".repeat(3001);
    await rejected({ consent_text: tooLong, consent_text_sha256: sha256Hex(tooLong) });
    const disguised = "Acepto‮texto";
    await rejected({ consent_text: disguised, consent_text_sha256: sha256Hex(disguised) });
  });

  it("una fila anterior a la migración (sin texto) se marca como no disponible y no se inventa el texto", async () => {
    await withTx(setup, async () => {
      const form = await formA();
      const id = await insertRequest(setup, w.tenantA, form.formId, {
        consent_text: null,
        consent_text_unavailable: true,
        consent_template_version: "v1",
        consent_text_sha256: sha256Hex("texto que ya no se tiene"),
      });
      expect(await statusOf(id)).toMatchObject({
        consent_text: null,
        consent_text_unavailable: true,
        consent_template_version: "v1",
      });
    });
    // Marcar «no disponible» no sirve para esquivar la regla en una fila con texto, ni al revés.
    await rejected({ consent_text_unavailable: true });
    await rejected({ consent_text: null });
  });
});
