// Sprint 4 · migración 29 · formularios públicos y sus servicios (H-086).
// Roles, escritura solo por funciones, revisión, validaciones de la lista cerrada de campos, sitios
// autorizados para incrustar, servicios sin precio, publicar y regenerar el enlace. Cada prueba corre en
// una transacción que se deshace.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAsPostgres, connect, expectSqlError, withTx } from "./helpers";
import {
  asUser,
  buildIntakeWorld,
  callAs,
  catalogItem,
  freeItem,
  makeForm,
  type IntakeWorld,
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

const CREATE = "select public.create_intake_form($1, $2) as r";
const SAVE = "select public.save_intake_form($1, $2, $3::jsonb, $4::jsonb) as r";
const STATUS = "select public.set_intake_form_status($1, $2) as r";
const REGENERATE = "select public.regenerate_intake_form_public_id($1) as r";
type Json = Record<string, unknown>;

const save = (formId: string, revision: number, form: object, items: object[] | null = null) =>
  callAs<{ revision: number }>(setup, w.owner, w.tenantA, SAVE, [
    formId,
    revision,
    JSON.stringify(form),
    items === null ? null : JSON.stringify(items),
  ]);

// Un guardado rechazado no cambia el formulario: se reutiliza el mismo dentro de cada prueba.
let errorForm: string | null = null;
beforeEach(() => {
  errorForm = null;
});
async function saveError(form: object, items: object[] | null = null, revision = 1) {
  if (errorForm === null) {
    errorForm = randomUUID();
    await callAs(setup, w.owner, w.tenantA, CREATE, [errorForm, "Para error"]);
  }
  const formId = errorForm;
  await asUser(setup, w.owner, w.tenantA);
  return expectSqlError(setup, SAVE, [
    formId,
    revision,
    JSON.stringify(form),
    items === null ? null : JSON.stringify(items),
  ]);
}

describe("quién puede escribir (§6)", () => {
  it("el Dueño y el Administrador crean formularios; los demás roles no", async () => {
    await withTx(setup, async () => {
      for (const user of [w.owner, w.admin]) {
        const created = await callAs<{ id: string; public_id: string; created: boolean }>(
          setup,
          user,
          w.tenantA,
          CREATE,
          [randomUUID(), "Mi formulario"],
        );
        expect(created.created).toBe(true);
        expect(created.public_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      }
      for (const user of [w.sales, w.approver, w.viewer]) {
        await asUser(setup, user, w.tenantA);
        const error = await expectSqlError(setup, CREATE, [randomUUID(), "No debería"]);
        expect(error.code).toBe("42501");
      }
    });
  });

  it("alguien de otra organización no puede actuar en A, ni con la cabecera de A ni sin cabecera", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      await asUser(setup, w.ownerB, w.tenantA);
      for (const [sql, params] of [
        [CREATE, [randomUUID(), "Intruso"]],
        [SAVE, [form.formId, 1, "{}", null]],
        [STATUS, [form.formId, "paused"]],
        [REGENERATE, [form.formId]],
      ] as const) {
        expect((await expectSqlError(setup, sql, [...params])).code, sql).toBe("42501");
      }
      await asUser(setup, w.ownerB, w.tenantB);
      for (const [sql, params] of [
        [SAVE, [form.formId, 1, "{}", null]],
        [STATUS, [form.formId, "paused"]],
        [REGENERATE, [form.formId]],
      ] as const) {
        // con su propia organización, el formulario de A no existe para quien llama
        expect((await expectSqlError(setup, sql, [...params])).code, sql).toBe("CP404");
      }
    });
  });

  it("nadie con pase escribe directo en las tablas, ni siquiera el Dueño", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      await asUser(setup, w.owner, w.tenantA);
      for (const sql of [
        `insert into public.intake_forms (id, tenant_id, name, title) values (gen_random_uuid(), '${w.tenantA}', 'x', 'x')`,
        `update public.intake_forms set title = 'hack' where id = '${form.formId}'`,
        `delete from public.intake_forms where id = '${form.formId}'`,
        `update public.intake_form_items set public_name = 'hack'`,
        `delete from public.intake_form_items`,
      ]) {
        expect((await expectSqlError(setup, sql)).code, sql).toBe("42501");
      }
    });
  });

  it("todos los miembros leen los formularios de su organización y nadie lee los de otra", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      for (const user of [w.owner, w.admin, w.sales, w.approver, w.viewer]) {
        await asUser(setup, user, w.tenantA);
        const { rows } = await setup.query("select id from public.intake_forms where id = $1", [
          form.formId,
        ]);
        expect(rows, user.email).toHaveLength(1);
        const items = await setup.query(
          "select id from public.intake_form_items where form_id = $1",
          [form.formId],
        );
        expect(items.rows.length, user.email).toBeGreaterThan(0);
      }
      await asUser(setup, w.ownerB, w.tenantB);
      expect((await setup.query("select id from public.intake_forms")).rows).toEqual([]);
      await asUser(setup, w.ownerB, w.tenantA);
      expect((await setup.query("select id from public.intake_forms")).rows).toEqual([]);
      await actAsPostgres(setup);
    });
  });
});

describe("crear", () => {
  it("es idempotente con el mismo id, y un id de otra organización no se reutiliza", async () => {
    await withTx(setup, async () => {
      const id = randomUUID();
      const first = await callAs<Json>(setup, w.owner, w.tenantA, CREATE, [id, "Uno"]);
      const again = await callAs<Json>(setup, w.owner, w.tenantA, CREATE, [id, "Uno"]);
      expect(again).toMatchObject({ id, public_id: first.public_id, created: false });
      await asUser(setup, w.ownerB, w.tenantB);
      expect((await expectSqlError(setup, CREATE, [id, "Robo"])).code).toBe("CP422");
    });
  });

  it("nombres inválidos: vacío, de 121 caracteres o con caracteres invisibles", async () => {
    await withTx(setup, async () => {
      await asUser(setup, w.owner, w.tenantA);
      for (const name of ["", "   ", "x".repeat(121), "hola‮atras", "dos\nlíneas", "ancho​cero"]) {
        expect(
          (await expectSqlError(setup, CREATE, [randomUUID(), name])).code,
          JSON.stringify(name),
        ).toBe("CP422");
      }
    });
  });

  it("el título público parte igual al nombre, con revisión 1 y en borrador", async () => {
    await withTx(setup, async () => {
      const id = randomUUID();
      await callAs(setup, w.owner, w.tenantA, CREATE, [id, "Cotiza tu flete"]);
      const { rows } = await setup.query(
        "select name, title, status, revision, daily_cap, fields from public.intake_forms where id = $1",
        [id],
      );
      expect(rows[0]).toMatchObject({
        name: "Cotiza tu flete",
        title: "Cotiza tu flete",
        status: "draft",
        revision: 1,
        daily_cap: 50,
      });
      expect(Object.keys(rows[0].fields).sort()).toEqual(
        ["comuna", "company", "desiredDate", "message", "phone", "serviceAddress"].sort(),
      );
    });
  });

  it("tope de 20 formularios por organización (los archivados no cuentan)", async () => {
    await withTx(setup, async () => {
      const ids: string[] = [];
      for (let n = 0; n < 20; n++) {
        const id = randomUUID();
        ids.push(id);
        await callAs(setup, w.owner, w.tenantA, CREATE, [id, `Formulario ${n}`]);
      }
      await asUser(setup, w.owner, w.tenantA);
      expect((await expectSqlError(setup, CREATE, [randomUUID(), "El 21"])).code).toBe("CP422");
      await callAs(setup, w.owner, w.tenantA, STATUS, [ids[0], "archived"]);
      await callAs(setup, w.owner, w.tenantA, CREATE, [randomUUID(), "El 21, ahora sí"]);
      // la otra organización tiene su propio tope
      await callAs(setup, w.ownerB, w.tenantB, CREATE, [randomUUID(), "De B"]);
    });
  });

  it("los identificadores públicos tienen la forma pedida y no se repiten", async () => {
    await withTx(setup, async () => {
      const seen = new Set<string>();
      for (let n = 0; n < 15; n++) {
        const created = await callAs<{ public_id: string }>(
          setup,
          n % 2 ? w.admin : w.owner,
          w.tenantA,
          CREATE,
          [randomUUID(), `F${n}`],
        );
        expect(created.public_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
        seen.add(created.public_id);
      }
      expect(seen.size).toBe(15);
      const { rows } = await setup.query(
        "select count(*)::int as n, count(distinct public_id)::int as d from public.intake_forms",
      );
      expect(rows[0].n).toBe(rows[0].d);
    });
  });
});

describe("guardar: revisión y claves cerradas", () => {
  it("guardar sube la revisión; con una revisión vieja (otra pestaña guardó antes) no guarda nada", async () => {
    await withTx(setup, async () => {
      const id = randomUUID();
      await callAs(setup, w.owner, w.tenantA, CREATE, [id, "Revisión"]);
      expect((await save(id, 1, { title: "Primero" })).revision).toBe(2);
      await asUser(setup, w.owner, w.tenantA);
      const conflict = await expectSqlError(setup, SAVE, [
        id,
        1,
        JSON.stringify({ title: "Pisado" }),
        null,
      ]);
      expect(conflict.code).toBe("CP409");
      const { rows } = await setup.query(
        "select title, revision from public.intake_forms where id = $1",
        [id],
      );
      expect(rows[0]).toMatchObject({ title: "Primero", revision: 2 });
    });
  });

  it("claves desconocidas, tipos equivocados y textos con caracteres invisibles se rechazan", async () => {
    await withTx(setup, async () => {
      for (const form of [
        { rut: "11111111-1" },
        { status: "published" },
        { public_id: "a".repeat(22) },
        { tenant_id: w.tenantB },
        { title: 5 },
        { title: "" },
        { title: "x".repeat(121) },
        { title: "bidi‮texto" },
        { intro: "a".repeat(1001) },
        { intro: "con\u0007campana" },
        { success_message: "b".repeat(501) },
        { daily_cap: 0 },
        { daily_cap: 201 },
        { daily_cap: 1.5 },
        { daily_cap: "50" },
        { privacy_policy_url: "http://ejemplo.cl/privacidad" },
        { privacy_policy_url: "https://ejemplo.cl/a b" },
        { privacy_policy_url: "javascript:alert(1)" },
        { privacy_policy_url: 'https://ejemplo.cl/"onmouseover="x' },
      ]) {
        expect((await saveError(form)).code, JSON.stringify(form)).toBe("CP422");
      }
    });
  });

  it("la introducción admite saltos de línea; el tope de envíos se ajusta de 1 a 200; la política vuelve a null", async () => {
    await withTx(setup, async () => {
      const id = randomUUID();
      await callAs(setup, w.owner, w.tenantA, CREATE, [id, "Ajustes"]);
      await save(id, 1, {
        intro: "Línea uno\nLínea dos",
        success_message: "Gracias",
        daily_cap: 200,
        privacy_policy_url: "https://mi-empresa.cl/privacidad",
      });
      const { rows } = await setup.query("select * from public.intake_forms where id = $1", [id]);
      expect(rows[0]).toMatchObject({
        intro: "Línea uno\nLínea dos",
        daily_cap: 200,
        privacy_policy_url: "https://mi-empresa.cl/privacidad",
      });
      await save(id, 2, { daily_cap: 1, privacy_policy_url: null });
      const after = await setup.query(
        "select daily_cap, privacy_policy_url from public.intake_forms where id = $1",
        [id],
      );
      expect(after.rows[0]).toEqual({ daily_cap: 1, privacy_policy_url: null });
    });
  });

  it("los campos se piden con una lista cerrada: nada de RUT ni de preguntas propias", async () => {
    await withTx(setup, async () => {
      const ok = {
        phone: "required",
        company: "off",
        comuna: "optional",
        serviceAddress: "required",
        desiredDate: "off",
        message: "optional",
      };
      for (const bad of [
        { ...ok, rut: "optional" },
        { ...ok, name: "off" },
        { ...ok, email: "off" },
        { ...ok, pregunta: "optional" },
        { ...ok, phone: "maybe" },
        { ...ok, phone: true },
        { phone: "off" },
        {},
        [],
        "text",
      ]) {
        expect((await saveError({ fields: bad })).code, JSON.stringify(bad)).toBe("CP422");
      }
      const id = randomUUID();
      await callAs(setup, w.owner, w.tenantA, CREATE, [id, "Campos"]);
      await save(id, 1, { fields: ok });
      const { rows } = await setup.query("select fields from public.intake_forms where id = $1", [
        id,
      ]);
      expect(rows[0].fields).toEqual(ok);
    });
  });

  it("la tabla también lo exige si alguien escribe directo como dueño de la base", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      for (const [column, value] of [
        ["fields", `'{"rut":"required"}'::jsonb`],
        ["embed_origins", `array['http://a.cl']`],
        ["daily_cap", "500"],
        ["public_id", `'corto'`],
        ["status", `'otro'`],
      ]) {
        const error = await expectSqlError(
          setup,
          `update public.intake_forms set ${column} = ${value} where id = $1`,
          [form.formId],
        );
        expect(error.code, column).toBe("23514");
      }
    });
  });
});

describe("sitios autorizados para incrustar (H-093)", () => {
  const INVALID: string[][] = [
    ["http://sitio.cl"],
    ["*"],
    ["https://*.sitio.cl"],
    ["https://sitio.cl; script-src *"],
    ["https://sitio.cl\n"],
    ["https://sitio.cl/ruta"],
    ["https://sitio.cl/"],
    ["https://usuario@sitio.cl"],
    ["https://Sitio.cl"],
    ["https://sitio"],
    ["https://sitio.cl:0"],
    ["https://sitio.cl:70000"],
    ["https://sitio.cl:08"],
    ["https://sitio.cl "],
    [" https://sitio.cl"],
    ["https://-sitio.cl"],
    ["https://sitio..cl"],
    ["https://sitio.cl'"],
    ["https://sitio.cl‮"],
    ["data:text/html,hola"],
    ["https://sitio.cl", "http://otro.cl"],
    Array.from({ length: 11 }, (_, n) => `https://sitio${n}.cl`),
  ];

  it.each(INVALID.map((origins) => [JSON.stringify(origins).slice(0, 60), origins] as const))(
    "rechaza %s",
    async (_label, origins) => {
      await withTx(setup, async () => {
        expect((await saveError({ embed_origins: origins })).code).toBe("CP422");
      });
    },
  );

  it("acepta https en minúsculas con puerto, quita repetidos, los ordena y deja la lista en la auditoría", async () => {
    await withTx(setup, async () => {
      const id = randomUUID();
      await callAs(setup, w.owner, w.tenantA, CREATE, [id, "Incrustable"]);
      await save(id, 1, {
        embed_origins: [
          "https://www.mi-sitio.cl",
          "https://mi-sitio.cl:8443",
          "https://www.mi-sitio.cl",
        ],
      });
      const { rows } = await setup.query(
        "select embed_origins from public.intake_forms where id = $1",
        [id],
      );
      expect(rows[0].embed_origins).toEqual([
        "https://mi-sitio.cl:8443",
        "https://www.mi-sitio.cl",
      ]);
      // diez sí caben (los sitios no cambian lo que ve el público: la revisión sigue en 1)
      await save(id, 1, {
        embed_origins: Array.from({ length: 10 }, (_, n) => `https://s${n}.cl`),
      });
      // y se pueden vaciar
      await save(id, 1, { embed_origins: [] });
      const audit = await setup.query(
        `select details from public.audit_log where resource_id = $1 and action = 'intake_form.embed_origins_changed' order by id`,
        [id],
      );
      expect(audit.rows).toHaveLength(3);
      expect(audit.rows[0].details).toEqual({
        old: [],
        new: ["https://mi-sitio.cl:8443", "https://www.mi-sitio.cl"],
      });
      expect(audit.rows[2].details.new).toEqual([]);
      expect(audit.rows[2].details.old).toHaveLength(10);
    });
  });

  it("guardar sin tocar los sitios no deja el aviso de cambio de sitios", async () => {
    await withTx(setup, async () => {
      const id = randomUUID();
      await callAs(setup, w.owner, w.tenantA, CREATE, [id, "Sin cambio"]);
      await save(id, 1, { embed_origins: ["https://uno.cl"] });
      await save(id, 1, { embed_origins: ["https://uno.cl"], title: "Otro título" });
      const audit = await setup.query(
        `select 1 from public.audit_log where resource_id = $1 and action = 'intake_form.embed_origins_changed'`,
        [id],
      );
      expect(audit.rows).toHaveLength(1);
    });
  });
});

describe("servicios del formulario (sin precio)", () => {
  it("se guardan en el orden de la pantalla, se actualizan por su id y los que faltan se quitan", async () => {
    await withTx(setup, async () => {
      const a = freeItem({ public_name: "Primero" });
      const b = catalogItem(w.catalogA, { public_name: "Segundo" });
      const c = freeItem({ public_name: "Tercero", is_active: false, quantity_mode: "none" });
      const form = await makeForm(setup, w.owner, w.tenantA, { items: [a, b, c] });
      const order = async () =>
        (
          await setup.query<{ public_name: string; position: number }>(
            "select public_name, position from public.intake_form_items where form_id = $1 order by position",
            [form.formId],
          )
        ).rows;
      expect((await order()).map((r) => r.public_name)).toEqual(["Primero", "Segundo", "Tercero"]);

      // reordenar, cambiar un nombre y quitar el tercero
      await save(form.formId, form.revision, {}, [b, { ...a, public_name: "Primero editado" }]);
      expect(await order()).toEqual([
        { public_name: "Segundo", position: 0 },
        { public_name: "Primero editado", position: 1 },
      ]);
      const { rows } = await setup.query(
        "select id from public.intake_form_items where form_id = $1 order by position",
        [form.formId],
      );
      expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
    });
  });

  it("p_items nulo deja los servicios como están; la lista vacía en un borrador los quita", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA, { publish: false });
      const saved = await save(form.formId, form.revision, { title: "Solo título" }, null);
      const count = async () =>
        (
          await setup.query(
            "select count(*)::int as n from public.intake_form_items where form_id = $1",
            [form.formId],
          )
        ).rows[0].n;
      expect(await count()).toBe(1);
      await save(form.formId, saved.revision, {}, []);
      expect(await count()).toBe(0);
    });
  });

  it("claves desconocidas (precio, costo, tarifa…) y valores inválidos se rechazan", async () => {
    await withTx(setup, async () => {
      for (const extra of [
        { unit_price_clp: 1000 },
        { price: 1000 },
        { cost: 1 },
        { tarifa: 1 },
        { amount: 1 },
        { margin: 1 },
        { tenant_id: w.tenantB },
        { form_id: randomUUID() },
      ]) {
        expect((await saveError({}, [freeItem(extra)])).code, JSON.stringify(extra)).toBe("CP422");
      }
      for (const bad of [
        { id: "no-es-uuid" },
        { id: undefined },
        { kind: "calc_model" },
        { kind: "otro" },
        { kind: "catalog" },
        { kind: "free", catalog_item_id: w.catalogA },
        { public_name: "" },
        { public_name: "x".repeat(151) },
        { public_name: "bidi‮" },
        { public_description: "y".repeat(501) },
        { unit: "litro" },
        { quantity_mode: "siempre" },
        { min_qty_milli: 0 },
        { min_qty_milli: 1000000001 },
        { max_qty_milli: 1.5 },
        { min_qty_milli: 5000, max_qty_milli: 1000 },
        { is_active: "si" },
      ]) {
        expect((await saveError({}, [freeItem(bad)])).code, JSON.stringify(bad)).toBe("CP422");
      }
      const dup = freeItem();
      expect((await saveError({}, [dup, dup])).code).toBe("CP422");
      expect(
        (
          await saveError(
            {},
            Array.from({ length: 51 }, () => freeItem()),
          )
        ).code,
      ).toBe("CP422");
    });
  });

  it("un servicio del catálogo de OTRA organización se rechaza (y la relación compuesta lo impide aunque se escriba directo)", async () => {
    await withTx(setup, async () => {
      expect((await saveError({}, [catalogItem(w.catalogB)])).code).toBe("CP404");
      const form = await makeForm(setup, w.owner, w.tenantA, { publish: false });
      await actAsPostgres(setup);
      const error = await expectSqlError(
        setup,
        `insert into public.intake_form_items (id, tenant_id, form_id, position, kind, catalog_item_id, public_name, unit)
         values (gen_random_uuid(), $1, $2, 9, 'catalog', $3, 'x', 'service')`,
        [w.tenantA, form.formId, w.catalogB],
      );
      expect(error.code).toBe("23503");
    });
  });

  it("el identificador de un servicio de otro formulario o de otra organización no se reutiliza", async () => {
    await withTx(setup, async () => {
      const mine = await makeForm(setup, w.owner, w.tenantA, { publish: false });
      const other = await makeForm(setup, w.ownerB, w.tenantB, { publish: false });
      const theirs = (
        await setup.query<{ id: string }>(
          "select id from public.intake_form_items where form_id = $1",
          [other.formId],
        )
      ).rows[0].id;
      await asUser(setup, w.owner, w.tenantA);
      const error = await expectSqlError(setup, SAVE, [
        mine.formId,
        mine.revision,
        "{}",
        JSON.stringify([freeItem({ id: theirs })]),
      ]);
      expect(error.code).toBe("CP422");
      // y el servicio de B sigue intacto
      const { rows } = await setup.query(
        "select form_id from public.intake_form_items where id = $1",
        [theirs],
      );
      expect(rows).toHaveLength(0); // (A no lo ve: es de B)
      await actAsPostgres(setup);
      const check = await setup.query(
        "select form_id from public.intake_form_items where id = $1",
        [theirs],
      );
      expect(check.rows[0].form_id).toBe(other.formId);
    });
  });

  it("la tabla de servicios no tiene ninguna columna que parezca de dinero", async () => {
    const { rows } = await setup.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name in ('intake_forms', 'intake_form_items')`,
    );
    for (const { column_name } of rows) {
      expect(column_name, column_name).not.toMatch(/price|cost|clp|tarif|amount|margin|estimate/i);
    }
  });
});

describe("publicar, pausar y archivar", () => {
  it("publicar exige un servicio activo y el correo de contacto de la organización", async () => {
    await withTx(setup, async () => {
      const id = randomUUID();
      await callAs(setup, w.owner, w.tenantA, CREATE, [id, "Sin servicios"]);
      await asUser(setup, w.owner, w.tenantA);
      expect((await expectSqlError(setup, STATUS, [id, "published"])).code).toBe("CP422");

      const inactive = await makeForm(setup, w.owner, w.tenantA, {
        publish: false,
        items: [freeItem({ is_active: false })],
      });
      await asUser(setup, w.owner, w.tenantA);
      expect(
        (await expectSqlError(setup, STATUS, [inactive.formId, "published"])).message,
      ).toContain("needs_item");

      const form = await makeForm(setup, w.owner, w.tenantA, { publish: false });
      await actAsPostgres(setup);
      await setup.query("update public.tenants set contact_email = null where tenant_id = $1", [
        w.tenantA,
      ]);
      await asUser(setup, w.owner, w.tenantA);
      expect((await expectSqlError(setup, STATUS, [form.formId, "published"])).message).toContain(
        "needs_contact_email",
      );
      await actAsPostgres(setup);
      await setup.query(
        "update public.tenants set contact_email = 'contacto@ejemplo.test' where tenant_id = $1",
        [w.tenantA],
      );
      const published = await callAs<Json>(setup, w.owner, w.tenantA, STATUS, [
        form.formId,
        "published",
      ]);
      expect(published).toEqual({ status: "published", changed: true });
    });
  });

  it("transiciones permitidas, repetir no hace nada, y archivado es definitivo", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA, { publish: false });
      const set = (status: string) =>
        callAs<Json>(setup, w.owner, w.tenantA, STATUS, [form.formId, status]);
      await asUser(setup, w.owner, w.tenantA);
      // desde borrador no se pausa
      expect((await expectSqlError(setup, STATUS, [form.formId, "paused"])).code).toBe("CP423");
      expect((await expectSqlError(setup, STATUS, [form.formId, "draft"])).code).toBe("CP422");
      expect((await expectSqlError(setup, STATUS, [form.formId, "borrado"])).code).toBe("CP422");
      expect(await set("published")).toEqual({ status: "published", changed: true });
      expect(await set("published")).toEqual({ status: "published", changed: false });
      expect(await set("paused")).toEqual({ status: "paused", changed: true });
      expect(await set("published")).toEqual({ status: "published", changed: true });
      expect(await set("archived")).toEqual({ status: "archived", changed: true });
      await asUser(setup, w.owner, w.tenantA);
      expect((await expectSqlError(setup, STATUS, [form.formId, "published"])).code).toBe("CP423");
      expect(
        (await expectSqlError(setup, SAVE, [form.formId, form.revision, "{}", null])).code,
      ).toBe("CP423");
      expect((await expectSqlError(setup, REGENERATE, [form.formId])).code).toBe("CP423");
      const { rows } = await setup.query(
        "select status, published_at, paused_at from public.intake_forms where id = $1",
        [form.formId],
      );
      expect(rows[0].status).toBe("archived");
      expect(rows[0].published_at).not.toBeNull();
    });
  });

  it("pausar guarda la hora y volver a publicar la borra, sin cambiar la primera publicación", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      const read = async () =>
        (
          await setup.query(
            "select published_at, paused_at from public.intake_forms where id = $1",
            [form.formId],
          )
        ).rows[0];
      const first = (await read()).published_at;
      expect(first).not.toBeNull();
      await callAs(setup, w.owner, w.tenantA, STATUS, [form.formId, "paused"]);
      expect((await read()).paused_at).not.toBeNull();
      await callAs(setup, w.owner, w.tenantA, STATUS, [form.formId, "published"]);
      const after = await read();
      expect(after.paused_at).toBeNull();
      expect(after.published_at).toEqual(first);
    });
  });

  it("un formulario publicado no se puede dejar sin servicios activos", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      await asUser(setup, w.owner, w.tenantA);
      expect(
        (await expectSqlError(setup, SAVE, [form.formId, form.revision, "{}", "[]"])).message,
      ).toContain("needs_item");
      const inactive = [freeItem({ id: form.itemIds[0], is_active: false })];
      expect(
        (
          await expectSqlError(setup, SAVE, [
            form.formId,
            form.revision,
            "{}",
            JSON.stringify(inactive),
          ])
        ).code,
      ).toBe("CP422");
    });
  });
});

describe("regenerar el enlace", () => {
  it("el identificador cambia, el anterior queda libre de efecto y todo queda en la auditoría", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      const result = await callAs<{ public_id: string }>(setup, w.admin, w.tenantA, REGENERATE, [
        form.formId,
      ]);
      expect(result.public_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(result.public_id).not.toBe(form.publicId);
      const { rows } = await setup.query(
        "select count(*)::int as n from public.intake_forms where public_id = $1",
        [form.publicId],
      );
      expect(rows[0].n).toBe(0);
      // no cambia la revisión: el formulario abierto en otra pantalla sigue vigente
      const rev = await setup.query("select revision from public.intake_forms where id = $1", [
        form.formId,
      ]);
      expect(rev.rows[0].revision).toBe(form.revision);
      await asUser(setup, w.sales, w.tenantA);
      expect((await expectSqlError(setup, REGENERATE, [form.formId])).code).toBe("42501");
    });
  });

  it("deja un registro por cada acción sensible, sin textos del formulario ni del visitante", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA, {
        form: { intro: "Texto que no va a la auditoría" },
      });
      await callAs(setup, w.owner, w.tenantA, STATUS, [form.formId, "paused"]);
      await callAs(setup, w.owner, w.tenantA, STATUS, [form.formId, "archived"]);
      const { rows } = await setup.query<{
        action: string;
        actor_user_id: string;
        details: unknown;
      }>(
        "select action, actor_user_id, details from public.audit_log where resource_id = $1 order by id",
        [form.formId],
      );
      expect(rows.map((r) => r.action)).toEqual([
        "intake_form.created",
        "intake_form.updated",
        "intake_form.published",
        "intake_form.paused",
        "intake_form.archived",
      ]);
      expect(rows.every((r) => r.actor_user_id === w.owner.id)).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("Texto que no va");
    });
  });
});

describe("la revisión solo sube con lo que ve el público (menor 7)", () => {
  const revisionOf = async (formId: string) =>
    (await setup.query("select revision from public.intake_forms where id = $1", [formId])).rows[0]
      .revision as number;

  it("el nombre interno, el tope diario y los sitios no la suben; el título, la introducción, el mensaje, los campos, la política y los servicios sí", async () => {
    await withTx(setup, async () => {
      const shown = freeItem({ public_name: "Visible" });
      const hidden = freeItem({ public_name: "Oculto", is_active: false });
      const form = await makeForm(setup, w.owner, w.tenantA, {
        publish: false,
        items: [shown, hidden],
      });
      let rev = form.revision;
      const same = async (formPart: object, items: object[] | null = null) => {
        const saved = await save(form.formId, rev, formPart, items);
        expect(saved.revision, JSON.stringify(formPart)).toBe(rev);
        expect(await revisionOf(form.formId)).toBe(rev);
      };
      const bumps = async (formPart: object, items: object[] | null = null) => {
        const saved = await save(form.formId, rev, formPart, items);
        expect(saved.revision, JSON.stringify(formPart)).toBe(rev + 1);
        rev = saved.revision;
      };
      await same({ name: "Otro nombre interno" });
      await same({ daily_cap: 77 });
      await same({ embed_origins: ["https://mi-sitio.cl"] });
      await same({}, [shown, hidden]); // los mismos servicios
      await same({}, [shown, { ...hidden, public_name: "Oculto editado" }]); // un servicio apagado no se ve
      await bumps({ title: "Otro título público" });
      await bumps({ intro: "Una introducción" });
      await bumps({ success_message: "Gracias, te escribimos" });
      await bumps({ privacy_policy_url: "https://mi-sitio.cl/privacidad" });
      await bumps({
        fields: {
          phone: "required",
          company: "off",
          comuna: "off",
          serviceAddress: "optional",
          desiredDate: "optional",
          message: "optional",
        },
      });
      await bumps({}, [{ ...shown, public_name: "Visible editado" }, hidden]);
      await bumps({}, [
        { ...shown, public_name: "Visible editado" },
        hidden,
        freeItem({ public_name: "Servicio nuevo" }),
      ]);
    });
  });

  it("el aviso de la auditoría dice 'items' solo si los servicios cambiaron de verdad", async () => {
    await withTx(setup, async () => {
      const item = freeItem();
      const form = await makeForm(setup, w.owner, w.tenantA, { publish: false, items: [item] });
      await save(form.formId, form.revision, { name: "Solo nombre" }, [item]);
      await save(form.formId, form.revision, {}, [{ ...item, public_name: "Distinto" }]);
      const { rows } = await setup.query<{ details: { changed: string[] } }>(
        `select details from public.audit_log where resource_id = $1 and action = 'intake_form.updated' order by id`,
        [form.formId],
      );
      expect(rows.at(-2)?.details.changed).toEqual(["name"]);
      expect(rows.at(-1)?.details.changed).toEqual(["items"]);
    });
  });
});

describe("servicios del catálogo inactivos (menor 8)", () => {
  it("no se pueden agregar; el que el formulario ya traía no impide guardar otros cambios", async () => {
    await withTx(setup, async () => {
      const catalog = catalogItem(w.catalogA);
      const form = await makeForm(setup, w.owner, w.tenantA, { publish: false, items: [catalog] });
      await setup.query("update public.catalog_items set is_active = false where id = $1", [
        w.catalogA,
      ]);
      // el servicio que ya estaba sigue pudiendo guardarse con otros cambios
      const saved = await save(form.formId, form.revision, { title: "Con catálogo apagado" }, [
        catalog,
      ]);
      expect(saved.revision).toBe(form.revision + 1);
      // uno nuevo con ese servicio inactivo, no
      await asUser(setup, w.owner, w.tenantA);
      const added = await expectSqlError(setup, SAVE, [
        form.formId,
        saved.revision,
        "{}",
        JSON.stringify([catalog, catalogItem(w.catalogA)]),
      ]);
      expect(added.code).toBe("CP422");
      expect(added.message).toContain("catalog_item_inactive");
      // uno nuevo pero apagado en el formulario, sí
      await actAsPostgres(setup);
      await save(form.formId, saved.revision, {}, [
        catalog,
        catalogItem(w.catalogA, { is_active: false }),
      ]);
    });
  });

  it("un servicio de otra organización sigue siendo 'no encontrado'", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA, { publish: false });
      await asUser(setup, w.owner, w.tenantA);
      const error = await expectSqlError(setup, SAVE, [
        form.formId,
        form.revision,
        "{}",
        JSON.stringify([catalogItem(w.catalogB)]),
      ]);
      expect(error.code).toBe("CP404");
    });
  });
});
