// Sprint 4 · migración 32 · asignar, descartar, restaurar y convertir una solicitud (H-089, H-090).
// Permisos de cada rol verificados en la base, miembros válidos, lista cerrada de estados, una sola
// cotización por solicitud y nada que cruce a otra organización. Cada prueba corre en una transacción que se
// deshace.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, expectSqlError, withTx, type TestUser } from "./helpers";
import {
  asUser,
  buildIntakeWorld,
  callAs,
  insertRequest,
  makeForm,
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

type Json = Record<string, unknown>;
const ASSIGN = "select public.assign_intake_request($1, $2) as r";
const DISCARD = "select public.discard_intake_request($1, $2, $3) as r";
const RESTORE = "select public.restore_intake_request($1) as r";
const CONVERT = "select public.convert_intake_request($1, $2, $3) as r";

const INSUFFICIENT_PRIVILEGE = "42501";

let form: MadeForm;
const newRequest = (over: Record<string, unknown> = {}) =>
  insertRequest(setup, w.tenantA, form.formId, over);
const rowOf = async (id: string) => {
  await actAsPostgres(setup);
  return (await setup.query("select * from public.intake_requests where id = $1", [id])).rows[0];
};

/** Una solicitud, dentro de una transacción con su formulario. */
async function withRequest<T>(
  fn: (id: string) => Promise<T>,
  over: Record<string, unknown> = {},
): Promise<T> {
  return withTx(setup, async () => {
    form = await makeForm(setup, w.owner, w.tenantA);
    return fn(await newRequest(over));
  });
}

const assignTo = async (id: string, user: TestUser) => {
  await actAsPostgres(setup);
  await setup.query(
    "update public.intake_requests set status = 'assigned', assigned_to = $2, assigned_at = now(), assigned_by = $3 where id = $1",
    [id, user.id, w.owner.id],
  );
};

async function denied(user: TestUser, sql: string, params: unknown[], tenant = w.tenantA) {
  await asUser(setup, user, tenant);
  const error = await expectSqlError(setup, sql, params);
  await actAsPostgres(setup);
  return error;
}

describe("asignar", () => {
  it("el Dueño y el Administrador asignan a quien cotiza; queda quién, a quién y cuándo, y la auditoría", async () => {
    await withRequest(async (id) => {
      for (const [by, to] of [
        [w.owner, w.sales],
        [w.admin, w.sales2],
        [w.owner, w.admin],
        [w.admin, w.owner],
      ] as const) {
        const result = await callAs<Json>(setup, by, w.tenantA, ASSIGN, [id, to.id]);
        expect(result).toEqual({ status: "assigned", assigned_to: to.id, changed: true });
        expect(await rowOf(id)).toMatchObject({
          status: "assigned",
          assigned_to: to.id,
          assigned_by: by.id,
        });
      }
      const { rows } = await setup.query(
        "select actor_user_id, details from public.audit_log where resource_id = $1 and action = 'intake_request.assigned' order by id",
        [id],
      );
      expect(rows).toHaveLength(4);
      expect(rows[0]).toMatchObject({
        actor_user_id: w.owner.id,
        details: { assigned_to: w.sales.id, previous: null },
      });
    });
  });

  it("repetir la misma asignación no hace nada", async () => {
    await withRequest(async (id) => {
      await callAs(setup, w.owner, w.tenantA, ASSIGN, [id, w.sales.id]);
      const before = await rowOf(id);
      expect(await callAs<Json>(setup, w.admin, w.tenantA, ASSIGN, [id, w.sales.id])).toMatchObject(
        { changed: false },
      );
      expect(await rowOf(id)).toEqual(before);
      const { rows } = await setup.query(
        "select 1 from public.audit_log where resource_id = $1 and action = 'intake_request.assigned'",
        [id],
      );
      expect(rows).toHaveLength(1);
    });
  });

  it("Comercial, Aprobador y Lector no asignan", async () => {
    await withRequest(async (id) => {
      for (const user of [w.sales, w.approver, w.viewer]) {
        expect((await denied(user, ASSIGN, [id, w.sales.id])).code, user.email).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
      expect((await rowOf(id)).status).toBe("new");
    });
  });

  it("el asignado debe ser miembro ACTIVO de ESTA organización y con rol que cotiza", async () => {
    await withRequest(async (id) => {
      await actAsPostgres(setup);
      await setup.query(
        "update public.members set status = 'removed', removed_at = now() where tenant_id = $1 and user_id = $2",
        [w.tenantA, w.sales2.id],
      );
      for (const [label, who] of [
        ["Aprobador", w.approver.id],
        ["Lector", w.viewer.id],
        ["de otra organización", w.ownerB.id],
        ["quitado del equipo", w.sales2.id],
        ["una cuenta que no existe", randomUUID()],
      ] as const) {
        await asUser(setup, w.owner, w.tenantA);
        const error = await expectSqlError(setup, ASSIGN, [id, who]);
        expect(error.code, label).toBe("CP422");
      }
      await actAsPostgres(setup);
      expect((await rowOf(id)).status).toBe("new");
    });
  });

  it("una solicitud inexistente o de otra organización: CP404; una convertida o descartada: CP423", async () => {
    await withRequest(async (id) => {
      await asUser(setup, w.owner, w.tenantA);
      expect((await expectSqlError(setup, ASSIGN, [randomUUID(), w.sales.id])).code).toBe("CP404");
      const other = await makeForm(setup, w.ownerB, w.tenantB);
      const theirs = await insertRequest(setup, w.tenantB, other.formId);
      await asUser(setup, w.owner, w.tenantA);
      expect((await expectSqlError(setup, ASSIGN, [theirs, w.sales.id])).code).toBe("CP404");
      expect((await rowOf(theirs)).status).toBe("new");
      // y con la cabecera de B la persona de A no es nadie
      await asUser(setup, w.owner, w.tenantB);
      expect((await expectSqlError(setup, ASSIGN, [theirs, w.sales.id])).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );

      await callAs(setup, w.owner, w.tenantA, DISCARD, [id, "spam", null]);
      await asUser(setup, w.owner, w.tenantA);
      expect((await expectSqlError(setup, ASSIGN, [id, w.sales.id])).code).toBe("CP423");
    });
  });
});

describe("descartar y restaurar", () => {
  it("el Dueño y el Administrador descartan con motivo; la nota se limpia y el motivo va a la auditoría sin texto libre", async () => {
    await withRequest(async (id) => {
      const result = await callAs<Json>(setup, w.admin, w.tenantA, DISCARD, [
        id,
        "duplicate",
        "  ya la tenía el equipo  ",
      ]);
      expect(result).toEqual({ status: "discarded", changed: true });
      expect(await rowOf(id)).toMatchObject({
        status: "discarded",
        discard_reason: "duplicate",
        discard_note: "ya la tenía el equipo",
        discarded_by: w.admin.id,
      });
      const { rows } = await setup.query(
        "select details from public.audit_log where resource_id = $1 and action = 'intake_request.discarded'",
        [id],
      );
      expect(rows).toEqual([{ details: { reason: "duplicate" } }]);
      // repetir no cambia nada
      expect(
        await callAs<Json>(setup, w.owner, w.tenantA, DISCARD, [id, "spam", null]),
      ).toMatchObject({ changed: false });
      expect((await rowOf(id)).discard_reason).toBe("duplicate");
    });
  });

  it("motivo fuera de la lista, nota de más de 200 caracteres o con caracteres de control: CP422", async () => {
    await withRequest(async (id) => {
      await asUser(setup, w.owner, w.tenantA);
      for (const params of [
        [id, "otro_motivo", null],
        [id, null, null],
        [id, "spam", "x".repeat(201)],
        [id, "other", "con\u0007campana"],
        [id, "other", "bidi‮texto"],
        [id, "other", "dos\nlíneas"],
      ]) {
        expect((await expectSqlError(setup, DISCARD, params)).code, JSON.stringify(params)).toBe(
          "CP422",
        );
      }
      expect((await rowOf(id)).status).toBe("new");
      await callAs(setup, w.owner, w.tenantA, DISCARD, [id, "other", "   "]);
      expect((await rowOf(id)).discard_note).toBeNull();
    });
  });

  it("el Comercial solo descarta las que tiene asignadas; Aprobador y Lector, ninguna", async () => {
    await withRequest(async (id) => {
      // sin responsable: no
      expect((await denied(w.sales, DISCARD, [id, "spam", null])).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      // de otro Comercial: no
      await assignTo(id, w.sales2);
      expect((await denied(w.sales, DISCARD, [id, "spam", null])).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      for (const user of [w.approver, w.viewer]) {
        expect((await denied(user, DISCARD, [id, "spam", null])).code, user.email).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
      // la suya: sí
      await callAs(setup, w.sales2, w.tenantA, DISCARD, [id, "out_of_scope", null]);
      expect((await rowOf(id)).status).toBe("discarded");
    });
  });

  it("restaurar vuelve a «nueva» sin responsable ni motivo; el Comercial solo restaura la que él descartó", async () => {
    await withRequest(async (id) => {
      await assignTo(id, w.sales);
      await callAs(setup, w.sales, w.tenantA, DISCARD, [id, "spam", "basura"]);
      // otro Comercial, Aprobador y Lector no pueden
      for (const user of [w.sales2, w.approver, w.viewer]) {
        expect((await denied(user, RESTORE, [id])).code, user.email).toBe(INSUFFICIENT_PRIVILEGE);
      }
      expect(await callAs<Json>(setup, w.sales, w.tenantA, RESTORE, [id])).toEqual({
        status: "new",
        changed: true,
      });
      expect(await rowOf(id)).toMatchObject({
        status: "new",
        assigned_to: null,
        assigned_by: null,
        discard_reason: null,
        discard_note: null,
        discarded_by: null,
      });
      const { rows } = await setup.query(
        "select details from public.audit_log where resource_id = $1 and action = 'intake_request.restored'",
        [id],
      );
      expect(rows).toEqual([{ details: { previous_reason: "spam" } }]);
      // restaurar una que ya está nueva no hace nada
      expect(await callAs<Json>(setup, w.owner, w.tenantA, RESTORE, [id])).toEqual({
        status: "new",
        changed: false,
      });
      // y una asignada no se «restaura»
      await assignTo(id, w.sales);
      await asUser(setup, w.owner, w.tenantA);
      expect((await expectSqlError(setup, RESTORE, [id])).code).toBe("CP423");
    });
  });

  it("el Dueño restaura cualquiera; una solicitud ajena o inexistente no existe", async () => {
    await withRequest(async (id) => {
      await assignTo(id, w.sales);
      await callAs(setup, w.admin, w.tenantA, DISCARD, [id, "spam", null]);
      expect((await callAs<Json>(setup, w.owner, w.tenantA, RESTORE, [id])).changed).toBe(true);
      await asUser(setup, w.owner, w.tenantA);
      expect((await expectSqlError(setup, RESTORE, [randomUUID()])).code).toBe("CP404");
      const other = await makeForm(setup, w.ownerB, w.tenantB);
      const theirs = await insertRequest(setup, w.tenantB, other.formId);
      await asUser(setup, w.owner, w.tenantA);
      expect((await expectSqlError(setup, RESTORE, [theirs])).code).toBe("CP404");
      expect((await expectSqlError(setup, DISCARD, [theirs, "spam", null])).code).toBe("CP404");
    });
  });
});

describe("convertir en cotización", () => {
  const quoteOf = async (quoteId: string) => {
    await actAsPostgres(setup);
    return (await setup.query("select * from public.quotes where id = $1", [quoteId])).rows[0];
  };
  const quoteCount = async () => {
    await actAsPostgres(setup);
    return (
      await setup.query("select count(*)::int as n from public.quotes where tenant_id = $1", [
        w.tenantA,
      ])
    ).rows[0].n as number;
  };

  it("crea el borrador del cliente elegido, vincula la solicitud, deja la historia y la auditoría", async () => {
    await withRequest(async (id) => {
      const result = await callAs<{ quote_id: string; number_display: string; converted: boolean }>(
        setup,
        w.owner,
        w.tenantA,
        CONVERT,
        [id, w.customerA, randomUUID()],
      );
      expect(result.converted).toBe(true);
      const quote = await quoteOf(result.quote_id);
      expect(quote).toMatchObject({
        status: "draft",
        tenant_id: w.tenantA,
        customer_id: w.customerA,
        created_by: w.owner.id,
        source_request_id: id,
        number_display: result.number_display,
      });
      expect(await rowOf(id)).toMatchObject({
        status: "converted",
        quote_id: result.quote_id,
        converted_by: w.owner.id,
        assigned_to: w.owner.id, // sin responsable: queda a cargo de quien la convierte
      });
      const events = await setup.query(
        "select type, actor_type, data from public.quote_events where quote_id = $1 order by id",
        [result.quote_id],
      );
      expect(events.rows.map((e) => e.type)).toEqual(["created", "created_from_request"]);
      expect(events.rows[1]).toMatchObject({ actor_type: "user", data: { request_id: id } });
      const audit = await setup.query(
        "select details from public.audit_log where resource_id = $1 and action = 'intake_request.converted'",
        [id],
      );
      expect(audit.rows).toEqual([{ details: { quote_id: result.quote_id } }]);
    });
  });

  it("convertida dos veces (u otra pestaña): la misma cotización, sin gastar otro número", async () => {
    await withRequest(async (id) => {
      const first = await callAs<Json>(setup, w.sales, w.tenantA, CONVERT, [
        id,
        w.customerA,
        randomUUID(),
      ]);
      const count = await quoteCount();
      const again = await callAs<Json>(setup, w.admin, w.tenantA, CONVERT, [
        id,
        w.customerA,
        randomUUID(),
      ]);
      expect(again).toEqual({
        quote_id: first.quote_id,
        number_display: first.number_display,
        converted: false,
      });
      expect(await quoteCount()).toBe(count);
      // aunque la segunda mande otro cliente, no se crea nada
      const other = await callAs<Json>(setup, w.owner, w.tenantA, CONVERT, [
        id,
        randomUUID(),
        randomUUID(),
      ]);
      expect(other.quote_id).toBe(first.quote_id);
    });
  });

  it("el Comercial convierte las suyas o las sin responsable (y queda a su cargo); la de otro Comercial, no", async () => {
    await withRequest(async (id) => {
      await callAs(setup, w.sales, w.tenantA, CONVERT, [id, w.customerA, randomUUID()]);
      expect(await rowOf(id)).toMatchObject({
        status: "converted",
        assigned_to: w.sales.id,
        assigned_by: w.sales.id,
      });
    });
    await withRequest(async (id) => {
      await assignTo(id, w.sales);
      await callAs(setup, w.sales, w.tenantA, CONVERT, [id, w.customerA, randomUUID()]);
      expect((await rowOf(id)).assigned_by).toBe(w.owner.id); // la asignación original se conserva
    });
    await withRequest(async (id) => {
      await assignTo(id, w.sales2);
      const count = await quoteCount();
      expect((await denied(w.sales, CONVERT, [id, w.customerA, randomUUID()])).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect(await quoteCount()).toBe(count);
      // el Dueño sí puede convertir la de otro, y no le quita el responsable
      await callAs(setup, w.owner, w.tenantA, CONVERT, [id, w.customerA, randomUUID()]);
      expect(await rowOf(id)).toMatchObject({
        status: "converted",
        assigned_to: w.sales2.id,
        converted_by: w.owner.id,
      });
    });
  });

  it("Aprobador y Lector no convierten", async () => {
    await withRequest(async (id) => {
      for (const user of [w.approver, w.viewer]) {
        expect(
          (await denied(user, CONVERT, [id, w.customerA, randomUUID()])).code,
          user.email,
        ).toBe(INSUFFICIENT_PRIVILEGE);
      }
      expect((await rowOf(id)).status).toBe("new");
    });
  });

  it("una solicitud descartada no se convierte (CP423)", async () => {
    await withRequest(async (id) => {
      await callAs(setup, w.owner, w.tenantA, DISCARD, [id, "spam", null]);
      const count = await quoteCount();
      await asUser(setup, w.owner, w.tenantA);
      expect((await expectSqlError(setup, CONVERT, [id, w.customerA, randomUUID()])).code).toBe(
        "CP423",
      );
      expect(await quoteCount()).toBe(count);
    });
  });

  it("un cliente de OTRA organización o anonimizado se rechaza y no queda nada a medias", async () => {
    await withRequest(async (id) => {
      const count = await quoteCount();
      const countB = (
        await setup.query("select count(*)::int as n from public.quotes where tenant_id = $1", [
          w.tenantB,
        ])
      ).rows[0].n;
      await asUser(setup, w.owner, w.tenantA);
      for (const customer of [w.customerB, w.customerAnon, randomUUID()]) {
        expect(
          (await expectSqlError(setup, CONVERT, [id, customer, randomUUID()])).code,
          customer,
        ).toBe("CP404");
      }
      await actAsPostgres(setup);
      expect((await rowOf(id)).status).toBe("new");
      expect(await quoteCount()).toBe(count);
      expect(
        (
          await setup.query("select count(*)::int as n from public.quotes where tenant_id = $1", [
            w.tenantB,
          ])
        ).rows[0].n,
      ).toBe(countB);
    });
  });

  it("una solicitud de otra organización no se convierte; ni con la cabecera de la otra", async () => {
    await withRequest(async () => {
      const other = await makeForm(setup, w.ownerB, w.tenantB);
      const theirs = await insertRequest(setup, w.tenantB, other.formId);
      await asUser(setup, w.owner, w.tenantA);
      expect((await expectSqlError(setup, CONVERT, [theirs, w.customerA, randomUUID()])).code).toBe(
        "CP404",
      );
      await asUser(setup, w.owner, w.tenantB);
      expect((await expectSqlError(setup, CONVERT, [theirs, w.customerB, randomUUID()])).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect((await rowOf(theirs)).status).toBe("new");
    });
  });

  it("la misma clave de creación en dos solicitudes no ata una cotización a dos solicitudes", async () => {
    await withRequest(async (id) => {
      const second = await newRequest();
      const key = randomUUID();
      await callAs(setup, w.owner, w.tenantA, CONVERT, [id, w.customerA, key]);
      await asUser(setup, w.owner, w.tenantA);
      const error = await expectSqlError(setup, CONVERT, [second, w.customerA, key]);
      // la clave devuelve la cotización que ya nació de la primera solicitud: no se amarra a la segunda
      expect(error.code).toBe("CP422");
      expect(error.message).toContain("creation_key_reused");
      await actAsPostgres(setup);
      expect((await rowOf(second)).status).toBe("new");
      expect((await rowOf(second)).quote_id).toBeNull();
    });
  });

  it("una clave de creación ya usada en otra cotización suya que ya no es borrador no amarra la solicitud", async () => {
    await withRequest(async (id) => {
      const key = randomUUID();
      await asUser(setup, w.owner, w.tenantA);
      const created = await setup.query<{ quote_id: string }>(
        "select * from public.create_quote($1, $2)",
        [w.customerA, key],
      );
      const quoteId = created.rows[0].quote_id;
      await actAsPostgres(setup);
      // una cotización que ya avanzó (se salta la guarda de estados solo para montar la prueba)
      await setup.query("set local session_replication_role = replica");
      await setup.query("update public.quotes set status = 'sent' where id = $1", [quoteId]);
      await setup.query("set local session_replication_role = origin");
      await asUser(setup, w.owner, w.tenantA);
      const error = await expectSqlError(setup, CONVERT, [id, w.customerA, key]);
      expect(error.code).toBe("CP422");
      expect(error.message).toContain("creation_key_reused");
      await actAsPostgres(setup);
      const request = await rowOf(id);
      expect(request).toMatchObject({ status: "new", quote_id: null });
      const quote = await setup.query(
        "select status, source_request_id from public.quotes where id = $1",
        [quoteId],
      );
      expect(quote.rows[0]).toEqual({ status: "sent", source_request_id: null });
    });
  });

  it("la cotización solo puede nacer de una solicitud de su propia organización (relación compuesta)", async () => {
    await withRequest(async (id) => {
      const other = await makeForm(setup, w.ownerB, w.tenantB);
      const theirs = await insertRequest(setup, w.tenantB, other.formId);
      const converted = await callAs<{ quote_id: string }>(setup, w.owner, w.tenantA, CONVERT, [
        id,
        w.customerA,
        randomUUID(),
      ]);
      const error = await expectSqlError(
        setup,
        "update public.quotes set source_request_id = $2 where id = $1",
        [converted.quote_id, theirs],
      );
      expect(error.code).toBe("23503");
    });
  });
});

describe("anonymize_intake_request (derecho de supresión)", () => {
  const ANONYMIZE = "select public.anonymize_intake_request($1, $2) as r";
  const PERSONAL = [
    "contact_name_enc",
    "contact_email_enc",
    "contact_phone_enc",
    "company_enc",
    "comuna_enc",
    "service_address_enc",
    "message_enc",
    "contact_email_hash",
    "consent_ip_enc",
  ];
  const withData = {
    contact_phone_enc: "v1.tel.tel",
    company_enc: "v1.emp.emp",
    comuna_enc: "v1.com.com",
    service_address_enc: "v1.dir.dir",
    message_enc: "v1.msg.msg",
    consent_ip_enc: "v1.ip.ip",
    desired_date: "2030-05-05",
  };

  it("el Dueño y el Administrador vacían los datos personales y conservan lo demás; queda en la auditoría sin datos personales", async () => {
    for (const by of [w.owner, w.admin]) {
      await withRequest(async (id) => {
        const before = await rowOf(id);
        const result = await callAs<Json>(setup, by, w.tenantA, ANONYMIZE, [
          id,
          "data_subject_request",
        ]);
        expect(result).toEqual({ anonymized: true, changed: true });
        const row = await rowOf(id);
        for (const column of PERSONAL) expect(row[column], column).toBeNull();
        expect(row.anonymized_at).not.toBeNull();
        // se conserva la historia de la organización y la prueba del consentimiento
        for (const column of [
          "items",
          "desired_date",
          "consent_text",
          "consent_text_sha256",
          "consent_template_version",
          "consented_at",
          "status",
          "form_revision",
        ])
          expect(row[column], column).toEqual(before[column]);
        const { rows } = await setup.query(
          "select actor_user_id, actor_type, result, details from public.audit_log where resource_id = $1 and action = 'intake_request.anonymized'",
          [id],
        );
        expect(rows).toEqual([
          {
            actor_user_id: by.id,
            actor_type: "user",
            result: "success",
            details: { reason: "data_subject_request", status: "new" },
          },
        ]);
        expect(JSON.stringify(rows)).not.toContain("v1.");
        // el interruptor interno no queda encendido
        const flag = await setup.query("select current_setting('app.intake_anonymize', true) as v");
        expect(flag.rows[0].v ?? "").toBe("");
      }, withData);
    }
  });

  it("funciona en cualquier estado: nueva, asignada, descartada y convertida", async () => {
    await withTx(setup, async () => {
      form = await makeForm(setup, w.owner, w.tenantA);
      const assigned = await newRequest(withData);
      await assignTo(assigned, w.sales);
      const discarded = await newRequest(withData);
      await callAs(setup, w.owner, w.tenantA, DISCARD, [discarded, "spam", null]);
      const converted = await newRequest(withData);
      await callAs(setup, w.owner, w.tenantA, CONVERT, [converted, w.customerA, randomUUID()]);
      const fresh = await newRequest(withData);
      for (const [id, status] of [
        [fresh, "new"],
        [assigned, "assigned"],
        [discarded, "discarded"],
        [converted, "converted"],
      ] as const) {
        expect(
          await callAs<Json>(setup, w.admin, w.tenantA, ANONYMIZE, [id, "other"]),
          status,
        ).toEqual({ anonymized: true, changed: true });
        const row = await rowOf(id);
        expect(row.status).toBe(status);
        expect(row.anonymized_at).not.toBeNull();
        for (const column of PERSONAL) expect(row[column], `${status} ${column}`).toBeNull();
      }
      // el vínculo con la cotización y el responsable se conservan
      expect((await rowOf(converted)).quote_id).not.toBeNull();
      expect((await rowOf(assigned)).assigned_to).toBe(w.sales.id);
    });
  });

  it("es idempotente: repetir no cambia nada ni deja otro registro", async () => {
    await withRequest(async (id) => {
      await callAs(setup, w.owner, w.tenantA, ANONYMIZE, [id, "wrong_data"]);
      const once = await rowOf(id);
      expect(await callAs<Json>(setup, w.admin, w.tenantA, ANONYMIZE, [id, "other"])).toEqual({
        anonymized: true,
        changed: false,
      });
      expect(await rowOf(id)).toEqual(once);
      const { rows } = await setup.query(
        "select details from public.audit_log where resource_id = $1 and action = 'intake_request.anonymized'",
        [id],
      );
      expect(rows).toEqual([{ details: { reason: "wrong_data", status: "new" } }]);
    }, withData);
  });

  it("Comercial, Aprobador y Lector no pueden (42501), ni con la solicitud asignada a ellos", async () => {
    await withRequest(async (id) => {
      await assignTo(id, w.sales);
      for (const user of [w.sales, w.approver, w.viewer]) {
        expect((await denied(user, ANONYMIZE, [id, "other"])).code, user.email).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
      const row = await rowOf(id);
      expect(row.anonymized_at).toBeNull();
      expect(row.contact_name_enc).not.toBeNull();
    }, withData);
  });

  it("una solicitud de otra organización no existe (CP404); ni con la cabecera de la otra (42501)", async () => {
    await withTx(setup, async () => {
      const other = await makeForm(setup, w.ownerB, w.tenantB);
      const theirs = await insertRequest(setup, w.tenantB, other.formId, withData);
      expect((await denied(w.owner, ANONYMIZE, [theirs, "other"])).code).toBe("CP404");
      expect((await denied(w.owner, ANONYMIZE, [theirs, "other"], w.tenantB)).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect((await denied(w.owner, ANONYMIZE, [randomUUID(), "other"])).code).toBe("CP404");
      const row = await rowOf(theirs);
      expect(row.anonymized_at).toBeNull();
      expect(row.contact_name_enc).not.toBeNull();
    });
  });

  it("el motivo es de una lista cerrada y no hay otro camino para anonimizar", async () => {
    await withRequest(async (id) => {
      for (const reason of [null, "", "porque sí", "Data_Subject_Request", "juan@correo.cl"]) {
        expect((await denied(w.owner, ANONYMIZE, [id, reason])).code, String(reason)).toBe("CP422");
      }
      expect((await denied(w.owner, ANONYMIZE, [null, "other"])).code).toBe("CP422");
      expect((await rowOf(id)).anonymized_at).toBeNull();
      // sin la función, vaciar los datos a mano sigue prohibido (la guarda no se abre sola)
      expect(
        (
          await expectSqlError(
            setup,
            `update public.intake_requests set contact_name_enc = null, contact_email_enc = null,
               contact_email_hash = null, anonymized_at = now() where id = $1`,
            [id],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
    }, withData);
  });

  it("la función no sirve para escribir datos: con el interruptor encendido, la guarda solo deja vaciar", async () => {
    await withRequest(async (id) => {
      await setup.query("select set_config('app.intake_anonymize', 'on', true)");
      expect(
        (
          await expectSqlError(
            setup,
            "update public.intake_requests set contact_name_enc = 'v1.nuevo.nuevo', anonymized_at = now() where id = $1",
            [id],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        (
          await expectSqlError(
            setup,
            "update public.intake_requests set items = '[]'::jsonb, contact_name_enc = null, contact_email_enc = null, contact_email_hash = null, anonymized_at = now() where id = $1",
            [id],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
    }, withData);
  });
});

describe("una solicitud anonimizada ya no se asigna ni se convierte (CP423)", () => {
  const ANONYMIZE = "select public.anonymize_intake_request($1, $2) as r";
  const quoteTotal = async () => {
    await actAsPostgres(setup);
    return (
      await setup.query("select count(*)::int as n from public.quotes where tenant_id = $1", [
        w.tenantA,
      ])
    ).rows[0].n as number;
  };

  it("nueva o asignada: asignar y convertir se rechazan, sin cambiar nada ni gastar un número", async () => {
    await withRequest(async (id) => {
      await callAs(setup, w.owner, w.tenantA, ASSIGN, [id, w.sales.id]);
      await callAs(setup, w.owner, w.tenantA, ANONYMIZE, [id, "other"]);
      const before = await rowOf(id);
      expect(before.anonymized_at).not.toBeNull();
      const quotes = await quoteTotal();

      await asUser(setup, w.owner, w.tenantA);
      const assign = await expectSqlError(setup, ASSIGN, [id, w.sales2.id]);
      expect(assign.code).toBe("CP423");
      expect(assign.message).toContain("anonymized");
      await asUser(setup, w.owner, w.tenantA);
      const convert = await expectSqlError(setup, CONVERT, [id, w.customerA, randomUUID()]);
      expect(convert.code).toBe("CP423");
      expect(convert.message).toContain("anonymized");

      expect(await rowOf(id)).toEqual(before);
      expect(await quoteTotal()).toBe(quotes);
    });
  });
});
