// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Sprint 5 · migración 20261104110000 · textos listos para usar (H-048a, PR 1: la base).
// Permisos de cada rol verificados en la base, escritura directa rechazada, tope de 50 (también con dos creaciones
// a la vez), nombre único por tipo, control de cambios simultáneos (CP409), texto inicial único, variables
// (con las mismas reglas que el módulo `src/lib/snippets`), caracteres invisibles, auditoría sin el texto,
// paridad de constantes con el módulo puro y borrado de verdad.
// Cada prueba corre en una transacción que se deshace (salvo las carreras entre dos conexiones, que usan su propia
// organización). Todo es ficticio.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SNIPPETS_MAX_PER_TENANT,
  SNIPPET_BODY_MAX_LENGTH,
  SNIPPET_KINDS,
  SNIPPET_MAX_VARIABLES,
  SNIPPET_NAME_MAX_LENGTH,
  SNIPPET_VARIABLES,
  SNIPPET_VARIABLE_VALUE_MAX_LENGTH,
  checkSnippetVariables,
  hasUnsafeSnippetCharacters,
  normalizeSnippetBody,
  normalizeSnippetName,
  type SnippetKind,
} from "../../src/lib/snippets/model";
import {
  actAsPostgres,
  connect,
  createTenantAs,
  createUser,
  expectSqlError,
  withTx,
  type TestUser,
} from "./helpers";
import { asUser, buildWorld, type World } from "./send-helpers";

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
const CREATE = "select public.create_text_snippet($1, $2, $3, $4, $5) as r";
const UPDATE = "select public.update_text_snippet($1, $2, $3, $4, $5) as r";
const DELETE = "select public.delete_text_snippet($1) as r";

const INSUFFICIENT_PRIVILEGE = "42501";
const NOT_FOUND = "CP404";
const CONFLICT = "CP409";
const INVALID = "CP422";

const SECRET = "TEXTO-SECRETO-QUE-NO-VA-A-LA-AUDITORIA";

async function call(user: TestUser, tenant: string, sql: string, params: unknown[]) {
  await asUser(setup, user, tenant);
  const { rows } = await setup.query<{ r: Json }>(sql, params);
  await actAsPostgres(setup);
  return rows[0].r;
}

async function denied(user: TestUser, tenant: string, sql: string, params: unknown[]) {
  await asUser(setup, user, tenant);
  const error = await expectSqlError(setup, sql, params);
  await actAsPostgres(setup);
  return error;
}

type Over = { id?: string; kind?: string; name?: string; body?: string; isDefault?: boolean };
const createParams = (over: Over = {}): (string | boolean | null)[] => [
  over.id ?? randomUUID(),
  over.kind ?? "conditions",
  over.name ?? `Texto ${randomUUID().slice(0, 8)}`,
  over.body ?? "Pago a 30 días.",
  over.isDefault ?? false,
];

const make = async (user: TestUser, over: Over = {}, tenant = w.tenantA) => {
  const params = createParams(over);
  const result = await call(user, tenant, CREATE, params);
  return { id: params[0] as string, params, result };
};

const updateParams = (id: string, revision: number, over: Over = {}) => [
  id,
  revision,
  over.name ?? "Nombre nuevo",
  over.body ?? "Texto nuevo.",
  over.isDefault ?? false,
];

const row = async (id: string) => {
  await actAsPostgres(setup);
  return (await setup.query("select * from public.text_snippets where id = $1", [id])).rows[0];
};
const count = async (sql: string, params: unknown[] = []) => {
  await actAsPostgres(setup);
  return Number((await setup.query<{ n: string }>(sql, params)).rows[0].n);
};
const auditOf = async (resourceId: string) => {
  await actAsPostgres(setup);
  return (
    await setup.query(
      `select action, resource_type, tenant_id, result, actor_type, actor_user_id, details
         from public.audit_log where resource_id = $1 order by id`,
      [resourceId],
    )
  ).rows;
};

/** Inserta N textos sueltos (como postgres) para probar el tope. */
async function seedSnippets(tenant: string, by: TestUser, n: number) {
  await actAsPostgres(setup);
  for (let i = 0; i < n; i++) {
    await setup.query(
      `insert into public.text_snippets (id, tenant_id, kind, name, body, created_by)
       values ($1, $2, 'conditions', $3, 'Texto de relleno.', $4)`,
      [randomUUID(), tenant, `Relleno ${i}`, by.id],
    );
  }
}

describe("quién puede administrar los textos", () => {
  it("el Dueño y el Administrador crean, cambian y eliminan; queda quién y cuándo", async () => {
    await withTx(setup, async () => {
      for (const user of [w.owner, w.admin]) {
        const { id, result } = await make(user, { kind: "email_body", body: "Hola {{cliente}}" });
        expect(result).toEqual({ result: "created", id, revision: 1 });
        const created = await row(id);
        expect(created.tenant_id).toBe(w.tenantA);
        expect(created.created_by).toBe(user.id);
        expect(created.revision).toBe(1);
        expect(created.is_default).toBe(false);

        const updated = await call(user, w.tenantA, UPDATE, updateParams(id, 1, { body: "Hola" }));
        expect(updated).toEqual({ result: "updated", id, revision: 2 });
        expect((await row(id)).updated_by).toBe(user.id);

        expect(await call(user, w.tenantA, DELETE, [id])).toEqual({ result: "deleted" });
        expect(await row(id)).toBeUndefined();
      }
    });
  });

  it("el Aprobador, el Comercial y el Observador reciben «sin permiso» en las tres funciones y no cambia nada", async () => {
    await withTx(setup, async () => {
      const { id } = await make(w.owner, { name: "Texto del Dueño", body: "Original." });
      for (const user of [w.approver, w.sales, w.viewer]) {
        const create = createParams();
        expect((await denied(user, w.tenantA, CREATE, create)).code).toBe(INSUFFICIENT_PRIVILEGE);
        expect(await row(create[0] as string)).toBeUndefined();
        expect((await denied(user, w.tenantA, UPDATE, updateParams(id, 1))).code).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        expect((await denied(user, w.tenantA, DELETE, [id])).code).toBe(INSUFFICIENT_PRIVILEGE);
      }
      const intact = await row(id);
      expect(intact.name).toBe("Texto del Dueño");
      expect(intact.body).toBe("Original.");
      expect(intact.revision).toBe(1);
    });
  });

  it("«sin permiso» llega antes que «no encontrado»: quien no puede ni se entera de si el texto existe", async () => {
    await withTx(setup, async () => {
      expect((await denied(w.sales, w.tenantA, UPDATE, updateParams(randomUUID(), 1))).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect((await denied(w.sales, w.tenantA, DELETE, [randomUUID()])).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });
  });

  it("quien no es miembro de la organización activa recibe «no encontrado», no «sin permiso»", async () => {
    await withTx(setup, async () => {
      const { id } = await make(w.owner);
      // El Dueño de B apuntando a A, y alguien sin cabecera de organización.
      expect((await denied(w.ownerB, w.tenantA, CREATE, createParams())).code).toBe(NOT_FOUND);
      expect((await denied(w.ownerB, w.tenantA, UPDATE, updateParams(id, 1))).code).toBe(NOT_FOUND);
      expect((await denied(w.ownerB, w.tenantA, DELETE, [id])).code).toBe(NOT_FOUND);
      await asUser(setup, w.owner, "");
      expect((await expectSqlError(setup, CREATE, createParams())).code).toBe(NOT_FOUND);
      await actAsPostgres(setup);
      expect((await row(id)).revision).toBe(1);
    });
  });

  it("un miembro que ya fue quitado de la organización recibe «no encontrado»", async () => {
    await withTx(setup, async () => {
      await actAsPostgres(setup);
      await setup.query(
        "update public.members set status = 'removed', removed_at = now() where tenant_id = $1 and user_id = $2",
        [w.tenantA, w.admin.id],
      );
      expect((await denied(w.admin, w.tenantA, CREATE, createParams())).code).toBe(NOT_FOUND);
    });
  });
});

describe("escribir directo en la tabla está cerrado para todos", () => {
  it("nadie con pase tiene permiso de insertar, cambiar ni borrar; solo existe la política de lectura", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<Record<string, boolean>>(
      `select
         has_table_privilege('authenticated', 'public.text_snippets', 'INSERT')  as ins,
         has_table_privilege('authenticated', 'public.text_snippets', 'UPDATE')  as upd,
         has_table_privilege('authenticated', 'public.text_snippets', 'DELETE')  as del,
         has_table_privilege('authenticated', 'public.text_snippets', 'TRUNCATE') as trunc,
         has_any_column_privilege('authenticated', 'public.text_snippets', 'INSERT, UPDATE') as cols,
         has_table_privilege('authenticated', 'public.text_snippets', 'SELECT')  as sel,
         has_any_column_privilege('anon', 'public.text_snippets', 'SELECT, INSERT, UPDATE') as anon_any,
         has_table_privilege('anon', 'public.text_snippets', 'DELETE') as anon_del`,
    );
    expect(rows[0]).toEqual({
      ins: false,
      upd: false,
      del: false,
      trunc: false,
      cols: false,
      sel: true,
      anon_any: false,
      anon_del: false,
    });
    const policies = await setup.query<{ cmd: string }>(
      "select cmd from pg_policies where schemaname = 'public' and tablename = 'text_snippets'",
    );
    expect(policies.rows.map((p) => p.cmd)).toEqual(["SELECT"]);
  });

  it("insert, update y delete con la sesión de un miembro (hasta el Dueño) son rechazados y la tabla queda igual", async () => {
    await withTx(setup, async () => {
      const { id } = await make(w.owner, { name: "Intocable", body: "Original." });
      for (const user of [w.owner, w.admin, w.sales]) {
        await asUser(setup, user, w.tenantA);
        const insert = await expectSqlError(
          setup,
          `insert into public.text_snippets (id, tenant_id, kind, name, body)
           values ($1, $2, 'conditions', 'Directo', 'Directo.')`,
          [randomUUID(), w.tenantA],
        );
        const update = await expectSqlError(
          setup,
          "update public.text_snippets set body = 'Pisado.' where id = $1",
          [id],
        );
        const del = await expectSqlError(setup, "delete from public.text_snippets where id = $1", [
          id,
        ]);
        await actAsPostgres(setup);
        for (const error of [insert, update, del]) expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
      }
      const intact = await row(id);
      expect(intact.body).toBe("Original.");
      expect(intact.revision).toBe(1);
      expect(
        await count("select count(*) as n from public.text_snippets where name = 'Directo'"),
      ).toBe(0);
    });
  });

  it("la organización de un texto no se puede cambiar ni siquiera como administrador de la base", async () => {
    await withTx(setup, async () => {
      const { id } = await make(w.owner);
      await actAsPostgres(setup);
      const error = await expectSqlError(
        setup,
        "update public.text_snippets set tenant_id = $2 where id = $1",
        [id, w.tenantB],
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });
});

describe("quién lee", () => {
  it("todo miembro lee los textos de su organización; nadie lee los de otra", async () => {
    await withTx(setup, async () => {
      const a = await make(w.owner, { name: "Visible en A" });
      const b = await make(w.ownerB, { name: "Visible en B" }, w.tenantB);
      for (const user of [w.owner, w.admin, w.approver, w.sales, w.viewer]) {
        await asUser(setup, user, w.tenantA);
        const { rows } = await setup.query<{ id: string }>("select id from public.text_snippets");
        await actAsPostgres(setup);
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(a.id);
        expect(ids).not.toContain(b.id);
      }
      // el Dueño de B no ve el de A aunque nombre la organización A
      await asUser(setup, w.ownerB, w.tenantA);
      const { rows } = await setup.query("select id from public.text_snippets");
      await actAsPostgres(setup);
      expect(rows).toEqual([]);
    });
  });
});

describe("tope de textos por organización", () => {
  it("el texto 50 se acepta y el 51 se rechaza con «too_many_snippets»; borrar uno libera un lugar", async () => {
    await withTx(setup, async () => {
      const owner = await createUser(setup);
      const tenant = await createTenantAs(setup, owner, "76086428-5", "Tope de textos");
      await seedSnippets(tenant, owner, SNIPPETS_MAX_PER_TENANT - 1);
      const last = await make(owner, { name: "El 50" }, tenant);
      expect(last.result.result).toBe("created");
      const over = await denied(owner, tenant, CREATE, createParams({ name: "El 51" }));
      expect(over.code).toBe(INVALID);
      expect(over.message).toBe("too_many_snippets");
      expect(
        await count("select count(*) as n from public.text_snippets where tenant_id = $1", [
          tenant,
        ]),
      ).toBe(SNIPPETS_MAX_PER_TENANT);
      // cambiar un texto existente no cuenta como uno nuevo
      expect(
        (await call(owner, tenant, UPDATE, updateParams(last.id, 1, { name: "El 50 cambiado" })))
          .result,
      ).toBe("updated");
      await call(owner, tenant, DELETE, [last.id]);
      expect((await make(owner, { name: "Otra vez el 50" }, tenant)).result.result).toBe("created");
    });
  });

  it("el tope es por organización: llenar una no afecta a otra", async () => {
    await withTx(setup, async () => {
      const owner = await createUser(setup);
      const tenant = await createTenantAs(setup, owner, "76086428-5", "Llena");
      await seedSnippets(tenant, owner, SNIPPETS_MAX_PER_TENANT);
      expect((await denied(owner, tenant, CREATE, createParams())).message).toBe(
        "too_many_snippets",
      );
      expect((await make(w.owner, { name: "Sigue pudiendo" })).result.result).toBe("created");
    });
  });
});

/** Corre `sql` en una conexión propia, con el candado tomado un instante, y confirma. Devuelve lo que respondió o el error. */
async function race(
  client: Client,
  user: TestUser,
  tenant: string,
  sql: string,
  params: unknown[],
) {
  await client.query("begin");
  await asUser(client, user, tenant);
  try {
    const { rows } = await client.query<{ r: Json }>(sql, params);
    await new Promise((resolve) => setTimeout(resolve, 150)); // se mantiene el candado un instante
    await client.query("commit");
    return { ok: true as const, result: rows[0].r };
  } catch (error) {
    await client.query("rollback");
    const e = error as { code?: string; message: string };
    return { ok: false as const, code: e.code, message: e.message };
  }
}

describe("dos personas a la vez (organización propia, se confirma)", () => {
  async function ownTenant(name: string) {
    const owner = await createUser(setup);
    await setup.query("begin");
    const tenant = await createTenantAs(setup, owner, "76086428-5", name);
    await setup.query("commit");
    return { owner, tenant };
  }

  it("dos creaciones justo en el borde del tope: entra una sola, la otra recibe «too_many_snippets»", async () => {
    const { owner, tenant } = await ownTenant("Carrera del tope");
    await seedSnippets(tenant, owner, SNIPPETS_MAX_PER_TENANT - 1);
    const second = await connect();
    try {
      const results = await Promise.all([
        race(setup, owner, tenant, CREATE, createParams({ name: "Uno" })),
        race(second, owner, tenant, CREATE, createParams({ name: "Dos" })),
      ]);
      const ok = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ code: INVALID, message: "too_many_snippets" });
      await actAsPostgres(setup);
      expect(
        await count("select count(*) as n from public.text_snippets where tenant_id = $1", [
          tenant,
        ]),
      ).toBe(SNIPPETS_MAX_PER_TENANT);
    } finally {
      await actAsPostgres(setup);
      await second.end();
    }
  });

  it("dos creaciones con el mismo nombre: entra una, la otra recibe «name_taken»", async () => {
    const { owner, tenant } = await ownTenant("Carrera del nombre");
    const second = await connect();
    try {
      const results = await Promise.all([
        race(setup, owner, tenant, CREATE, createParams({ name: "Condiciones" })),
        race(second, owner, tenant, CREATE, createParams({ name: "CONDICIONES" })),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ code: INVALID, message: "name_taken" });
    } finally {
      await actAsPostgres(setup);
      await second.end();
    }
  });

  it("dos textos iniciales a la vez: los dos se crean y queda uno solo marcado, sin errores del índice", async () => {
    const { owner, tenant } = await ownTenant("Carrera del texto inicial");
    const second = await connect();
    try {
      const results = await Promise.all([
        race(
          setup,
          owner,
          tenant,
          CREATE,
          createParams({ kind: "email_body", name: "A", isDefault: true }),
        ),
        race(
          second,
          owner,
          tenant,
          CREATE,
          createParams({ kind: "email_body", name: "B", isDefault: true }),
        ),
      ]);
      expect(results.every((r) => r.ok)).toBe(true);
      await actAsPostgres(setup);
      expect(
        await count(
          "select count(*) as n from public.text_snippets where tenant_id = $1 and is_default",
          [tenant],
        ),
      ).toBe(1);
      expect(
        await count("select count(*) as n from public.text_snippets where tenant_id = $1", [
          tenant,
        ]),
      ).toBe(2);
    } finally {
      await actAsPostgres(setup);
      await second.end();
    }
  });

  it("dos cambios al mismo texto con la misma revisión: gana uno, el otro recibe CP409", async () => {
    const { owner, tenant } = await ownTenant("Carrera de la revisión");
    const id = randomUUID();
    const created = await race(setup, owner, tenant, CREATE, createParams({ id }));
    expect(created.ok).toBe(true);
    const second = await connect();
    try {
      const results = await Promise.all([
        race(setup, owner, tenant, UPDATE, updateParams(id, 1, { name: "Gana A", body: "A." })),
        race(second, owner, tenant, UPDATE, updateParams(id, 1, { name: "Gana B", body: "B." })),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({
        code: CONFLICT,
        message: "revision_conflict",
      });
      expect((await row(id)).revision).toBe(2);
    } finally {
      await actAsPostgres(setup);
      await second.end();
    }
  });
});

describe("nombre único por tipo", () => {
  it("«Condición» con la tilde unida y con la tilde separada es el mismo nombre", async () => {
    await withTx(setup, async () => {
      const joined = await make(w.owner, { kind: "conditions", name: "Condici\u00f3n de pago" });
      // se guarda en forma NFC aunque llegue con la tilde separada
      const separated = "Condicio\u0301n de pago";
      expect(separated).not.toBe("Condici\u00f3n de pago");
      expect(
        await denied(
          w.owner,
          w.tenantA,
          CREATE,
          createParams({ kind: "conditions", name: separated }),
        ),
      ).toMatchObject({
        code: INVALID,
        message: "name_taken",
      });
      // al revés: se guarda con la tilde separada y se busca con la unida
      const other = await make(w.owner, { kind: "exclusions", name: separated });
      expect((await row(other.id)).name).toBe("Condici\u00f3n de pago");
      expect(
        await denied(
          w.owner,
          w.tenantA,
          CREATE,
          createParams({ kind: "exclusions", name: "CONDICI\u00d3N DE PAGO" }),
        ),
      ).toMatchObject({
        code: INVALID,
        message: "name_taken",
      });
      // cambiar un texto a un nombre que ya existe en la otra forma también choca
      const third = await make(w.owner, { kind: "conditions", name: "Otra" });
      expect(
        await denied(w.owner, w.tenantA, UPDATE, updateParams(third.id, 1, { name: separated })),
      ).toMatchObject({
        code: INVALID,
        message: "name_taken",
      });
      expect((await row(joined.id)).name).toBe("Condici\u00f3n de pago");
    });
  });

  it("el mismo nombre en el mismo tipo se rechaza, aunque cambien mayúsculas o espacios de los bordes", async () => {
    await withTx(setup, async () => {
      await make(w.owner, { kind: "exclusions", name: "No incluye embalaje" });
      for (const name of [
        "No incluye embalaje",
        "NO INCLUYE EMBALAJE",
        "  no incluye embalaje \n",
      ]) {
        const error = await denied(
          w.owner,
          w.tenantA,
          CREATE,
          createParams({ kind: "exclusions", name }),
        );
        expect(error, name).toMatchObject({ code: INVALID, message: "name_taken" });
      }
    });
  });

  it("el mismo nombre en otro tipo, o en otra organización, está bien", async () => {
    await withTx(setup, async () => {
      await make(w.owner, { kind: "exclusions", name: "Estándar" });
      expect((await make(w.owner, { kind: "conditions", name: "Estándar" })).result.result).toBe(
        "created",
      );
      expect((await make(w.owner, { kind: "footer_note", name: "Estándar" })).result.result).toBe(
        "created",
      );
      expect(
        (await make(w.ownerB, { kind: "exclusions", name: "Estándar" }, w.tenantB)).result.result,
      ).toBe("created");
    });
  });

  it("al cambiar un texto: chocar con otro se rechaza; cambiarle solo las mayúsculas a su propio nombre, no", async () => {
    await withTx(setup, async () => {
      const a = await make(w.owner, { name: "Pago a 30 días" });
      const b = await make(w.owner, { name: "Pago contado" });
      const clash = await denied(
        w.owner,
        w.tenantA,
        UPDATE,
        updateParams(b.id, 1, { name: "pago a 30 DÍAS" }),
      );
      expect(clash).toMatchObject({ code: INVALID, message: "name_taken" });
      const own = await call(
        w.owner,
        w.tenantA,
        UPDATE,
        updateParams(a.id, 1, { name: "PAGO A 30 DÍAS" }),
      );
      expect(own.result).toBe("updated");
    });
  });
});

describe("control de cambios simultáneos (CP409)", () => {
  it("con la revisión que se vio se guarda y sube; con una vieja se rechaza sin cambiar nada", async () => {
    await withTx(setup, async () => {
      const { id } = await make(w.owner, { name: "Primera versión", body: "Uno." });
      const first = await call(
        w.owner,
        w.tenantA,
        UPDATE,
        updateParams(id, 1, { name: "Segunda", body: "Dos." }),
      );
      expect(first).toEqual({ result: "updated", id, revision: 2 });
      // otra pestaña seguía con la revisión 1
      const stale = await denied(
        w.admin,
        w.tenantA,
        UPDATE,
        updateParams(id, 1, { name: "Pisada", body: "Tres." }),
      );
      expect(stale).toMatchObject({ code: CONFLICT, message: "revision_conflict" });
      const current = await row(id);
      expect(current.name).toBe("Segunda");
      expect(current.body).toBe("Dos.");
      expect(current.revision).toBe(2);
      // una revisión del futuro tampoco vale
      expect((await denied(w.owner, w.tenantA, UPDATE, updateParams(id, 3))).code).toBe(CONFLICT);
    });
  });

  it("guardar exactamente lo mismo responde «unchanged»: no sube la revisión ni deja auditoría", async () => {
    await withTx(setup, async () => {
      const { id } = await make(w.owner, {
        name: "Igual",
        body: "Mismo texto.",
        kind: "conditions",
      });
      const before = (await auditOf(id)).length;
      const same = await call(
        w.owner,
        w.tenantA,
        UPDATE,
        updateParams(id, 1, { name: " Igual ", body: "Mismo texto.\r\n" }),
      );
      expect(same).toEqual({ result: "unchanged", id, revision: 1 });
      expect((await row(id)).revision).toBe(1);
      expect((await auditOf(id)).length).toBe(before);
    });
  });

  it("argumentos que faltan o una revisión menor a 1 dan «dato inválido»", async () => {
    await withTx(setup, async () => {
      const { id } = await make(w.owner);
      for (const params of [
        [id, null, "n", "b", false],
        [id, 0, "n", "b", false],
        [id, 1, null, "b", false],
        [id, 1, "n", null, false],
        [id, 1, "n", "b", null],
        [null, 1, "n", "b", false],
      ]) {
        const error = await denied(w.owner, w.tenantA, UPDATE, params);
        expect(error, JSON.stringify(params)).toMatchObject({
          code: INVALID,
          message: "invalid_arguments",
        });
      }
    });
  });

  it("cambiar o eliminar un texto que no existe responde «snippet_not_found»", async () => {
    await withTx(setup, async () => {
      expect(await denied(w.owner, w.tenantA, UPDATE, updateParams(randomUUID(), 1))).toMatchObject(
        {
          code: NOT_FOUND,
          message: "snippet_not_found",
        },
      );
      expect(await denied(w.owner, w.tenantA, DELETE, [randomUUID()])).toMatchObject({
        code: NOT_FOUND,
        message: "snippet_not_found",
      });
    });
  });
});

describe("texto inicial del correo", () => {
  it("marcar uno desmarca el anterior en el mismo paso, sube su revisión y lo deja en la auditoría", async () => {
    await withTx(setup, async () => {
      const first = await make(w.owner, { kind: "email_body", name: "Primero", isDefault: true });
      expect((await row(first.id)).is_default).toBe(true);
      const second = await make(w.admin, { kind: "email_body", name: "Segundo", isDefault: true });
      expect((await row(first.id)).is_default).toBe(false);
      expect((await row(first.id)).revision).toBe(2);
      expect((await row(second.id)).is_default).toBe(true);
      expect(
        await count(
          "select count(*) as n from public.text_snippets where tenant_id = $1 and is_default",
          [w.tenantA],
        ),
      ).toBe(1);
      const audit = await auditOf(first.id);
      expect(audit.map((a) => a.action)).toEqual(["text_snippet.created", "text_snippet.updated"]);
      expect(audit[1].details).toMatchObject({ changed: ["is_default"] });
    });
  });

  it("al cambiar un texto del correo para que sea el inicial, el otro se desmarca; y se puede quitar la marca", async () => {
    await withTx(setup, async () => {
      const a = await make(w.owner, { kind: "email_body", name: "A", isDefault: true });
      const b = await make(w.owner, { kind: "email_body", name: "B" });
      const toB = await call(
        w.owner,
        w.tenantA,
        UPDATE,
        updateParams(b.id, 1, { name: "B", body: "Texto nuevo.", isDefault: true }),
      );
      expect(toB.result).toBe("updated");
      expect((await row(a.id)).is_default).toBe(false);
      expect((await row(a.id)).revision).toBe(2);
      // quitar la marca: queda sin texto inicial
      const off = await call(
        w.owner,
        w.tenantA,
        UPDATE,
        updateParams(b.id, 2, { name: "B", body: "Texto nuevo.", isDefault: false }),
      );
      expect(off.result).toBe("updated");
      expect(
        await count(
          "select count(*) as n from public.text_snippets where tenant_id = $1 and is_default",
          [w.tenantA],
        ),
      ).toBe(0);
    });
  });

  it("cada organización tiene el suyo", async () => {
    await withTx(setup, async () => {
      await make(w.owner, { kind: "email_body", name: "Inicial de A", isDefault: true });
      await make(
        w.ownerB,
        { kind: "email_body", name: "Inicial de B", isDefault: true },
        w.tenantB,
      );
      expect(
        await count(
          "select count(*) as n from public.text_snippets where is_default and tenant_id = any($1)",
          [[w.tenantA, w.tenantB]],
        ),
      ).toBe(2);
    });
  });

  it("solo el texto del correo puede ser el inicial: los otros tres tipos reciben «default_only_email»", async () => {
    await withTx(setup, async () => {
      for (const kind of ["conditions", "exclusions", "footer_note"]) {
        const error = await denied(
          w.owner,
          w.tenantA,
          CREATE,
          createParams({ kind, isDefault: true }),
        );
        expect(error, kind).toMatchObject({ code: INVALID, message: "default_only_email" });
        const { id } = await make(w.owner, { kind });
        const update = await denied(
          w.owner,
          w.tenantA,
          UPDATE,
          updateParams(id, 1, { isDefault: true }),
        );
        expect(update, kind).toMatchObject({ code: INVALID, message: "default_only_email" });
      }
    });
  });

  it("la tabla misma lo impide: ni por una inserción directa se marca un texto que no es del correo, ni dos a la vez", async () => {
    await withTx(setup, async () => {
      await actAsPostgres(setup);
      const wrongKind = await expectSqlError(
        setup,
        `insert into public.text_snippets (id, tenant_id, kind, name, body, is_default)
         values ($1, $2, 'conditions', 'Mal tipo', 'x', true)`,
        [randomUUID(), w.tenantA],
      );
      expect(wrongKind.code).toBe("23514");
      await setup.query(
        `insert into public.text_snippets (id, tenant_id, kind, name, body, is_default)
         values ($1, $2, 'email_body', 'Uno', 'x', true)`,
        [randomUUID(), w.tenantA],
      );
      const twoDefaults = await expectSqlError(
        setup,
        `insert into public.text_snippets (id, tenant_id, kind, name, body, is_default)
         values ($1, $2, 'email_body', 'Dos', 'x', true)`,
        [randomUUID(), w.tenantA],
      );
      expect(twoDefaults.code).toBe("23505");
    });
  });
});

describe("variables", () => {
  // Cada caso se compara con la revisión del módulo puro (`checkSnippetVariables`): las dos tienen que decir lo mismo.
  const texts = [
    "",
    "Hola, adjunto la cotización.",
    "Estimado {{cliente}}:",
    "{{cliente}} {{numero}} {{remitente}} {{organizacion}} {{cliente}}",
    "{{cliente}}{{numero}}",
    "Hola {{nombre}}",
    "Hola {{Cliente}}",
    "Hola {{ cliente }}",
    "Hola {{}}",
    "{{{{cliente}}}}",
    "{{cli{{cliente}}ente}}",
    "Hola {cliente",
    "Hola {{cliente",
    "Hola cliente}}",
    "{{{cliente}}}",
    "{{cliente}} {{otra}}",
    "{{cliente}}".repeat(10),
    "{{cliente}}".repeat(11),
    "{{cliente}}".repeat(10) + "{{otra}}",
    "Opción {A} o {B}.",
    "Para {{cliente}}",
    "No incluye }} nada",
    "{{",
    "}}",
    "{",
    "}",
    "línea uno\n{{cliente}}\nlínea tres",
    "{{cliente\n}}",
    "{{cliente}}\n\n{{numero}}",
    // una variable dentro de la dirección de un enlace (revisión de Aarón al PR #67)
    "[Mira]({{cliente}})",
    "[Mira](https://{{organizacion}}/x)",
    "[Mira](https://ejemplo.cl/{{numero}}) y más",
    "Hola\n\n[Mira]({{cliente}}) gracias",
    "[{{cliente}}](https://ejemplo.cl/x)",
    "[Mira](https://ejemplo.cl/x) {{cliente}}",
    "Hola ({{cliente}}), gracias",
    "[Mira](https://ejemplo.cl/x\n{{cliente}})",
    "[Mira]({{otra}})",
    "[Mira]({{cliente}}",
    "[Mira]({{cliente}})".repeat(11),
  ];

  it("la base y el módulo puro dicen lo mismo en cada caso y cada tipo", async () => {
    await actAsPostgres(setup);
    for (const kind of SNIPPET_KINDS) {
      for (const text of texts) {
        const { rows } = await setup.query<{ p: string | null }>(
          "select app.snippet_variables_problem($1, $2) as p",
          [kind, text],
        );
        const pure = checkSnippetVariables(kind, text);
        expect(rows[0].p, `${kind}: ${JSON.stringify(text)}`).toBe(pure.ok ? null : pure.problem);
      }
    }
  });

  it("al crear, las variables válidas se guardan tal cual y las malas se rechazan con su motivo", async () => {
    await withTx(setup, async () => {
      const ok = await make(w.owner, {
        kind: "email_body",
        body: "Estimado {{cliente}}: cotización {{numero}}, {{remitente}} de {{organizacion}}.",
      });
      expect(ok.result.result).toBe("created");
      expect((await row(ok.id)).body).toContain("{{organizacion}}");

      const cases: [string, string, string][] = [
        ["email_body", "Hola {{nombre}}", "unknown_variable"],
        ["email_body", "Hola {{cliente}", "unknown_variable"],
        ["email_body", "{{cliente}}".repeat(11), "too_many_variables"],
        ["email_body", "[Mira]({{cliente}})", "variable_in_link"],
        ["email_body", "[Mira](https://{{organizacion}}/x)", "variable_in_link"],
        ["conditions", "Para {{cliente}}", "variables_not_allowed"],
        ["exclusions", "Para {{cliente}}", "variables_not_allowed"],
        ["footer_note", "}}", "variables_not_allowed"],
      ];
      for (const [kind, body, message] of cases) {
        const error = await denied(w.owner, w.tenantA, CREATE, createParams({ kind, body }));
        expect(error, `${kind}: ${body}`).toMatchObject({ code: INVALID, message });
      }
      // lo mismo al cambiar (el tipo sale de la fila)
      const { id } = await make(w.owner, { kind: "conditions" });
      expect(
        await denied(w.owner, w.tenantA, UPDATE, updateParams(id, 1, { body: "{{cliente}}" })),
      ).toMatchObject({
        code: INVALID,
        message: "variables_not_allowed",
      });
      const mail = await make(w.owner, { kind: "email_body" });
      expect(
        await denied(
          w.owner,
          w.tenantA,
          UPDATE,
          updateParams(mail.id, 1, { body: "{{cliente}} {{x}}" }),
        ),
      ).toMatchObject({ code: INVALID, message: "unknown_variable" });
    });
  });

  it("diez variables entran en un texto de 4.000 caracteres", async () => {
    await withTx(setup, async () => {
      const token = "{{cliente}}";
      const body =
        "a".repeat(SNIPPET_BODY_MAX_LENGTH - SNIPPET_MAX_VARIABLES * token.length) +
        token.repeat(SNIPPET_MAX_VARIABLES);
      expect(body).toHaveLength(SNIPPET_BODY_MAX_LENGTH);
      expect((await make(w.owner, { kind: "email_body", body })).result.result).toBe("created");
    });
  });
});

describe("forma del nombre y del texto", () => {
  it("largo: nombre de 1 a 80, texto de 1 a 4.000; contados por carácter", async () => {
    await withTx(setup, async () => {
      const long = (n: number) => "ñ".repeat(n);
      expect(
        (
          await make(w.owner, {
            name: long(SNIPPET_NAME_MAX_LENGTH),
            body: long(SNIPPET_BODY_MAX_LENGTH),
          })
        ).result.result,
      ).toBe("created");
      expect(
        (
          await make(w.owner, {
            name: "😀".repeat(SNIPPET_NAME_MAX_LENGTH),
            body: "😀".repeat(SNIPPET_BODY_MAX_LENGTH),
          })
        ).result.result,
      ).toBe("created");
      for (const [over, message] of [
        [{ name: long(SNIPPET_NAME_MAX_LENGTH + 1) }, "invalid_name"],
        [{ name: "" }, "invalid_name"],
        [{ name: "   " }, "invalid_name"],
        [{ body: long(SNIPPET_BODY_MAX_LENGTH + 1) }, "invalid_body"],
        [{ body: "" }, "invalid_body"],
        [{ body: " \n\t " }, "invalid_body"],
      ] as [Over, string][]) {
        expect(
          await denied(w.owner, w.tenantA, CREATE, createParams(over)),
          JSON.stringify(over).slice(0, 80),
        ).toMatchObject({
          code: INVALID,
          message,
        });
      }
    });
  });

  it("tipo desconocido o argumentos que faltan: «dato inválido»", async () => {
    await withTx(setup, async () => {
      expect(
        await denied(w.owner, w.tenantA, CREATE, createParams({ kind: "asunto" })),
      ).toMatchObject({
        code: INVALID,
        message: "invalid_kind",
      });
      for (let i = 0; i < 5; i++) {
        const params = createParams();
        params[i] = null;
        expect(await denied(w.owner, w.tenantA, CREATE, params), `arg ${i}`).toMatchObject({
          code: INVALID,
          message: "invalid_arguments",
        });
      }
    });
  });

  it("los espacios y saltos de los bordes se quitan y los saltos de Windows pasan a uno solo (igual que el módulo puro)", async () => {
    await withTx(setup, async () => {
      const raw = {
        name: "  Mi texto \t\n",
        body: "\r\n  Línea uno\r\nLínea dos\rLínea tres  \n\n",
      };
      const { id } = await make(w.owner, raw);
      const saved = await row(id);
      expect(saved.name).toBe("Mi texto");
      expect(saved.body).toBe("Línea uno\nLínea dos\nLínea tres");
      expect(saved.name).toBe(normalizeSnippetName(raw.name));
      expect(saved.body).toBe(normalizeSnippetBody(raw.body));
    });
  });

  it("las funciones de limpieza de la base y las del módulo puro dan lo mismo", async () => {
    await actAsPostgres(setup);
    const inputs = [
      "",
      "  a  ",
      "\t\n a \n\t",
      "a\r\nb",
      "a\rb",
      "\r\n\r\n",
      "\u00a0a\u00a0",
      "a\n\n\nb",
      "   \r\n  x  \r\n   ",
      "ñandú 😀",
      "Condicio\u0301n", // tilde separada de la letra
      "Condici\u00f3n",
      "  Condicio\u0301n \r\n",
    ];
    for (const input of inputs) {
      const { rows } = await setup.query<{ n: string; b: string }>(
        "select app.snippet_normalize_name($1) as n, app.snippet_normalize_body($1) as b",
        [input],
      );
      expect(rows[0].n, JSON.stringify(input)).toBe(normalizeSnippetName(input));
      expect(rows[0].b, JSON.stringify(input)).toBe(normalizeSnippetBody(input));
    }
  });
});

describe("caracteres invisibles y de control", () => {
  const unsafe = [
    "\u0001",
    "\u0008",
    "\u000b",
    "\u001f",
    "\u007f",
    "\u0085",
    "\u00ad",
    "\u034f",
    "\u200b",
    "\u200e",
    "\u2028",
    "\u202e",
    "\u2060",
    "\u2066",
    "\u3164",
    "\ufeff",
    "\uffa0",
    "\u{e0041}",
  ];

  it("el nombre y el texto con alguno de ellos se rechazan al crear y al cambiar", async () => {
    await withTx(setup, async () => {
      const { id } = await make(w.owner);
      for (const char of unsafe) {
        const code = char.codePointAt(0)!.toString(16);
        expect(
          await denied(w.owner, w.tenantA, CREATE, createParams({ name: `Nom${char}bre` })),
          code,
        ).toMatchObject({
          code: INVALID,
          message: "invalid_name",
        });
        expect(
          await denied(w.owner, w.tenantA, CREATE, createParams({ body: `Tex${char}to` })),
          code,
        ).toMatchObject({
          code: INVALID,
          message: "invalid_body",
        });
        expect(
          await denied(w.owner, w.tenantA, UPDATE, updateParams(id, 1, { name: `N${char}` })),
          code,
        ).toMatchObject({
          code: INVALID,
          message: "invalid_name",
        });
        expect(
          await denied(w.owner, w.tenantA, UPDATE, updateParams(id, 1, { body: `T${char}` })),
          code,
        ).toMatchObject({
          code: INVALID,
          message: "invalid_body",
        });
      }
    });
  });

  it("el tabulador y el salto de línea valen en el texto, no en el nombre", async () => {
    await withTx(setup, async () => {
      expect((await make(w.owner, { body: "Col1\tCol2\nFila 2" })).result.result).toBe("created");
      for (const name of ["Dos\nlíneas", "Con\ttab"]) {
        expect(await denied(w.owner, w.tenantA, CREATE, createParams({ name }))).toMatchObject({
          code: INVALID,
          message: "invalid_name",
        });
      }
    });
  });

  it("la tabla también lo rechaza si alguien lo intenta por fuera de las funciones", async () => {
    await withTx(setup, async () => {
      await actAsPostgres(setup);
      for (const [column, value] of [
        ["name", "a\u200bb"],
        ["body", "a\u202eb"],
      ] as const) {
        const error = await expectSqlError(
          setup,
          `insert into public.text_snippets (id, tenant_id, kind, name, body)
           values ($1, $2, 'conditions', ${column === "name" ? "$3" : "'ok'"}, ${column === "body" ? "$3" : "'ok'"})`,
          [randomUUID(), w.tenantA, value],
        );
        expect(error.code, column).toBe("23514");
      }
      for (const [name, body] of [
        ["x".repeat(81), "ok"],
        ["ok", "x".repeat(4001)],
        ["", "ok"],
        ["ok", ""],
      ]) {
        const error = await expectSqlError(
          setup,
          `insert into public.text_snippets (id, tenant_id, kind, name, body) values ($1, $2, 'conditions', $3, $4)`,
          [randomUUID(), w.tenantA, name, body],
        );
        expect(error.code).toBe("23514");
      }
    });
  });

  it("la base y el módulo puro rechazan EXACTAMENTE los mismos caracteres (todo Unicode, una vez por tipo de texto)", async () => {
    await actAsPostgres(setup);
    for (const multiline of [true, false]) {
      const { rows } = await setup.query<{ n: number }>(
        `select n from generate_series(1, 1114111) n
          where (n < 55296 or n > 57343) and app.intake_text_unsafe(chr(n), $1) order by n`,
        [multiline],
      );
      const db = rows.map((r) => r.n);
      const pure: number[] = [];
      for (let n = 1; n <= 0x10ffff; n++) {
        if (n >= 0xd800 && n <= 0xdfff) continue;
        if (hasUnsafeSnippetCharacters(String.fromCodePoint(n), multiline)) pure.push(n);
      }
      expect(pure.length).toBeGreaterThan(100);
      expect(pure, multiline ? "varias líneas" : "una línea").toEqual(db);
    }
    // el carácter nulo no puede existir en un texto de la base: el módulo puro lo rechaza de todos modos
    expect(hasUnsafeSnippetCharacters("a\u0000b", true)).toBe(true);
  });
});

describe("auditoría", () => {
  it("crear, cambiar y eliminar quedan registrados con tipo, nombre y campos cambiados, SIN el texto", async () => {
    await withTx(setup, async () => {
      const { id } = await make(w.owner, {
        kind: "email_body",
        name: "Saludo",
        body: `Hola {{cliente}}. ${SECRET}`,
        isDefault: true,
      });
      await call(
        w.admin,
        w.tenantA,
        UPDATE,
        updateParams(id, 1, { name: "Saludo largo", body: `Otro ${SECRET}`, isDefault: true }),
      );
      await call(w.owner, w.tenantA, DELETE, [id]);

      const audit = await auditOf(id);
      expect(audit.map((a) => a.action)).toEqual([
        "text_snippet.created",
        "text_snippet.updated",
        "text_snippet.deleted",
      ]);
      for (const entry of audit) {
        expect(entry.resource_type).toBe("text_snippet");
        expect(entry.tenant_id).toBe(w.tenantA);
        expect(entry.result).toBe("success");
        expect(entry.actor_type).toBe("user");
        expect(Object.keys(entry.details)).not.toContain("body");
        expect(JSON.stringify(entry.details)).not.toContain(SECRET);
        expect(JSON.stringify(entry.details)).not.toContain("{{cliente}}");
      }
      expect(audit[0].actor_user_id).toBe(w.owner.id);
      expect(audit[0].details).toEqual({ kind: "email_body", name: "Saludo", is_default: true });
      expect(audit[1].actor_user_id).toBe(w.admin.id);
      expect(audit[1].details).toEqual({
        kind: "email_body",
        name: "Saludo largo",
        changed: ["name", "body"],
      });
      expect(audit[2].details).toEqual({
        kind: "email_body",
        name: "Saludo largo",
        was_default: true,
      });
    });
  });

  it("un texto de 4.000 caracteres no hace fallar su propio registro (el detalle de la auditoría tiene un tope de 8 KB)", async () => {
    await withTx(setup, async () => {
      const { id } = await make(w.owner, {
        name: "ñ".repeat(80),
        body: "ñ".repeat(SNIPPET_BODY_MAX_LENGTH),
      });
      await call(
        w.owner,
        w.tenantA,
        UPDATE,
        updateParams(id, 1, { name: "ñ".repeat(79), body: "á".repeat(SNIPPET_BODY_MAX_LENGTH) }),
      );
      await call(w.owner, w.tenantA, DELETE, [id]);
      expect((await auditOf(id)).length).toBe(3);
    });
  });

  it("lo que se rechaza no deja registro ni texto en ninguna parte de la auditoría", async () => {
    await withTx(setup, async () => {
      const before = await count(
        "select count(*) as n from public.audit_log where tenant_id = $1",
        [w.tenantA],
      );
      await denied(w.sales, w.tenantA, CREATE, createParams({ body: SECRET }));
      await denied(
        w.owner,
        w.tenantA,
        CREATE,
        createParams({ kind: "conditions", body: `{{cliente}} ${SECRET}` }),
      );
      expect(
        await count("select count(*) as n from public.audit_log where tenant_id = $1", [w.tenantA]),
      ).toBe(before);
      expect(
        await count("select count(*) as n from public.audit_log where details::text like $1", [
          `%${SECRET}%`,
        ]),
      ).toBe(0);
    });
  });

  it("la auditoría queda con la organización de quien actúa", async () => {
    await withTx(setup, async () => {
      const a = await make(w.owner);
      const b = await make(w.ownerB, {}, w.tenantB);
      expect((await auditOf(a.id))[0].tenant_id).toBe(w.tenantA);
      expect((await auditOf(b.id))[0].tenant_id).toBe(w.tenantB);
    });
  });
});

describe("repetir el mismo identificador", () => {
  it("crear dos veces el mismo texto (doble clic) devuelve el que ya existe y no duplica ni audita de nuevo", async () => {
    await withTx(setup, async () => {
      const { id, params } = await make(w.owner, { name: "Una vez" });
      const again = await call(w.owner, w.tenantA, CREATE, params);
      expect(again).toEqual({ result: "exists", id, revision: 1 });
      expect(
        await count("select count(*) as n from public.text_snippets where id = $1", [id]),
      ).toBe(1);
      expect((await auditOf(id)).length).toBe(1);
    });
  });

  it("el identificador de un texto de OTRA organización no se puede reutilizar, y el texto ajeno no cambia", async () => {
    await withTx(setup, async () => {
      const { id } = await make(w.owner, { name: "De A", body: "Original de A." });
      const error = await denied(
        w.ownerB,
        w.tenantB,
        CREATE,
        createParams({ id, name: "Robo", body: "Robado." }),
      );
      expect(error).toMatchObject({ code: INVALID, message: "id_in_use" });
      const intact = await row(id);
      expect(intact.tenant_id).toBe(w.tenantA);
      expect(intact.body).toBe("Original de A.");
    });
  });

  it("apuntar a un texto de otra organización con las funciones de cambiar y eliminar es «no encontrado» y no lo toca", async () => {
    await withTx(setup, async () => {
      const b = await make(w.ownerB, { name: "De B", body: "Original de B." }, w.tenantB);
      expect(
        await denied(w.owner, w.tenantA, UPDATE, updateParams(b.id, 1, { body: "Pisado." })),
      ).toMatchObject({
        code: NOT_FOUND,
        message: "snippet_not_found",
      });
      expect(await denied(w.owner, w.tenantA, DELETE, [b.id])).toMatchObject({
        code: NOT_FOUND,
        message: "snippet_not_found",
      });
      const intact = await row(b.id);
      expect(intact.body).toBe("Original de B.");
      expect(intact.revision).toBe(1);
    });
  });
});

describe("eliminar", () => {
  it("borra de verdad: la fila desaparece, el texto no queda en la auditoría y repetir da «no encontrado»", async () => {
    await withTx(setup, async () => {
      const { id } = await make(w.owner, { name: "Se va", body: `Contenido ${SECRET}` });
      expect(await call(w.owner, w.tenantA, DELETE, [id])).toEqual({ result: "deleted" });
      expect(await row(id)).toBeUndefined();
      expect(
        await count("select count(*) as n from public.text_snippets where body like $1", [
          `%${SECRET}%`,
        ]),
      ).toBe(0);
      expect(
        await count("select count(*) as n from public.audit_log where details::text like $1", [
          `%${SECRET}%`,
        ]),
      ).toBe(0);
      expect(await denied(w.owner, w.tenantA, DELETE, [id])).toMatchObject({ code: NOT_FOUND });
      // los demás argumentos
      expect(await denied(w.owner, w.tenantA, DELETE, [null])).toMatchObject({
        code: INVALID,
        message: "invalid_arguments",
      });
    });
  });

  it("eliminar el texto inicial deja a la organización sin texto inicial, y el nombre queda libre", async () => {
    await withTx(setup, async () => {
      const { id } = await make(w.owner, { kind: "email_body", name: "Inicial", isDefault: true });
      await call(w.owner, w.tenantA, DELETE, [id]);
      expect(
        await count(
          "select count(*) as n from public.text_snippets where tenant_id = $1 and is_default",
          [w.tenantA],
        ),
      ).toBe(0);
      expect(
        (await make(w.owner, { kind: "email_body", name: "Inicial", isDefault: true })).result
          .result,
      ).toBe("created");
    });
  });
});

describe("paridad con el módulo puro (src/lib/snippets)", () => {
  it("las constantes de la base son las del módulo", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<Record<string, number>>(
      `select app.snippets_max_per_tenant() as max_per_tenant,
              app.snippet_name_max_length() as name_max,
              app.snippet_body_max_length() as body_max,
              app.snippet_max_variables() as max_variables,
              app.snippet_variable_value_max_length() as value_max`,
    );
    expect(rows[0]).toEqual({
      max_per_tenant: SNIPPETS_MAX_PER_TENANT,
      name_max: SNIPPET_NAME_MAX_LENGTH,
      body_max: SNIPPET_BODY_MAX_LENGTH,
      max_variables: SNIPPET_MAX_VARIABLES,
      value_max: SNIPPET_VARIABLE_VALUE_MAX_LENGTH,
    });
  });

  it("los tipos y las variables de la base son los del módulo, en el mismo orden", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<{ kinds: string[]; variables: string[] }>(
      "select app.snippet_kinds() as kinds, app.snippet_variable_names() as variables",
    );
    expect(rows[0].kinds).toEqual([...SNIPPET_KINDS]);
    expect(rows[0].variables).toEqual([...SNIPPET_VARIABLES]);
  });

  it("los límites reales de la tabla son los del módulo: el máximo entra y uno más no", async () => {
    await withTx(setup, async () => {
      await actAsPostgres(setup);
      const insert = (name: string, body: string) =>
        setup.query(
          `insert into public.text_snippets (id, tenant_id, kind, name, body) values ($1, $2, 'conditions', $3, $4)`,
          [randomUUID(), w.tenantA, name, body],
        );
      await insert("n".repeat(SNIPPET_NAME_MAX_LENGTH), "b".repeat(SNIPPET_BODY_MAX_LENGTH));
      for (const [name, body] of [
        ["n".repeat(SNIPPET_NAME_MAX_LENGTH + 1), "b"],
        ["n", "b".repeat(SNIPPET_BODY_MAX_LENGTH + 1)],
      ]) {
        const error = await expectSqlError(
          setup,
          `insert into public.text_snippets (id, tenant_id, kind, name, body) values ($1, $2, 'conditions', $3, $4)`,
          [randomUUID(), w.tenantA, name, body],
        );
        expect(error.code).toBe("23514");
      }
    });
  });

  it("en el módulo puro cada tipo y cada variable tienen lo que la base espera (nadie agrega uno sin tocar la base)", () => {
    const kinds: SnippetKind[] = ["email_body", "conditions", "exclusions", "footer_note"];
    expect([...SNIPPET_KINDS]).toEqual(kinds);
    expect(SNIPPET_VARIABLES).toHaveLength(4);
  });
});

describe("la migración y su deshacer", () => {
  const root = path.resolve(import.meta.dirname, "..", "..", "supabase");
  const down = readFileSync(
    path.join(root, "rollbacks", "20261104110000_text_snippets.down.sql"),
    "utf8",
  );
  const up = readFileSync(
    path.join(root, "migrations", "20261104110000_text_snippets.sql"),
    "utf8",
  );
  const objects = `select
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'app') and p.proname ~ 'snippet') as functions,
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname ~ 'text_snippets') as relations`;

  it("el deshacer quita todo lo que la migración crea, aunque haya textos guardados, y se puede volver a aplicar", async () => {
    await withTx(setup, async () => {
      // La organización de esta prueba tiene textos: el deshacer no depende de que la tabla esté vacía.
      // (Dentro de la transacción: no deja nada guardado.)
      await seedSnippets(w.tenantA, w.owner, 1);
      await actAsPostgres(setup);
      const before = (await setup.query<{ functions: string; relations: string }>(objects)).rows[0];
      expect(Number(before.functions)).toBe(13);
      await setup.query(down);
      const after = (await setup.query<{ functions: string; relations: string }>(objects)).rows[0];
      expect(after).toEqual({ functions: "0", relations: "0" });
      await setup.query(up);
      expect((await setup.query(objects)).rows[0]).toEqual(before);
      // nada de esto se confirma: la transacción se deshace al terminar
    });
    expect(
      await count("select count(*) as n from pg_proc where proname = 'create_text_snippet'"),
    ).toBe(1);
  });
});
