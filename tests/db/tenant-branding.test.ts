// H-007 · Marca de la organización: columnas de `tenants` y políticas de Storage (migración 13).
// Las políticas se prueban con SQL como `authenticated`; las pruebas por la API de Storage, con pase
// real, están en tests/isolation/storage.test.ts. Cada prueba corre en una transacción que se deshace.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TENANT_HEADER,
  actAs,
  actAsPostgres,
  connect,
  createTenantAs,
  createUser,
  expectSqlError,
  withTx,
  type TestUser,
} from "./helpers";

const BUCKET = "tenant-logos";
const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const LOGO_MAX_BYTES = 1_048_576; // debe coincidir con LOGO_MAX_BYTES (src/lib/brand/logo.ts)

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

const logoName = (tenantId: string, code = "0123456789ab", ext = "png") =>
  `${tenantId}/logo-${code}.${ext}`;

async function addMember(tenantId: string, user: TestUser, role: string) {
  await db.query("insert into public.members (tenant_id, user_id, role) values ($1, $2, $3)", [
    tenantId,
    user.id,
    role,
  ]);
}

/** Crea el objeto como `postgres` (para probar lecturas): deja la sesión como postgres. */
async function seedObject(name: string) {
  await actAsPostgres(db);
  await db.query(`insert into storage.objects (bucket_id, name) values ($1, $2)`, [BUCKET, name]);
}

async function visibleObjects(user: TestUser, header?: string): Promise<string[]> {
  await actAs(db, user, header ? { [TENANT_HEADER]: header } : {});
  const { rows } = await db.query<{ name: string }>(
    `select name from storage.objects where bucket_id = $1 order by name`,
    [BUCKET],
  );
  await actAsPostgres(db);
  return rows.map((r) => r.name);
}

describe("bucket de logos", () => {
  it("existe, es privado y limita tamaño y tipos", async () => {
    const { rows } = await db.query(
      `select public, file_size_limit, allowed_mime_types from storage.buckets where id = $1`,
      [BUCKET],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].public).toBe(false);
    expect(Number(rows[0].file_size_limit)).toBe(LOGO_MAX_BYTES);
    expect([...rows[0].allowed_mime_types].sort()).toEqual([
      "image/jpeg",
      "image/png",
      "image/svg+xml",
    ]);
  });

  it("solo tiene políticas de leer y borrar (nadie sube con su sesión: sube el servidor), todas para `authenticated` y ninguna para anon", async () => {
    const { rows } = await db.query<{ polname: string; polcmd: string; anon: boolean }>(
      `select polname, polcmd,
              (polroles = '{0}'::oid[]
               or exists (select 1 from pg_roles r where r.oid = any (polroles) and r.rolname = 'anon')) as anon
       from pg_policy where polrelid = 'storage.objects'::regclass and polname like 'tenant_logos_%'
       order by polname`,
    );
    expect(rows.map((r) => [r.polname, r.polcmd])).toEqual([
      ["tenant_logos_delete", "d"],
      ["tenant_logos_select", "r"],
    ]);
    expect(rows.every((r) => !r.anon)).toBe(true);
  });
});

describe("políticas de storage.objects", () => {
  it("ni el Dueño ni el Administrador suben con su sesión: solo el servidor sube (la limpieza del SVG no se salta)", () =>
    withTx(db, async () => {
      const dueno = await createUser(db);
      const admin = await createUser(db);
      const tenantId = await createTenantAs(db, dueno);
      await addMember(tenantId, admin, "admin");

      for (const [user, code] of [
        [dueno, "aaaaaaaaaaaa"],
        [admin, "bbbbbbbbbbbb"],
      ] as const) {
        await actAs(db, user, { [TENANT_HEADER]: tenantId });
        const err = await expectSqlError(
          db,
          `insert into storage.objects (bucket_id, name) values ($1, $2)`,
          [BUCKET, logoName(tenantId, code)],
        );
        expect(err.code).toBe(INSUFFICIENT_PRIVILEGE);
      }
      await actAsPostgres(db);
      expect(await visibleObjects(dueno, tenantId)).toEqual([]);
    }));

  it("nadie sube a la carpeta de otra organización, con ninguna cabecera", () =>
    withTx(db, async () => {
      const ana = await createUser(db);
      const beto = await createUser(db);
      const tenantA = await createTenantAs(db, ana);
      const tenantB = await createTenantAs(db, beto);

      for (const header of [tenantA, tenantB, undefined, "basura"]) {
        await actAs(db, ana, header ? { [TENANT_HEADER]: header } : {});
        const err = await expectSqlError(
          db,
          `insert into storage.objects (bucket_id, name) values ($1, $2)`,
          [BUCKET, logoName(tenantB)],
        );
        expect(err.code, `cabecera ${header}`).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }));

  it("sin cabecera, o con una organización a la que no pertenece, no se sube ni a la propia", () =>
    withTx(db, async () => {
      const ana = await createUser(db);
      const beto = await createUser(db);
      const tenantA = await createTenantAs(db, ana);
      const tenantB = await createTenantAs(db, beto);

      for (const header of [undefined, tenantB]) {
        await actAs(db, ana, header ? { [TENANT_HEADER]: header } : {});
        const err = await expectSqlError(
          db,
          `insert into storage.objects (bucket_id, name) values ($1, $2)`,
          [BUCKET, logoName(tenantA)],
        );
        expect(err.code).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }));

  it("Comercial, Aprobador y Observador no suben, aunque sean miembros", () =>
    withTx(db, async () => {
      const dueno = await createUser(db);
      const tenantId = await createTenantAs(db, dueno);
      for (const role of ["sales", "approver", "viewer"]) {
        await actAsPostgres(db);
        const member = await createUser(db);
        await addMember(tenantId, member, role);
        await actAs(db, member, { [TENANT_HEADER]: tenantId });
        const err = await expectSqlError(
          db,
          `insert into storage.objects (bucket_id, name) values ($1, $2)`,
          [BUCKET, logoName(tenantId)],
        );
        expect(err.code, role).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }));

  it("no acepta rutas con subcarpetas ni fuera del bucket de logos", () =>
    withTx(db, async () => {
      const dueno = await createUser(db);
      const tenantId = await createTenantAs(db, dueno);
      await actAs(db, dueno, { [TENANT_HEADER]: tenantId });
      const nested = await expectSqlError(
        db,
        `insert into storage.objects (bucket_id, name) values ($1, $2)`,
        [BUCKET, `${tenantId}/otra/logo.png`],
      );
      expect(nested.code).toBe(INSUFFICIENT_PRIVILEGE);
      const otherBucket = await expectSqlError(
        db,
        `insert into storage.objects (bucket_id, name) values ('otro-bucket', $1)`,
        [logoName(tenantId)],
      );
      expect(otherBucket.code).toBeDefined();
    }));

  it("cada persona solo ve los archivos de la organización activa, aun siendo de las dos", () =>
    withTx(db, async () => {
      const ana = await createUser(db);
      const beto = await createUser(db);
      const mixta = await createUser(db);
      const lector = await createUser(db);
      const tenantA = await createTenantAs(db, ana);
      const tenantB = await createTenantAs(db, beto);
      await addMember(tenantA, mixta, "admin");
      await addMember(tenantB, mixta, "admin");
      await addMember(tenantA, lector, "viewer");
      const a = logoName(tenantA);
      const b = logoName(tenantB, "ffffffffffff");
      await seedObject(a);
      await seedObject(b);

      expect(await visibleObjects(ana, tenantA)).toEqual([a]);
      expect(await visibleObjects(ana, tenantB)).toEqual([]);
      expect(await visibleObjects(ana)).toEqual([]);
      expect(await visibleObjects(beto, tenantB)).toEqual([b]);
      expect(await visibleObjects(mixta, tenantA)).toEqual([a]);
      expect(await visibleObjects(mixta, tenantB)).toEqual([b]);
      expect(await visibleObjects(mixta)).toEqual([]);
      // un Observador sí ve el logo de su organización (lo necesita para el selector)
      expect(await visibleObjects(lector, tenantA)).toEqual([a]);
    }));

  it("quien fue quitado de la organización deja de ver sus archivos", () =>
    withTx(db, async () => {
      const dueno = await createUser(db);
      const ex = await createUser(db);
      const tenantId = await createTenantAs(db, dueno);
      await addMember(tenantId, ex, "admin");
      await seedObject(logoName(tenantId));
      expect(await visibleObjects(ex, tenantId)).toHaveLength(1);
      await db.query(
        `update public.members set status = 'removed', removed_at = now() where tenant_id = $1 and user_id = $2`,
        [tenantId, ex.id],
      );
      expect(await visibleObjects(ex, tenantId)).toEqual([]);
    }));

  it("anon no lee ni escribe", () =>
    withTx(db, async () => {
      const dueno = await createUser(db);
      const tenantId = await createTenantAs(db, dueno);
      await seedObject(logoName(tenantId));
      await db.query("reset role");
      await db.query(`select set_config('request.headers', $1, true)`, [
        JSON.stringify({ [TENANT_HEADER]: tenantId }),
      ]);
      await db.query("set local role anon");
      const { rows } = await db.query(`select name from storage.objects where bucket_id = $1`, [
        BUCKET,
      ]);
      expect(rows).toEqual([]);
      const err = await expectSqlError(
        db,
        `insert into storage.objects (bucket_id, name) values ($1, $2)`,
        [BUCKET, logoName(tenantId, "cccccccccccc")],
      );
      expect(err.code).toBe(INSUFFICIENT_PRIVILEGE);
    }));
});

describe("columnas de marca en tenants", () => {
  it("Dueño y Administrador guardan colores y ruta del logo con save_tenant_brand; el Observador no", () =>
    withTx(db, async () => {
      const dueno = await createUser(db);
      const admin = await createUser(db);
      const lector = await createUser(db);
      const tenantId = await createTenantAs(db, dueno);
      await addMember(tenantId, admin, "admin");
      await addMember(tenantId, lector, "viewer");
      await seedObject(logoName(tenantId));
      const save = `select public.save_tenant_brand('#2b54e0', '#0f1729', 'set', $1)`;

      for (const user of [dueno, admin]) {
        await actAs(db, user, { [TENANT_HEADER]: tenantId });
        await db.query(save, [logoName(tenantId)]);
      }

      await actAs(db, lector, { [TENANT_HEADER]: tenantId });
      const denied = await expectSqlError(db, save, [logoName(tenantId)]);
      expect(denied.code).toBe(INSUFFICIENT_PRIVILEGE);

      await actAsPostgres(db);
      const { rows } = await db.query(
        `select brand_primary_color, brand_secondary_color, logo_path from public.tenants where tenant_id = $1`,
        [tenantId],
      );
      expect(rows[0]).toEqual({
        brand_primary_color: "#2b54e0",
        brand_secondary_color: "#0f1729",
        logo_path: logoName(tenantId),
      });

      // "keep" conserva la ruta; "remove" la quita
      await actAs(db, dueno, { [TENANT_HEADER]: tenantId });
      await db.query(`select public.save_tenant_brand('#112233', null, 'keep', null)`);
      await actAsPostgres(db);
      let after = await db.query(`select logo_path from public.tenants where tenant_id = $1`, [
        tenantId,
      ]);
      expect(after.rows[0].logo_path).toBe(logoName(tenantId));
      await actAs(db, dueno, { [TENANT_HEADER]: tenantId });
      await db.query(`select public.save_tenant_brand('#112233', null, 'remove', null)`);
      await actAsPostgres(db);
      after = await db.query(`select logo_path from public.tenants where tenant_id = $1`, [
        tenantId,
      ]);
      expect(after.rows[0].logo_path).toBeNull();
    }));

  it("`logo_path` no se puede cambiar con un update directo, ni por el Dueño", () =>
    withTx(db, async () => {
      const dueno = await createUser(db);
      const tenantId = await createTenantAs(db, dueno);
      await actAs(db, dueno, { [TENANT_HEADER]: tenantId });
      const err = await expectSqlError(
        db,
        `update public.tenants set logo_path = $2 where tenant_id = $1`,
        [tenantId, logoName(tenantId)],
      );
      expect(err.code).toBe(INSUFFICIENT_PRIVILEGE);
    }));

  it("save_tenant_brand rechaza un logo que no está en Storage, uno de otra organización y modos raros", () =>
    withTx(db, async () => {
      const ana = await createUser(db);
      const beto = await createUser(db);
      const tenantA = await createTenantAs(db, ana);
      const tenantB = await createTenantAs(db, beto);
      await seedObject(logoName(tenantB));
      await actAs(db, ana, { [TENANT_HEADER]: tenantA });
      for (const path of [logoName(tenantA), logoName(tenantB), null]) {
        const err = await expectSqlError(
          db,
          `select public.save_tenant_brand('#112233', null, 'set', $1)`,
          [path],
        );
        expect(err.code, String(path)).toBe("CP422");
      }
      const mode = await expectSqlError(
        db,
        `select public.save_tenant_brand('#112233', null, 'otro', null)`,
      );
      expect(mode.code).toBe("CP422");
      // anon no la ejecuta
      await db.query("reset role");
      await db.query("set local role anon");
      const anon = await expectSqlError(
        db,
        `select public.save_tenant_brand('#112233', null, 'keep', null)`,
      );
      expect(anon.code).toBe(INSUFFICIENT_PRIVILEGE);
    }));

  it("el cambio de marca queda en la auditoría", () =>
    withTx(db, async () => {
      const dueno = await createUser(db);
      const tenantId = await createTenantAs(db, dueno);
      await actAs(db, dueno, { [TENANT_HEADER]: tenantId });
      await db.query(
        `update public.tenants set brand_primary_color = '#112233' where tenant_id = $1`,
        [tenantId],
      );
      await actAsPostgres(db);
      const { rows } = await db.query(
        `select count(*)::int as n from public.audit_log
         where tenant_id = $1 and action = 'tenant.updated' and actor_user_id = $2`,
        [tenantId, dueno.id],
      );
      expect(rows[0].n).toBe(1);
    }));

  it.each(["rojo", "#FFF", "#ABCDEF", "#12345", "#1234567", "2b54e0", "#2b54e0; drop"])(
    "rechaza el color %j",
    (color) =>
      withTx(db, async () => {
        const dueno = await createUser(db);
        const tenantId = await createTenantAs(db, dueno);
        await actAs(db, dueno, { [TENANT_HEADER]: tenantId });
        const err = await expectSqlError(
          db,
          `update public.tenants set brand_primary_color = $2 where tenant_id = $1`,
          [tenantId, color],
        );
        expect(err.code).toBe(CHECK_VIOLATION);
      }),
  );

  it("rechaza una ruta de logo que no sea de la propia organización o tenga forma rara", () =>
    withTx(db, async () => {
      const dueno = await createUser(db);
      const tenantId = await createTenantAs(db, dueno);
      for (const path of [
        logoName(randomUUID()),
        `${tenantId}/../${randomUUID()}/logo-0123456789ab.png`,
        `${tenantId}/logo.png`,
        `${tenantId}/logo-0123456789ab.html`,
        `${tenantId}/sub/logo-0123456789ab.png`,
        "logo-0123456789ab.png",
      ]) {
        await seedObject(path);
        await actAs(db, dueno, { [TENANT_HEADER]: tenantId });
        const err = await expectSqlError(
          db,
          `select public.save_tenant_brand(null, null, 'set', $1)`,
          [path],
        );
        expect(["CP422", CHECK_VIOLATION], path).toContain(err.code);
      }
    }));

  it("no se puede editar una organización ajena ni columnas que no son de la persona", () =>
    withTx(db, async () => {
      const ana = await createUser(db);
      const beto = await createUser(db);
      await createTenantAs(db, ana);
      const tenantB = await createTenantAs(db, beto);
      // Ana con la cabecera de B: no es miembro, no hay organización activa, 0 filas
      await actAs(db, ana, { [TENANT_HEADER]: tenantB });
      const result = await db.query(
        `update public.tenants set brand_primary_color = '#000000' where tenant_id = $1`,
        [tenantB],
      );
      expect(result.rowCount).toBe(0);
      // y las columnas internas siguen sin permiso de escritura
      const err = await expectSqlError(
        db,
        `update public.tenants set status = 'archived' where tenant_id = $1`,
        [tenantB],
      );
      expect(err.code).toBe(INSUFFICIENT_PRIVILEGE);
    }));

  it("al editar el contacto se exige un correo con forma válida", () =>
    withTx(db, async () => {
      const dueno = await createUser(db);
      const tenantId = await createTenantAs(db, dueno);
      await actAs(db, dueno, { [TENANT_HEADER]: tenantId });
      const err = await expectSqlError(
        db,
        `update public.tenants set contact_email = 'esto no es un correo' where tenant_id = $1`,
        [tenantId],
      );
      expect(err.code).toBe(CHECK_VIOLATION);
      const ok = await db.query(
        `update public.tenants set contact_email = 'contacto@ejemplo.test', rut = '76086428-5' where tenant_id = $1`,
        [tenantId],
      );
      expect(ok.rowCount).toBe(1);
    }));
});
