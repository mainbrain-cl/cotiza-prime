// H-116 · etapa 1 · Que nadie pueda adueñarse de una cuenta registrándose antes con su correo: ataques con pases REALES (GoTrue y
// PostgREST locales), solo la base de datos (la aplicación llega en las etapas 2 y 3).
//   · Una cuenta SIN terminar (la que un registro previo dejó con la contraseña de otra persona) no crea organizaciones, no ve ni acepta
//     invitaciones, no lee datos de ninguna organización y no puede terminarse con una sesión de contraseña.
//   · El recorrido legítimo: la sesión de un enlace del correo (`amr` de enlace) fija la contraseña, cierra las otras sesiones y termina la
//     cuenta; con eso, el pase de quien plantó la contraseña deja de servir EN LA BASE aunque no haya vencido (PostgREST lo sigue aceptando).
//   · El registro público está apagado (X7, X8), `/resend` no crea cuentas (X9) y `PUT /auth/v1/user` no cambia el correo (X10).
//   · Un pase cuya sesión se cerró no lee datos de su organización, no llama las funciones ni cambia `profiles.full_name` (X11).
//   · Las dos columnas nuevas de `profiles` no se leen ni se escriben por la API.
// Solo cuentas nuevas `@ejemplo.test` (se borran al final). Todo es ficticio.
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  TEST_PASSWORD,
  adminCreateUser,
  localEnv,
  rest,
  rpc,
  signIn,
  type Session,
} from "../support/local-supabase";
import { claimsOf, gotrue } from "../support/mfa-gate";
import { fixture, openDb, tenantHeader, tokenOf } from "./context";

vi.setConfig({ testTimeout: 60_000 });

let db: Client;
const created: string[] = [];
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  if (created.length > 0) {
    await db
      .query("delete from public.tenants where created_by = any($1)", [created])
      .catch(() => undefined);
    await db.query("delete from auth.users where id = any($1)", [created]).catch(() => undefined);
  }
  await db.end();
});

/** Una cuenta nueva con contraseña (la de las pruebas), sin terminar si `ready` es falso. */
async function account(label: string, ready: boolean): Promise<{ email: string; id: string }> {
  const email = `h116-${label}-${randomBytes(4).toString("hex")}@ejemplo.test`;
  const id = await adminCreateUser(email, {}, { ready });
  created.push(id);
  return { email, id };
}

const adminHeaders = () => {
  const { secretKey } = localEnv();
  return {
    apikey: secretKey,
    authorization: `Bearer ${secretKey}`,
    "content-type": "application/json",
  };
};

/** La sesión de un enlace del correo: un enlace mágico generado con la llave maestra y canjeado como lo haría la persona. */
async function emailLinkSession(email: string): Promise<Session> {
  const { apiUrl, publishableKey } = localEnv();
  const generated = await fetch(`${apiUrl}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ type: "magiclink", email }),
  });
  expect(generated.status).toBe(200);
  const { hashed_token: tokenHash } = (await generated.json()) as { hashed_token: string };
  const verified = await fetch(`${apiUrl}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash: tokenHash }),
  });
  expect(verified.status).toBe(200);
  const body = (await verified.json()) as {
    access_token: string;
    expires_at: number;
    user: { id: string };
  };
  return { accessToken: body.access_token, expiresAt: body.expires_at, userId: body.user.id };
}

const versions = async () => {
  const { rows } = await db.query<{ kind: string; version: string }>(
    "select kind, version from public.legal_documents where is_current",
  );
  return {
    p_terms_version: rows.find((r) => r.kind === "terms")!.version,
    p_privacy_version: rows.find((r) => r.kind === "privacy")!.version,
  };
};

const sha = (c: string) => c.repeat(64);

describe("H-116 · la cuenta que un registro previo dejó con la contraseña de otra persona", () => {
  it("con esa contraseña (aal1, `amr` de contraseña) no puede terminarse, crear organizaciones, ver invitaciones ni leer datos de nadie", async () => {
    const fx = fixture();
    const attacker = await account("atacante", false);
    const pass = (await signIn(attacker.email)).accessToken;
    expect(claimsOf(pass).amr.map((a) => a.method)).toEqual(["password"]);

    const done = await rpc(pass, "complete_account_setup", {
      p_full_name: "Atacante",
      ...(await versions()),
    });
    expect(done.status, done.text).toBe(200);
    expect(done.json).toEqual({ result: "not_email_link" });

    const create = await rpc(pass, "create_tenant", {
      p_name: "Negocio del atacante",
      p_rut: "76086428-5",
    });
    expect(create.status).toBeGreaterThanOrEqual(400);
    expect(create.text).toContain("Termina de crear tu cuenta");
    for (const name of ["invitation_preview", "accept_invitation"]) {
      const res = await rpc(pass, name, { p_token_sha256: sha("a") });
      expect(res.status, name).toBe(200);
      expect(res.json, name).toEqual({ result: "unverified" });
    }
    expect((await rpc(pass, "my_account_ready")).json).toBe(false);
    expect(
      (await rpc(pass, "account_setup_preflight", { p_full_name: "x", ...(await versions()) }))
        .json,
    ).toEqual({
      result: "not_email_link",
    });

    // ninguna organización: ni con la cabecera de A ni con la de B
    for (const org of [fx.orgs.A.tenantId, fx.orgs.B.tenantId]) {
      for (const table of ["customers", "quotes", "catalog_items", "members", "audit_log"]) {
        const res = await rest(pass, `${table}?select=*`, { headers: tenantHeader(org) });
        expect(res.text, `${table} ${org}`).not.toContain(fx.orgs.B.canary);
        expect(res.text, `${table} ${org}`).not.toContain(org);
      }
    }
    expect(
      (await db.query("select 1 from public.tenants where created_by = $1", [attacker.id]))
        .rowCount,
    ).toBe(0);
    // y queda una sola fila de auditoría del intento (sin el correo)
    const audit = await db.query<{ n: string; details: unknown }>(
      "select count(*) over () as n, details from public.audit_log where actor_user_id = $1 and action = 'account.setup_denied'",
      [attacker.id],
    );
    expect(audit.rows.map((r) => r.n)).toEqual(["1"]);
    expect(JSON.stringify(audit.rows[0].details)).not.toContain(attacker.email);
  });

  it("recorrido legítimo: la víctima fija su contraseña desde el enlace del correo y cierra las otras sesiones; el pase del atacante deja de servir en la base aunque no haya vencido", async () => {
    const fx = fixture();
    const victim = await account("victima", false); // la cuenta con la contraseña que plantó el atacante
    const attackerPass = (await signIn(victim.email)).accessToken;
    const attackerClaims = claimsOf(attackerPass);

    // La víctima abre el enlace del correo: sesión de enlace (`otp`), no de contraseña
    const link = await emailLinkSession(victim.email);
    const claims = claimsOf(link.accessToken);
    expect(claims.amr.map((a) => a.method)).toContain("otp");
    expect(claims.amr.map((a) => a.method)).not.toContain("password");
    expect(claims.session_id).not.toBe(attackerClaims.session_id);

    const args = { p_full_name: "María Verdadera", ...(await versions()) };
    // todavía hay otra sesión abierta (la del atacante): no se puede terminar
    expect((await rpc(link.accessToken, "account_setup_preflight", args)).json).toEqual({
      result: "ok",
    });
    expect((await rpc(link.accessToken, "complete_account_setup", args)).json).toEqual({
      result: "other_sessions",
    });

    // 1) la víctima fija su contraseña desde su sesión (anula la del atacante) y 2) cierra las demás sesiones
    const newPassword = `Clave-${randomBytes(6).toString("hex")}-Nueva`;
    const changed = await gotrue(link.accessToken, "PUT", "user", { password: newPassword });
    expect(changed.status).toBe(200);
    const { apiUrl, publishableKey } = localEnv();
    const logout = await fetch(`${apiUrl}/auth/v1/logout?scope=others`, {
      method: "POST",
      headers: { apikey: publishableKey, authorization: `Bearer ${link.accessToken}` },
    });
    expect(logout.status).toBe(204);

    // el pase del atacante, todavía sin vencer: GoTrue ya lo rechaza, PostgREST lo acepta (la ventana que cierra la base)
    expect(claimsOf(attackerPass).session_id).toBe(attackerClaims.session_id);
    expect((await gotrue(attackerPass, "GET", "user")).json?.error_code).toBe("session_not_found");
    expect(
      (await rpc(attackerPass, "my_last_tenant_id")).status,
      "PostgREST sigue aceptando el pase",
    ).toBe(200);
    const complete = await rpc(attackerPass, "complete_account_setup", args);
    expect(complete.status).toBeGreaterThanOrEqual(400);
    expect(complete.text).toContain("session_closed");

    // la víctima termina la cuenta
    const result = await rpc(link.accessToken, "complete_account_setup", args);
    expect(result.status, result.text).toBe(200);
    expect(result.json).toEqual({ result: "completed", already_ready: false });
    expect((await rpc(link.accessToken, "my_account_ready")).json).toBe(true);
    // sus aceptaciones son las reales: posteriores a verificar y de una sola sesión
    const acceptances = await db.query(
      "select 1 from public.legal_acceptances where user_id = $1",
      [victim.id],
    );
    expect(acceptances.rowCount).toBe(2);
    expect(
      (await db.query("select 1 from auth.sessions where user_id = $1", [victim.id])).rowCount,
    ).toBe(1);
    expect(
      (
        await db.query<{ full_name: string }>(
          "select full_name from public.profiles where user_id = $1",
          [victim.id],
        )
      ).rows[0].full_name,
    ).toBe("María Verdadera");

    // con la cuenta terminada, la víctima crea su organización con la contraseña nueva (pase de contraseña)
    await expect(signIn(victim.email), "la contraseña del atacante ya no sirve").rejects.toThrow();
    const tenant = await rpc(link.accessToken, "create_tenant", {
      p_name: "Negocio de la víctima",
      p_rut: "76086428-5",
    });
    expect(tenant.status, tenant.text).toBe(200);
    const tenantId = tenant.json as string;

    // el atacante, con su pase sin vencer: no crea organizaciones, no llama las funciones, no lee la organización ni cambia el nombre
    expect(
      (await rpc(attackerPass, "create_tenant", { p_name: "Otro", p_rut: "76086428-5" })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await rpc(attackerPass, "accept_invitation", { p_token_sha256: sha("b") })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await rpc(attackerPass, "invitation_preview", { p_token_sha256: sha("b") })).status,
    ).toBeGreaterThanOrEqual(400);
    for (const table of ["members", "customers", "catalog_items", "tenants", "quotes"]) {
      const res = await rest(attackerPass, `${table}?select=*`, {
        headers: tenantHeader(tenantId),
      });
      expect(res.text, table).not.toContain(tenantId);
    }
    const patch = await rest(attackerPass, `profiles?user_id=eq.${victim.id}&select=user_id`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: { full_name: "Nombre del atacante" },
    });
    expect(
      patch.json,
      "la regla profiles_update no deja pasar el pase de una sesión cerrada",
    ).toEqual([]);
    expect(
      (
        await db.query<{ full_name: string }>(
          "select full_name from public.profiles where user_id = $1",
          [victim.id],
        )
      ).rows[0].full_name,
    ).toBe("María Verdadera");
    // y de B nada
    expect(
      (
        await rest(attackerPass, "customers?select=*", {
          headers: tenantHeader(fx.orgs.B.tenantId),
        })
      ).text,
    ).not.toContain(fx.orgs.B.canary);
    // la víctima, con su pase de enlace y sesión abierta, sí ve su organización
    const visible = await rest(link.accessToken, "tenants?select=tenant_id", {
      headers: tenantHeader(tenantId),
    });
    expect(visible.json).toEqual([{ tenant_id: tenantId }]);
  });

  it("X11 · un pase cuya sesión se cerró (`signOut`) no lee datos de su organización, no llama las funciones ni cambia `profiles.full_name`, aunque no haya vencido", async () => {
    const person = await account("sesion-cerrada", true);
    const closing = await signIn(person.email);
    const staying = await signIn(person.email);
    const tenant = await rpc(closing.accessToken, "create_tenant", {
      p_name: "Negocio con sesiones",
      p_rut: "76086428-5",
    });
    expect(tenant.status, tenant.text).toBe(200);
    const tenantId = tenant.json as string;
    const header = tenantHeader(tenantId);
    // antes de cerrar: lee su organización
    expect(
      (await rest(closing.accessToken, "tenants?select=tenant_id", { headers: header })).json,
    ).toEqual([{ tenant_id: tenantId }]);

    const { apiUrl, publishableKey } = localEnv();
    const logout = await fetch(`${apiUrl}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: { apikey: publishableKey, authorization: `Bearer ${closing.accessToken}` },
    });
    expect(logout.status).toBe(204);
    expect((await gotrue(closing.accessToken, "GET", "user")).json?.error_code).toBe(
      "session_not_found",
    );
    // PostgREST todavía acepta el pase (la ventana de hasta 15 minutos): lo que no pasa por la organización sigue respondiendo...
    expect((await rpc(closing.accessToken, "my_last_tenant_id")).status).toBe(200);
    // ...y todo lo demás, no
    for (const table of [
      "tenants",
      "members",
      "customers",
      "catalog_items",
      "quotes",
      "numbering_settings",
    ]) {
      const res = await rest(closing.accessToken, `${table}?select=*`, { headers: header });
      expect(res.text, table).not.toContain(tenantId);
    }
    expect(
      (await rpc(closing.accessToken, "create_tenant", { p_name: "Otra", p_rut: "76086428-5" }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await rpc(
          closing.accessToken,
          "set_numbering",
          { p_prefix: "XX", p_mode: "yearly", p_start_number: 1 },
          header,
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
    for (const name of ["invitation_preview", "accept_invitation"]) {
      expect(
        (await rpc(closing.accessToken, name, { p_token_sha256: sha("c") })).status,
        name,
      ).toBeGreaterThanOrEqual(400);
    }
    expect((await rpc(closing.accessToken, "my_account_ready")).status).toBeGreaterThanOrEqual(400);
    const patch = await rest(
      closing.accessToken,
      `profiles?user_id=eq.${person.id}&select=user_id`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: { full_name: "Reescrito" },
      },
    );
    expect(patch.json).toEqual([]);
    // la otra sesión de la misma cuenta sigue funcionando (y SÍ puede cambiar su nombre: el `[]` de arriba es por la sesión cerrada)
    const alive = await rest(
      staying.accessToken,
      `profiles?user_id=eq.${person.id}&select=user_id`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: { full_name: "Nombre Vivo" },
      },
    );
    expect(alive.json).toEqual([{ user_id: person.id }]);
    expect(
      (await rest(staying.accessToken, "tenants?select=tenant_id", { headers: header })).json,
    ).toEqual([{ tenant_id: tenantId }]);
    expect((await rpc(staying.accessToken, "my_account_ready")).json).toBe(true);
  });
});

describe("H-116 · una persona con la cuenta terminada", () => {
  it("Ana, con su pase de contraseña, no puede llamar `complete_account_setup`; su cuenta está terminada y nadie lee ni escribe `account_ready_at` ni `signup_email`", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    expect(claimsOf(token).amr.map((a) => a.method)).toEqual(["password"]);
    const res = await rpc(token, "complete_account_setup", {
      p_full_name: "Ana",
      ...(await versions()),
    });
    expect(res.json).toEqual({ result: "not_email_link" });
    expect((await rpc(token, "my_account_ready")).json).toBe(true);
    // ni por columnas, ni con `select=*`, ni de otra persona
    for (const column of ["account_ready_at", "signup_email"]) {
      for (const query of [
        `profiles?select=${column}`,
        `profiles?user_id=eq.${fx.personas.beto.userId}&select=${column}`,
        `profiles?${column}=not.is.null&select=user_id`,
      ]) {
        const read = await rest(token, query);
        expect(read.status, query).toBeGreaterThanOrEqual(400);
      }
      const write = await rest(token, `profiles?user_id=eq.${fx.personas.ana.userId}`, {
        method: "PATCH",
        body: {
          [column]: column === "signup_email" ? "otro@ejemplo.test" : new Date().toISOString(),
        },
      });
      expect(write.status, column).toBeGreaterThanOrEqual(400);
    }
    expect((await rest(token, "profiles?select=*")).status).toBeGreaterThanOrEqual(400);
  });
});

describe("H-116 · el registro público está apagado y el correo no cambia", () => {
  it("X7 · `POST /auth/v1/signup` responde `signup_disabled` y no crea la cuenta", async () => {
    const { apiUrl, publishableKey } = localEnv();
    const email = `h116-x7-${randomBytes(4).toString("hex")}@ejemplo.test`;
    const res = await fetch(`${apiUrl}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ email, password: TEST_PASSWORD, data: { full_name: "Atacante" } }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error_code: string }).error_code).toBe("signup_disabled");
    expect((await db.query("select 1 from auth.users where email = $1", [email])).rowCount).toBe(0);
  });

  it("X8 · `POST /auth/v1/otp` con `create_user` no crea la cuenta", async () => {
    const { apiUrl, publishableKey } = localEnv();
    const email = `h116-x8-${randomBytes(4).toString("hex")}@ejemplo.test`;
    const res = await fetch(`${apiUrl}/auth/v1/otp`, {
      method: "POST",
      headers: { apikey: publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ email, create_user: true }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await db.query("select 1 from auth.users where email = $1", [email])).rowCount).toBe(0);
  });

  it("X9 · `POST /auth/v1/resend` no crea cuentas ni fija contraseñas, y sobre una cuenta sin verificar no cambia su contraseña", async () => {
    const { apiUrl, publishableKey } = localEnv();
    const nobody = `h116-x9-${randomBytes(4).toString("hex")}@ejemplo.test`;
    await fetch(`${apiUrl}/auth/v1/resend`, {
      method: "POST",
      headers: { apikey: publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ type: "signup", email: nobody, password: TEST_PASSWORD }),
    });
    expect((await db.query("select 1 from auth.users where email = $1", [nobody])).rowCount).toBe(
      0,
    );
    // una cuenta sin verificar y con una contraseña ajena: reenviar no la cambia
    const email = `h116-x9b-${randomBytes(4).toString("hex")}@ejemplo.test`;
    const create = await fetch(`${apiUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ email, password: TEST_PASSWORD, email_confirm: false }),
    });
    const id = ((await create.json()) as { id: string }).id;
    created.push(id);
    const before = (
      await db.query<{ p: string }>(
        "select encrypted_password as p from auth.users where id = $1",
        [id],
      )
    ).rows[0].p;
    await fetch(`${apiUrl}/auth/v1/resend`, {
      method: "POST",
      headers: { apikey: publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ type: "signup", email, password: "Otra-Clave-Del-Atacante-1" }),
    });
    expect(
      (
        await db.query<{ p: string }>(
          "select encrypted_password as p from auth.users where id = $1",
          [id],
        )
      ).rows[0].p,
    ).toBe(before);
  });

  it("X10 · `PUT /auth/v1/user` con otro correo falla y el correo de la cuenta no cambia (el disparador), tenga o no la cuenta terminada", async () => {
    for (const ready of [true, false]) {
      const person = await account(`x10-${ready ? "lista" : "sin-terminar"}`, ready);
      const link = await emailLinkSession(person.email);
      const victim = `h116-victima-${randomBytes(4).toString("hex")}@ejemplo.test`;
      const res = await gotrue(link.accessToken, "PUT", "user", { email: victim });
      expect(res.status, `ready=${ready}`).toBeGreaterThanOrEqual(400);
      const row = await db.query<{ email: string; email_change: string | null }>(
        "select email, email_change from auth.users where id = $1",
        [person.id],
      );
      expect(row.rows[0].email).toBe(person.email);
      expect(row.rows[0].email_change ?? "").toBe("");
      // y la cuenta sigue siendo la misma persona: su correo de alta es el de siempre
      expect(
        (
          await db.query<{ s: string }>(
            "select signup_email as s from public.profiles where user_id = $1",
            [person.id],
          )
        ).rows[0].s,
      ).toBe(person.email);
    }
  });

  it("el cambio de correo por SQL directo hace que la cuenta deje de contar como terminada (y `accept_invitation` y `create_tenant` fallan)", async () => {
    const person = await account("correo-cambiado", true);
    const session = await signIn(person.email);
    expect((await rpc(session.accessToken, "my_account_ready")).json).toBe(true);
    const other = `h116-cambiado-${randomBytes(4).toString("hex")}@ejemplo.test`;
    const client = await openDb();
    try {
      await client.query("begin");
      await client.query("set local app.allow_email_change = 'on'");
      await client.query("update auth.users set email = $2 where id = $1", [person.id, other]);
      await client.query("commit");
    } finally {
      await client.end();
    }
    const pass = session.accessToken;
    expect((await rpc(pass, "my_account_ready")).json).toBe(false);
    expect((await rpc(pass, "accept_invitation", { p_token_sha256: sha("d") })).json).toEqual({
      result: "unverified",
    });
    expect(
      (
        await rpc(pass, "create_tenant", {
          p_name: "Negocio",
          p_rut: "76086428-5",
          p_industry: "services",
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    // y `complete_account_setup` responde `email_changed` desde cualquier sesión
    const link = await emailLinkSession(other);
    expect(
      (
        await rpc(link.accessToken, "complete_account_setup", {
          p_full_name: "X",
          ...(await versions()),
        })
      ).json,
    ).toEqual({
      result: "email_changed",
    });
  });
});
