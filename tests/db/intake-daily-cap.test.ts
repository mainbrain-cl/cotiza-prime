// H-092 · pendiente m11 · El tope diario (`intake_forms.daily_cap`) lo leen solo Dueño y Administrador.
// Con pases reales de cada rol: la columna ya no se lee por la API directa (ni con `select *`, ni filtrando por
// ella), el resto de la tabla sí, la función `intake_form_daily_caps` responde según la matriz, el guardado del
// tope sigue andando y el «deshacer» devuelve el estado anterior. Cada prueba corre en una transacción que se
// deshace.
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, expectSqlError, withTx } from "./helpers";
import { asUser, buildIntakeWorld, callAs, makeForm, type IntakeWorld } from "./intake-helpers";

let setup: Client;
let w: IntakeWorld;
beforeAll(async () => {
  setup = await connect();
  w = await buildIntakeWorld(setup);
});
afterAll(async () => {
  await setup.end();
});

const CAPS = "select * from public.intake_form_daily_caps($1) as r";
const CAPS_ALL = "select * from public.intake_form_daily_caps() as r";
const SAVE = "select public.save_intake_form($1, $2, $3::jsonb, null) as r";
// Algunas de las columnas legibles (la prueba de permisos por columna cubre las 18 que no son `daily_cap`).
const READABLE =
  "id, tenant_id, public_id, name, title, intro, success_message, status, revision, fields";

const MANAGERS = () => [w.owner, w.admin];
const OTHERS = () => [w.approver, w.sales, w.viewer];

describe("quién lee el tope por la función", () => {
  it("el Dueño y el Administrador leen el tope de un formulario y el de todos los de su organización", async () => {
    await withTx(setup, async () => {
      const one = await makeForm(setup, w.owner, w.tenantA, { form: { daily_cap: 7 } });
      const two = await makeForm(setup, w.owner, w.tenantA, { form: { daily_cap: 120 } });
      const other = await makeForm(setup, w.ownerB, w.tenantB, { form: { daily_cap: 3 } });
      for (const user of MANAGERS()) {
        await asUser(setup, user, w.tenantA);
        const single = await setup.query(CAPS, [one.formId]);
        expect(single.rows).toEqual([{ form_id: one.formId, daily_cap: 7 }]);
        const all = await setup.query(CAPS_ALL);
        const byId = new Map(all.rows.map((r) => [r.form_id as string, r.daily_cap as number]));
        expect(byId.get(one.formId)).toBe(7);
        expect(byId.get(two.formId)).toBe(120);
        // Nunca un formulario de otra organización.
        expect(byId.has(other.formId)).toBe(false);
      }
      await actAsPostgres(setup);
    });
  });

  it("Aprobador, Comercial y Observador reciben «prohibido» (42501), con o sin formulario", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      for (const user of OTHERS()) {
        await asUser(setup, user, w.tenantA);
        expect((await expectSqlError(setup, CAPS, [form.formId])).code).toBe("42501");
        expect((await expectSqlError(setup, CAPS_ALL)).code).toBe("42501");
      }
      await actAsPostgres(setup);
    });
  });

  it("alguien de otra organización: con la cabecera de A o sin ninguna es 42501; con la suya, el formulario de A «no existe» (CP404)", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA, { form: { daily_cap: 9 } });
      await asUser(setup, w.ownerB, w.tenantA);
      expect((await expectSqlError(setup, CAPS, [form.formId])).code).toBe("42501");
      expect((await expectSqlError(setup, CAPS_ALL)).code).toBe("42501");
      await asUser(setup, w.ownerB, w.tenantB);
      expect((await expectSqlError(setup, CAPS, [form.formId])).code).toBe("CP404");
      expect((await expectSqlError(setup, CAPS, [randomUUID()])).code).toBe("CP404");
      // Sin formulario: solo lo suyo (aquí, nada de A).
      const all = await setup.query(CAPS_ALL);
      expect(all.rows.map((r) => r.form_id)).not.toContain(form.formId);
      await actAsPostgres(setup);
    });
  });
});

describe("la columna ya no se lee por la API directa", () => {
  it("nadie con pase lee `daily_cap` de la tabla: ni el Dueño, ni con `select *`, ni filtrando por él", async () => {
    await withTx(setup, async () => {
      await makeForm(setup, w.owner, w.tenantA, { form: { daily_cap: 33 } });
      for (const user of [...MANAGERS(), ...OTHERS()]) {
        await asUser(setup, user, w.tenantA);
        for (const sql of [
          "select daily_cap from public.intake_forms",
          "select * from public.intake_forms",
          "select id from public.intake_forms where daily_cap = 33",
          "select id from public.intake_forms order by daily_cap",
        ]) {
          expect((await expectSqlError(setup, sql)).code, `${user.email}: ${sql}`).toBe("42501");
        }
      }
      await actAsPostgres(setup);
    });
  });

  it("todas las demás columnas siguen legibles para todos los roles, solo las de su organización", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA);
      const otherTenant = await makeForm(setup, w.ownerB, w.tenantB);
      for (const user of [...MANAGERS(), ...OTHERS()]) {
        await asUser(setup, user, w.tenantA);
        const { rows } = await setup.query(`select ${READABLE} from public.intake_forms`);
        const ids = rows.map((r) => r.id);
        expect(ids, user.email).toContain(form.formId);
        expect(ids, user.email).not.toContain(otherTenant.formId);
      }
      await actAsPostgres(setup);
    });
  });

  it("el permiso de lectura queda por columnas: todas menos `daily_cap`, y ninguna otra tabla cambió", async () => {
    const { rows } = await setup.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'intake_forms'
          and grantee = 'authenticated' and privilege_type = 'SELECT'`,
    );
    const granted = new Set(rows.map((r) => r.column_name));
    expect(granted.has("daily_cap")).toBe(false);
    const all = await setup.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'intake_forms'`,
    );
    // Si se agrega una columna a la tabla, o se suma aquí a la lista de lectura o se decide que es privada.
    expect(all.rows.map((r) => r.column_name).filter((c) => !granted.has(c))).toEqual([
      "daily_cap",
    ]);
    const anon = await setup.query(
      `select 1 from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'intake_forms' and grantee in ('anon', 'PUBLIC')`,
    );
    expect(anon.rowCount).toBe(0);
  });
});

describe("guardar el tope sigue funcionando para quien corresponde", () => {
  it("el Dueño y el Administrador cambian el tope y la función muestra el valor nuevo", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA, { form: { daily_cap: 10 } });
      let revision = form.revision;
      for (const [user, cap] of [
        [w.owner, 25],
        [w.admin, 26],
      ] as const) {
        const saved = await callAs<{ revision: number }>(setup, user, w.tenantA, SAVE, [
          form.formId,
          revision,
          JSON.stringify({ daily_cap: cap }),
        ]);
        revision = saved.revision;
        await asUser(setup, user, w.tenantA);
        expect((await setup.query(CAPS, [form.formId])).rows[0].daily_cap).toBe(cap);
      }
      await actAsPostgres(setup);
    });
  });

  it("los demás roles no pueden guardar el tope (42501)", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA, { form: { daily_cap: 10 } });
      for (const user of OTHERS()) {
        await asUser(setup, user, w.tenantA);
        const error = await expectSqlError(setup, SAVE, [
          form.formId,
          form.revision,
          JSON.stringify({ daily_cap: 99 }),
        ]);
        expect(error.code, user.email).toBe("42501");
      }
      await actAsPostgres(setup);
      const { rows } = await setup.query(
        "select daily_cap from public.intake_forms where id = $1",
        [form.formId],
      );
      expect(rows[0].daily_cap).toBe(10);
    });
  });
});

describe("el deshacer de intake_daily_cap_column", () => {
  const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
  const NAME = "20261102100000_intake_daily_cap_column";
  const sql = (kind: "migrations" | "rollbacks", suffix: string) =>
    readFileSync(path.join(ROOT, kind, `${NAME}${suffix}.sql`), "utf8");

  it("borra la función y devuelve la lectura de todas las columnas; volver a aplicar la migración la limita de nuevo", async () => {
    await withTx(setup, async () => {
      const form = await makeForm(setup, w.owner, w.tenantA, { form: { daily_cap: 44 } });
      await actAsPostgres(setup);
      await setup.query(sql("rollbacks", ".down"));
      const gone = await setup.query(
        "select to_regprocedure('public.intake_form_daily_caps(uuid)') is not null as found",
      );
      expect(gone.rows[0].found).toBe(false);
      // Como estaba antes: cualquier miembro lee el tope por la tabla.
      await asUser(setup, w.sales, w.tenantA);
      const before = await setup.query("select daily_cap from public.intake_forms where id = $1", [
        form.formId,
      ]);
      expect(before.rows[0].daily_cap).toBe(44);
      expect((await setup.query("select * from public.intake_forms")).rowCount).toBeGreaterThan(0);

      await actAsPostgres(setup);
      await setup.query(sql("migrations", ""));
      await asUser(setup, w.sales, w.tenantA);
      expect((await expectSqlError(setup, "select daily_cap from public.intake_forms")).code).toBe(
        "42501",
      );
      await asUser(setup, w.owner, w.tenantA);
      expect((await setup.query(CAPS, [form.formId])).rows[0].daily_cap).toBe(44);
      await actAsPostgres(setup);
    });
  });
});
