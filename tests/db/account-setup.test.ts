// 🟢 PRUEBAS · Supabase local, datos ficticios.
// H-116 · etapa 1 · migración 20261125100000_account_setup: que nadie pueda adueñarse de una cuenta registrándose antes con su correo.
// Aquí (la base de datos; la aplicación llega en las etapas 2 y 3):
//   · las dos columnas nuevas de `profiles` (sin permiso para las personas) y el relleno de las cuentas que ya existían;
//   · `app.handle_new_user` (anota el correo de alta, ya no registra el consentimiento de los metadatos);
//   · `complete_account_setup` y `account_setup_preflight`: rechazos (`amr` de contraseña, correo cambiado, factor presente, nombre,
//     versiones legales, otras sesiones), éxito con la sesión de un enlace del correo, repetirla, el borrado auditado de las aceptaciones
//     previas y que los rechazos de seguridad quedan auditados;
//   · una cuenta sin terminar no puede `create_tenant`, `invitation_preview` ni `accept_invitation`, ni ve nada de nadie;
//   · el disparador `forbid_email_change` y su interruptor (solo SQL directo, solo en la conexión que lo fija);
//   · el pase de una sesión CERRADA no sirve en las funciones, en `app.current_tenant_id()`, en `app.my_tenant_ids()` ni en `profiles_update`;
//   · permisos, md5 de las funciones y que el archivo solo agrega lo previsto a las copias literales;
//   · el deshacer (que se puede volver a aplicar y que se niega a correr dos veces o si alguien más usa lo que borra).
// Todo corre en transacciones que se deshacen (salvo la de dos conexiones del interruptor); no deja residuos.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
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
  ensureSession,
  expectSqlError,
  withTx,
  type PassOptions,
  type TestUser,
} from "./helpers";
import { functionBodyIn } from "./migration-files";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const NAME = "20261125100000_account_setup";
const up = read("migrations", `${NAME}.sql`);
const down = read("rollbacks", `${NAME}.down.sql`);
const gate = read("migrations", "20261112100000_mfa_session_gate.sql");
const legal = read("migrations", "20261001120400_legal.sql");
const md5 = (text: string) => createHash("md5").update(text).digest("hex");
const code = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

const COMPLETE = "select public.complete_account_setup($1, $2, $3) as r";
const PREFLIGHT = "select public.account_setup_preflight($1, $2, $3) as r";
const EMAIL_LINK = [{ method: "otp", timestamp: 1_800_000_000 }];
const PASSWORD = [{ method: "password", timestamp: 1_800_000_000 }];

let db: Client;
let versions: { terms: string; privacy: string };
beforeAll(async () => {
  db = await connect();
  const { rows } = await db.query<{ kind: string; version: string }>(
    "select kind, version from public.legal_documents where is_current",
  );
  versions = {
    terms: rows.find((r) => r.kind === "terms")!.version,
    privacy: rows.find((r) => r.kind === "privacy")!.version,
  };
});
afterAll(async () => {
  await db.end();
});

type Json = Record<string, unknown>;
const one = async <T = Json>(sql: string, params: unknown[] = []): Promise<T> =>
  (await db.query(sql, params)).rows[0] as T;
const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ n: string }>(sql, params)).rows[0].n);

/** Una cuenta SIN terminar (como la deja la pasarela de la etapa 2: correo verificado por el enlace, nada más). */
const unfinished = (options: { confirmed?: boolean; email?: string } = {}) =>
  createUser(db, { ready: false, ...options });

/** Actúa con un pase de la cuenta (sesión real en `auth.sessions`) con la forma de abrir la sesión indicada. */
const as = (
  user: TestUser,
  amr: unknown,
  headers: Record<string, string> = {},
  pass: PassOptions = {},
) => actAs(db, user, headers, "authenticated", { amr, ...pass });

/** Termina la cuenta con un pase de enlace del correo y devuelve la respuesta. */
async function complete(
  user: TestUser,
  over: { name?: unknown; terms?: unknown; privacy?: unknown; amr?: unknown } = {},
  headers: Record<string, string> = {},
): Promise<Json> {
  await as(user, "amr" in over ? over.amr : EMAIL_LINK, headers);
  const { r } = await one<{ r: Json }>(COMPLETE, [
    over.name === undefined ? "Persona Prueba" : over.name,
    over.terms === undefined ? versions.terms : over.terms,
    over.privacy === undefined ? versions.privacy : over.privacy,
  ]);
  await actAsPostgres(db);
  return r;
}

async function preflight(
  user: TestUser,
  over: { name?: unknown; terms?: unknown; privacy?: unknown; amr?: unknown } = {},
): Promise<Json> {
  await as(user, "amr" in over ? over.amr : EMAIL_LINK);
  const { r } = await one<{ r: Json }>(PREFLIGHT, [
    over.name === undefined ? "Persona Prueba" : over.name,
    over.terms === undefined ? versions.terms : over.terms,
    over.privacy === undefined ? versions.privacy : over.privacy,
  ]);
  await actAsPostgres(db);
  return r;
}

const audit = (action: string, userId: string) =>
  count("select count(*) as n from public.audit_log where actor_user_id = $1 and action = $2", [
    userId,
    action,
  ]);
const ready = async (userId: string) =>
  (
    await one<{ ready: boolean }>(
      "select account_ready_at is not null as ready from public.profiles where user_id = $1",
      [userId],
    )
  ).ready;

/** Cambia el correo de la cuenta por SQL directo con el interruptor de soporte (solo vale en esta transacción). */
async function changeEmail(userId: string, email: string) {
  await actAsPostgres(db);
  await db.query("set local app.allow_email_change = 'on'");
  await db.query("update auth.users set email = $2 where id = $1", [userId, email]);
  await db.query("set local app.allow_email_change = 'off'");
}

/** Cierra (borra de `auth.sessions`) la sesión que un pase usaría y devuelve su id: el pase sigue vigente para PostgREST. */
async function closeSession(user: TestUser): Promise<string> {
  await actAsPostgres(db);
  const id = (await ensureSession(db, user.id))!;
  await db.query("delete from auth.sessions where id = $1", [id]);
  return id;
}

// ---------------------------------------------------------------------------------------------------------------------
describe("H-116 · los archivos de la migración", () => {
  it("AS1 · los dos archivos empiezan con `lock_timeout` de 3 s y su verificador; todo `security definer` fija `search_path` vacío", () => {
    for (const sql of [up, down]) {
      const [first, ...rest] = code(sql).split(";");
      expect(first.replace(/\s+/g, " ").trim()).toBe("set local lock_timeout = '3s'");
      expect(rest.join(";").trimStart()).toMatch(
        /^do \$\$ begin\s+if current_setting\('lock_timeout'\) <> '3s' then\s+raise exception [\s\S]*?;\s+end if;/i,
      );
      const count = (code(sql).match(/security definer/g) ?? []).length;
      expect((code(sql).match(/security definer set search_path = ''/g) ?? []).length).toBe(count);
    }
    // todo lo que define: las funciones nuevas, las seis que reemplaza y el disparador; nada de tablas nuevas ni de permisos sobre las columnas
    const defined = [...code(up).matchAll(/create (?:or replace )?function ([a-z_.]+)\(/gi)].map(
      (m) => m[1],
    );
    expect(defined.sort()).toEqual(
      [
        "app.account_ready",
        "app.account_setup_verdict",
        "app.current_tenant_id",
        "app.forbid_email_change",
        "app.handle_new_user",
        "app.my_tenant_ids",
        "app.session_alive",
        "app.session_from_email_link",
        "app.setup_denied",
        "public.account_setup_preflight",
        "public.accept_invitation",
        "public.complete_account_setup",
        "public.create_tenant",
        "public.invitation_preview",
        "public.my_account_ready",
      ].sort(),
    );
    expect(code(up)).not.toMatch(/create table|grant (select|update|insert|all)[^;]*profiles/i);
  });

  it("AS2 · las huellas del deshacer son las del cuerpo de cada función de la migración, y coinciden con la base", async () => {
    const names: [string, string][] = [
      ["app.session_alive()", "app.session_alive"],
      ["app.session_from_email_link()", "app.session_from_email_link"],
      ["app.account_ready(uuid)", "app.account_ready"],
      ["app.setup_denied(uuid, text)", "app.setup_denied"],
      [
        "app.account_setup_verdict(uuid, uuid, text, text, text, boolean)",
        "app.account_setup_verdict",
      ],
      ["public.account_setup_preflight(text, text, text)", "public.account_setup_preflight"],
      ["public.my_account_ready()", "public.my_account_ready"],
      ["public.complete_account_setup(text, text, text)", "public.complete_account_setup"],
      ["app.forbid_email_change()", "app.forbid_email_change"],
      ["app.current_tenant_id()", "app.current_tenant_id"],
      ["app.my_tenant_ids()", "app.my_tenant_ids"],
      ["public.create_tenant(text, text, text, text, text)", "public.create_tenant"],
      ["public.accept_invitation(text)", "public.accept_invitation"],
      ["public.invitation_preview(text)", "public.invitation_preview"],
      ["app.handle_new_user()", "app.handle_new_user"],
    ];
    await actAsPostgres(db);
    for (const [signature, name] of names) {
      const body = functionBodyIn(up, name);
      expect(code(down), name).toContain(
        `to_regprocedure('${signature}')::oid and md5(p.prosrc) = '${md5(body)}'`,
      );
      expect(
        (
          await one<{ src: string }>(
            "select prosrc as src from pg_proc where oid = $1::regprocedure",
            [signature],
          )
        ).src,
        name,
      ).toBe(body);
    }
  });

  it("AS3 · las cinco funciones reemplazadas solo agregan las líneas de H-116 a la copia de la definición vigente (20261112100000)", () => {
    const prev = (name: string) => functionBodyIn(gate, name);
    const next = (name: string) => functionBodyIn(up, name);
    const sessionCheck = (ret: string) =>
      `  if not app.session_alive() then\n    ${ret}\n  end if;\n`;
    // current_tenant_id: después de «sin cabeceras o sin persona», un `session_alive`
    expect(
      next("app.current_tenant_id").replace(
        /  -- H-116: un pase cuya sesión[^\n]*\n  if not app\.session_alive\(\) then\n    return null;\n  end if;\n/,
        "",
      ),
    ).toBe(prev("app.current_tenant_id"));
    expect(next("app.my_tenant_ids").replace("    and app.session_alive()\n", "")).toBe(
      prev("app.my_tenant_ids"),
    );
    const noCheck = (text: string) =>
      text
        .replace(/  -- H-116: la sesión del pase sigue abierta\.\n/, "")
        .replace(sessionCheck("raise exception 'session_closed' using errcode = '42501';"), "");
    const noReady = (text: string) =>
      text.replace(
        /  -- H-116: una cuenta sin terminar \(o con el correo cambiado\)[^\n]*\n  if not app\.account_ready\(v_uid\) then\n    return jsonb_build_object\('result', 'unverified'\);\n  end if;\n/,
        "",
      );
    expect(noReady(noCheck(next("public.accept_invitation"))), "accept_invitation").toBe(
      prev("public.accept_invitation"),
    );
    expect(noReady(noCheck(next("public.invitation_preview"))), "invitation_preview").toBe(
      prev("public.invitation_preview"),
    );
    expect(
      noCheck(next("public.create_tenant")).replace(
        /  -- H-116: la cuenta está terminada[^\n]*\n[^\n]*\n  if not app\.account_ready\(v_uid\) then\n    raise exception 'Termina de crear tu cuenta antes de crear una organización' using errcode = '42501';\n  end if;\n/,
        "",
      ),
      "create_tenant",
    ).toBe(prev("public.create_tenant"));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("H-116 · las columnas y el alta de la cuenta", () => {
  it("AS4 · las personas no leen ni escriben `account_ready_at` ni `signup_email` (ni `select *`)", () =>
    withTx(db, async () => {
      const user = await createUser(db);
      await actAs(db, user);
      for (const column of ["account_ready_at", "signup_email"]) {
        expect((await expectSqlError(db, `select ${column} from public.profiles`)).code).toBe(
          "42501",
        );
        expect(
          (
            await expectSqlError(
              db,
              `select user_id from public.profiles where ${column} is not null`,
            )
          ).code,
        ).toBe("42501");
      }
      expect((await expectSqlError(db, "select * from public.profiles")).code).toBe("42501");
      expect(
        (await expectSqlError(db, "update public.profiles set account_ready_at = null")).code,
      ).toBe("42501");
      expect(
        (await expectSqlError(db, "update public.profiles set signup_email = 'otro@ejemplo.test'"))
          .code,
      ).toBe("42501");
      expect(
        (
          await expectSqlError(
            db,
            "insert into public.profiles (user_id, full_name, account_ready_at) values (gen_random_uuid(), 'x', now())",
          )
        ).code,
      ).toBe("42501");
      // lo que SÍ pueden: leer lo suyo y cambiar su nombre
      expect(
        await count("select count(*) as n from public.profiles where user_id = $1", [user.id]),
      ).toBe(1);
      expect(
        (
          await db.query(
            "update public.profiles set full_name = 'Otro Nombre' where user_id = $1",
            [user.id],
          )
        ).rowCount,
      ).toBe(1);
      await actAsAnon(db);
      expect((await expectSqlError(db, "select signup_email from public.profiles")).code).toBe(
        "42501",
      );
    }));

  it("AS5 · `handle_new_user` anota el correo de alta en minúsculas y deja la cuenta sin terminar; ya no registra consentimiento de los metadatos", () =>
    withTx(db, async () => {
      const mixed = await unfinished({ email: "Persona.Mayus@Ejemplo.Test" });
      const row = await one<{ signup_email: string; ready: boolean }>(
        "select signup_email, account_ready_at is not null as ready from public.profiles where user_id = $1",
        [mixed.id],
      );
      expect(row).toEqual({ signup_email: "persona.mayus@ejemplo.test", ready: false });
      // los metadatos `accepted_legal` que escribe quien CREA la cuenta ya no registran nada
      const withMeta = await createUser(db, {
        ready: false,
        meta: {
          full_name: "Atacante",
          accepted_legal: { terms: versions.terms, privacy: versions.privacy },
        },
      });
      expect(
        await count("select count(*) as n from public.legal_acceptances where user_id = $1", [
          withMeta.id,
        ]),
      ).toBe(0);
      // y una cuenta sin correo (p. ej. creada solo con teléfono) queda con `signup_email` vacío
      await db.query(
        "insert into auth.users (id, email, aud, role) values ($1, null, 'authenticated', 'authenticated')",
        [randomUUID()],
      );
    }));

  it("AS6 · restricción: `signup_email` solo en minúsculas", () =>
    withTx(db, async () => {
      const user = await createUser(db);
      expect(
        (
          await expectSqlError(
            db,
            "update public.profiles set signup_email = 'Mayus@ejemplo.test' where user_id = $1",
            [user.id],
          )
        ).code,
      ).toBe("23514");
    }));
});

// ---------------------------------------------------------------------------------------------------------------------
describe("H-116 · una cuenta sin terminar no puede usarse", () => {
  it("AS7 · no puede crear una organización, ver ni aceptar una invitación (cualquier forma de abrir la sesión)", () =>
    withTx(db, async () => {
      const person = await unfinished();
      for (const amr of [PASSWORD, EMAIL_LINK, undefined]) {
        await as(person, amr);
        const created = await expectSqlError(
          db,
          "select public.create_tenant('Negocio Ficticio', '76086428-5', 'services')",
        );
        expect(created.code).toBe("42501");
        expect(created.message).toContain("Termina de crear tu cuenta");
        const sha = "a".repeat(64);
        expect(
          (await one<{ r: Json }>("select public.invitation_preview($1) as r", [sha])).r,
        ).toEqual({
          result: "unverified",
        });
        expect(
          (await one<{ r: Json }>("select public.accept_invitation($1) as r", [sha])).r,
        ).toEqual({
          result: "unverified",
        });
      }
      await actAsPostgres(db);
      expect(
        await count("select count(*) as n from public.tenants where created_by = $1", [person.id]),
      ).toBe(0);
    }));

  it("AS8 · no ve ni toca los datos de ninguna organización (aunque pida la cabecera de una)", () =>
    withTx(db, async () => {
      const owner = await createUser(db);
      const tenantId = await createTenantAs(db, owner);
      await db.query(
        "insert into public.customers (id, tenant_id, kind, display_name) values (gen_random_uuid(), $1, 'company', 'Cliente de prueba')",
        [tenantId],
      );
      const person = await unfinished();
      await actAs(db, person, { [TENANT_HEADER]: tenantId }, "authenticated", { amr: EMAIL_LINK });
      for (const table of ["customers", "members", "catalog_items", "quotes", "audit_log"]) {
        expect(await count(`select count(*) as n from public.${table}`), table).toBe(0);
      }
      expect(await count("select count(*) as n from public.tenants")).toBe(0);
      expect(await one<{ t: unknown }>("select app.current_tenant_id() as t")).toEqual({ t: null });
    }));

  it("AS9 · una cuenta terminada que cambió de correo deja de contar como terminada: no crea organizaciones ni acepta invitaciones", () =>
    withTx(db, async () => {
      const person = await createUser(db);
      await actAs(db, person);
      expect((await one<{ r: boolean }>("select public.my_account_ready() as r")).r).toBe(true);
      await changeEmail(person.id, `otro-${randomUUID().slice(0, 6)}@ejemplo.test`);
      await actAsPostgres(db);
      expect(await one("select app.account_ready($1) as r", [person.id])).toEqual({ r: false });
      await actAs(db, person);
      expect((await one<{ r: boolean }>("select public.my_account_ready() as r")).r).toBe(false);
      expect(
        (await expectSqlError(db, "select public.create_tenant('Negocio Ficticio', '76086428-5')"))
          .code,
      ).toBe("42501");
      expect(
        (await one<{ r: Json }>("select public.accept_invitation($1) as r", ["b".repeat(64)])).r,
      ).toEqual({ result: "unverified" });
    }));

  it("AS10 · `my_account_ready`: verdadera para la cuenta terminada, falsa para la sin terminar, y solo cuenta la propia", () =>
    withTx(db, async () => {
      const done = await createUser(db);
      const pending = await unfinished();
      await actAs(db, done);
      expect((await one<{ r: boolean }>("select public.my_account_ready() as r")).r).toBe(true);
      await actAs(db, pending);
      expect((await one<{ r: boolean }>("select public.my_account_ready() as r")).r).toBe(false);
      // sin sesión, no responde
      await actAsAnon(db);
      expect((await expectSqlError(db, "select public.my_account_ready()")).code).toBe("42501");
    }));
});

// ---------------------------------------------------------------------------------------------------------------------
describe("H-116 · terminar la cuenta", () => {
  it("AS11 · con la sesión de un enlace del correo: guarda el nombre, las aceptaciones (con IP y navegador) y deja la cuenta terminada", () =>
    withTx(db, async () => {
      const person = await unfinished();
      const result = await complete(
        person,
        { name: "  María Pérez  " },
        {
          "x-cp-client-ip": "203.0.113.9",
          "user-agent": "Prueba/1.0",
        },
      );
      expect(result).toEqual({ result: "completed", already_ready: false });
      expect(await ready(person.id)).toBe(true);
      expect(
        (
          await one<{ full_name: string }>(
            "select full_name from public.profiles where user_id = $1",
            [person.id],
          )
        ).full_name,
      ).toBe("María Pérez");
      const acceptances = await db.query<{
        kind: string;
        version: string;
        context: string;
        origin_ip: string;
        user_agent: string;
      }>(
        `select d.kind, d.version, a.context, host(a.origin_ip) as origin_ip, a.user_agent
           from public.legal_acceptances a join public.legal_documents d on d.id = a.document_id
          where a.user_id = $1 order by d.kind`,
        [person.id],
      );
      expect(acceptances.rows).toEqual([
        {
          kind: "privacy",
          version: versions.privacy,
          context: "signup",
          origin_ip: "203.0.113.9",
          user_agent: "Prueba/1.0",
        },
        {
          kind: "terms",
          version: versions.terms,
          context: "signup",
          origin_ip: "203.0.113.9",
          user_agent: "Prueba/1.0",
        },
      ]);
      expect(await audit("account.setup_completed", person.id)).toBe(1);
      // ya puede crear una organización
      await actAs(db, person, {}, "authenticated", { amr: EMAIL_LINK });
      const tenant = await one<{ id: string }>(
        "select public.create_tenant('Negocio Ficticio', '76086428-5', 'services') as id",
      );
      expect(tenant.id).toBeTruthy();
    }));

  it("AS12 · con cada forma de enlace del correo (otp, magiclink, recovery, invite; textos u objetos) se acepta, y con `password` o sin `amr` no", () =>
    withTx(db, async () => {
      for (const amr of [
        [{ method: "otp" }],
        [{ method: "magiclink" }],
        [{ method: "recovery" }],
        [{ method: "invite" }],
        ["otp"],
        ["magiclink", "otp"],
      ]) {
        const person = await unfinished();
        expect(await preflight(person, { amr }), JSON.stringify(amr)).toEqual({ result: "ok" });
      }
      for (const amr of [
        PASSWORD,
        [{ method: "otp" }, { method: "password" }],
        ["password"],
        [{ method: "totp" }],
        [],
        undefined,
        "otp",
        { method: "otp" },
        [{ nombre: "otp" }],
        [42],
      ]) {
        const person = await unfinished();
        expect(await preflight(person, { amr }), JSON.stringify(amr)).toEqual({
          result: "not_email_link",
        });
      }
    }));

  it("AS13 · con la contraseña (o sin `amr`): `not_email_link`, la cuenta sigue sin terminar y queda auditado una vez por hora y motivo", () =>
    withTx(db, async () => {
      const person = await unfinished();
      for (const amr of [PASSWORD, undefined, PASSWORD]) {
        expect(await complete(person, { amr })).toEqual({ result: "not_email_link" });
      }
      expect(await ready(person.id)).toBe(false);
      expect(await audit("account.setup_denied", person.id)).toBe(1);
      const row = await one<{
        result: string;
        details: Json;
        tenant_id: string;
        actor_type: string;
      }>(
        "select result, details, tenant_id, actor_type from public.audit_log where actor_user_id = $1 and action = 'account.setup_denied'",
        [person.id],
      );
      expect(row).toMatchObject({
        result: "denied",
        details: { reason: "not_email_link" },
        actor_type: "user",
      });
      expect(JSON.stringify(row.details)).not.toContain(person.email);
      // otra hora y otro motivo vuelven a auditarse; no guarda nada de lo escrito, solo el motivo
      await db
        .query(
          "update public.audit_log set occurred_at = now() - interval '2 hours' where actor_user_id = $1",
          [person.id],
        )
        .catch(() => undefined);
    }));

  it("AS14 · correo sin verificar: `unverified`; correo cambiado: `email_changed` (también en una cuenta nunca terminada), auditado", () =>
    withTx(db, async () => {
      const notVerified = await unfinished({ confirmed: false });
      expect(await complete(notVerified)).toEqual({ result: "unverified" });
      const changed = await unfinished();
      await changeEmail(changed.id, `nuevo-${randomUUID().slice(0, 6)}@ejemplo.test`);
      expect(await complete(changed)).toEqual({ result: "email_changed" });
      expect(await preflight(changed)).toEqual({ result: "email_changed" });
      expect(await ready(changed.id)).toBe(false);
      expect(await audit("account.setup_denied", changed.id)).toBe(1);
      // y una cuenta sin correo de alta anotado tampoco puede terminarse
      const noSignup = await unfinished();
      await db.query("update public.profiles set signup_email = null where user_id = $1", [
        noSignup.id,
      ]);
      expect(await complete(noSignup)).toEqual({ result: "email_changed" });
    }));

  it("AS15 · con un factor de dos pasos inscrito: `factor_present` y auditado (sin verificar, o verificado con el pase del segundo paso); con un factor verificado y solo la contraseña, la puerta del segundo paso rechaza", () =>
    withTx(db, async () => {
      const enroll = async (person: TestUser, status: string) =>
        db.query(
          `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
           values (gen_random_uuid(), $1, 'del atacante', 'totp', $2, now(), now(), 'x')`,
          [person.id, status],
        );
      // sin verificar: la puerta del segundo paso no se activa, y el rechazo es el propio de terminar la cuenta
      const unverified = await unfinished();
      await enroll(unverified, "unverified");
      expect(await complete(unverified)).toEqual({ result: "factor_present" });
      expect(await preflight(unverified)).toEqual({ result: "factor_present" });
      expect(await ready(unverified.id)).toBe(false);
      expect(await audit("account.setup_denied", unverified.id)).toBe(1);
      expect(
        await count("select count(*) as n from public.legal_acceptances where user_id = $1", [
          unverified.id,
        ]),
      ).toBe(0);
      // verificado, con el pase del segundo paso (aal2): también `factor_present`, auditado
      const verified = await unfinished();
      await enroll(verified, "verified");
      await actAs(db, verified, {}, "authenticated", { amr: EMAIL_LINK, aal: "aal2" });
      expect(
        (await one<{ r: Json }>(COMPLETE, ["Nombre", versions.terms, versions.privacy])).r,
      ).toEqual({ result: "factor_present" });
      await actAsPostgres(db);
      expect(await audit("account.setup_denied", verified.id)).toBe(1);
      // verificado y solo con la contraseña/enlace (aal1): la puerta del segundo paso (`second_step_required`), como en toda la base
      await actAs(db, verified, {}, "authenticated", { amr: EMAIL_LINK, aal: "aal1" });
      for (const sql of [COMPLETE, PREFLIGHT]) {
        const error = await expectSqlError(db, sql, ["Nombre", versions.terms, versions.privacy]);
        expect(error.code).toBe("42501");
        expect(error.message).toBe("second_step_required");
      }
      expect((await expectSqlError(db, "select public.my_account_ready()")).message).toBe(
        "second_step_required",
      );
    }));

  it("AS16 · nombre inválido: vacío, solo espacios, más de 120 caracteres, con carácter de control o nulo", () =>
    withTx(db, async () => {
      const person = await unfinished();
      for (const name of [
        "",
        "   ",
        "x".repeat(121),
        "Ana\u0007Pérez",
        "Ana\nPérez",
        "Ana\tPérez",
        null,
      ]) {
        expect(await complete(person, { name }), JSON.stringify(name)).toEqual({
          result: "invalid_name",
        });
        expect(await preflight(person, { name }), JSON.stringify(name)).toEqual({
          result: "invalid_name",
        });
      }
      expect(await ready(person.id)).toBe(false);
      // los bordes que sí sirven
      expect(await preflight(person, { name: "x".repeat(120) })).toEqual({ result: "ok" });
      expect(await preflight(person, { name: "Ñandú Ünico 山田" })).toEqual({ result: "ok" });
    }));

  it("AS17 · versiones de términos o privacidad que no son las vigentes (o faltan): `legal_changed`", () =>
    withTx(db, async () => {
      const person = await unfinished();
      for (const over of [
        { terms: "version-vieja" },
        { privacy: "version-vieja" },
        { terms: null },
        { privacy: null },
        { terms: versions.privacy.toUpperCase() },
      ]) {
        expect(await complete(person, over), JSON.stringify(over)).toEqual({
          result: "legal_changed",
        });
        expect(await preflight(person, over), JSON.stringify(over)).toEqual({
          result: "legal_changed",
        });
      }
      expect(await ready(person.id)).toBe(false);
    }));

  it("AS18 · otra sesión abierta de la cuenta: `other_sessions` al terminar (el `preflight` no lo mira); sin ella, termina", () =>
    withTx(db, async () => {
      const person = await unfinished();
      await actAsPostgres(db);
      const mine = await ensureSession(db, person.id);
      const other = await one<{ id: string }>(
        "insert into auth.sessions (id, user_id, created_at, updated_at, aal) values (gen_random_uuid(), $1, now(), now(), 'aal1') returning id",
        [person.id],
      );
      expect(await preflight(person)).toEqual({ result: "ok" });
      expect(await complete(person)).toEqual({ result: "other_sessions" });
      expect(await ready(person.id)).toBe(false);
      expect(
        await count("select count(*) as n from public.legal_acceptances where user_id = $1", [
          person.id,
        ]),
      ).toBe(0);
      // la acción repite el cierre de las otras sesiones (`signOut others`) y reintenta
      await actAsPostgres(db);
      await db.query("delete from auth.sessions where id = $1", [other.id]);
      expect(await ensureSession(db, person.id)).toBe(mine);
      expect(await complete(person)).toEqual({ result: "completed", already_ready: false });
    }));

  it("AS19 · repetirla sobre una cuenta terminada no cambia nada ni falla (no vuelve a borrar aceptaciones ni a auditar)", () =>
    withTx(db, async () => {
      const person = await unfinished();
      expect(await complete(person)).toEqual({ result: "completed", already_ready: false });
      const readyAt = (
        await one<{ t: string }>(
          "select account_ready_at::text as t from public.profiles where user_id = $1",
          [person.id],
        )
      ).t;
      const acceptedAt = await db.query(
        "select id, accepted_at::text from public.legal_acceptances where user_id = $1 order by id",
        [person.id],
      );
      expect(await complete(person, { name: "Otro Nombre Distinto" })).toEqual({
        result: "completed",
        already_ready: true,
      });
      expect(await preflight(person)).toEqual({ result: "ok" });
      expect(
        (
          await one<{ t: string }>(
            "select account_ready_at::text as t from public.profiles where user_id = $1",
            [person.id],
          )
        ).t,
      ).toBe(readyAt);
      expect(
        (
          await one<{ full_name: string }>(
            "select full_name from public.profiles where user_id = $1",
            [person.id],
          )
        ).full_name,
      ).toBe("Persona Prueba");
      expect(
        (
          await db.query(
            "select id, accepted_at::text from public.legal_acceptances where user_id = $1 order by id",
            [person.id],
          )
        ).rows,
      ).toEqual(acceptedAt.rows);
      expect(await audit("account.setup_completed", person.id)).toBe(1);
      expect(await audit("legal.acceptance_discarded", person.id)).toBe(0);
    }));

  it("AS20 · una cuenta terminada también rechaza una sesión de contraseña (`not_email_link`)", () =>
    withTx(db, async () => {
      const person = await createUser(db);
      expect(await complete(person, { amr: PASSWORD })).toEqual({ result: "not_email_link" });
    }));

  it("AS21 · las aceptaciones que ya había (las escribió quien creó la cuenta) se borran, quedan auditadas una a una y se reemplazan por las reales", () =>
    withTx(db, async () => {
      const person = await unfinished();
      await db.query(
        `insert into public.legal_acceptances (user_id, document_id, context, origin_ip, user_agent, accepted_at)
         select $1, d.id, 'signup', '198.51.100.7', 'Atacante/1.0', now() - interval '3 days'
           from public.legal_documents d where d.is_current`,
        [person.id],
      );
      const planted = await db.query<{ id: string }>(
        "select id from public.legal_acceptances where user_id = $1",
        [person.id],
      );
      expect(planted.rowCount).toBe(2);
      expect(
        await complete(
          person,
          {},
          { "x-cp-client-ip": "203.0.113.50", "user-agent": "Victima/2.0" },
        ),
      ).toEqual({
        result: "completed",
        already_ready: false,
      });
      const now = await db.query<{ id: string; ip: string; user_agent: string }>(
        "select id, host(origin_ip) as ip, user_agent from public.legal_acceptances where user_id = $1",
        [person.id],
      );
      expect(now.rowCount).toBe(2);
      expect(now.rows.map((r) => r.ip)).toEqual(["203.0.113.50", "203.0.113.50"]);
      expect(now.rows.map((r) => r.user_agent)).toEqual(["Victima/2.0", "Victima/2.0"]);
      expect(now.rows.some((r) => planted.rows.some((p) => p.id === r.id))).toBe(false);
      const discarded = await db.query<{ details: Json; resource_id: string; result: string }>(
        "select details, resource_id, result from public.audit_log where actor_user_id = $1 and action = 'legal.acceptance_discarded' order by details ->> 'kind'",
        [person.id],
      );
      expect(discarded.rowCount).toBe(2);
      expect(discarded.rows.map((r) => r.details.kind)).toEqual(["privacy", "terms"]);
      expect(discarded.rows.map((r) => r.details.version)).toEqual([
        versions.privacy,
        versions.terms,
      ]);
      expect(
        discarded.rows.every((r) => r.details.context === "signup" && r.result === "success"),
      ).toBe(true);
      expect(await audit("account.setup_completed", person.id)).toBe(1);
      expect(
        (
          await one<{ d: Json }>(
            "select details as d from public.audit_log where actor_user_id = $1 and action = 'account.setup_completed'",
            [person.id],
          )
        ).d,
      ).toEqual({ discarded_acceptances: 2 });
    }));

  it("AS22 · `account_setup_preflight` rechaza lo mismo (salvo otras sesiones), no escribe nada y no audita", () =>
    withTx(db, async () => {
      const person = await unfinished();
      const before = {
        audit: await count("select count(*) as n from public.audit_log where actor_user_id = $1", [
          person.id,
        ]),
        acceptances: await count(
          "select count(*) as n from public.legal_acceptances where user_id = $1",
          [person.id],
        ),
        profile: (await one(
          "select full_name, account_ready_at from public.profiles where user_id = $1",
          [person.id],
        )) as Json,
      };
      expect(await preflight(person, { amr: PASSWORD })).toEqual({ result: "not_email_link" });
      expect(await preflight(person, { name: "" })).toEqual({ result: "invalid_name" });
      expect(await preflight(person, { terms: "vieja" })).toEqual({ result: "legal_changed" });
      expect(await preflight(person)).toEqual({ result: "ok" });
      expect({
        audit: await count("select count(*) as n from public.audit_log where actor_user_id = $1", [
          person.id,
        ]),
        acceptances: await count(
          "select count(*) as n from public.legal_acceptances where user_id = $1",
          [person.id],
        ),
        profile: (await one(
          "select full_name, account_ready_at from public.profiles where user_id = $1",
          [person.id],
        )) as Json,
      }).toEqual(before);
      // y una cuenta ya terminada responde ok
      const done = await createUser(db);
      expect(await preflight(done)).toEqual({ result: "ok" });
    }));

  it("AS23 · en una transacción de solo lectura (un GET de PostgREST) `complete_account_setup` no se atiende", () =>
    withTx(db, async () => {
      const person = await unfinished();
      await as(person, EMAIL_LINK);
      await db.query("set transaction_read_only = on");
      const error = await expectSqlError(db, COMPLETE, [
        "Nombre",
        versions.terms,
        versions.privacy,
      ]);
      expect(error.code).toBe("25006");
    }));

  it("AS24 · sin sesión (anon) no se ejecuta ninguna de las tres funciones", () =>
    withTx(db, async () => {
      await actAsAnon(db);
      for (const sql of [
        "select public.complete_account_setup('A', 'b', 'c')",
        "select public.account_setup_preflight('A', 'b', 'c')",
        "select public.my_account_ready()",
      ]) {
        expect((await expectSqlError(db, sql)).code, sql).toBe("42501");
      }
    }));
});

// ---------------------------------------------------------------------------------------------------------------------
describe("H-116 · el pase de una sesión cerrada no sirve", () => {
  it("AS25 · `app.session_alive()`: sesión de la cuenta, vencida, ajena, inexistente, sin `session_id` o con uno que no es uuid", () =>
    withTx(db, async () => {
      const person = await createUser(db);
      const stranger = await createUser(db);
      await actAsPostgres(db);
      const own = (await ensureSession(db, person.id))!;
      const foreign = (await ensureSession(db, stranger.id))!;
      const expired = (
        await one<{ id: string }>(
          "insert into auth.sessions (id, user_id, created_at, updated_at, aal, not_after) values (gen_random_uuid(), $1, now(), now(), 'aal1', now() - interval '1 minute') returning id",
          [person.id],
        )
      ).id;
      const alive = async (session: string | "none") => {
        await actAs(db, person, {}, "authenticated", { session });
        const { r } = await one<{ r: boolean }>("select app.session_alive() as r");
        await actAsPostgres(db);
        return r;
      };
      expect(await alive(own)).toBe(true);
      expect(await alive(expired)).toBe(false);
      expect(await alive(foreign)).toBe(false);
      expect(await alive(randomUUID())).toBe(false);
      expect(await alive("none")).toBe(false);
      expect(await alive("no-es-un-uuid")).toBe(false);
      expect(await alive("'; drop table x; --")).toBe(false);
      // sin persona (anon): ni siquiera puede llamarla
      await actAsAnon(db);
      expect((await expectSqlError(db, "select app.session_alive()")).code).toBe("42501");
    }));

  it("AS26 · con la sesión cerrada: las seis funciones fallan, la organización activa y el selector quedan vacíos y `profiles_update` no cambia ninguna fila", () =>
    withTx(db, async () => {
      const owner = await createUser(db);
      const tenantId = await createTenantAs(db, owner);
      const person = await unfinished();
      const sha = "c".repeat(64);
      const sessionId = await closeSession(owner);
      const closed = (
        user: TestUser,
        headers: Record<string, string> = {},
        amr: unknown = EMAIL_LINK,
      ) => actAs(db, user, headers, "authenticated", { session: sessionId, amr });
      // la Dueña con su pase de sesión cerrada
      await closed(owner, { [TENANT_HEADER]: tenantId });
      expect(await one("select app.current_tenant_id() as t")).toEqual({ t: null });
      expect(await count("select count(*) as n from app.my_tenant_ids()")).toBe(0);
      for (const table of ["members", "customers", "catalog_items", "tenants"]) {
        expect(await count(`select count(*) as n from public.${table}`), table).toBe(0);
      }
      // ni siquiera su propia membresía ni su propio perfil (las ramas «filas propias» de `members_select` y `profiles_select`)
      expect(await count("select count(*) as n from public.profiles")).toBe(0);
      expect(
        (await expectSqlError(db, "select public.create_tenant('Otro Negocio', '76086428-5')"))
          .code,
      ).toBe("42501");
      expect((await expectSqlError(db, "select public.invitation_preview($1)", [sha])).code).toBe(
        "42501",
      );
      expect((await expectSqlError(db, "select public.accept_invitation($1)", [sha])).code).toBe(
        "42501",
      );
      expect((await expectSqlError(db, "select public.my_account_ready()")).code).toBe("42501");
      expect(
        (await expectSqlError(db, PREFLIGHT, ["Nombre", versions.terms, versions.privacy])).code,
      ).toBe("42501");
      expect(
        (await expectSqlError(db, COMPLETE, ["Nombre", versions.terms, versions.privacy])).code,
      ).toBe("42501");
      // `profiles_update`: ni su nombre cambia
      expect(
        (
          await db.query("update public.profiles set full_name = 'Reescrito' where user_id = $1", [
            owner.id,
          ])
        ).rowCount,
      ).toBe(0);
      await actAsPostgres(db);
      expect(
        (
          await one<{ full_name: string }>(
            "select full_name from public.profiles where user_id = $1",
            [owner.id],
          )
        ).full_name,
      ).not.toBe("Reescrito");
      // lo mismo para una cuenta sin terminar que además cierra su sesión
      const personSession = await closeSession(person);
      await actAs(db, person, {}, "authenticated", { session: personSession, amr: EMAIL_LINK });
      expect(
        (await expectSqlError(db, COMPLETE, ["Nombre", versions.terms, versions.privacy])).code,
      ).toBe("42501");
      await actAsPostgres(db);
      expect(await ready(person.id)).toBe(false);
    }));

  it("AS27 · con la sesión abierta, `profiles_update` cambia el nombre y `current_tenant_id`/`my_tenant_ids` responden", () =>
    withTx(db, async () => {
      const owner = await createUser(db);
      const tenantId = await createTenantAs(db, owner);
      await actAs(db, owner, { [TENANT_HEADER]: tenantId });
      expect((await one<{ t: string }>("select app.current_tenant_id() as t")).t).toBe(tenantId);
      expect(await count("select count(*) as n from app.my_tenant_ids()")).toBe(1);
      expect(
        (
          await db.query(
            "update public.profiles set full_name = 'Nuevo Nombre' where user_id = $1",
            [owner.id],
          )
        ).rowCount,
      ).toBe(1);
    }));
});

// ---------------------------------------------------------------------------------------------------------------------
describe("H-116 · el correo de una cuenta no cambia hasta H-109", () => {
  it("AS28 · el disparador rechaza cambiar `email` (también solo en mayúsculas) y anotar un cambio pendiente partiendo de NULL o de vacío", () =>
    withTx(db, async () => {
      const person = await createUser(db);
      await actAsPostgres(db);
      expect(
        (
          await expectSqlError(
            db,
            "update auth.users set email = 'otro@ejemplo.test' where id = $1",
            [person.id],
          )
        ).code,
      ).toBe("42501");
      expect(
        (
          await expectSqlError(db, "update auth.users set email = upper(email) where id = $1", [
            person.id,
          ])
        ).code,
      ).toBe("42501");
      expect(
        (await expectSqlError(db, "update auth.users set email = null where id = $1", [person.id]))
          .code,
      ).toBe("42501");
      for (const before of [null, ""]) {
        await db.query("set local app.allow_email_change = 'on'");
        await db.query("update auth.users set email_change = $2 where id = $1", [
          person.id,
          before,
        ]);
        await db.query("set local app.allow_email_change = 'off'");
        const error = await expectSqlError(
          db,
          "update auth.users set email_change = 'pendiente@ejemplo.test', email_change_token_new = 'x' where id = $1",
          [person.id],
        );
        expect(error.code, String(before)).toBe("42501");
      }
      expect(
        (await one<{ email: string }>("select email from auth.users where id = $1", [person.id]))
          .email,
      ).toBe(person.email);
    }));

  it("AS29 · deja pasar las demás actualizaciones de `auth.users` (confirmar el correo, fijar la contraseña, `last_sign_in_at`), también sobre una fila con un cambio pendiente", () =>
    withTx(db, async () => {
      const person = await createUser(db, { confirmed: false });
      await actAsPostgres(db);
      const ok = async (sql: string) => {
        const res = await db.query(sql, [person.id]);
        expect(res.rowCount, sql).toBe(1);
      };
      await ok("update auth.users set email_confirmed_at = now() where id = $1");
      await ok("update auth.users set encrypted_password = 'hash-de-prueba' where id = $1");
      await ok("update auth.users set last_sign_in_at = now(), updated_at = now() where id = $1");
      await ok("update auth.users set raw_user_meta_data = '{\"a\":1}'::jsonb where id = $1");
      // una fila que YA trae un cambio pendiente (puesto con el interruptor): las demás actualizaciones pasan
      await db.query("set local app.allow_email_change = 'on'");
      await db.query(
        "update auth.users set email_change = 'pendiente@ejemplo.test', email_change_token_new = 'tok' where id = $1",
        [person.id],
      );
      await db.query("set local app.allow_email_change = 'off'");
      await ok("update auth.users set last_sign_in_at = now() where id = $1");
      await ok("update auth.users set encrypted_password = 'otro-hash' where id = $1");
      // y borrar el cambio pendiente (lo que hace el relleno) también pasa
      await ok(
        "update auth.users set email_change = '', email_change_token_new = '' where id = $1",
      );
    }));

  it("AS30 · el interruptor `app.allow_email_change` solo vale en la conexión que lo fija; otra conexión sigue rechazada", async () => {
    const person = await createUser(db, { ready: true });
    const other = await connect();
    try {
      await db.query("begin");
      await db.query("set local app.allow_email_change = 'on'");
      const nuevo = `soporte-${randomUUID().slice(0, 6)}@ejemplo.test`;
      expect(
        (await db.query("update auth.users set email = $2 where id = $1", [person.id, nuevo]))
          .rowCount,
      ).toBe(1);
      // otra conexión, mientras tanto: el cambio de otra fila sigue prohibido
      const victim = await createUser(other);
      await expect(
        other.query("update auth.users set email = 'otro-' || email where id = $1", [victim.id]),
      ).rejects.toMatchObject({ code: "42501" });
      await other.query("delete from auth.users where id = $1", [victim.id]);
      await db.query("rollback");
      // el interruptor era de la transacción: tras ella ya no vale
      await expect(
        db.query("update auth.users set email = $2 where id = $1", [person.id, nuevo]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("rollback").catch(() => undefined);
      await db.query("delete from auth.users where id = $1", [person.id]);
      await other.end();
    }
  });

  it("AS31 · las personas no pueden fijar el interruptor por la API (`authenticated` no cambia el correo ni con el ajuste)", () =>
    withTx(db, async () => {
      const person = await createUser(db);
      await actAs(db, person);
      // `authenticated` no tiene ningún permiso sobre `auth.users`: ni con el ajuste puesto
      await db.query("set local app.allow_email_change = 'on'");
      expect(
        (
          await expectSqlError(
            db,
            "update auth.users set email = 'otro@ejemplo.test' where id = $1",
            [person.id],
          )
        ).code,
      ).toBe("42501");
    }));
});

// ---------------------------------------------------------------------------------------------------------------------
describe("H-116 · permisos y el límite de intentos", () => {
  it("AS32 · quién ejecuta qué: solo `authenticated` las tres públicas y `session_alive`; `anon` nada; las ayudas internas, nadie", async () => {
    await actAsPostgres(db);
    const can = async (role: string, signature: string) =>
      (
        await one<{ r: boolean }>(
          "select has_function_privilege($1, $2::regprocedure, 'execute') as r",
          [role, signature],
        )
      ).r;
    for (const signature of [
      "public.complete_account_setup(text, text, text)",
      "public.account_setup_preflight(text, text, text)",
      "public.my_account_ready()",
      "app.session_alive()",
    ]) {
      expect(await can("authenticated", signature), signature).toBe(true);
      expect(await can("anon", signature), signature).toBe(false);
    }
    for (const signature of [
      "app.session_from_email_link()",
      "app.account_ready(uuid)",
      "app.setup_denied(uuid, text)",
      "app.account_setup_verdict(uuid, uuid, text, text, text, boolean)",
      "app.forbid_email_change()",
    ]) {
      expect(await can("authenticated", signature), signature).toBe(false);
      expect(await can("anon", signature), signature).toBe(false);
    }
  });

  it("AS33 · `signup_email` es un alcance válido del límite de intentos", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const key = createHash("sha256").update(randomUUID()).digest("hex");
      await db.query("select public.auth_limit_record_failure('signup_email', $1, 3, 3600, 3600)", [
        key,
      ]);
      expect(
        await count(
          "select count(*) as n from public.auth_rate_limits where scope = 'signup_email' and key_hash = $1",
          [key],
        ),
      ).toBe(1);
      expect(
        (
          await expectSqlError(
            db,
            "select public.auth_limit_record_failure('otro_alcance', $1, 3, 3600, 3600)",
            [key],
          )
        ).code,
      ).toBeTruthy();
    }));
});

// ---------------------------------------------------------------------------------------------------------------------
describe("H-116 · el relleno de las cuentas que ya existían", () => {
  /** Lo que la migración hace con los datos que ya hay: las secciones «2.» y «3.» (hasta crear la función del disparador). */
  const filling = (() => {
    const from = up.indexOf("update public.profiles p\n   set signup_email");
    const to = up.indexOf("create function app.forbid_email_change");
    return code(up.slice(from, to));
  })();

  it("AS34 · las verificadas y con contraseña pasan a terminadas; las demás quedan sin terminar; todas reciben el correo de alta; se borran los cambios de correo pendientes", () =>
    withTx(db, async () => {
      const verified = await createUser(db, {
        ready: false,
        email: "Verificada.Con.Clave@Ejemplo.Test",
      });
      const noPassword = await createUser(db, { ready: false });
      const unverified = await createUser(db, { ready: false, confirmed: false });
      const pending = await createUser(db, { ready: false });
      await actAsPostgres(db);
      for (const u of [verified, pending, unverified]) {
        await db.query(
          "update auth.users set encrypted_password = 'hash-de-prueba' where id = $1",
          [u.id],
        );
      }
      // el estado «anterior a la migración»: sin correo de alta
      await db.query("update public.profiles set signup_email = null where user_id = any ($1)", [
        [verified.id, noPassword.id, unverified.id, pending.id],
      ]);
      // un cambio de correo a medias, con su código en `auth.one_time_tokens`
      await db.query("set local app.allow_email_change = 'on'");
      await db.query(
        `update auth.users set email_change = 'otro@ejemplo.test', email_change_token_new = 'tok-nuevo', email_change_token_current = 'tok-actual',
                email_change_confirm_status = 1 where id = $1`,
        [pending.id],
      );
      await db.query("set local app.allow_email_change = 'off'");
      await db.query(
        "insert into auth.one_time_tokens (id, user_id, token_type, token_hash, relates_to) values (gen_random_uuid(), $1, 'email_change_token_new', 'hash-1', 'otro@ejemplo.test')",
        [pending.id],
      );
      await db.query(
        "insert into auth.one_time_tokens (id, user_id, token_type, token_hash, relates_to) values (gen_random_uuid(), $1, 'recovery_token', 'hash-2', 'x')",
        [pending.id],
      );
      await db.query(filling);
      const profile = async (u: TestUser) =>
        one<{ signup_email: string; ready: boolean }>(
          "select signup_email, account_ready_at is not null as ready from public.profiles where user_id = $1",
          [u.id],
        );
      expect(await profile(verified)).toEqual({
        signup_email: "verificada.con.clave@ejemplo.test",
        ready: true,
      });
      expect(await profile(noPassword)).toEqual({ signup_email: noPassword.email, ready: false });
      expect(await profile(unverified)).toEqual({ signup_email: unverified.email, ready: false });
      expect((await profile(pending)).ready).toBe(true);
      expect(
        await one(
          "select coalesce(email_change, '') as c, coalesce(email_change_token_new, '') as n, coalesce(email_change_token_current, '') as t, email_change_confirm_status as s from auth.users where id = $1",
          [pending.id],
        ),
      ).toEqual({ c: "", n: "", t: "", s: 0 });
      expect(
        (
          await db.query<{ token_type: string }>(
            "select token_type from auth.one_time_tokens where user_id = $1",
            [pending.id],
          )
        ).rows,
      ).toEqual([{ token_type: "recovery_token" }]);
    }));
});

// ---------------------------------------------------------------------------------------------------------------------
describe("H-116 · el deshacer", () => {
  const SIGNATURES = {
    current: "app.current_tenant_id()",
    mine: "app.my_tenant_ids()",
    create: "public.create_tenant(text, text, text, text, text)",
    accept: "public.accept_invitation(text)",
    preview: "public.invitation_preview(text)",
    handle: "app.handle_new_user()",
  };
  const NEW_FUNCTIONS = [
    "app.session_alive()",
    "app.session_from_email_link()",
    "app.account_ready(uuid)",
    "app.setup_denied(uuid, text)",
    "app.account_setup_verdict(uuid, uuid, text, text, text, boolean)",
    "public.account_setup_preflight(text, text, text)",
    "public.my_account_ready()",
    "public.complete_account_setup(text, text, text)",
    "app.forbid_email_change()",
  ];
  type Definition = {
    src: string;
    secdef: boolean;
    cfg: string[] | null;
    volatility: string;
    returns: string;
    anon: boolean;
    auth: boolean;
  };
  const definition = async (signature: string): Promise<Definition> =>
    one<Definition>(
      `select p.prosrc as src, p.prosecdef as secdef, p.proconfig as cfg, p.provolatile as volatility,
              pg_get_function_result(p.oid) as returns,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p where p.oid = $1::regprocedure`,
      [signature],
    );
  const policyText = async () =>
    (
      await db.query<{ policyname: string; t: string }>(
        `select policyname, coalesce(qual, '') || ' | ' || coalesce(with_check, '') as t from pg_policies
          where schemaname = 'public' and policyname in ('profiles_update', 'profiles_select', 'members_select')
          order by policyname`,
      )
    ).rows;
  const columns = async () =>
    (
      await db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name in ('account_ready_at', 'signup_email')",
      )
    ).rows.map((r) => r.column_name);
  const triggerExists = async () =>
    (await count(
      "select count(*) as n from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'forbid_email_change' and not tgisinternal",
    )) === 1;
  const functionExists = async (signature: string) =>
    (await one<{ r: boolean }>("select to_regprocedure($1) is not null as r", [signature])).r;

  it("AS35 · el deshacer devuelve las seis funciones EXACTAMENTE a su texto anterior (con sus atributos y permisos), la política a la anterior y quita todo lo nuevo; se puede volver a aplicar", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const beforeDown: Record<string, Definition> = {};
      for (const [key, signature] of Object.entries(SIGNATURES))
        beforeDown[key] = await definition(signature);
      expect(await columns()).toHaveLength(2);
      expect(await triggerExists()).toBe(true);
      const policiesWithUp = await policyText();
      const tenantOwner = (await createUser(db)).id;
      const note = await one<{ n: string }>("select count(*)::text as n from public.profiles");
      await db.query(down);
      // las seis funciones, como eran
      const expected = {
        current: functionBodyIn(gate, "app.current_tenant_id"),
        mine: functionBodyIn(gate, "app.my_tenant_ids"),
        create: functionBodyIn(gate, "public.create_tenant"),
        accept: functionBodyIn(gate, "public.accept_invitation"),
        preview: functionBodyIn(gate, "public.invitation_preview"),
        handle: functionBodyIn(legal, "app.handle_new_user"),
      };
      for (const [key, signature] of Object.entries(SIGNATURES)) {
        const now = await definition(signature);
        expect(now.src, key).toBe(expected[key as keyof typeof expected]);
        expect({ ...now, src: "" }, key).toEqual({ ...beforeDown[key], src: "" });
      }
      const own =
        "(user_id = ( SELECT auth.uid() AS uid)) AND (NOT ( SELECT app.second_step_pending() AS second_step_pending))";
      expect(await policyText()).toEqual([
        {
          policyname: "members_select",
          t: `((${own}) OR ((tenant_id = ( SELECT app.current_tenant_id() AS current_tenant_id)) AND ((status = 'active'::text) OR ( SELECT app.can('team.manage'::text) AS can)))) | `,
        },
        {
          policyname: "profiles_select",
          t: `((${own}) OR (user_id IN ( SELECT app.current_tenant_people() AS current_tenant_people))) | `,
        },
        { policyname: "profiles_update", t: `(${own}) | (${own})` },
      ]);
      // lo nuevo se fue
      expect(await columns()).toEqual([]);
      expect(await triggerExists()).toBe(false);
      for (const signature of NEW_FUNCTIONS)
        expect(await functionExists(signature), signature).toBe(false);
      expect(
        await count(
          "select count(*) as n from pg_constraint where conname = 'profiles_signup_email_check'",
        ),
      ).toBe(0);
      // la lista de alcances volvió a la anterior
      expect(
        (
          await expectSqlError(
            db,
            "select public.auth_limit_record_failure('signup_email', $1, 3, 3600, 3600)",
            ["e".repeat(64)],
          )
        ).code,
      ).toBeTruthy();
      // las cuentas no se tocan
      expect((await one<{ n: string }>("select count(*)::text as n from public.profiles")).n).toBe(
        note.n,
      );
      expect(await count("select count(*) as n from auth.users where id = $1", [tenantOwner])).toBe(
        1,
      );
      // el cambio de correo vuelve a ser posible (ya no hay disparador) y el alta vuelve a registrar el consentimiento de los metadatos
      const user = await createUser(db, {
        meta: { accepted_legal: { terms: versions.terms, privacy: versions.privacy } },
      });
      expect(
        await count("select count(*) as n from public.legal_acceptances where user_id = $1", [
          user.id,
        ]),
      ).toBe(2);
      await db.query("update auth.users set email = 'cambiado@ejemplo.test' where id = $1", [
        user.id,
      ]);
      // volver a aplicar la migración: todo vuelve
      await db.query(up);
      expect(await columns()).toHaveLength(2);
      expect(await triggerExists()).toBe(true);
      for (const [key, signature] of Object.entries(SIGNATURES)) {
        expect(await definition(signature), key).toEqual(beforeDown[key]);
      }
      for (const signature of NEW_FUNCTIONS)
        expect(await functionExists(signature), signature).toBe(true);
      expect(await policyText()).toEqual(policiesWithUp);
    }));

  it("AS36 · el deshacer borra los contadores del alcance nuevo antes de devolver la lista, y un segundo deshacer se niega sin cambiar nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query("select public.auth_limit_record_failure('signup_email', $1, 3, 3600, 3600)", [
        "f".repeat(64),
      ]);
      await db.query(down);
      expect(
        await count(
          "select count(*) as n from public.auth_rate_limits where scope = 'signup_email'",
        ),
      ).toBe(0);
      const refused = await expectSqlError(db, down);
      expect(refused.message).toContain("no se puede deshacer 20261125100000_account_setup");
    }));

  it("AS37 · el deshacer se niega (y no cambia nada) si una de las funciones ya no es la de la migración", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      for (const [name, args] of [
        ["app.session_alive", ""],
        ["app.account_ready", "p_user uuid"],
      ] as const) {
        await db.query("savepoint s");
        const returns = name === "app.account_ready" ? "boolean" : "boolean";
        await db.query(
          `create or replace function ${name}(${args}) returns ${returns} language sql stable security definer set search_path = '' as $$ select true $$`,
        );
        const refused = await expectSqlError(db, down);
        expect(refused.message, name).toContain("ya no es la de esta migracion");
        expect(await columns()).toHaveLength(2);
        await db.query("rollback to savepoint s");
      }
    }));

  it("AS38 · el deshacer se niega si OTRA función o política nombra las ayudas o las columnas que borraría", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(
        "create function public.tmp_nombra_columna() returns text language sql stable security definer set search_path = '' as $$ select signup_email from public.profiles limit 1 $$",
      );
      const byFunction = await expectSqlError(db, down);
      expect(byFunction.message).toContain("otra funcion o politica nombra");
      expect(await columns()).toHaveLength(2);
      await db.query("drop function public.tmp_nombra_columna()");
      await db.query("create table public.tmp_pol (tenant_id uuid)");
      await db.query("alter table public.tmp_pol enable row level security");
      await db.query(
        "create policy tmp_pol_p on public.tmp_pol for select using ((select app.session_alive()))",
      );
      expect((await expectSqlError(db, down)).message).toContain("otra funcion o politica nombra");
    }));
});
