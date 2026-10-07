// Sprint 4 · migración 31 · funciones del formulario público, solo del servidor (H-087, H-092).
// Lectura sin precios, envío con todas sus defensas (la organización sale del formulario, los servicios se
// revalidan, el tope va dentro de la transacción), contadores en hora de Chile, bloqueos y avisos sin datos
// del visitante. Cada prueba corre en una transacción que se deshace.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsAnon, actAsPostgres, connect, expectSqlError, withTx } from "./helpers";
import {
  buildIntakeWorld,
  callAs,
  CONSENT_TEXT,
  CONSENT_VERSION,
  callAsServer,
  catalogItem,
  expectFails,
  freeItem,
  insertRequest,
  makeForm,
  sha256Hex,
  submitAsServer,
  submitParams,
  SUBMIT_SQL,
  type IntakeWorld,
  type MadeForm,
  type SubmitArgs,
} from "./intake-helpers";
import { actAsService, asUser } from "./send-helpers";

let setup: Client;
let w: IntakeWorld;
beforeAll(async () => {
  setup = await connect();
  w = await buildIntakeWorld(setup);
});
afterAll(async () => {
  await setup.end();
});

type Json = Record<string, unknown>;
const READ = "select public.intake_form_read($1) as r";
const read = (publicId: string) => callAsServer<Json>(setup, READ, [publicId]);
const INTERNAL_NAME = "Nombre interno reservado";
const FORBIDDEN_KEY = /price|cost|clp|tarif|amount|margin/i;

/** Todas las claves de un JSON, a cualquier profundidad. */
function allKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, into));
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      into.push(key);
      allKeys(inner, into);
    }
  }
  return into;
}

interface Fixture {
  form: MadeForm;
  free: ReturnType<typeof freeItem>;
  catalog: ReturnType<typeof catalogItem>;
}

/** Un formulario publicado con un servicio libre y uno de catálogo (cantidad obligatoria entre 1 y 50). */
async function publishedForm(options: { form?: Json; extra?: object[] } = {}): Promise<Fixture> {
  const free = freeItem({ public_name: "Flete urbano", quantity_mode: "optional" });
  const catalog = catalogItem(w.catalogA, {
    public_name: "Traslado de catálogo",
    quantity_mode: "required",
    min_qty_milli: 1000,
    max_qty_milli: 50000,
  });
  const form = await makeForm(setup, w.owner, w.tenantA, {
    items: [free, catalog, ...(options.extra ?? [])],
    name: INTERNAL_NAME,
    form: { title: "Pide tu flete", ...options.form },
  });
  return { form, free, catalog };
}

const args = (fx: Fixture, over: Partial<SubmitArgs> = {}): SubmitArgs => ({
  publicId: fx.form.publicId,
  revision: fx.form.revision,
  items: [{ form_item_id: fx.free.id, quantity_milli: 2000 }],
  ...over,
});

const countersOf = async (formId: string) =>
  (await setup.query("select * from public.intake_daily_counters where form_id = $1", [formId]))
    .rows[0] as Record<string, number> | undefined;
const requestsOf = async (formId: string) =>
  (
    await setup.query(
      "select * from public.intake_requests where form_id = $1 order by created_at",
      [formId],
    )
  ).rows;

describe("quién puede llamarlas: solo el servidor", () => {
  const FUNCTIONS = [
    "intake_form_read(text)",
    "intake_request_submit(text, uuid, uuid, integer, text, text, text, text, text, text, text, text, date, jsonb, text, text, text)",
    "intake_record_block(text, text)",
    "intake_notice_recipients(uuid, text, uuid)",
    "intake_notice_register(uuid, uuid, text, uuid, text, text, uuid)",
    "intake_notice_settle(uuid, text, text, text)",
  ];

  it("las seis solo las ejecuta service_role: ni anon, ni authenticated, ni el público en general", async () => {
    for (const fn of FUNCTIONS) {
      const { rows } = await setup.query(
        `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') as auth,
                has_function_privilege('service_role', $1, 'EXECUTE') as service`,
        [`public.${fn}`],
      );
      expect(rows[0], fn).toEqual({ anon: false, auth: false, service: true });
    }
  });

  it("una persona con sesión, incluso Dueño, y un visitante anónimo reciben 'permission denied'", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const submit = submitParams(args(fx));
      await asUser(setup, w.owner, w.tenantA);
      for (const [sql, params] of [
        [READ, [fx.form.publicId]],
        [SUBMIT_SQL, submit],
        ["select public.intake_record_block($1, 'rate') as r", [fx.form.publicId]],
        [
          "select public.intake_notice_recipients($1, 'request_received', null) as r",
          [randomUUID()],
        ],
      ] as const) {
        expect((await expectSqlError(setup, sql, [...params])).code, sql).toBe("42501");
      }
      await actAsAnon(setup);
      for (const [sql, params] of [
        [READ, [fx.form.publicId]],
        [SUBMIT_SQL, submit],
      ] as const) {
        expect((await expectSqlError(setup, sql, [...params])).code, sql).toBe("42501");
      }
      await actAsPostgres(setup);
    });
  });
});

describe("intake_form_read", () => {
  it("entrega lo que ve el visitante, sin ninguna clave de dinero, y solo lee", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm({
        form: {
          intro: "Cuéntanos qué necesitas",
          privacy_policy_url: "https://mi-empresa.cl/privacidad",
          embed_origins: ["https://mi-sitio.cl"],
        },
      });
      await actAsPostgres(setup);
      await setup.query(
        "update public.tenants set brand_primary_color = '#112233', brand_secondary_color = '#445566', logo_path = $2 where tenant_id = $1",
        [w.tenantA, `${w.tenantA}/logo-abcdef012345.png`],
      );
      const before = (
        await setup.query("select count(*)::int as n from public.intake_daily_counters")
      ).rows[0].n;
      const result = await read(fx.form.publicId);
      expect(result).toMatchObject({
        state: "ok",
        tenant_id: w.tenantA,
        form_id: fx.form.formId,
        revision: fx.form.revision,
        intro: "Cuéntanos qué necesitas",
        privacy_policy_url: "https://mi-empresa.cl/privacidad",
        embed_origins: ["https://mi-sitio.cl"],
        org: { contact_email: "contacto@ejemplo.test" },
        brand: { primary_color: "#112233", secondary_color: "#445566" },
        logo_path: `${w.tenantA}/logo-abcdef012345.png`,
      });
      const items = result.items as Json[];
      expect(items.map((i) => i.name)).toEqual(["Flete urbano", "Traslado de catálogo"]);
      expect(items[1]).toMatchObject({
        unit: "service",
        quantity_mode: "required",
        min_qty_milli: 1000,
        max_qty_milli: 50000,
      });
      // lo que NO sale: el servicio del catálogo al que apunta, el tope, el nombre interno, el autor, el precio
      const text = JSON.stringify(result);
      for (const secret of [
        w.catalogA,
        "daily_cap",
        "catalog_item_id",
        "created_by",
        INTERNAL_NAME,
        "7314829",
        w.owner.id,
      ]) {
        expect(text, secret).not.toContain(secret);
      }
      // y ninguna clave, a ninguna profundidad, parece de dinero (plan §7)
      const keys = allKeys(result);
      expect(keys.length).toBeGreaterThan(15);
      for (const key of keys) expect(key, key).not.toMatch(FORBIDDEN_KEY);
      // leer no escribe
      expect(
        (await setup.query("select count(*)::int as n from public.intake_daily_counters")).rows[0]
          .n,
      ).toBe(before);
    });
  });

  it("solo entrega los servicios activos, en el orden de la pantalla", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm({
        extra: [
          freeItem({ public_name: "Oculto", is_active: false }),
          freeItem({ public_name: "Último" }),
        ],
      });
      const items = ((await read(fx.form.publicId)).items as Json[]).map((i) => i.name);
      expect(items).toEqual(["Flete urbano", "Traslado de catálogo", "Último"]);
    });
  });

  it("borrador, archivado, identificador mal formado o inexistente, y organización archivada: not_found", async () => {
    await withTx(setup, async () => {
      const draft = await makeForm(setup, w.owner, w.tenantA, { publish: false });
      expect(await read(draft.publicId)).toEqual({ state: "not_found" });
      const archived = await makeForm(setup, w.owner, w.tenantA);
      await callAs(
        setup,
        w.owner,
        w.tenantA,
        "select public.set_intake_form_status($1, 'archived') as r",
        [archived.formId],
      );
      expect(await read(archived.publicId)).toEqual({ state: "not_found" });
      for (const id of ["corto", "x".repeat(23), "", "a".repeat(21) + "!", "a".repeat(22)]) {
        expect(await read(id), id).toEqual({ state: "not_found" });
      }
      expect(await callAsServer(setup, READ, [null])).toEqual({ state: "not_found" });
      const live = await makeForm(setup, w.owner, w.tenantA);
      await actAsPostgres(setup);
      await setup.query(
        "update public.tenants set status = 'archived', archived_at = now() where tenant_id = $1",
        [w.tenantA],
      );
      expect(await read(live.publicId)).toEqual({ state: "not_found" });
    });
  });

  it("en pausa entrega el contacto, la marca y los sitios autorizados (para el marco), pero ni servicios ni campos", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm({ form: { embed_origins: ["https://mi-sitio.cl"] } });
      await callAs(
        setup,
        w.owner,
        w.tenantA,
        "select public.set_intake_form_status($1, 'paused') as r",
        [fx.form.formId],
      );
      const result = await read(fx.form.publicId);
      expect(result.state).toBe("paused");
      expect(result).toHaveProperty("org");
      expect(result.embed_origins).toEqual(["https://mi-sitio.cl"]);
      for (const key of ["items", "fields", "intro", "revision"])
        expect(result).not.toHaveProperty(key);
      for (const key of allKeys(result)) expect(key).not.toMatch(FORBIDDEN_KEY);
    });
  });

  it("al regenerar el enlace, el identificador anterior da not_found y el nuevo funciona", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const { public_id: next } = await callAs<{ public_id: string }>(
        setup,
        w.owner,
        w.tenantA,
        "select public.regenerate_intake_form_public_id($1) as r",
        [fx.form.formId],
      );
      expect(await read(fx.form.publicId)).toEqual({ state: "not_found" });
      expect((await read(next)).state).toBe("ok");
      expect((await submitAsServer(setup, args(fx))).result).toBe("not_found");
    });
  });
});

describe("intake_request_submit · el camino feliz", () => {
  it("guarda la solicitud en la organización del formulario, reescribe los servicios desde la base y cuenta", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm({
        form: {
          fields: {
            phone: "optional",
            company: "optional",
            comuna: "optional",
            serviceAddress: "optional",
            desiredDate: "optional",
            message: "optional",
          },
        },
      });
      const requestId = randomUUID();
      const result = await submitAsServer(
        setup,
        args(fx, {
          requestId,
          items: [
            { form_item_id: fx.free.id, quantity_milli: null },
            { form_item_id: fx.catalog.id, quantity_milli: 5500 },
          ],
          over: {
            phone: "v1.tel.tel",
            company: "v1.emp.emp",
            comuna: "v1.com.com",
            address: "v1.dir.dir",
            message: "v1.msg.msg",
            consentIp: "v1.ip.ip",
          },
        }),
      );
      expect(result).toMatchObject({
        result: "ok",
        replayed: false,
        request_id: requestId,
        tenant_id: w.tenantA,
        form_id: fx.form.formId,
      });
      const [row] = await requestsOf(fx.form.formId);
      expect(row).toMatchObject({
        id: requestId,
        tenant_id: w.tenantA,
        status: "new",
        form_revision: fx.form.revision,
        consent_template_version: CONSENT_VERSION,
        consent_text: CONSENT_TEXT,
        consent_text_sha256: sha256Hex(CONSENT_TEXT),
        consent_text_unavailable: false,
        consent_ip_enc: "v1.ip.ip",
        contact_phone_enc: "v1.tel.tel",
        message_enc: "v1.msg.msg",
      });
      expect(row.items).toEqual([
        {
          form_item_id: fx.free.id,
          catalog_item_id: null,
          name: "Flete urbano",
          unit: "service",
          quantity_milli: null,
        },
        {
          form_item_id: fx.catalog.id,
          catalog_item_id: w.catalogA,
          name: "Traslado de catálogo",
          unit: "service",
          quantity_milli: 5500,
        },
      ]);
      // el precio del catálogo (7314829) no está por ninguna parte
      expect(JSON.stringify(row)).not.toContain("7314829");
      expect(await countersOf(fx.form.formId)).toMatchObject({
        accepted: 1,
        blocked_cap: 0,
        blocked_rate: 0,
      });
    });
  });

  it("deja un registro de auditoría de la parte pública, sin IP ni datos del visitante", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const requestId = randomUUID();
      await submitAsServer(
        setup,
        args(fx, { requestId, over: { name: "v1.secreto.secreto", email: "v1.correo.secreto" } }),
      );
      const { rows } = await setup.query(
        "select actor_type, actor_user_id, result, origin_ip, details from public.audit_log where resource_id = $1",
        [requestId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_type: "public",
        actor_user_id: null,
        result: "success",
        origin_ip: null,
      });
      expect(JSON.stringify(rows[0].details)).not.toContain("secreto");
      expect(Object.keys(rows[0].details).sort()).toEqual(["form_id", "form_revision"]);
    });
  });

  it("el mismo envío repetido (misma clave) devuelve la misma solicitud, incluso con el formulario ya en pausa", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const submitKey = randomUUID();
      const first = await submitAsServer(setup, args(fx, { submitKey }));
      const again = await submitAsServer(setup, args(fx, { submitKey }));
      expect(again).toMatchObject({ result: "ok", replayed: true, request_id: first.request_id });
      await callAs(
        setup,
        w.owner,
        w.tenantA,
        "select public.set_intake_form_status($1, 'paused') as r",
        [fx.form.formId],
      );
      expect(await submitAsServer(setup, args(fx, { submitKey }))).toMatchObject({
        result: "ok",
        replayed: true,
      });
      expect(await requestsOf(fx.form.formId)).toHaveLength(1);
      expect((await countersOf(fx.form.formId))?.accepted).toBe(1);
    });
  });

  it("una misma clave de envío en OTRO formulario es otra solicitud", async () => {
    await withTx(setup, async () => {
      const one = await publishedForm();
      const two = await publishedForm();
      const submitKey = randomUUID();
      const a = await submitAsServer(setup, args(one, { submitKey }));
      const b = await submitAsServer(setup, args(two, { submitKey }));
      expect(a.request_id).not.toBe(b.request_id);
      expect(a.replayed).toBe(false);
      expect(b.replayed).toBe(false);
    });
  });
});

describe("intake_request_submit · lo que no se recibe", () => {
  it("pausado, borrador, archivado, inexistente o de una organización archivada: no guarda nada", async () => {
    await withTx(setup, async () => {
      const paused = await publishedForm();
      await callAs(
        setup,
        w.owner,
        w.tenantA,
        "select public.set_intake_form_status($1, 'paused') as r",
        [paused.form.formId],
      );
      expect(await submitAsServer(setup, args(paused))).toMatchObject({ result: "paused" });
      expect((await countersOf(paused.form.formId))?.blocked_paused).toBe(1);

      const draft = await makeForm(setup, w.owner, w.tenantA, { publish: false });
      const draftArgs = {
        publicId: draft.publicId,
        revision: draft.revision,
        items: [{ form_item_id: draft.itemIds[0], quantity_milli: null }],
      };
      expect((await submitAsServer(setup, draftArgs)).result).toBe("not_found");
      const missing = await submitAsServer(setup, { ...draftArgs, publicId: "A".repeat(22) });
      expect(missing.result).toBe("not_found");
      expect((await submitAsServer(setup, { ...draftArgs, publicId: "corto" })).result).toBe(
        "not_found",
      );
      expect(await requestsOf(draft.formId)).toHaveLength(0);
      expect(await countersOf(draft.formId)).toBeUndefined();
    });
  });

  it("un formulario que el administrador editó mientras la persona lo llenaba: form_changed, y con la revisión nueva sí pasa", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const saved = await callAs<{ revision: number }>(
        setup,
        w.owner,
        w.tenantA,
        "select public.save_intake_form($1, $2, $3::jsonb, null) as r",
        [fx.form.formId, fx.form.revision, JSON.stringify({ title: "Nuevo título" })],
      );
      const stale = await submitAsServer(setup, args(fx));
      expect(stale).toMatchObject({ result: "form_changed", revision: saved.revision });
      expect(await requestsOf(fx.form.formId)).toHaveLength(0);
      expect((await submitAsServer(setup, args(fx, { revision: saved.revision }))).result).toBe(
        "ok",
      );
    });
  });

  it("servicios de OTRO formulario, inactivos, repetidos o desconocidos: invalid_items, sin guardar y contados", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm({
        extra: [freeItem({ public_name: "Apagado", is_active: false })],
      });
      const other = await makeForm(setup, w.owner, w.tenantA);
      const otherTenant = await makeForm(setup, w.ownerB, w.tenantB);
      const inactive = (
        (
          await setup.query(
            "select id from public.intake_form_items where form_id = $1 and not is_active",
            [fx.form.formId],
          )
        ).rows[0] as { id: string }
      ).id;
      const cases: [string, SubmitArgs["items"]][] = [
        [
          "de otro formulario de la organización",
          [{ form_item_id: other.itemIds[0], quantity_milli: null }],
        ],
        ["de otra organización", [{ form_item_id: otherTenant.itemIds[0], quantity_milli: null }]],
        ["inactivo", [{ form_item_id: inactive, quantity_milli: null }]],
        [
          "repetido",
          [
            { form_item_id: fx.free.id, quantity_milli: null },
            { form_item_id: fx.free.id, quantity_milli: null },
          ],
        ],
        ["desconocido", [{ form_item_id: randomUUID(), quantity_milli: null }]],
        [
          "con un bueno y uno ajeno",
          [
            { form_item_id: fx.free.id, quantity_milli: null },
            { form_item_id: other.itemIds[0], quantity_milli: null },
          ],
        ],
      ];
      for (const [label, items] of cases) {
        expect((await submitAsServer(setup, args(fx, { items }))).result, label).toBe(
          "invalid_items",
        );
      }
      expect(await requestsOf(fx.form.formId)).toHaveLength(0);
      expect((await countersOf(fx.form.formId))?.blocked_invalid).toBe(cases.length);
      // ni el formulario ajeno ni el de otra organización recibieron nada
      expect(await requestsOf(other.formId)).toHaveLength(0);
      expect(await requestsOf(otherTenant.formId)).toHaveLength(0);
    });
  });

  it("la cantidad respeta el modo de cada servicio: ninguna, opcional u obligatoria, y sus límites", async () => {
    await withTx(setup, async () => {
      const none = freeItem({ public_name: "Sin cantidad", quantity_mode: "none" });
      const fx = await publishedForm({ extra: [none] });
      const bad: [string, SubmitArgs["items"]][] = [
        ["con cantidad donde no se pide", [{ form_item_id: none.id, quantity_milli: 1000 }]],
        [
          "sin cantidad donde es obligatoria",
          [{ form_item_id: fx.catalog.id, quantity_milli: null }],
        ],
        ["bajo el mínimo", [{ form_item_id: fx.catalog.id, quantity_milli: 999 }]],
        ["sobre el máximo", [{ form_item_id: fx.catalog.id, quantity_milli: 50001 }]],
      ];
      for (const [label, items] of bad) {
        expect((await submitAsServer(setup, args(fx, { items }))).result, label).toBe(
          "invalid_items",
        );
      }
      for (const items of [
        [{ form_item_id: none.id, quantity_milli: null }],
        [{ form_item_id: fx.catalog.id, quantity_milli: 1000 }],
        [{ form_item_id: fx.catalog.id, quantity_milli: 50000 }],
      ]) {
        expect((await submitAsServer(setup, args(fx, { items }))).result).toBe("ok");
      }
    });
  });

  it("lo que el formulario no pide no se guarda y lo obligatorio tiene que venir; la fecha, entre hoy y un año", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm({
        form: {
          fields: {
            phone: "required",
            company: "off",
            comuna: "off",
            serviceAddress: "off",
            desiredDate: "optional",
            message: "off",
          },
        },
      });
      const bad: [string, SubmitArgs["over"]][] = [
        ["falta el teléfono obligatorio", { phone: null }],
        ["viene la empresa que no se pide", { phone: "v1.t.t", company: "v1.e.e" }],
        ["viene el mensaje que no se pide", { phone: "v1.t.t", message: "v1.m.m" }],
        ["viene la dirección que no se pide", { phone: "v1.t.t", address: "v1.d.d" }],
        ["fecha de ayer", { phone: "v1.t.t", desiredDate: "2000-01-01" }],
        ["fecha a dos años", { phone: "v1.t.t", desiredDate: "2099-01-01" }],
      ];
      for (const [label, over] of bad) {
        expect((await submitAsServer(setup, args(fx, { over }))).result, label).toBe(
          "invalid_data",
        );
      }
      expect((await countersOf(fx.form.formId))?.blocked_invalid).toBe(bad.length);
      const tomorrow = (
        await setup.query<{ d: string }>("select (app.current_business_date() + 1)::text as d")
      ).rows[0].d;
      expect(
        (
          await submitAsServer(
            setup,
            args(fx, { over: { phone: "v1.t.t", desiredDate: tomorrow } }),
          )
        ).result,
      ).toBe("ok");
      expect(await requestsOf(fx.form.formId)).toHaveLength(1);
    });
  });

  it("los argumentos mal armados (error del servidor, no del visitante) se rechazan con CP422 y no dejan nada", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const base = submitParams(args(fx));
      const tweak = (index: number, value: unknown) =>
        base.map((v, i) => (i === index ? value : v));
      const bad: [string, unknown[]][] = [
        ["sin clave de envío", tweak(2, null)],
        ["sin revisión", tweak(3, null)],
        ["sin nombre cifrado", tweak(4, null)],
        ["sin correo cifrado", tweak(5, null)],
        ["huella del correo mala", tweak(11, "no-es-huella")],
        ["sin huella", tweak(11, null)],
        ["sin servicios", tweak(13, "[]")],
        ["servicios no es lista", tweak(13, "{}")],
        ["servicios nulos", tweak(13, null)],
        [
          "demasiados servicios",
          tweak(
            13,
            JSON.stringify(
              Array.from({ length: 31 }, () => ({
                form_item_id: randomUUID(),
                quantity_milli: null,
              })),
            ),
          ),
        ],
        [
          "servicio con una clave de precio",
          tweak(
            13,
            JSON.stringify([{ form_item_id: fx.free.id, quantity_milli: null, unit_price_clp: 1 }]),
          ),
        ],
        [
          "servicio con nombre propio",
          tweak(13, JSON.stringify([{ form_item_id: fx.free.id, name: "Otro" }])),
        ],
        ["servicio con id malo", tweak(13, JSON.stringify([{ form_item_id: "no-es-uuid" }]))],
        [
          "cantidad fuera de rango",
          tweak(13, JSON.stringify([{ form_item_id: fx.free.id, quantity_milli: 0 }])),
        ],
        ["sin versión del consentimiento", tweak(14, null)],
        ["sin texto del consentimiento", tweak(15, null)],
        ["texto del consentimiento vacío", tweak(15, "")],
        ["texto del consentimiento de 3.001", tweak(15, "x".repeat(3001))],
        ["texto del consentimiento con control invisible", tweak(15, "Acepto‮texto")],
        ["versión del consentimiento sin formato", tweak(14, "v1")],
        ["versión del consentimiento larga", tweak(14, "intake-v" + "1".repeat(40))],
        ["nombre cifrado de 2.001", tweak(4, "x".repeat(2001))],
        ["mensaje cifrado de 12.001", tweak(10, "x".repeat(12001))],
        ["IP cifrada de 2.001", tweak(16, "x".repeat(2001))],
      ];
      await actAsService(setup);
      for (const [label, params] of bad) {
        const error = await expectSqlError(setup, SUBMIT_SQL, params);
        expect(error.code, label).toBe("CP422");
      }
      await actAsPostgres(setup);
      expect(await requestsOf(fx.form.formId)).toHaveLength(0);
      expect(await countersOf(fx.form.formId)).toBeUndefined();
    });
  });
});

describe("topes del día", () => {
  it("con tope 2: la tercera solicitud se rechaza dentro de la transacción y el aviso sale solo la primera vez", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm({ form: { daily_cap: 2 } });
      const newArgs = () => args(fx);
      const results = [];
      for (let n = 0; n < 4; n++) results.push(await submitAsServer(setup, newArgs()));
      expect(results.map((r) => r.result)).toEqual(["ok", "ok", "cap_reached", "cap_reached"]);
      expect(results.map((r) => r.notify_cap)).toEqual([undefined, undefined, true, false]);
      expect(results[2]).toMatchObject({ tenant_id: w.tenantA, form_id: fx.form.formId });
      const counters = await countersOf(fx.form.formId);
      expect(counters).toMatchObject({ accepted: 2, blocked_cap: 2 });
      expect(counters?.cap_notified_at).toBeTruthy();
      expect(await requestsOf(fx.form.formId)).toHaveLength(2);
    });
  });

  it("el tope de la organización (300 al día entre todos sus formularios) también corta", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const others: MadeForm[] = [];
      for (let n = 0; n < 6; n++) others.push(await makeForm(setup, w.owner, w.tenantA));
      await actAsPostgres(setup);
      for (const form of others) {
        await setup.query(
          "insert into public.intake_daily_counters (tenant_id, form_id, day, accepted) values ($1, $2, app.current_business_date(), 50)",
          [w.tenantA, form.formId],
        );
      }
      // 300 aceptadas en otros formularios: este todavía está a 0 de su tope de 50
      const result = await submitAsServer(setup, args(fx));
      expect(result.result).toBe("cap_reached");
      expect((await countersOf(fx.form.formId))?.blocked_cap).toBe(1);
      expect(await requestsOf(fx.form.formId)).toHaveLength(0);
      // la otra organización no se ve afectada
      const b = await makeForm(setup, w.ownerB, w.tenantB);
      expect(
        (
          await submitAsServer(setup, {
            publicId: b.publicId,
            revision: b.revision,
            items: [{ form_item_id: b.itemIds[0], quantity_milli: null }],
          })
        ).result,
      ).toBe("ok");
    });
  });

  it("el día cambia a medianoche de Chile, no de UTC", async () => {
    const dayOf = async (instant: string) =>
      (
        await setup.query<{ d: string }>(
          "select app.business_date_of($1::timestamptz)::text as d",
          [instant],
        )
      ).rows[0].d;
    // invierno (UTC-4): 02:30 UTC del 1 de julio todavía es 30 de junio en Chile
    expect(await dayOf("2026-07-01T02:30:00Z")).toBe("2026-06-30");
    expect(await dayOf("2026-07-01T04:00:00Z")).toBe("2026-07-01");
    // verano (UTC-3): 02:30 UTC del 1 de diciembre todavía es 30 de noviembre
    expect(await dayOf("2026-12-01T02:30:00Z")).toBe("2026-11-30");
    expect(await dayOf("2026-12-01T03:00:00Z")).toBe("2026-12-01");
    // y el contador de hoy usa esa misma regla
    await withTx(setup, async () => {
      const fx = await publishedForm();
      await submitAsServer(setup, args(fx));
      const { rows } = await setup.query<{ same: boolean }>(
        "select day = app.business_date_of(now()) as same from public.intake_daily_counters where form_id = $1",
        [fx.form.formId],
      );
      expect(rows).toEqual([{ same: true }]);
    });
  });

  it("los contadores de cada día son separados: lo de ayer no cuenta para el tope de hoy", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm({ form: { daily_cap: 1 } });
      await actAsPostgres(setup);
      await setup.query(
        "insert into public.intake_daily_counters (tenant_id, form_id, day, accepted) values ($1, $2, app.current_business_date() - 1, 200)",
        [w.tenantA, fx.form.formId],
      );
      expect((await submitAsServer(setup, args(fx))).result).toBe("ok");
    });
  });
});

describe("intake_record_block", () => {
  it("suma cada motivo a su contador; un identificador que no existe no hace nada", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const block = (publicId: string, reason: string) =>
        callAsServer<Json>(setup, "select public.intake_record_block($1, $2) as r", [
          publicId,
          reason,
        ]);
      for (const reason of ["captcha", "captcha", "rate", "invalid", "invalid", "invalid"]) {
        expect(await block(fx.form.publicId, reason)).toEqual({ recorded: true });
      }
      expect(await countersOf(fx.form.formId)).toMatchObject({
        accepted: 0,
        blocked_captcha: 2,
        blocked_rate: 1,
        blocked_cap: 0,
        blocked_paused: 0,
        blocked_invalid: 3,
      });
      const before = (
        await setup.query("select count(*)::int as n from public.intake_daily_counters")
      ).rows[0].n;
      for (const id of ["A".repeat(22), "corto", ""]) {
        expect(await block(id, "rate"), id).toEqual({ recorded: false });
      }
      expect(
        await callAsServer(setup, "select public.intake_record_block(null, 'rate') as r"),
      ).toEqual({ recorded: false });
      expect(
        (await setup.query("select count(*)::int as n from public.intake_daily_counters")).rows[0]
          .n,
      ).toBe(before);
      await actAsService(setup);
      // el tope y la pausa ya se cuentan dentro del envío: aquí no se aceptan
      for (const reason of ["otro", "cap", "paused"]) {
        expect(
          (
            await expectSqlError(setup, "select public.intake_record_block($1, $2)", [
              fx.form.publicId,
              reason,
            ])
          ).code,
          reason,
        ).toBe("CP422");
      }
      expect(
        (
          await expectSqlError(setup, "select public.intake_record_block($1, null)", [
            fx.form.publicId,
          ])
        ).code,
      ).toBe("CP422");
      await actAsPostgres(setup);
    });
  });

  it("cuenta en un formulario en pausa, pero no en un borrador", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const draft = await makeForm(setup, w.owner, w.tenantA, { publish: false });
      const block = (id: string) =>
        callAsServer<Json>(setup, "select public.intake_record_block($1, 'rate') as r", [id]);
      expect(await block(draft.publicId)).toEqual({ recorded: false });
      expect(await countersOf(draft.formId)).toBeUndefined();
      await callAs(
        setup,
        w.owner,
        w.tenantA,
        "select public.set_intake_form_status($1, 'paused') as r",
        [fx.form.formId],
      );
      expect(await block(fx.form.publicId)).toEqual({ recorded: true });
      expect((await countersOf(fx.form.formId))?.blocked_rate).toBe(1);
    });
  });

  it("no cuenta nada de un formulario archivado y se queda en la organización del formulario", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const b = await makeForm(setup, w.ownerB, w.tenantB);
      await callAs(
        setup,
        w.owner,
        w.tenantA,
        "select public.set_intake_form_status($1, 'archived') as r",
        [fx.form.formId],
      );
      const block = (id: string) =>
        callAsServer<Json>(setup, "select public.intake_record_block($1, 'captcha') as r", [id]);
      expect(await block(fx.form.publicId)).toEqual({ recorded: false });
      expect(await block(b.publicId)).toEqual({ recorded: true });
      const { rows } = await setup.query(
        "select tenant_id from public.intake_daily_counters where form_id = $1",
        [b.formId],
      );
      expect(rows).toEqual([{ tenant_id: w.tenantB }]);
    });
  });
});

describe("avisos al equipo, sin datos del visitante", () => {
  const recipients = (requestId: string | null, kind: string, formId: string | null = null) =>
    callAsServer<{
      kind: string;
      audience: string;
      recipients: { user_id: string; email: string }[];
      limited: boolean;
      tenant_id: string;
      form_name: string;
    }>(setup, "select public.intake_notice_recipients($1, $2, $3) as r", [requestId, kind, formId]);
  const emails = (r: { recipients: { email: string }[] }) =>
    r.recipients.map((x) => x.email).sort();
  const assign = async (requestId: string, to: string) => {
    await actAsPostgres(setup);
    await setup.query(
      "update public.intake_requests set status = 'assigned', assigned_to = $2, assigned_at = now(), assigned_by = $3 where id = $1",
      [requestId, to, w.owner.id],
    );
  };
  const removeMember = async (userId: string) => {
    await actAsPostgres(setup);
    await setup.query(
      "update public.members set status = 'removed', removed_at = now() where tenant_id = $1 and user_id = $2",
      [w.tenantA, userId],
    );
  };

  it("«llegó una solicitud» va al Dueño y a los Administradores activos, nunca a otros ni a otra organización", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const id = await insertRequest(setup, w.tenantA, fx.form.formId);
      const result = await recipients(id, "request_received");
      expect(result).toMatchObject({ audience: "managers", limited: false, tenant_id: w.tenantA });
      expect(emails(result)).toEqual([w.admin.email, w.owner.email].sort());
      const text = JSON.stringify(result);
      for (const other of [w.sales, w.approver, w.viewer, w.ownerB])
        expect(text).not.toContain(other.email);
      await removeMember(w.admin.id);
      expect(emails(await recipients(id, "request_received"))).toEqual([w.owner.email]);
    });
  });

  it("«te asignaron una solicitud» va a la persona asignada si sigue activa; si no, a Dueño y Administradores", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const id = await insertRequest(setup, w.tenantA, fx.form.formId);
      await assign(id, w.sales.id);
      const result = await recipients(id, "request_assigned");
      expect(result.audience).toBe("assignee");
      expect(result.recipients).toEqual([{ user_id: w.sales.id, email: w.sales.email }]);
      await removeMember(w.sales.id);
      const after = await recipients(id, "request_assigned");
      expect(after.audience).toBe("managers");
      expect(emails(after)).toEqual([w.admin.email, w.owner.email].sort());
      expect(JSON.stringify(after)).not.toContain(w.sales.email);
    });
  });

  it("«tu formulario llegó al tope» es de un formulario y va a Dueño y Administradores", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const result = await recipients(null, "intake_cap_reached", fx.form.formId);
      expect(emails(result)).toEqual([w.admin.email, w.owner.email].sort());
      expect(result.form_name).toBe(INTERNAL_NAME);
    });
  });

  it("la respuesta no lleva ningún dato del visitante", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const id = await insertRequest(setup, w.tenantA, fx.form.formId, {
        contact_name_enc: "v1.nombre-secreto.nombre-secreto",
        contact_email_enc: "v1.correo-secreto.correo-secreto",
        message_enc: "v1.mensaje-secreto.mensaje-secreto",
      });
      for (const kind of ["request_received", "request_assigned"]) {
        const text = JSON.stringify(await recipients(id, kind));
        expect(text).not.toContain("secreto");
        for (const key of ["contact_name", "contact_email", "message", "consent", "items", "phone"])
          expect(text).not.toContain(key);
      }
    });
  });

  it("argumentos mal armados y solicitudes o formularios que no existen", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const id = await insertRequest(setup, w.tenantA, fx.form.formId);
      await actAsService(setup);
      const call = (sql: string, params: unknown[]) => expectSqlError(setup, sql, params);
      const RECIPIENTS = "select public.intake_notice_recipients($1, $2, $3)";
      expect((await call(RECIPIENTS, [id, "otro", null])).code).toBe("CP422");
      expect((await call(RECIPIENTS, [id, null, null])).code).toBe("CP422");
      expect((await call(RECIPIENTS, [null, "request_received", null])).code).toBe("CP422");
      expect((await call(RECIPIENTS, [id, "request_received", fx.form.formId])).code).toBe("CP422");
      expect((await call(RECIPIENTS, [id, "intake_cap_reached", fx.form.formId])).code).toBe(
        "CP422",
      );
      expect((await call(RECIPIENTS, [null, "intake_cap_reached", null])).code).toBe("CP422");
      expect((await call(RECIPIENTS, [randomUUID(), "request_received", null])).code).toBe("CP404");
      expect((await call(RECIPIENTS, [null, "intake_cap_reached", randomUUID()])).code).toBe(
        "CP404",
      );
      await actAsPostgres(setup);
    });
  });

  it("máximo 20 solicitudes avisadas por día y organización", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const ids: string[] = [];
      for (let n = 0; n < 21; n++) ids.push(await insertRequest(setup, w.tenantA, fx.form.formId));
      const register = (requestId: string) =>
        callAsServer<Json>(
          setup,
          "select public.intake_notice_register($1, $2, 'request_received', $3, 'v1.a.a', $4, null) as r",
          [randomUUID(), requestId, w.owner.id, sha256Hex(w.owner.email)],
        );
      for (let n = 0; n < 20; n++) {
        expect((await recipients(ids[n], "request_received")).limited, `solicitud ${n + 1}`).toBe(
          false,
        );
        expect(await register(ids[n])).toEqual({ registered: true });
      }
      const twentyFirst = await recipients(ids[20], "request_received");
      expect(twentyFirst).toMatchObject({ limited: true, recipients: [] });
      expect(await register(ids[20])).toEqual({ registered: false, reason: "daily_limit" });
      // una solicitud ya avisada puede seguir avisándose a otra persona (no cuenta contra sí misma)
      expect((await recipients(ids[0], "request_received")).limited).toBe(false);
      // los avisos de asignación no tienen ese tope
      expect((await recipients(ids[20], "request_assigned")).limited).toBe(false);
    });
  });

  it("registrar y cerrar el aviso: solo a miembros activos de la organización, una vez, y queda en email_messages", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const id = await insertRequest(setup, w.tenantA, fx.form.formId);
      await assign(id, w.sales.id);
      const emailId = randomUUID();
      const REGISTER =
        "select public.intake_notice_register($1, $2, $3, $4, 'v1.dest.dest', $5, $6) as r";
      const params = (over: Partial<Record<number, unknown>> = {}) =>
        [emailId, id, "request_assigned", w.sales.id, sha256Hex("dest"), null].map((v, i) =>
          i in over ? over[i] : v,
        );
      expect(await callAsServer(setup, REGISTER, params())).toEqual({ registered: true });
      // el mismo aviso repetido no duplica
      expect(await callAsServer(setup, REGISTER, params())).toEqual({ registered: true });
      const { rows } = await setup.query(
        "select kind, status, tenant_id, intake_request_id, intake_form_id, quote_id, package_id, provider from public.email_messages where id = $1",
        [emailId],
      );
      expect(rows).toEqual([
        {
          kind: "request_assigned",
          status: "pending",
          tenant_id: w.tenantA,
          intake_request_id: id,
          intake_form_id: null,
          quote_id: null,
          package_id: null,
          provider: "pending",
        },
      ]);
      const SETTLE = "select public.intake_notice_settle($1, $2, $3, $4) as r";
      expect(await callAsServer(setup, SETTLE, [emailId, "memory", "prov-1", null])).toEqual({
        status: "sent",
      });
      expect(await callAsServer(setup, SETTLE, [emailId, "memory", "prov-2", null])).toEqual({
        status: "already_settled",
      });
      const failing = randomUUID();
      await callAsServer(setup, REGISTER, params({ 0: failing }));
      expect(await callAsServer(setup, SETTLE, [failing, null, null, "smtp_down"])).toEqual({
        status: "failed",
      });
      const settled = await setup.query(
        "select status, error_code, provider_message_id from public.email_messages where id = $1",
        [failing],
      );
      expect(settled.rows[0]).toEqual({
        status: "failed",
        error_code: "smtp_down",
        provider_message_id: null,
      });

      await actAsService(setup);
      const call = (sql: string, p: unknown[]) => expectSqlError(setup, sql, p);
      // alguien de OTRA organización, o que ya no es miembro, no puede ser destinatario
      expect((await call(REGISTER, params({ 0: randomUUID(), 3: w.ownerB.id }))).code).toBe(
        "42501",
      );
      await actAsPostgres(setup);
      await removeMember(w.sales.id);
      await actAsService(setup);
      expect((await call(REGISTER, params({ 0: randomUUID() }))).code).toBe("42501");
      expect((await call(REGISTER, params({ 0: null }))).code).toBe("CP422");
      expect((await call(REGISTER, params({ 2: "quote" }))).code).toBe("CP422");
      expect((await call(REGISTER, params({ 4: "no-es-huella" }))).code).toBe("CP422");
      expect(
        (await call(REGISTER, params({ 1: randomUUID(), 0: randomUUID(), 3: w.owner.id }))).code,
      ).toBe("CP404");
      expect((await call(SETTLE, [randomUUID(), "memory", "x", null])).code).toBe("CP404");
      const pending = randomUUID();
      await actAsPostgres(setup);
      await callAsServer(setup, REGISTER, params({ 0: pending, 3: w.owner.id }));
      await actAsService(setup);
      expect((await call(SETTLE, [pending, null, null, "con espacios"])).code).toBe("CP422");
      await actAsPostgres(setup);
    });
  });

  it("el aviso del tope se registra con el formulario, y los demás tipos no admiten ese formulario", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const emailId = randomUUID();
      const register = (
        kind: string,
        requestId: string | null,
        formId: string | null,
        id = emailId,
      ) =>
        callAsServer<Json>(
          setup,
          "select public.intake_notice_register($1, $2, $3, $4, 'v1.d.d', $5, $6) as r",
          [id, requestId, kind, w.owner.id, sha256Hex("dest"), formId],
        );
      expect(await register("intake_cap_reached", null, fx.form.formId)).toEqual({
        registered: true,
      });
      const { rows } = await setup.query(
        "select intake_form_id, intake_request_id from public.email_messages where id = $1",
        [emailId],
      );
      expect(rows).toEqual([{ intake_form_id: fx.form.formId, intake_request_id: null }]);
      await actAsPostgres(setup);
      const request = await insertRequest(setup, w.tenantA, fx.form.formId);
      await actAsService(setup);
      const error = await expectFails(setup, () =>
        setup.query(
          "select public.intake_notice_register($1, $2, 'request_received', $3, 'v1.d.d', $4, $5)",
          [randomUUID(), request, w.owner.id, sha256Hex("d"), fx.form.formId],
        ),
      );
      expect(error.code).toBe("CP422");
      await actAsPostgres(setup);
    });
  });
});

describe("avisos: regla de destinatarios, identificador ajeno y organización activa (menores 2 y 4)", () => {
  const REGISTER =
    "select public.intake_notice_register($1, $2, $3, $4, 'v1.dest.dest', $5, $6) as r";
  const registerAs = (
    kind: string,
    requestId: string | null,
    toUser: string,
    over: { id?: string; formId?: string | null; hash?: string } = {},
  ) =>
    callAsServer<Json>(setup, REGISTER, [
      over.id ?? randomUUID(),
      requestId,
      kind,
      toUser,
      over.hash ?? sha256Hex("dest"),
      over.formId ?? null,
    ]);
  const assignTo = async (requestId: string, to: string) => {
    await actAsPostgres(setup);
    await setup.query(
      "update public.intake_requests set status = 'assigned', assigned_to = $2, assigned_at = now(), assigned_by = $3 where id = $1",
      [requestId, to, w.owner.id],
    );
  };

  it("el registro aplica la regla del aviso: «llegó una solicitud» y «tope» solo a Dueño y Administradores", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const id = await insertRequest(setup, w.tenantA, fx.form.formId);
      expect(await registerAs("request_received", id, w.admin.id)).toEqual({ registered: true });
      await actAsService(setup);
      for (const who of [w.sales, w.approver, w.viewer]) {
        const error = await expectFails(setup, () =>
          setup.query(REGISTER, [
            randomUUID(),
            id,
            "request_received",
            who.id,
            sha256Hex("d"),
            null,
          ]),
        );
        expect(error.code, who.email).toBe("42501");
      }
      const cap = await expectFails(setup, () =>
        setup.query(REGISTER, [
          randomUUID(),
          null,
          "intake_cap_reached",
          w.sales.id,
          sha256Hex("d"),
          fx.form.formId,
        ]),
      );
      expect(cap.code).toBe("42501");
      await actAsPostgres(setup);
    });
  });

  it("«te asignaron» solo a la persona asignada (o a Dueño y Administradores si ya no sigue)", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const id = await insertRequest(setup, w.tenantA, fx.form.formId);
      await assignTo(id, w.sales.id);
      expect(await registerAs("request_assigned", id, w.sales.id)).toEqual({ registered: true });
      await actAsService(setup);
      // con una persona asignada activa, nadie más recibe ese aviso
      const other = await expectFails(setup, () =>
        setup.query(REGISTER, [
          randomUUID(),
          id,
          "request_assigned",
          w.owner.id,
          sha256Hex("d"),
          null,
        ]),
      );
      expect(other.code).toBe("42501");
      await actAsPostgres(setup);
    });
  });

  it("un identificador de aviso que ya es de otra fila no se registra, y repetir el mismo aviso sí es un reintento", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const first = await insertRequest(setup, w.tenantA, fx.form.formId);
      const second = await insertRequest(setup, w.tenantA, fx.form.formId);
      const emailId = randomUUID();
      expect(await registerAs("request_received", first, w.owner.id, { id: emailId })).toEqual({
        registered: true,
      });
      // el mismo aviso otra vez: reintento
      expect(await registerAs("request_received", first, w.owner.id, { id: emailId })).toEqual({
        registered: true,
      });
      // el mismo identificador para otra solicitud, otro tipo o otro destinatario: no
      for (const attempt of [
        () => registerAs("request_received", second, w.owner.id, { id: emailId }),
        () =>
          registerAs("request_received", first, w.owner.id, { id: emailId, hash: sha256Hex("x") }),
        () =>
          registerAs("intake_cap_reached", null, w.owner.id, {
            id: emailId,
            formId: fx.form.formId,
          }),
      ]) {
        expect(await attempt()).toEqual({ registered: false, reason: "id_in_use" });
      }
      const { rows } = await setup.query(
        "select intake_request_id from public.email_messages where id = $1",
        [emailId],
      );
      expect(rows).toEqual([{ intake_request_id: first }]);
      // y el identificador de un aviso de OTRA organización tampoco se pisa
      const b = await makeForm(setup, w.ownerB, w.tenantB);
      const requestB = await insertRequest(setup, w.tenantB, b.formId);
      const foreign = randomUUID();
      await registerAs("request_received", requestB, w.ownerB.id, { id: foreign });
      expect(await registerAs("request_received", first, w.owner.id, { id: foreign })).toEqual({
        registered: false,
        reason: "id_in_use",
      });
    });
  });

  it("si la organización ya no está activa, no hay destinatarios y no se registra nada", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const id = await insertRequest(setup, w.tenantA, fx.form.formId);
      await actAsPostgres(setup);
      await setup.query(
        "update public.tenants set status = 'archived', archived_at = now() where tenant_id = $1",
        [w.tenantA],
      );
      for (const kind of ["request_received", "request_assigned"]) {
        const result = await callAsServer<{ recipients: unknown[] }>(
          setup,
          "select public.intake_notice_recipients($1, $2, null) as r",
          [id, kind],
        );
        expect(result.recipients, kind).toEqual([]);
        expect(await registerAs(kind, id, w.owner.id), kind).toEqual({
          registered: false,
          reason: "tenant_inactive",
        });
      }
      const cap = await callAsServer<{ recipients: unknown[] }>(
        setup,
        "select public.intake_notice_recipients(null, 'intake_cap_reached', $1) as r",
        [fx.form.formId],
      );
      expect(cap.recipients).toEqual([]);
      expect(
        await registerAs("intake_cap_reached", null, w.owner.id, { formId: fx.form.formId }),
      ).toEqual({ registered: false, reason: "tenant_inactive" });
      const { rows } = await setup.query(
        "select count(*)::int as n from public.email_messages where tenant_id = $1 and intake_request_id is not null",
        [w.tenantA],
      );
      expect(rows[0].n).toBe(0);
    });
  });
});

describe("el tope avisa cuál es (menor 5)", () => {
  const noticeCount = async (key: "cap_notified_at" | "org_cap_notified_at") =>
    (
      await setup.query<{ n: number }>(
        `select count(*)::int as n from public.intake_daily_counters where tenant_id = $1 and ${key} is not null`,
        [w.tenantA],
      )
    ).rows[0].n;

  it("el del formulario trae cap_kind 'form' y avisa una vez por formulario", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm({ form: { daily_cap: 1 } });
      expect((await submitAsServer(setup, args(fx))).result).toBe("ok");
      const first = await submitAsServer(setup, args(fx));
      const second = await submitAsServer(setup, args(fx));
      expect(first).toMatchObject({ result: "cap_reached", cap_kind: "form", notify_cap: true });
      expect(second).toMatchObject({ result: "cap_reached", cap_kind: "form", notify_cap: false });
      expect(await noticeCount("cap_notified_at")).toBe(1);
      expect(await noticeCount("org_cap_notified_at")).toBe(0);
    });
  });

  it("el de la organización trae cap_kind 'org' y avisa UNA vez por organización aunque sean varios formularios", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const second = await makeForm(setup, w.owner, w.tenantA);
      const third = await makeForm(setup, w.owner, w.tenantA);
      const fillers: MadeForm[] = [];
      for (let n = 0; n < 6; n++) fillers.push(await makeForm(setup, w.owner, w.tenantA));
      await actAsPostgres(setup);
      for (const form of fillers) {
        await setup.query(
          "insert into public.intake_daily_counters (tenant_id, form_id, day, accepted) values ($1, $2, app.current_business_date(), 50)",
          [w.tenantA, form.formId],
        );
      }
      const results = [
        await submitAsServer(setup, args(fx)),
        await submitAsServer(setup, args(fx)),
        await submitAsServer(setup, {
          publicId: second.publicId,
          revision: second.revision,
          items: [{ form_item_id: second.itemIds[0], quantity_milli: null }],
        }),
        await submitAsServer(setup, {
          publicId: third.publicId,
          revision: third.revision,
          items: [{ form_item_id: third.itemIds[0], quantity_milli: null }],
        }),
      ];
      expect(results.map((r) => [r.result, r.cap_kind, r.notify_cap])).toEqual([
        ["cap_reached", "org", true],
        ["cap_reached", "org", false],
        ["cap_reached", "org", false],
        ["cap_reached", "org", false],
      ]);
      expect(await noticeCount("org_cap_notified_at")).toBe(1);
      expect(await noticeCount("cap_notified_at")).toBe(0);
    });
  });
});

describe("consentimiento y correlación en el envío (I1 y menor 6)", () => {
  it("guarda el texto aceptado y la huella la calcula la base", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const text = "Acepto que Mi Organización use mis datos para responder esta solicitud.";
      await submitAsServer(setup, args(fx, { over: { consentText: text } }));
      const [row] = await requestsOf(fx.form.formId);
      expect(row).toMatchObject({
        consent_text: text,
        consent_text_sha256: sha256Hex(text),
        consent_text_unavailable: false,
        consent_template_version: CONSENT_VERSION,
      });
      // con tildes y eñes, la huella es la del texto en UTF-8
      const accents = "Acepto el tratamiento de mis datos: ñandú, camión, años.";
      await submitAsServer(setup, args(fx, { over: { consentText: accents } }));
      const rows = await requestsOf(fx.form.formId);
      expect(rows.find((r) => r.consent_text === accents)?.consent_text_sha256).toBe(
        sha256Hex(accents),
      );
    });
  });

  it("la auditoría del envío lleva la correlación de x-cp-request-id y ninguna IP", async () => {
    await withTx(setup, async () => {
      const fx = await publishedForm();
      const correlation = randomUUID();
      const requestId = randomUUID();
      await actAsService(setup);
      await setup.query("select set_config('request.headers', $1, true)", [
        JSON.stringify({ "x-cp-request-id": correlation, "x-cp-client-ip": "203.0.113.9" }),
      ]);
      await setup.query(SUBMIT_SQL, submitParams(args(fx, { requestId })));
      await actAsPostgres(setup);
      const { rows } = await setup.query(
        "select correlation_id, origin_ip, actor_type from public.audit_log where resource_id = $1 and action = 'intake_request.received'",
        [requestId],
      );
      expect(rows).toEqual([
        { correlation_id: correlation, origin_ip: null, actor_type: "public" },
      ]);
      // sin cabecera, o con una que no es un identificador, queda vacía
      const other = randomUUID();
      await actAsService(setup);
      await setup.query("select set_config('request.headers', $1, true)", [
        JSON.stringify({ "x-cp-request-id": "no-es-uuid" }),
      ]);
      await setup.query(SUBMIT_SQL, submitParams(args(fx, { requestId: other })));
      await actAsPostgres(setup);
      const none = await setup.query(
        "select correlation_id from public.audit_log where resource_id = $1 and action = 'intake_request.received'",
        [other],
      );
      expect(none.rows).toEqual([{ correlation_id: null }]);
    });
  });
});
