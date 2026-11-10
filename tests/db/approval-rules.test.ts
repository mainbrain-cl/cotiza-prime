// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Sprint 5 · migración 20261110110000 · la regla de aprobación (H-040a: la base).
// Versión 1 «Nunca» para toda organización (las que ya existían y las nuevas, no la de plataforma), quién puede cambiarla y
// quién no, historial de solo agregar (ni siquiera con la llave maestra), validaciones, doble clic, cambio simultáneo
// (CP409, y con dos Administradores a la vez gana uno), auditoría con la regla anterior y la nueva, lectura aislada entre
// organizaciones y permisos de las funciones. Cada prueba corre en una transacción que se deshace (salvo las carreras entre
// dos conexiones, que usan su propia organización). Todo es ficticio.
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actAsPostgres,
  connect,
  createTenantAs,
  createUser,
  expectSqlError,
  withTx,
  type TestUser,
} from "./helpers";
import { actAsService, asUser, buildWorld, type World } from "./send-helpers";

let setup: Client;
let w: World;
beforeAll(async () => {
  setup = await connect();
  w = await buildWorld(setup);
});
afterAll(async () => {
  await setup.end();
});

type Json = Record<string, unknown>;
const SET = "select public.set_approval_rule($1, $2, $3, $4) as r";
const INSUFFICIENT_PRIVILEGE = "42501";
const NOT_FOUND = "CP404";
const CONFLICT = "CP409";
const INVALID = "CP422";
const CHECK_VIOLATION = "23514";

async function set(user: TestUser, tenant: string, args: unknown[]): Promise<Json> {
  await asUser(setup, user, tenant);
  const { rows } = await setup.query<{ r: Json }>(SET, args);
  await actAsPostgres(setup);
  return rows[0].r;
}
async function setDenied(user: TestUser, tenant: string, args: unknown[]) {
  await asUser(setup, user, tenant);
  const error = await expectSqlError(setup, SET, args);
  await actAsPostgres(setup);
  return error;
}
const rulesOf = async (tenant: string) => {
  await actAsPostgres(setup);
  return (
    await setup.query("select * from public.approval_rules where tenant_id = $1 order by version", [
      tenant,
    ])
  ).rows;
};
const auditOf = async (tenant: string) => {
  await actAsPostgres(setup);
  return (
    await setup.query(
      `select action, resource_type, resource_id, tenant_id, result, actor_type, actor_user_id, details
         from public.audit_log where tenant_id = $1 and action = 'approval_rule.updated' order by id`,
      [tenant],
    )
  ).rows;
};

describe("la regla inicial: «Nunca»", () => {
  it("toda organización tiene su versión 1 «Nunca», sin umbrales y sin autor", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query(
      `select t.tenant_id, count(r.*)::int as n, min(r.version) as first, max(r.version) as last,
              bool_and(r.mode = 'never' or r.version > 1) as ok
         from public.tenants t left join public.approval_rules r on r.tenant_id = t.tenant_id
        where t.kind = 'organization' group by t.tenant_id`,
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.n, row.tenant_id).toBeGreaterThanOrEqual(1);
      expect(row.first, row.tenant_id).toBe(1);
      expect(row.ok, row.tenant_id).toBe(true);
    }
    const [v1] = await rulesOf(w.tenantA);
    expect(v1).toMatchObject({
      version: 1,
      mode: "never",
      amount_threshold_clp: null,
      discount_threshold_bp: null,
      created_by: null,
    });
  });

  it("una organización nueva (por create_tenant) la recibe sola", async () => {
    await withTx(setup, async () => {
      const owner = await createUser(setup);
      const tenant = await createTenantAs(setup, owner, "76086428-5", "Organización nueva");
      const rules = await rulesOf(tenant);
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({ version: 1, mode: "never", created_by: null });
    });
  });

  it("la organización «plataforma» no tiene regla (no cotiza)", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query(
      `select count(*)::int as n from public.approval_rules r
         join public.tenants t on t.tenant_id = r.tenant_id where t.kind = 'platform'`,
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("quién puede cambiar la regla", () => {
  it("el Dueño y el Administrador: sube la versión y queda la auditoría con la regla anterior y la nueva", async () => {
    await withTx(setup, async () => {
      const first = await set(w.owner, w.tenantA, [1, "conditional", 2_000_000, 1_000]);
      expect(first).toMatchObject({ changed: true, version: 2 });
      const second = await set(w.admin, w.tenantA, [2, "always", null, null]);
      expect(second).toMatchObject({ changed: true, version: 3 });

      const rules = await rulesOf(w.tenantA);
      expect(rules.map((r) => [r.version, r.mode])).toEqual([
        [1, "never"],
        [2, "conditional"],
        [3, "always"],
      ]);
      expect(rules[1]).toMatchObject({
        amount_threshold_clp: "2000000",
        discount_threshold_bp: 1000,
        created_by: w.owner.id,
      });
      expect(rules[2]).toMatchObject({ amount_threshold_clp: null, created_by: w.admin.id });

      const audit = await auditOf(w.tenantA);
      expect(audit).toHaveLength(2);
      expect(audit[0]).toMatchObject({
        action: "approval_rule.updated",
        resource_type: "approval_rule",
        resource_id: rules[1].id,
        tenant_id: w.tenantA,
        result: "success",
        actor_type: "user",
        actor_user_id: w.owner.id,
      });
      expect(audit[0].details).toEqual({
        version: 2,
        old: { mode: "never", amount_threshold_clp: null, discount_threshold_bp: null },
        new: { mode: "conditional", amount_threshold_clp: 2_000_000, discount_threshold_bp: 1_000 },
      });
      expect(audit[1].details).toMatchObject({
        version: 3,
        old: { mode: "conditional", amount_threshold_clp: 2_000_000 },
        new: { mode: "always", amount_threshold_clp: null },
      });
    });
  });

  it("Aprobador, Comercial y Observador reciben 42501 y no cambia nada", async () => {
    await withTx(setup, async () => {
      for (const user of [w.approver, w.sales, w.viewer]) {
        const error = await setDenied(user, w.tenantA, [1, "always", null, null]);
        expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
      }
      expect(await rulesOf(w.tenantA)).toHaveLength(1);
      expect(await auditOf(w.tenantA)).toHaveLength(0);
    });
  });

  it("quien no es miembro de la organización recibe «no encontrado»; la de B no se toca", async () => {
    await withTx(setup, async () => {
      // El Dueño de B con la cabecera de A: la base no lo reconoce como miembro de A.
      const error = await setDenied(w.ownerB, w.tenantA, [1, "always", null, null]);
      expect(error.code).toBe(NOT_FOUND);
      // Sin sesión no hay nada que hacer.
      await actAsPostgres(setup);
      await setup.query("set local role anon");
      const anon = await expectSqlError(setup, SET, [1, "always", null, null]);
      expect(anon.code).toBe(INSUFFICIENT_PRIVILEGE);
      await actAsPostgres(setup);
      expect(await rulesOf(w.tenantA)).toHaveLength(1);
      expect(await rulesOf(w.tenantB)).toHaveLength(1);
    });
  });

  it("el Dueño de A cambia A sin tocar B", async () => {
    await withTx(setup, async () => {
      await set(w.owner, w.tenantA, [1, "always", null, null]);
      expect((await rulesOf(w.tenantA)).map((r) => r.mode)).toEqual(["never", "always"]);
      expect((await rulesOf(w.tenantB)).map((r) => r.mode)).toEqual(["never"]);
      expect(await auditOf(w.tenantB)).toHaveLength(0);
    });
  });
});

describe("validaciones: cada dato inválido, CP422 con su motivo", () => {
  const cases: [string, unknown[], string][] = [
    ["versión esperada vacía", [null, "never", null, null], "invalid_arguments"],
    ["versión esperada 0", [0, "never", null, null], "invalid_arguments"],
    ["modo vacío", [1, null, null, null], "invalid_arguments"],
    ["modo desconocido", [1, "a_veces", null, null], "invalid_mode"],
    ["monto 0", [1, "conditional", 0, null], "amount_out_of_range"],
    ["monto negativo", [1, "conditional", -5, null], "amount_out_of_range"],
    ["monto 10¹²", [1, "conditional", 1_000_000_000_000, null], "amount_out_of_range"],
    ["descuento negativo", [1, "conditional", null, -1], "discount_out_of_range"],
    ["descuento 100 %", [1, "conditional", null, 10_000], "discount_out_of_range"],
    ["condicional sin condiciones", [1, "conditional", null, null], "missing_condition"],
    ["«Nunca» con monto", [1, "never", 1_000, null], "unexpected_threshold"],
    ["«Nunca» con descuento 0", [1, "never", null, 0], "unexpected_threshold"],
    ["«Siempre» con monto", [1, "always", 1_000, null], "unexpected_threshold"],
    ["«Siempre» con descuento", [1, "always", null, 500], "unexpected_threshold"],
  ];
  it.each(cases)("%s", async (_name, args, reason) => {
    await withTx(setup, async () => {
      const error = await setDenied(w.owner, w.tenantA, args);
      expect(error.code).toBe(INVALID);
      expect(error.message).toBe(reason);
      expect(await rulesOf(w.tenantA)).toHaveLength(1);
    });
  });

  it("los valores en el borde se aceptan: monto 1, monto 10¹² − 1, descuento 0 y 9.999", async () => {
    await withTx(setup, async () => {
      expect(await set(w.owner, w.tenantA, [1, "conditional", 1, 0])).toMatchObject({ version: 2 });
      expect(
        await set(w.owner, w.tenantA, [2, "conditional", 999_999_999_999, 9_999]),
      ).toMatchObject({ version: 3 });
    });
  });

  it("la validación va antes de la versión: un dato malo con versión vieja da CP422, no CP409", async () => {
    await withTx(setup, async () => {
      await set(w.owner, w.tenantA, [1, "always", null, null]);
      const error = await setDenied(w.owner, w.tenantA, [1, "conditional", 0, null]);
      expect(error.code).toBe(INVALID);
    });
  });
});

describe("doble clic y cambios simultáneos", () => {
  it("guardar lo mismo que ya rige no crea versión ni auditoría (aunque la versión esperada sea vieja)", async () => {
    await withTx(setup, async () => {
      await set(w.owner, w.tenantA, [1, "conditional", 500_000, null]);
      const again = await set(w.owner, w.tenantA, [2, "conditional", 500_000, null]);
      expect(again).toMatchObject({ changed: false, version: 2 });
      const stale = await set(w.admin, w.tenantA, [1, "conditional", 500_000, null]);
      expect(stale).toMatchObject({ changed: false, version: 2 });
      expect(await rulesOf(w.tenantA)).toHaveLength(2);
      expect(await auditOf(w.tenantA)).toHaveLength(1);
    });
  });

  it("si otra persona la cambió antes (versión esperada vieja y contenido distinto): CP409 y no se pisa su cambio", async () => {
    await withTx(setup, async () => {
      await set(w.owner, w.tenantA, [1, "always", null, null]);
      const error = await setDenied(w.admin, w.tenantA, [1, "conditional", 100, null]);
      expect(error.code).toBe(CONFLICT);
      expect(error.message).toBe("rule_changed");
      expect((await rulesOf(w.tenantA)).map((r) => r.mode)).toEqual(["never", "always"]);
    });
  });

  it("una versión esperada de futuro tampoco pasa", async () => {
    await withTx(setup, async () => {
      const error = await setDenied(w.owner, w.tenantA, [7, "always", null, null]);
      expect(error.code).toBe(CONFLICT);
    });
  });

  it("dos Administradores a la vez con la misma versión esperada: gana uno y el otro recibe CP409", async () => {
    // Organización propia (las dos conexiones confirman de verdad).
    const owner = await createUser(setup);
    await setup.query("begin");
    const tenant = await createTenantAs(setup, owner, "76086428-5", "Carrera de reglas");
    const admins = [await createUser(setup), await createUser(setup)];
    for (const admin of admins) {
      await setup.query(
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'admin')",
        [tenant, admin.id],
      );
    }
    await setup.query("commit");

    const clients = await Promise.all([connect(), connect()]);
    try {
      const contents = [
        [1, "always", null, null],
        [1, "conditional", 1_500_000, null],
      ];
      const outcomes = await Promise.all(
        clients.map(async (client, index) => {
          await client.query("begin");
          try {
            await asUser(client, admins[index], tenant);
            const { rows } = await client.query<{ r: Json }>(SET, contents[index]);
            await client.query("commit");
            return { ok: true as const, version: rows[0].r.version as number };
          } catch (error) {
            await client.query("rollback");
            return { ok: false as const, code: (error as { code?: string }).code };
          }
        }),
      );
      expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
      const loser = outcomes.find((o) => !o.ok);
      expect(loser).toEqual({ ok: false, code: CONFLICT });
      const rules = await rulesOf(tenant);
      expect(rules.map((r) => r.version)).toEqual([1, 2]);
      expect(await auditOf(tenant)).toHaveLength(1);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });
});

describe("el historial es de solo agregar", () => {
  const attempts: [string, string][] = [
    ["editar una versión", "update public.approval_rules set mode = 'always' where tenant_id = $1"],
    ["borrar una versión", "delete from public.approval_rules where tenant_id = $1"],
    ["vaciar la tabla", "truncate public.approval_rules"],
    [
      "cambiar su organización",
      "update public.approval_rules set tenant_id = gen_random_uuid() where tenant_id = $1",
    ],
  ];

  it.each(attempts)("la llave maestra del servidor no puede %s", async (_name, sql) => {
    await withTx(setup, async () => {
      await actAsService(setup);
      const error = await expectSqlError(setup, sql, sql.includes("$1") ? [w.tenantA] : []);
      // Vaciar la tabla ni siquiera llega al disparador: Postgres lo niega antes porque `quote_packages` la referencia (0A000).
      expect(error.code).toBe(sql.startsWith("truncate") ? "0A000" : INSUFFICIENT_PRIVILEGE);
      await actAsPostgres(setup);
      expect(await rulesOf(w.tenantA)).toHaveLength(1);
    });
  });

  it.each(attempts.slice(0, 2))("el dueño de la base tampoco: %s", async (_name, sql) => {
    await withTx(setup, async () => {
      await actAsPostgres(setup);
      const error = await expectSqlError(setup, sql, [w.tenantA]);
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
      expect(error.message).toMatch(/append-only|inmutable|immutable/i);
    });
  });

  it("nadie con sesión escribe directo: sin permiso (ni el Dueño)", async () => {
    await withTx(setup, async () => {
      for (const user of [w.owner, w.admin]) {
        await asUser(setup, user, w.tenantA);
        for (const sql of [
          `insert into public.approval_rules (tenant_id, version, mode, created_by)
             values ('${w.tenantA}', 2, 'always', '${user.id}')`,
          `update public.approval_rules set mode = 'always' where tenant_id = '${w.tenantA}'`,
          `delete from public.approval_rules where tenant_id = '${w.tenantA}'`,
        ]) {
          const error = await expectSqlError(setup, sql);
          expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
        }
        await actAsPostgres(setup);
      }
      expect(await rulesOf(w.tenantA)).toHaveLength(1);
    });
  });

  const rows: [string, string][] = [
    [
      "condicional sin umbrales",
      `insert into public.approval_rules (tenant_id, version, mode, created_by) values ($1, 2, 'conditional', $2)`,
    ],
    [
      "«Nunca» con umbral",
      `insert into public.approval_rules (tenant_id, version, mode, amount_threshold_clp, created_by) values ($1, 2, 'never', 5, $2)`,
    ],
    [
      "versión 2 sin autor",
      `insert into public.approval_rules (tenant_id, version, mode) values ($1, 2, 'always')`,
    ],
    [
      "monto 0",
      `insert into public.approval_rules (tenant_id, version, mode, amount_threshold_clp, created_by) values ($1, 2, 'conditional', 0, $2)`,
    ],
    [
      "modo desconocido",
      `insert into public.approval_rules (tenant_id, version, mode, created_by) values ($1, 2, 'x', $2)`,
    ],
    [
      "versión repetida",
      `insert into public.approval_rules (tenant_id, version, mode, created_by) values ($1, 1, 'always', $2)`,
    ],
  ];
  it.each(rows)("la tabla misma rechaza una fila inválida: %s", async (name, sql) => {
    await withTx(setup, async () => {
      await actAsPostgres(setup);
      const params = sql.includes("$2") ? [w.tenantA, w.owner.id] : [w.tenantA];
      const error = await expectSqlError(setup, sql, params);
      expect(error.code, name).toBe(name === "versión repetida" ? "23505" : CHECK_VIOLATION);
    });
  });
});

describe("quién lee la regla", () => {
  it("los cinco roles de la organización la leen; la de otra organización no la ve nadie", async () => {
    await withTx(setup, async () => {
      await set(w.owner, w.tenantA, [1, "conditional", 1_234_567, null]);
      for (const user of [w.owner, w.admin, w.approver, w.sales, w.viewer]) {
        await asUser(setup, user, w.tenantA);
        const { rows } = await setup.query(
          "select tenant_id, version, amount_threshold_clp from public.approval_rules order by version",
        );
        expect(
          rows.map((r) => [r.tenant_id, r.version]),
          user.id,
        ).toEqual([
          [w.tenantA, 1],
          [w.tenantA, 2],
        ]);
        await actAsPostgres(setup);
      }
      // El Dueño de B ve solo lo suyo, aunque pida la cabecera de A.
      await asUser(setup, w.ownerB, w.tenantB);
      const own = await setup.query(
        "select tenant_id, amount_threshold_clp from public.approval_rules",
      );
      expect(own.rows.map((r) => r.tenant_id)).toEqual([w.tenantB]);
      expect(JSON.stringify(own.rows)).not.toContain("1234567");
      await actAsPostgres(setup);
      await asUser(setup, w.ownerB, w.tenantA);
      const foreign = await setup.query("select * from public.approval_rules");
      expect(foreign.rows).toEqual([]);
      await actAsPostgres(setup);
    });
  });

  it("anon no lee nada", async () => {
    await withTx(setup, async () => {
      await actAsPostgres(setup);
      await setup.query("set local role anon");
      const error = await expectSqlError(setup, "select * from public.approval_rules");
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });
});

describe("permisos de las funciones", () => {
  it("set_approval_rule la ejecuta quien tiene sesión y no anon; las internas, nadie con pase", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<{
      name: string;
      schema: string;
      anon: boolean;
      auth: boolean;
      secdef: boolean;
      cfg: string[] | null;
    }>(
      `select p.proname as name, n.nspname as schema,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              p.prosecdef as secdef, p.proconfig as cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where (n.nspname = 'public' and p.proname = 'set_approval_rule')
           or (n.nspname = 'app' and p.proname in (
                 'quote_approval_check', 'approval_rule_reasons', 'approval_discount_bp',
                 'approval_amount_max_clp', 'approval_discount_max_bp', 'approval_bp_scale', 'approval_modes',
                 'tenants_create_default_approval_rule', 'quote_packages_approval_gate'))
        order by 1`,
    );
    expect(rows).toHaveLength(10);
    for (const r of rows) {
      expect(r.anon, r.name).toBe(false);
      expect(r.auth, r.name).toBe(r.name === "set_approval_rule");
      if (r.secdef) expect(r.cfg, r.name).toContain('search_path=""');
    }
    expect(rows.find((r) => r.name === "set_approval_rule")?.secdef).toBe(true);
  });

  it("una persona con sesión no puede llamar a las funciones internas", async () => {
    await withTx(setup, async () => {
      await asUser(setup, w.owner, w.tenantA);
      for (const sql of [
        `select app.quote_approval_check('${w.tenantA}', gen_random_uuid())`,
        "select app.approval_rule_reasons('always', null, null, 1, 0, 0)",
        "select app.approval_discount_bp(1, 1)",
      ]) {
        const error = await expectSqlError(setup, sql);
        expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });
  });
});
