// Sprint 4 · Ataques 1, 2 y 3 de aislamiento sobre las solicitudes: asignar, descartar, restaurar y convertir
// una solicitud de otra organización, asignar a quien no es miembro activo, y convertir con un cliente de otra
// organización. Siempre con pases reales y `fetch` directo; la llave maestra solo sirve como "el servidor"
// para que lleguen solicitudes y para verificar.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localEnv, rpc } from "../support/local-supabase";
import { fingerprint, fixture, openDb, tenantHeader, tokenOf } from "./context";
import { ISOLATION_TABLES } from "./registry";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

const codeOf = (res: { json: unknown }) => (res.json as { code?: string } | null)?.code;
const spec = (name: string) => ISOLATION_TABLES.find((t) => t.name === name)!;

/** Una solicitud nueva en el formulario de A, recibida como la recibe el servidor. */
async function freshRequestOfA(): Promise<string> {
  const fx = fixture();
  const a = fx.orgs.A.intake!;
  const { secretKey } = localEnv();
  const requestId = randomUUID();
  const res = await rpc(
    secretKey,
    "intake_request_submit",
    {
      p_public_id: a.publicId,
      p_request_id: requestId,
      p_submit_key: randomUUID(),
      p_form_revision: a.revision,
      p_contact_name_enc: "v1.nombre.cifrado",
      p_contact_email_enc: "v1.correo.cifrado",
      p_contact_phone_enc: null,
      p_company_enc: null,
      p_comuna_enc: null,
      p_service_address_enc: null,
      p_message_enc: null,
      p_contact_email_hash: "9".repeat(64),
      p_desired_date: null,
      p_items: [{ form_item_id: a.freeItemId, quantity_milli: null }],
      p_consent_template_version: "intake-v1",
      p_consent_text: "Acepto que la organización use mis datos para responder esta solicitud.",
      p_consent_ip_enc: null,
    },
    { apikey: secretKey },
  );
  expect(res.status, res.text).toBe(200);
  expect((res.json as { result: string }).result).toBe("ok");
  return requestId;
}

const statusOf = async (id: string) =>
  (
    await db.query<{ status: string; assigned_to: string | null; quote_id: string | null }>(
      "select status, assigned_to, quote_id from public.intake_requests where id = $1",
      [id],
    )
  ).rows[0];

describe("Ataque 1 · actuar sobre una solicitud de B con el pase de A", () => {
  it("Ana asigna, descarta, restaura y convierte la solicitud de B: CP404 y B queda intacta", async () => {
    const fx = fixture();
    const b = fx.orgs.B.intake!;
    const token = await tokenOf("ana");
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const tables = ["intake_requests", "quotes", "quote_events", "audit_log"].map(spec);
    const before = new Map<string, string>();
    for (const t of tables) before.set(t.name, await fingerprint(db, t));

    const calls: [string, object][] = [
      [
        "assign_intake_request",
        { p_request_id: b.requestId, p_assignee_user_id: fx.personas.ana.userId },
      ],
      ["discard_intake_request", { p_request_id: b.requestId, p_reason: "spam", p_note: null }],
      ["restore_intake_request", { p_request_id: b.requestId }],
      ["anonymize_intake_request", { p_request_id: b.requestId, p_reason: "data_subject_request" }],
      [
        "convert_intake_request",
        {
          p_request_id: b.requestId,
          p_customer_id: fx.orgs.A.customerIds[0],
          p_creation_key: randomUUID(),
        },
      ],
      [
        "convert_intake_request",
        {
          p_request_id: b.requestId,
          p_customer_id: fx.orgs.B.customerIds[0],
          p_creation_key: randomUUID(),
        },
      ],
    ];
    for (const [name, args] of calls) {
      const res = await rpc(token, name, args, headers);
      expect(res.status, name).toBeGreaterThanOrEqual(400);
      expect(codeOf(res), `${name}: ${res.text}`).toBe("CP404");
      expect(res.text).not.toContain(fx.orgs.B.canary);
    }
    for (const t of tables) {
      expect(await fingerprint(db, t), `${t.name} de B cambió`).toBe(before.get(t.name));
    }
    expect((await statusOf(b.requestId)).status).toBe("new");
  });

  it("con la cabecera de B (o sin ninguna) Ana ni siquiera llega a las funciones: 42501", async () => {
    const fx = fixture();
    const b = fx.orgs.B.intake!;
    const token = await tokenOf("ana");
    for (const header of [fx.orgs.B.tenantId, undefined]) {
      for (const [name, args] of [
        [
          "assign_intake_request",
          { p_request_id: b.requestId, p_assignee_user_id: fx.personas.ana.userId },
        ],
        ["discard_intake_request", { p_request_id: b.requestId, p_reason: "spam", p_note: null }],
        ["restore_intake_request", { p_request_id: b.requestId }],
        [
          "anonymize_intake_request",
          { p_request_id: b.requestId, p_reason: "data_subject_request" },
        ],
        [
          "convert_intake_request",
          {
            p_request_id: b.requestId,
            p_customer_id: fx.orgs.B.customerIds[0],
            p_creation_key: randomUUID(),
          },
        ],
      ] as [string, object][]) {
        const res = await rpc(token, name, args, tenantHeader(header));
        expect(res.status, name).toBeGreaterThanOrEqual(400);
        expect(codeOf(res), `${name}: ${res.text}`).toBe("42501");
      }
    }
    expect((await statusOf(b.requestId)).status).toBe("new");
  });

  it("Dante (lector de A) no puede asignar, descartar ni convertir las de A", async () => {
    const fx = fixture();
    const requestId = await freshRequestOfA();
    const token = await tokenOf("dante");
    const headers = tenantHeader(fx.orgs.A.tenantId);
    for (const [name, args] of [
      [
        "assign_intake_request",
        { p_request_id: requestId, p_assignee_user_id: fx.personas.ana.userId },
      ],
      ["discard_intake_request", { p_request_id: requestId, p_reason: "spam", p_note: null }],
      ["restore_intake_request", { p_request_id: requestId }],
      [
        "convert_intake_request",
        {
          p_request_id: requestId,
          p_customer_id: fx.orgs.A.customerIds[0],
          p_creation_key: randomUUID(),
        },
      ],
    ] as [string, object][]) {
      const res = await rpc(token, name, args, headers);
      expect(res.status, name).toBeGreaterThanOrEqual(400);
      expect(codeOf(res), `${name}: ${res.text}`).toBe("42501");
    }
    expect((await statusOf(requestId)).status).toBe("new");
  });
});

describe("Ataque 2 · asignar a quien no es miembro activo de la organización", () => {
  it("a Beto (solo de B), a Carla (quitada de A) y a Dante (lector): rechazado; a Mixta (administradora de A): sí", async () => {
    const fx = fixture();
    // Carla estuvo en A y la quitaron: la membresía queda como «quitada»
    await db.query(
      `insert into public.members (tenant_id, user_id, role, status, removed_at)
       values ($1, $2, 'sales', 'removed', now()) on conflict (tenant_id, user_id) do nothing`,
      [fx.orgs.A.tenantId, fx.personas.carla.userId],
    );
    const requestId = await freshRequestOfA();
    const token = await tokenOf("ana");
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const beforeB = await fingerprint(db, spec("intake_requests"));
    for (const who of ["beto", "carla", "dante"] as const) {
      const res = await rpc(
        token,
        "assign_intake_request",
        { p_request_id: requestId, p_assignee_user_id: fx.personas[who].userId },
        headers,
      );
      expect(res.status, who).toBeGreaterThanOrEqual(400);
      expect(codeOf(res), `${who}: ${res.text}`).toBe("CP422");
    }
    expect(await statusOf(requestId)).toMatchObject({ status: "new", assigned_to: null });
    // control positivo: el mismo llamado con una persona válida funciona (el rechazo no era por argumentos mal armados)
    const ok = await rpc(
      token,
      "assign_intake_request",
      { p_request_id: requestId, p_assignee_user_id: fx.personas.mixta.userId },
      headers,
    );
    expect(ok.status, ok.text).toBe(200);
    expect(await statusOf(requestId)).toMatchObject({
      status: "assigned",
      assigned_to: fx.personas.mixta.userId,
    });
    expect(await fingerprint(db, spec("intake_requests"))).toBe(beforeB);
  });

  it("Ana (Dueña) no puede asignar una solicitud de A a una cuenta que no existe", async () => {
    const fx = fixture();
    const requestId = await freshRequestOfA();
    const res = await rpc(
      await tokenOf("ana"),
      "assign_intake_request",
      { p_request_id: requestId, p_assignee_user_id: randomUUID() },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(codeOf(res), res.text).toBe("CP422");
    expect((await statusOf(requestId)).status).toBe("new");
  });
});

describe("Ataque 3b · convertir (H-090): Comercial ajena, clave repetida y doble conversión", () => {
  const quotesOfA = async (tenantId: string) =>
    (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.quotes where tenant_id = $1",
        [tenantId],
      )
    ).rows[0].n;

  it("Carla (Comercial de A) no convierte la solicitud asignada a otra persona (42501); una sin asignar sí y queda a su cargo", async () => {
    const fx = fixture();
    const headers = tenantHeader(fx.orgs.A.tenantId);
    // Carla es Dueña de C: aquí entra a A como Comercial (y al terminar queda como «quitada»).
    const setCarla = (status: "active" | "removed") =>
      db.query(
        `insert into public.members (tenant_id, user_id, role, status, removed_at)
         values ($1, $2, 'sales', $3, case when $3 = 'removed' then now() end)
         on conflict (tenant_id, user_id) do update
           set role = 'sales', status = excluded.status, removed_at = excluded.removed_at`,
        [fx.orgs.A.tenantId, fx.personas.carla.userId, status],
      );
    await setCarla("active");
    try {
      await carlaAttacks(fx, headers);
    } finally {
      await setCarla("removed");
    }
  });

  async function carlaAttacks(fx: ReturnType<typeof fixture>, headers: Record<string, string>) {
    const assigned = await freshRequestOfA();
    const mixtaAssign = await rpc(
      await tokenOf("ana"),
      "assign_intake_request",
      { p_request_id: assigned, p_assignee_user_id: fx.personas.mixta.userId },
      headers,
    );
    expect(mixtaAssign.status, mixtaAssign.text).toBe(200);
    const before = await quotesOfA(fx.orgs.A.tenantId);

    const token = await tokenOf("carla");
    const denied = await rpc(
      token,
      "convert_intake_request",
      {
        p_request_id: assigned,
        p_customer_id: fx.orgs.A.customerIds[0],
        p_creation_key: randomUUID(),
      },
      headers,
    );
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(codeOf(denied), denied.text).toBe("42501");
    expect(await quotesOfA(fx.orgs.A.tenantId)).toBe(before);
    expect(await statusOf(assigned)).toMatchObject({
      status: "assigned",
      assigned_to: fx.personas.mixta.userId,
      quote_id: null,
    });

    // control positivo: una sin asignar sí, y queda a cargo de Carla
    const free = await freshRequestOfA();
    const ok = await rpc(
      token,
      "convert_intake_request",
      {
        p_request_id: free,
        p_customer_id: fx.orgs.A.customerIds[0],
        p_creation_key: randomUUID(),
      },
      headers,
    );
    expect(ok.status, ok.text).toBe(200);
    expect(await statusOf(free)).toMatchObject({
      status: "converted",
      assigned_to: fx.personas.carla.userId,
    });
  }

  it("la misma clave de creación en otra solicitud: CP422 y la segunda queda intacta", async () => {
    const fx = fixture();
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const token = await tokenOf("ana");
    const key = randomUUID();
    const first = await freshRequestOfA();
    const second = await freshRequestOfA();
    const ok = await rpc(
      token,
      "convert_intake_request",
      { p_request_id: first, p_customer_id: fx.orgs.A.customerIds[0], p_creation_key: key },
      headers,
    );
    expect(ok.status, ok.text).toBe(200);
    const before = await quotesOfA(fx.orgs.A.tenantId);
    const reused = await rpc(
      token,
      "convert_intake_request",
      { p_request_id: second, p_customer_id: fx.orgs.A.customerIds[0], p_creation_key: key },
      headers,
    );
    expect(reused.status).toBeGreaterThanOrEqual(400);
    expect(codeOf(reused), reused.text).toBe("CP422");
    expect(await quotesOfA(fx.orgs.A.tenantId)).toBe(before);
    expect(await statusOf(second)).toMatchObject({ status: "new", quote_id: null });
  });

  it("convertir dos veces la misma solicitud (otra pestaña) devuelve la misma cotización sin crear otra", async () => {
    const fx = fixture();
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const token = await tokenOf("ana");
    const requestId = await freshRequestOfA();
    const first = await rpc(
      token,
      "convert_intake_request",
      {
        p_request_id: requestId,
        p_customer_id: fx.orgs.A.customerIds[0],
        p_creation_key: randomUUID(),
      },
      headers,
    );
    expect(first.status, first.text).toBe(200);
    const before = await quotesOfA(fx.orgs.A.tenantId);
    const again = await rpc(
      token,
      "convert_intake_request",
      {
        p_request_id: requestId,
        p_customer_id: fx.orgs.A.customerIds[0],
        p_creation_key: randomUUID(),
      },
      headers,
    );
    expect(again.status, again.text).toBe(200);
    expect((again.json as { quote_id: string; converted: boolean }).converted).toBe(false);
    expect((again.json as { quote_id: string }).quote_id).toBe(
      (first.json as { quote_id: string }).quote_id,
    );
    expect(await quotesOfA(fx.orgs.A.tenantId)).toBe(before);
  });
});

describe("Ataque 3 · convertir con un cliente de otra organización", () => {
  it("el `customer_id` de B con una solicitud de A: rechazado, sin cotización y sin cambios; con uno de A, sí", async () => {
    const fx = fixture();
    const requestId = await freshRequestOfA();
    const token = await tokenOf("ana");
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const quotes = async (tenantId: string) =>
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from public.quotes where tenant_id = $1",
          [tenantId],
        )
      ).rows[0].n;
    const beforeA = await quotes(fx.orgs.A.tenantId);
    const beforeB = await quotes(fx.orgs.B.tenantId);
    const quotesOfB = await fingerprint(db, spec("quotes"));

    const crossed = await rpc(
      token,
      "convert_intake_request",
      {
        p_request_id: requestId,
        p_customer_id: fx.orgs.B.customerIds[0],
        p_creation_key: randomUUID(),
      },
      headers,
    );
    expect(crossed.status).toBeGreaterThanOrEqual(400);
    expect(codeOf(crossed), crossed.text).toBe("CP404");
    expect(crossed.text).not.toContain(fx.orgs.B.canary);
    expect(await quotes(fx.orgs.A.tenantId)).toBe(beforeA);
    expect(await quotes(fx.orgs.B.tenantId)).toBe(beforeB);
    expect(await fingerprint(db, spec("quotes"))).toBe(quotesOfB);
    expect((await statusOf(requestId)).status).toBe("new");

    // control positivo: con un cliente propio, la conversión funciona y queda en A
    const ok = await rpc(
      token,
      "convert_intake_request",
      {
        p_request_id: requestId,
        p_customer_id: fx.orgs.A.customerIds[0],
        p_creation_key: randomUUID(),
      },
      headers,
    );
    expect(ok.status, ok.text).toBe(200);
    const result = ok.json as { quote_id: string; converted: boolean };
    expect(result.converted).toBe(true);
    const { rows } = await db.query<{
      tenant_id: string;
      source_request_id: string;
      customer_id: string;
    }>("select tenant_id, source_request_id, customer_id from public.quotes where id = $1", [
      result.quote_id,
    ]);
    expect(rows).toEqual([
      {
        tenant_id: fx.orgs.A.tenantId,
        source_request_id: requestId,
        customer_id: fx.orgs.A.customerIds[0],
      },
    ]);
    expect(await quotes(fx.orgs.A.tenantId)).toBe(beforeA + 1);
  });
});
