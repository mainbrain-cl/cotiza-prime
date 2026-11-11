// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Sprint 5 · H-040 · Aislamiento de la regla de aprobación: ataques con pases reales y `fetch` directo.
//  1. Ana (A) apunta a B con su pase —cabecera de B, sin cabecera, mal escrita— para cambiar su regla: «No encontrado».
//  2. Beto (Dueño de B) hace lo mismo hacia A. Mixta (Administradora de A y de B), parada en A, cambia A y no toca B; la
//     auditoría queda con el tenant_id de A.
//  3. Dante (Observador), Dario (Aprobador), Sofia y Ex (Comercial) no pueden cambiar la regla de A.
//  4. Nadie con un pase escribe directo en la tabla, ni siquiera en la de su propia organización.
//  5. Lectura: cada miembro de A ve la regla de A y ninguna de B; el umbral canario de B no aparece en ninguna respuesta.
//  6. La regla de B no bloquea los envíos de A (a nivel de base de datos): la regla es de cada organización.
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rest, rpc } from "../support/local-supabase";
import { countWhere, fingerprint, fixture, openDb, tenantHeader, tokenOf } from "./context";
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
const B_CANARY_AMOUNT = "1234567";

const setArgs = (over: Record<string, unknown> = {}) => ({
  p_expected_version: 1,
  p_mode: "always",
  p_amount_threshold_clp: null,
  p_discount_threshold_bp: null,
  ...over,
});

/** Lo que un ataque a la regla podría tocar. */
const WATCHED = ["approval_rules", "audit_log"] as const;
async function snapshot() {
  const out = new Map<string, string>();
  for (const name of WATCHED) out.set(name, await fingerprint(db, spec(name)));
  return out;
}
async function expectUntouched(before: Map<string, string>) {
  for (const name of WATCHED) {
    expect(await fingerprint(db, spec(name)), `${name} cambió`).toBe(before.get(name));
  }
}

describe("Ataque 1 · Ana, con su pase, apunta a B", () => {
  it("con la cabecera de B, sin cabecera o mal escrita: «No encontrado» y B queda intacta", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const before = await snapshot();
    const headers = [
      fx.orgs.B.tenantId,
      fx.orgs.B.tenantId.toUpperCase(),
      fx.orgs.B.tenantId.replaceAll("-", ""),
      `{${fx.orgs.B.tenantId}}`,
      undefined,
      "",
      "null",
    ];
    for (const header of headers) {
      const res = await rpc(
        token,
        "set_approval_rule",
        setArgs({ p_expected_version: 2 }),
        tenantHeader(header),
      );
      expect(res.status, `${header}`).toBeGreaterThanOrEqual(400);
      expect(codeOf(res), `${header}`).toBe("CP404");
      expect(res.text, `${header}`).not.toContain(fx.orgs.B.canary);
      expect(res.text, `${header}`).not.toContain(fx.orgs.B.tenantId);
      expect(res.text, `${header}`).not.toContain(B_CANARY_AMOUNT);
    }
    await expectUntouched(before);
    expect(
      await countWhere(db, "approval_rules", `tenant_id = '${fx.orgs.B.tenantId}' and version = 2`),
    ).toBe(1);
  });

  it("mandar un tenant_id como argumento no sirve: la función no lo acepta", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const before = await snapshot();
    const res = await rpc(
      token,
      "set_approval_rule",
      setArgs({ p_tenant_id: fx.orgs.B.tenantId, tenant_id: fx.orgs.B.tenantId }),
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    await expectUntouched(before);
  });
});

describe("Ataque 2 · entre organizaciones, en los dos sentidos", () => {
  it("Beto (Dueño de B) no toca la regla de A ni con la cabecera de A ni con la suya", async () => {
    const fx = fixture();
    const token = await tokenOf("beto");
    const before = await snapshot();
    // Con la cabecera de A: no es miembro de A.
    const asA = await rpc(
      token,
      "set_approval_rule",
      setArgs({ p_expected_version: 2 }),
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(codeOf(asA)).toBe("CP404");
    expect(asA.text).not.toContain(fx.orgs.A.canary);
    expect(asA.text).not.toContain(String(fx.orgs.A.approval!.amountThresholdClp));
    // Con la suya y una versión esperada que solo existe en A (B y A van en la misma): sin efecto sobre A.
    const asB = await rpc(
      token,
      "set_approval_rule",
      setArgs({ p_expected_version: 99 }),
      tenantHeader(fx.orgs.B.tenantId),
    );
    expect(codeOf(asB)).toBe("CP409");
    await expectUntouched(before);
  });

  it("Mixta (Administradora de A y de B), parada en A, cambia A y no toca B; la auditoría queda en A", async () => {
    const fx = fixture();
    const a = fx.orgs.A.approval!;
    const token = await tokenOf("mixta");
    const bBefore = await snapshot();
    const res = await rpc(
      token,
      "set_approval_rule",
      setArgs({
        p_expected_version: a.version,
        p_mode: "conditional",
        p_amount_threshold_clp: a.amountThresholdClp + 1,
      }),
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ changed: true, version: a.version + 1 });
    // A tiene su versión nueva, de Mixta
    expect(
      await countWhere(
        db,
        "approval_rules",
        `tenant_id = '${fx.orgs.A.tenantId}' and version = ${a.version + 1} and created_by = '${fx.personas.mixta.userId}'`,
      ),
    ).toBe(1);
    // B no cambió en nada
    await expectUntouched(bBefore);
    // La auditoría de lo que hizo quedó con el tenant_id de A, con los montos y sin datos de B
    const { rows } = await db.query(
      `select tenant_id, details::text as details from public.audit_log
        where action = 'approval_rule.updated' and actor_user_id = $1 and tenant_id = $2`,
      [fx.personas.mixta.userId, fx.orgs.A.tenantId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.tenant_id).toBe(fx.orgs.A.tenantId);
      expect(row.details).not.toContain(B_CANARY_AMOUNT);
    }
    expect(
      await countWhere(
        db,
        "audit_log",
        `action = 'approval_rule.updated' and actor_user_id = '${fx.personas.mixta.userId}' and tenant_id = '${fx.orgs.B.tenantId}'`,
      ),
    ).toBe(0);
  });

  it("Ana puede cambiar la de A (control positivo) y la de B sigue como estaba", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const bFingerprint = await fingerprint(db, spec("approval_rules"));
    const { rows } = await db.query<{ version: number }>(
      "select max(version) as version from public.approval_rules where tenant_id = $1",
      [fx.orgs.A.tenantId],
    );
    const res = await rpc(
      token,
      "set_approval_rule",
      setArgs({ p_expected_version: rows[0].version, p_mode: "never" }),
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(res.status, res.text).toBe(200);
    expect(await fingerprint(db, spec("approval_rules"))).toBe(bFingerprint);
  });
});

describe("Ataque 3 · quienes no pueden cambiar la regla de A", () => {
  it("Dante (Observador), Dario (Aprobador) y Sofia (Comercial) leen la regla de A pero reciben «sin permiso»", async () => {
    const fx = fixture();
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const before = await snapshot();
    for (const persona of ["dante", "dario", "sofia"] as const) {
      const token = await tokenOf(persona);
      const read = await rest(token, "approval_rules?select=id,tenant_id,version", { headers });
      expect(read.status, persona).toBe(200);
      const rows = read.json as { tenant_id: string }[];
      expect(rows.length, persona).toBeGreaterThanOrEqual(2);
      expect(new Set(rows.map((r) => r.tenant_id)), persona).toEqual(new Set([fx.orgs.A.tenantId]));
      const res = await rpc(
        token,
        "set_approval_rule",
        setArgs({ p_expected_version: 99 }),
        headers,
      );
      expect(res.status, persona).toBeGreaterThanOrEqual(400);
      expect(codeOf(res), persona).toBe("42501");
    }
    await expectUntouched(before);
  });

  it("Ex (Comercial en A) no puede cambiar la regla de A", async () => {
    const fx = fixture();
    const token = await tokenOf("ex");
    const before = await snapshot();
    const res = await rpc(
      token,
      "set_approval_rule",
      setArgs({ p_expected_version: 99 }),
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(["42501", "CP404"]).toContain(codeOf(res));
    await expectUntouched(before);
  });
});

describe("Ataque 4 · escribir directo en la tabla", () => {
  it("nadie con un pase (ni la Dueña, ni la Administradora, ni el Observador) crea, edita ni borra por la API de tablas", async () => {
    const fx = fixture();
    const before = await snapshot();
    for (const persona of ["ana", "mixta", "dante"] as const) {
      const token = await tokenOf(persona);
      const headers = { ...tenantHeader(fx.orgs.A.tenantId), Prefer: "return=representation" };
      const post = await rest(token, "approval_rules", {
        method: "POST",
        headers,
        body: {
          tenant_id: fx.orgs.A.tenantId,
          version: 99,
          mode: "never",
          created_by: fx.personas[persona].userId,
        },
      });
      expect(post.status, `${persona} POST`).toBeGreaterThanOrEqual(400);
      const patch = await rest(token, `approval_rules?tenant_id=eq.${fx.orgs.A.tenantId}`, {
        method: "PATCH",
        headers,
        body: { mode: "never", amount_threshold_clp: 1 },
      });
      expect(patch.status, `${persona} PATCH`).toBeGreaterThanOrEqual(400);
      const del = await rest(token, `approval_rules?tenant_id=eq.${fx.orgs.A.tenantId}`, {
        method: "DELETE",
        headers,
      });
      expect(del.status, `${persona} DELETE`).toBeGreaterThanOrEqual(400);
    }
    await expectUntouched(before);
    expect(
      await countWhere(
        db,
        "approval_rules",
        `tenant_id = '${fx.orgs.A.tenantId}' and version = 99`,
      ),
    ).toBe(0);
  });

  it("apuntar a una fila de B por su identificador tampoco sirve", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const before = await snapshot();
    const ruleId = fx.orgs.B.approval!.ruleId;
    for (const method of ["PATCH", "DELETE"]) {
      const res = await rest(token, `approval_rules?id=eq.${ruleId}`, {
        method,
        headers: { ...tenantHeader(fx.orgs.A.tenantId), Prefer: "return=representation" },
        body: method === "PATCH" ? { mode: "never" } : undefined,
      });
      expect(res.status, method).toBeGreaterThanOrEqual(400);
      expect(res.text, method).not.toContain(B_CANARY_AMOUNT);
    }
    await expectUntouched(before);
  });
});

describe("Ataque 5 · lectura", () => {
  it("cada miembro de A ve las reglas de A y ninguna de B; el umbral canario de B no aparece en ninguna respuesta", async () => {
    const fx = fixture();
    const headersA = tenantHeader(fx.orgs.A.tenantId);
    for (const persona of ["ana", "mixta", "dante", "dario", "sofia", "ex"] as const) {
      const token = await tokenOf(persona);
      const res = await rest(token, "approval_rules?select=*", { headers: headersA });
      expect(res.status, persona).toBe(200);
      const rows = res.json as { tenant_id: string; amount_threshold_clp: number | null }[];
      // Ex puede haber sido quitada de A por otra prueba que corre a la vez: entonces no ve nada (nunca algo de B).
      if (persona !== "ex") expect(rows.length, persona).toBeGreaterThanOrEqual(2);
      expect(
        rows.every((r) => r.tenant_id === fx.orgs.A.tenantId),
        persona,
      ).toBe(true);
      expect(res.text, persona).not.toContain(B_CANARY_AMOUNT);
      expect(res.text, persona).not.toContain(fx.orgs.B.tenantId);
    }
  });

  it("Ana pidiendo con la cabecera de B, sin cabecera o por el identificador de una fila de B: nada", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    for (const header of [fx.orgs.B.tenantId, undefined]) {
      const all = await rest(token, "approval_rules?select=*", { headers: tenantHeader(header) });
      expect(all.status).toBe(200);
      expect(all.json).toEqual([]);
      const byId = await rest(
        token,
        `approval_rules?select=*&id=eq.${fx.orgs.B.approval!.ruleId}`,
        {
          headers: tenantHeader(header),
        },
      );
      expect(byId.json).toEqual([]);
      expect(all.text + byId.text).not.toContain(B_CANARY_AMOUNT);
    }
    // Ni siquiera en la organización propia: la fila de B por su identificador no aparece
    const own = await rest(token, `approval_rules?select=*&id=eq.${fx.orgs.B.approval!.ruleId}`, {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    expect(own.json).toEqual([]);
  });

  it("Beto ve el canario en SU organización (control positivo) y solo ahí", async () => {
    const fx = fixture();
    const token = await tokenOf("beto");
    const res = await rest(token, "approval_rules?select=*", {
      headers: tenantHeader(fx.orgs.B.tenantId),
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain(B_CANARY_AMOUNT);
    const foreign = await rest(token, "approval_rules?select=*", {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    expect(foreign.json).toEqual([]);
  });
});

describe("Ataque 6 · la regla de una organización no manda sobre otra", () => {
  it("con la regla de B en «Siempre», un envío de A sigue pasando por la regla de A (a nivel de base de datos)", async () => {
    const fx = fixture();
    // Se mide en la base, como postgres: el estado de la fixture no se toca (todo dentro de una transacción que se deshace).
    await db.query("begin");
    try {
      await db.query(
        `insert into public.approval_rules (tenant_id, version, mode, created_by)
         select $1, max(version) + 1, 'always', $2 from public.approval_rules where tenant_id = $1`,
        [fx.orgs.B.tenantId, fx.personas.beto.userId],
      );
      const a = await db.query(
        "select (app.quote_approval_check($1, $2) ->> 'rule_id') as rule_id, (app.quote_approval_check($1, $2) -> 'reasons') as reasons",
        [fx.orgs.A.tenantId, fx.orgs.A.quoteIds[0]],
      );
      const { rows: latestA } = await db.query<{ id: string }>(
        "select id from public.approval_rules where tenant_id = $1 order by version desc limit 1",
        [fx.orgs.A.tenantId],
      );
      expect(a.rows[0].rule_id).toBe(latestA[0].id);
      // y la cotización de A no se puede evaluar con la organización B (CP404, sin pistas)
      await expect(
        db.query("select app.quote_approval_check($1, $2)", [
          fx.orgs.B.tenantId,
          fx.orgs.A.quoteIds[0],
        ]),
      ).rejects.toMatchObject({ code: "CP404" });
    } finally {
      await db.query("rollback");
    }
  });
});
