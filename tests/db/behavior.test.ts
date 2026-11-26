// Pruebas mínimas de comportamiento de la base de datos del sprint 1.
// La batería completa de aislamiento (§8.3) es la historia H-012 y vive en tests/isolation.
// Cada prueba corre dentro de una transacción que se deshace: no deja datos en la base local.
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TENANT_HEADER,
  actAs,
  actAsAnon,
  actAsPostgres,
  connect,
  createTenantAs,
  createUser,
  expectSqlError,
  withTx,
} from "./helpers";

const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const MAX_TENANTS_PER_USER = 5; // debe coincidir con app.max_tenants_per_user()
const FICTIONAL_RUT = "76086428-5";

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

const hex64 = () => randomBytes(32).toString("hex");

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query(sql, params);
  return rows[0] as T;
}

async function currentTenantAs(userId: string, header?: string): Promise<string | null> {
  await actAs(
    db,
    { id: userId, email: "" },
    header === undefined ? {} : { [TENANT_HEADER]: header },
  );
  const r = await one<{ t: string | null }>("select app.current_tenant_id() as t");
  await actAsPostgres(db);
  return r.t;
}

describe("create_tenant", () => {
  it("exige correo verificado", () =>
    withTx(db, async () => {
      const user = await createUser(db, { confirmed: false });
      await actAs(db, user);
      const err = await expectSqlError(
        db,
        "select public.create_tenant('Mi Negocio', $1, 'services')",
        [FICTIONAL_RUT],
      );
      expect(err.code).toBe(INSUFFICIENT_PRIVILEGE);
    }));

  it("crea organización, Dueño, numeración y auditoría", () =>
    withTx(db, async () => {
      const user = await createUser(db);
      const tenantId = await createTenantAs(db, user, "76.086.428-5", "  Negocio Uno ");

      const tenant = await one<{ name: string; rut: string; kind: string; created_by: string }>(
        "select name, rut, kind, created_by from public.tenants where tenant_id = $1",
        [tenantId],
      );
      expect(tenant).toMatchObject({
        name: "Negocio Uno",
        rut: FICTIONAL_RUT,
        kind: "organization",
        created_by: user.id,
      });

      const member = await one<{ role: string; status: string }>(
        "select role, status from public.members where tenant_id = $1 and user_id = $2",
        [tenantId, user.id],
      );
      expect(member).toEqual({ role: "owner", status: "active" });

      const settings = await one<{ prefix: string; mode: string }>(
        "select prefix, mode from public.numbering_settings where tenant_id = $1",
        [tenantId],
      );
      expect(settings).toEqual({ prefix: "COT", mode: "yearly" });

      const { rows } = await db.query<{ action: string; actor_user_id: string; result: string }>(
        "select action, actor_user_id, result from public.audit_log where tenant_id = $1 order by id",
        [tenantId],
      );
      expect(rows.map((r) => r.action)).toEqual(
        expect.arrayContaining(["tenant.created", "member.created", "numbering.created"]),
      );
      expect(rows.every((r) => r.actor_user_id === user.id && r.result === "success")).toBe(true);

      const profile = await one<{ last_tenant_id: string }>(
        "select last_tenant_id from public.profiles where user_id = $1",
        [user.id],
      );
      expect(profile.last_tenant_id).toBe(tenantId);
    }));

  it("rechaza un RUT inválido", () =>
    withTx(db, async () => {
      const user = await createUser(db);
      await actAs(db, user);
      const err = await expectSqlError(
        db,
        "select public.create_tenant('Mi Negocio', '76086428-4')",
      );
      expect(err.message).toMatch(/RUT/);
    }));

  it("respeta el tope de organizaciones por persona", () =>
    withTx(db, async () => {
      const user = await createUser(db);
      for (let i = 0; i < MAX_TENANTS_PER_USER; i++) await createTenantAs(db, user);
      await actAs(db, user);
      const err = await expectSqlError(db, "select public.create_tenant('Una más', $1)", [
        FICTIONAL_RUT,
      ]);
      expect(err.message).toMatch(/máximo/);
    }));

  it("no se puede ejecutar sin sesión (anon)", () =>
    withTx(db, async () => {
      await actAsAnon(db);
      const err = await expectSqlError(db, "select public.create_tenant('X Y', $1)", [
        FICTIONAL_RUT,
      ]);
      expect(err.code).toBe(INSUFFICIENT_PRIVILEGE);
    }));
});

describe("app.current_tenant_id()", () => {
  it("devuelve la organización solo si la persona es miembro; null con cabecera ajena o basura", () =>
    withTx(db, async () => {
      const ana = await createUser(db);
      const beto = await createUser(db);
      const tenantA = await createTenantAs(db, ana);
      const tenantB = await createTenantAs(db, beto);

      expect(await currentTenantAs(ana.id, tenantA)).toBe(tenantA);
      expect(await currentTenantAs(ana.id, tenantA.toUpperCase())).toBe(tenantA);

      // cabecera ajena
      expect(await currentTenantAs(ana.id, tenantB)).toBeNull();
      expect(await currentTenantAs(ana.id, tenantB.toUpperCase())).toBeNull();
      // sin cabecera, o basura
      expect(await currentTenantAs(ana.id)).toBeNull();
      for (const garbage of [
        "",
        "null",
        "x",
        "1; drop table public.tenants",
        "00000000-0000-0000-0000-000000000000",
        "{}",
      ]) {
        expect(await currentTenantAs(ana.id, garbage)).toBeNull();
      }
      // la organización de la plataforma nunca es "activa"
      expect(await currentTenantAs(ana.id, "00000000-0000-4000-8000-000000000001")).toBeNull();
    }));

  it("devuelve null con request.headers vacío o sin sesión", () =>
    withTx(db, async () => {
      const ana = await createUser(db);
      const tenantA = await createTenantAs(db, ana);
      await db.query(
        "select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true), set_config('request.headers', '', true)",
      );
      expect((await one<{ t: string | null }>("select app.current_tenant_id() as t")).t).toBeNull();
      await db.query(`select set_config('request.headers', $1, true)`, [
        JSON.stringify({ [TENANT_HEADER]: tenantA }),
      ]);
      expect((await one<{ t: string | null }>("select app.current_tenant_id() as t")).t).toBeNull(); // sin pase
    }));

  it("una persona quitada pierde el acceso de inmediato", () =>
    withTx(db, async () => {
      const dueno = await createUser(db);
      const ex = await createUser(db);
      const tenantId = await createTenantAs(db, dueno);
      await db.query(
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'sales')",
        [tenantId, ex.id],
      );
      expect(await currentTenantAs(ex.id, tenantId)).toBe(tenantId);
      await db.query(
        "update public.members set status = 'removed', removed_at = now() where tenant_id = $1 and user_id = $2",
        [tenantId, ex.id],
      );
      expect(await currentTenantAs(ex.id, tenantId)).toBeNull();
    }));
});

describe("numeración", () => {
  const year = async () => (await one<{ y: number }>("select app.current_business_year() as y")).y;

  async function allocate(tenantId: string): Promise<{ seq: string; display: string }> {
    return one("select seq, display from app.allocate_quote_number($1)", [tenantId]);
  }

  it("el contador sube de a uno, con formato anual y relleno", () =>
    withTx(db, async () => {
      const user = await createUser(db);
      const tenantId = await createTenantAs(db, user);
      await actAs(db, user, { [TENANT_HEADER]: tenantId }, "postgres");
      const y = await year();
      expect((await allocate(tenantId)).display).toBe(`COT-${y}-0001`);
      expect((await allocate(tenantId)).display).toBe(`COT-${y}-0002`);
      expect((await allocate(tenantId)).display).toBe(`COT-${y}-0003`);
    }));

  it("set_numbering rechaza un número menor al último usado y acepta saltar hacia adelante", () =>
    withTx(db, async () => {
      const user = await createUser(db);
      const tenantId = await createTenantAs(db, user);
      await actAs(db, user, { [TENANT_HEADER]: tenantId }, "postgres");
      await allocate(tenantId);
      await allocate(tenantId);
      await allocate(tenantId); // último usado: 3

      await actAs(db, user, { [TENANT_HEADER]: tenantId });
      const err = await expectSqlError(db, "select public.set_numbering('COT', 'yearly', 3)");
      expect(err.code).toBe(CHECK_VIOLATION);
      expect(err.message).toMatch(/no puede ser menor que 4/);

      // el siguiente número ya admitido: 4
      expect(
        (await one<{ n: string }>("select public.set_numbering('PRES', 'yearly', 4) as n")).n,
      ).toMatch(/^PRES-\d{4}-0004$/);

      // salto: un número más largo que el ancho no se corta (lpad cortaría 12345 a 1234)
      const y = await year();
      expect(
        (await one<{ n: string }>("select public.set_numbering('PRES', 'yearly', 12345) as n")).n,
      ).toBe(`PRES-${y}-12345`);
      await actAs(db, user, { [TENANT_HEADER]: tenantId }, "postgres");
      expect((await allocate(tenantId)).display).toBe(`PRES-${y}-12345`);
      expect((await allocate(tenantId)).display).toBe(`PRES-${y}-12346`);
    }));

  it("al cambiar a formato corrido el número tampoco retrocede", () =>
    withTx(db, async () => {
      const user = await createUser(db);
      const tenantId = await createTenantAs(db, user);
      await actAs(db, user, { [TENANT_HEADER]: tenantId }, "postgres");
      await allocate(tenantId);
      await allocate(tenantId); // último usado: 2

      await actAs(db, user, { [TENANT_HEADER]: tenantId });
      const err = await expectSqlError(db, "select public.set_numbering('COT', 'continuous', 2)");
      expect(err.code).toBe(CHECK_VIOLATION);
      // sin número: conserva el siguiente (3)
      expect(
        (await one<{ n: string }>("select public.set_numbering('COT', 'continuous') as n")).n,
      ).toBe("COT-0003");
      await actAs(db, user, { [TENANT_HEADER]: tenantId }, "postgres");
      expect((await allocate(tenantId)).display).toBe("COT-0003");
    }));

  it("el contador no se puede bajar ni siquiera con acceso directo", () =>
    withTx(db, async () => {
      const user = await createUser(db);
      const tenantId = await createTenantAs(db, user);
      await actAs(db, user, { [TENANT_HEADER]: tenantId }, "postgres");
      await allocate(tenantId);
      await allocate(tenantId);
      const err = await expectSqlError(
        db,
        "update public.numbering_sequences set last_number = 1 where tenant_id = $1",
        [tenantId],
      );
      expect(err.code).toBe(CHECK_VIOLATION);
    }));

  it("preview_next_quote_number muestra el siguiente sin consumirlo", () =>
    withTx(db, async () => {
      const user = await createUser(db);
      const tenantId = await createTenantAs(db, user);
      await actAs(db, user, { [TENANT_HEADER]: tenantId });
      const y = await year();
      expect((await one<{ n: string }>("select public.preview_next_quote_number() as n")).n).toBe(
        `COT-${y}-0001`,
      );
      expect((await one<{ n: string }>("select public.preview_next_quote_number() as n")).n).toBe(
        `COT-${y}-0001`,
      );
      await actAs(db, user); // sin organización activa
      expect(
        (await one<{ n: string | null }>("select public.preview_next_quote_number() as n")).n,
      ).toBeNull();
    }));

  it("un rol sin permiso no puede cambiar la numeración, y nadie puede asignar números directamente", () =>
    withTx(db, async () => {
      const dueno = await createUser(db);
      const lector = await createUser(db);
      const otro = await createUser(db);
      const tenantId = await createTenantAs(db, dueno);
      const otherTenant = await createTenantAs(db, otro);
      await db.query(
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'viewer')",
        [tenantId, lector.id],
      );

      await actAs(db, lector, { [TENANT_HEADER]: tenantId });
      expect(
        (await expectSqlError(db, "select public.set_numbering('COT', 'yearly', 10)")).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        (await expectSqlError(db, "select * from app.allocate_quote_number($1)", [tenantId])).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);

      // desde dentro (como postgres) tampoco se puede asignar en otra organización
      await actAs(db, dueno, { [TENANT_HEADER]: tenantId }, "postgres");
      expect(
        (await expectSqlError(db, "select * from app.allocate_quote_number($1)", [otherTenant]))
          .message,
      ).toMatch(/forbidden/);
    }));
});

describe("audit_log es de solo agregar", () => {
  it("rechaza update, delete y truncate, y nadie de la aplicación puede escribir", () =>
    withTx(db, async () => {
      const user = await createUser(db);
      const tenantId = await createTenantAs(db, user);

      expect(
        (
          await expectSqlError(
            db,
            "update public.audit_log set action = 'x.y' where tenant_id = $1",
            [tenantId],
          )
        ).message,
      ).toMatch(/append-only/);
      expect(
        (await expectSqlError(db, "delete from public.audit_log where tenant_id = $1", [tenantId]))
          .message,
      ).toMatch(/append-only/);
      expect((await expectSqlError(db, "truncate public.audit_log")).message).toMatch(
        /append-only/,
      );

      // aunque se active el modo de retención, una fila reciente no se puede borrar
      await db.query("select set_config('app.retention_purge', 'on', true)");
      expect(
        (await expectSqlError(db, "delete from public.audit_log where tenant_id = $1", [tenantId]))
          .message,
      ).toMatch(/append-only/);

      // una fila vencida (más de 24 meses) sí se puede borrar por retención
      await db.query(
        `insert into public.audit_log (tenant_id, occurred_at, actor_type, action, result)
         values ($1, now() - interval '25 months', 'system', 'old.entry', 'success')`,
        [tenantId],
      );
      const del = await db.query(
        "delete from public.audit_log where tenant_id = $1 and action = 'old.entry'",
        [tenantId],
      );
      expect(del.rowCount).toBe(1);

      await actAs(db, user, { [TENANT_HEADER]: tenantId });
      expect(
        (
          await expectSqlError(
            db,
            "insert into public.audit_log (tenant_id, actor_type, action, result) values ($1, 'user', 'a.b', 'success')",
            [tenantId],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await expectSqlError(db, "update public.audit_log set action = 'x.y'")).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect((await expectSqlError(db, "delete from public.audit_log")).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    }));

  it("solo Dueño y Administrador leen la auditoría de su organización activa", () =>
    withTx(db, async () => {
      const dueno = await createUser(db);
      const vendedor = await createUser(db);
      const otro = await createUser(db);
      const tenantId = await createTenantAs(db, dueno);
      await createTenantAs(db, otro);
      await db.query(
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'sales')",
        [tenantId, vendedor.id],
      );

      await actAs(db, dueno, { [TENANT_HEADER]: tenantId });
      const ownerRows = await db.query("select distinct tenant_id from public.audit_log");
      expect(ownerRows.rows).toEqual([{ tenant_id: tenantId }]);

      await actAs(db, vendedor, { [TENANT_HEADER]: tenantId });
      expect((await db.query("select 1 from public.audit_log")).rowCount).toBe(0);
    }));
});

describe("términos y consentimiento", () => {
  async function publishTestDocuments(): Promise<void> {
    await db.query("update public.legal_documents set is_current = false");
    await db.query(
      `insert into public.legal_documents (kind, version, content_sha256, published_at, is_current)
       values ('terms', 'v-test-1', $1, now(), true), ('privacy', 'v-test-1', $2, now(), true)`,
      [hex64(), hex64()],
    );
  }

  it("el registro crea el perfil sin terminar y anota el correo de alta; los metadatos de quien crea la cuenta ya NO registran la aceptación (H-116)", () =>
    withTx(db, async () => {
      await publishTestDocuments();
      const ok = await createUser(db, {
        ready: false,
        meta: {
          full_name: "Ana Ficticia",
          accepted_legal: { terms: "v-test-1", privacy: "v-test-1" },
        },
      });
      const none = await createUser(db, { ready: false });

      expect(
        await one<{ full_name: string; signup_email: string; ready: boolean }>(
          "select full_name, signup_email, account_ready_at is not null as ready from public.profiles where user_id = $1",
          [ok.id],
        ),
      ).toEqual({ full_name: "Ana Ficticia", signup_email: ok.email, ready: false });
      const count = (id: string) =>
        one<{ n: string }>(
          "select count(*) as n from public.legal_acceptances where user_id = $1",
          [id],
        );
      // Quien crea la cuenta puede no ser la persona: ninguna aceptación sale de los metadatos
      expect((await count(ok.id)).n).toBe("0");
      expect((await count(none.id)).n).toBe("0");
      // el perfil se creó igual, con el nombre sacado del correo
      expect(
        (
          await one<{ full_name: string }>(
            "select full_name from public.profiles where user_id = $1",
            [none.id],
          )
        ).full_name,
      ).toMatch(/^u-/);
    }));

  it("accept_current_legal_documents registra lo que falta, una sola vez, y no se puede editar", () =>
    withTx(db, async () => {
      await publishTestDocuments();
      const user = await createUser(db);
      await actAs(db, user, { "x-cp-client-ip": "203.0.113.7" });
      expect(
        (await one<{ n: number }>("select public.accept_current_legal_documents() as n")).n,
      ).toBe(2);
      expect(
        (await one<{ n: number }>("select public.accept_current_legal_documents() as n")).n,
      ).toBe(0);
      const row = await one<{ context: string; origin_ip: string }>(
        "select context, origin_ip::text from public.legal_acceptances where user_id = $1 limit 1",
        [user.id],
      );
      expect(row).toEqual({ context: "reaccept", origin_ip: "203.0.113.7/32" });
      // solo agregar (la persona ni siquiera tiene permiso de editar)
      expect(
        (await expectSqlError(db, "update public.legal_acceptances set context = 'signup'")).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      await actAsPostgres(db);
      expect(
        (await expectSqlError(db, "update public.legal_acceptances set context = 'signup'"))
          .message,
      ).toMatch(/append-only/);
    }));

  it("sin sesión (anon) se leen los documentos, pero nada más", () =>
    withTx(db, async () => {
      await publishTestDocuments();
      await actAsAnon(db);
      expect(
        (await db.query("select * from public.legal_documents")).rowCount,
      ).toBeGreaterThanOrEqual(2);
      for (const table of [
        "tenants",
        "members",
        "profiles",
        "customers",
        "catalog_items",
        "audit_log",
        "legal_acceptances",
        "numbering_settings",
      ]) {
        expect((await expectSqlError(db, `select * from public.${table}`)).code).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
      expect(
        (await expectSqlError(db, "select public.accept_current_legal_documents()")).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
    }));
});

describe("catálogo y clientes: RLS, columnas y auditoría", () => {
  it("el catálogo se crea con tenant propio, no cambia de organización y audita los precios", () =>
    withTx(db, async () => {
      const ana = await createUser(db);
      const beto = await createUser(db);
      const tenantA = await createTenantAs(db, ana);
      const tenantB = await createTenantAs(db, beto);

      await actAs(db, ana, { [TENANT_HEADER]: tenantA });
      const item = await one<{ id: string; tenant_id: string; created_by: string }>(
        `insert into public.catalog_items (name, unit, unit_price_clp) values ('Flete', 'km', 1500)
         returning id, tenant_id, created_by`,
      );
      expect(item).toMatchObject({ tenant_id: tenantA, created_by: ana.id });

      // crear en otra organización: rechazado
      expect(
        (
          await expectSqlError(
            db,
            "insert into public.catalog_items (tenant_id, name, unit, unit_price_clp) values ($1, 'X', 'km', 1)",
            [tenantB],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      // mudar una fila propia a otra organización: sin permiso de columna
      expect(
        (await expectSqlError(db, "update public.catalog_items set tenant_id = $1", [tenantB]))
          .code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      // sin política de borrado
      expect((await expectSqlError(db, "delete from public.catalog_items")).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      // dinero en enteros no negativos
      expect(
        (await expectSqlError(db, "update public.catalog_items set unit_price_clp = -1")).code,
      ).toBe(CHECK_VIOLATION);

      await db.query("update public.catalog_items set unit_price_clp = 1800 where id = $1", [
        item.id,
      ]);

      // Ana con la cabecera de B: no ve ni toca nada
      await actAs(db, ana, { [TENANT_HEADER]: tenantB });
      expect((await db.query("select 1 from public.catalog_items")).rowCount).toBe(0);
      expect((await db.query("update public.catalog_items set name = 'hack'")).rowCount).toBe(0);

      await actAs(db, ana, { [TENANT_HEADER]: tenantA });
      expect((await db.query("select 1 from public.catalog_items")).rowCount).toBe(1);
      await actAsPostgres(db);
      const audit = await one<{
        details: { old: Record<string, number>; new: Record<string, number> };
        action: string;
      }>(
        "select action, details from public.audit_log where resource_id = $1 and action = 'catalog_item.price_changed'",
        [item.id],
      );
      expect(audit.details).toEqual({
        old: { unit_price_clp: 1500 },
        new: { unit_price_clp: 1800 },
      });
    }));

  it("H-021: solo Dueño y Administrador editan; desactivar y reactivar queda en auditoría con precio anterior y nuevo", () =>
    withTx(db, async () => {
      const dueno = await createUser(db);
      const comercial = await createUser(db);
      const tenantId = await createTenantAs(db, dueno);
      await db.query(
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'sales')",
        [tenantId, comercial.id],
      );

      await actAs(db, dueno, { [TENANT_HEADER]: tenantId });
      const item = await one<{ id: string }>(
        `insert into public.catalog_items (name, unit, unit_price_clp) values ('Flete', 'km', 1500)
         returning id`,
      );
      await db.query(
        "update public.catalog_items set unit_price_clp = 2000, name = 'Flete largo' where id = $1",
        [item.id],
      );
      await db.query("update public.catalog_items set is_active = false where id = $1", [item.id]);
      await db.query("update public.catalog_items set is_active = true where id = $1", [item.id]);

      // el Comercial no puede editar ni desactivar: la base no le encuentra la fila
      await actAs(db, comercial, { [TENANT_HEADER]: tenantId });
      expect(
        (
          await db.query("update public.catalog_items set unit_price_clp = 1 where id = $1", [
            item.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await db.query("update public.catalog_items set is_active = false where id = $1", [
            item.id,
          ])
        ).rowCount,
      ).toBe(0);

      await actAsPostgres(db);
      const rows = (
        await db.query<{ action: string; details: Record<string, Record<string, unknown>> }>(
          "select action, details from public.audit_log where resource_id = $1",
          [item.id],
        )
      ).rows;
      const price = rows.find((r) => r.action === "catalog_item.price_changed");
      expect(price?.details).toEqual({
        old: { name: "Flete", unit_price_clp: 1500 },
        new: { name: "Flete largo", unit_price_clp: 2000 },
      });
      const toggles = rows.filter(
        (r) => r.action === "catalog_item.updated" && "is_active" in (r.details.new ?? {}),
      );
      // dentro de una transacción todas las filas comparten la misma hora: se compara sin orden
      expect(toggles.map((r) => r.details.new.is_active).sort()).toEqual([false, true]);
      const stored = await one<{ unit_price_clp: string; is_active: boolean }>(
        "select unit_price_clp, is_active from public.catalog_items where id = $1",
        [item.id],
      );
      expect(Number(stored.unit_price_clp)).toBe(2000);
      expect(stored.is_active).toBe(true);
    }));

  it("los clientes los crean Dueño, Administrador y Comercial; la auditoría guarda solo nombres de campos", () =>
    withTx(db, async () => {
      const dueno = await createUser(db);
      const comercial = await createUser(db);
      const lector = await createUser(db);
      const tenantId = await createTenantAs(db, dueno);
      await db.query(
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'sales'), ($1, $3, 'viewer')",
        [tenantId, comercial.id, lector.id],
      );
      const customerId = crypto.randomUUID();
      const secretEmail = "v1.SECRETO-CIFRADO.abc";

      await actAs(db, comercial, { [TENANT_HEADER]: tenantId });
      await db.query(
        `insert into public.customers (id, kind, display_name, email_enc, email_hash) values ($1, 'person', 'Cliente Ficticio', $2, $3)`,
        [customerId, secretEmail, hex64()],
      );
      await db.query(
        "update public.customers set display_name = 'Cliente Nuevo', email_enc = $2, email_hash = $3 where id = $1",
        [customerId, "v1.OTRO-SECRETO.xyz", hex64()],
      );
      // Editar solo el nombre: la auditoría marca solo el nombre (la app ya no re-cifra lo demás)
      await db.query(
        "update public.customers set display_name = 'Cliente Renombrado' where id = $1",
        [customerId],
      );

      await actAs(db, lector, { [TENANT_HEADER]: tenantId });
      expect((await db.query("select 1 from public.customers")).rowCount).toBe(1); // ve
      expect(
        (
          await expectSqlError(
            db,
            "insert into public.customers (id, kind, display_name) values (gen_random_uuid(), 'person', 'No')",
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await db.query("update public.customers set display_name = 'hack'")).rowCount).toBe(
        0,
      ); // no edita

      // huella inválida o a medias
      await actAs(db, comercial, { [TENANT_HEADER]: tenantId });
      expect(
        (
          await expectSqlError(
            db,
            "insert into public.customers (id, kind, display_name, email_hash) values (gen_random_uuid(), 'person', 'X', $1)",
            [hex64()],
          )
        ).code,
      ).toBe(CHECK_VIOLATION);

      await actAsPostgres(db);
      const { rows } = await db.query<{ action: string; details: Record<string, unknown> }>(
        "select action, details from public.audit_log where resource_id = $1 order by id",
        [customerId],
      );
      expect(rows.map((r) => r.action)).toEqual([
        "customer.created",
        "customer.updated",
        "customer.updated",
      ]);
      expect(rows[1].details).toEqual({ changed: ["display_name", "email_enc", "email_hash"] });
      expect(rows[2].details).toEqual({ changed: ["display_name"] });
      expect(JSON.stringify(rows)).not.toMatch(/SECRETO|Cliente Nuevo|Cliente Renombrado/);
    }));

  it("members y tenants: sin escritura directa de miembros; el rol no se puede escalar", () =>
    withTx(db, async () => {
      const dueno = await createUser(db);
      const comercial = await createUser(db);
      const tenantId = await createTenantAs(db, dueno);
      await db.query(
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'sales')",
        [tenantId, comercial.id],
      );

      await actAs(db, comercial, { [TENANT_HEADER]: tenantId });
      expect(
        (
          await expectSqlError(db, "update public.members set role = 'owner' where user_id = $1", [
            comercial.id,
          ])
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        (
          await expectSqlError(
            db,
            "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'admin')",
            [tenantId, comercial.id],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      // un Comercial no edita la organización (la política deja 0 filas)
      expect((await db.query("update public.tenants set name = 'Mía ahora'")).rowCount).toBe(0);
      // el Dueño sí; y solo hay un Dueño activo
      await actAs(db, dueno, { [TENANT_HEADER]: tenantId });
      expect((await db.query("update public.tenants set name = 'Nombre Nuevo'")).rowCount).toBe(1);
      await actAsPostgres(db);
      expect(
        (
          await expectSqlError(
            db,
            "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'owner')",
            [tenantId, comercial.id],
          )
        ).code,
      ).toBe("23505");
    }));
});
