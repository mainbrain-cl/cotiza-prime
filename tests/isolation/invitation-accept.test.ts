// Sprint 5 · H-009 · Aislamiento de aceptar una invitación: ataques con pases reales y `fetch` directo.
//  1. Una persona usa el código de una invitación de OTRA organización dirigida a otro correo: «wrong_email», la
//     otra organización queda intacta y no se entrega ni su nombre ni su id ni su canario.
//  2. Da igual la cabecera de organización que mande: aceptar no la lee (la organización sale de la invitación).
//  3. Quien está en A y en B (Mixta), quien fue quitada (Ex) y quien solo mira (Dante) tampoco entran por ahí.
//  4. La respuesta es idéntica sea cual sea la organización dueña del código: no delata a cuál pertenece.
//  5. El límite de aceptaciones fallidas por persona, por la API.
//  6. Sin sesión, nada responde.
//  7. (Corrección I1) Ver una invitación ajena (la vista previa) no escribe nada: ni en la auditoría de B ni en el
//     contador de fallos de la cuenta que mira. Solo intentar aceptar cuenta y deja registro.
//  8. (Decisión de Aarón en el PR #35, 2026-11-09; se construyó en el PR #36) El intento de alguien de FUERA de la organización de la invitación
//     queda en el registro de esa organización SIN autor (sin id, IP, navegador ni correlación); la copia completa
//     queda solo en la organización «plataforma». Quien es o fue de esa organización conserva su id. Las comprobaciones
//     de «cero» se hacen solo para quien NO es ni fue de esa organización, decidido en el momento (otras pruebas pueden
//     haber dejado a alguien como ex miembro), así que el resultado no depende del orden de los archivos; el Ataque 8
//     (el último de este archivo) lo comprueba al final, mirando todas las acciones.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rest, rpc } from "../support/local-supabase";
import {
  countWhere,
  fingerprint,
  fixture,
  openDb,
  orgMarkers,
  peopleOfOrgs,
  tenantHeader,
  tokenOf,
} from "./context";
import { ISOLATION_TABLES } from "./registry";
import type { PersonaKey } from "./fixture";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

const spec = (name: string) => ISOLATION_TABLES.find((t) => t.name === name)!;
const randomSha = () => randomBytes(32).toString("hex");
const BUSINESS_TABLES = ["invitations", "members", "email_messages", "audit_log"] as const;

/**
 * Huella de lo de B. En la auditoría NO cuentan los `invitation.accept_denied`: que quede escrito que alguien probó
 * el código de una invitación de B con otro correo es justamente lo que se quiere (se comprueba aparte).
 */
async function fingerprintB(name: (typeof BUSINESS_TABLES)[number]): Promise<string> {
  if (name !== "audit_log") return fingerprint(db, spec(name));
  const { rows } = await db.query<{ h: string }>(
    `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h
       from public.audit_log t
      where t.tenant_id = $1 and t.action <> 'invitation.accept_denied'`,
    [fixture().orgs.B.tenantId],
  );
  return rows[0].h;
}

async function snapshotB() {
  const out = new Map<string, string>();
  for (const name of BUSINESS_TABLES) out.set(name, await fingerprintB(name));
  return out;
}

/** Cuántos intentos de aceptar esa invitación hay en el registro de su organización (con o sin autor). */
const deniedFor = (tenantId: string, invitationId: string) =>
  countWhere(
    db,
    "audit_log",
    `action = 'invitation.accept_denied' and tenant_id = '${tenantId}' and resource_id = '${invitationId}'`,
  );

/**
 * Cuántas filas `invitation.accept_denied` de ESA organización guardan el id de esa persona en cualquier columna (el
 * texto de la fila entera). El montaje del mundo de pruebas deja otras filas con ids ajenos; esas las revisa el
 * Ataque 8 (a), que mira todas las acciones.
 */
async function idInOrgAudit(tenantId: string, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*)::text as n from public.audit_log t
      where t.tenant_id = $1 and t.action = 'invitation.accept_denied' and position($2 in t::text) > 0`,
    [tenantId, userId],
  );
  return Number(rows[0].n);
}

/**
 * Quien NO es ni fue de esa organización no deja su id en su registro. Quien sí lo es o lo fue (otras pruebas de este
 * mundo compartido pueden haber dejado a alguien como ex miembro: por ejemplo Carla en A) conserva su id por regla, y
 * ahí no hay nada que exigir. Se decide en el momento de comprobar, no al montar el mundo, para que el resultado no
 * dependa del orden en que corran los archivos.
 */
async function expectNoIdUnlessInsider(
  tenantId: string,
  userId: string,
  label: string,
): Promise<void> {
  if ((await peopleOfOrgs(db, [tenantId])).has(userId)) return;
  expect(await idInOrgAudit(tenantId, userId), label).toBe(0);
}

/** Cuántas copias de esos intentos hay en la organización «plataforma» (solo las ve Main Brain). */
async function platformDenied(userId: string, invitationId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*)::text as n from public.audit_log
      where action = 'invitation.accept_denied' and tenant_id = app.platform_tenant_id()
        and actor_user_id = $1 and resource_id = $2`,
    [userId, invitationId],
  );
  return Number(rows[0].n);
}

interface DeniedRow {
  actor_type: string;
  actor_user_id: string | null;
  origin_ip: string | null;
  user_agent: string | null;
  correlation_id: string | null;
  result: string;
  details: unknown;
}
/** La fila más reciente de ese intento en el registro de la organización de la invitación. */
async function lastDenied(tenantId: string, invitationId: string): Promise<DeniedRow> {
  const { rows } = await db.query<DeniedRow>(
    `select actor_type, actor_user_id, origin_ip::text, user_agent, correlation_id, result, details
       from public.audit_log
      where action = 'invitation.accept_denied' and tenant_id = $1 and resource_id = $2
      order by id desc limit 1`,
    [tenantId, invitationId],
  );
  return rows[0];
}

/** El navegador que manda `call`: así «navegador nulo» en el intento de alguien de fuera quiere decir que la función lo descartó. */
const CLIENT_USER_AGENT = "Prueba-Aislamiento/1.0";

/** Lo que tiene que cumplir un intento de alguien de FUERA: sin autor, IP, navegador ni correlación. */
const ANONYMOUS_ATTEMPT = {
  actor_type: "user",
  actor_user_id: null,
  origin_ip: null,
  user_agent: null,
  correlation_id: null,
  result: "denied",
  details: { reason: "wrong_email", step: "accept" },
};

/** Fallos de aceptación que lleva la cuenta (el contador guarda una huella del id, no el id). */
const failuresOf = async (userId: string): Promise<number> => {
  const key = createHash("sha256").update(`invite_accept_user|${userId}`).digest("hex");
  const { rows } = await db.query<{ failures: number }>(
    "select failures from public.auth_rate_limits where scope = 'invite_accept_user' and key_hash = $1",
    [key],
  );
  return rows[0]?.failures ?? 0;
};

const call = async (
  persona: PersonaKey,
  fn: "accept_invitation" | "invitation_preview",
  sha: string,
  header?: string,
) =>
  rpc(
    await tokenOf(persona),
    fn,
    { p_token_sha256: sha },
    {
      ...tenantHeader(header),
      // Como si llegaran de la aplicación: así «IP nula» y «correlación nula» en el intento de alguien de fuera quieren
      // decir que la función los descartó, no que nadie los mandó.
      "x-cp-client-ip": "203.0.113.7",
      "x-cp-request-id": randomUUID(),
      "user-agent": CLIENT_USER_AGENT,
    },
  );

describe("Ataque 1 · usar el código de una invitación de B (dirigida a otro correo) con el pase de A", () => {
  it.each(["accept_invitation", "invitation_preview"] as const)(
    "Ana, con %s, es rechazada: «wrong_email», B queda intacta y no se filtra nada de B",
    async (fn) => {
      const fx = fixture();
      const b = fx.orgs.B.invitation!;
      const before = await snapshotB();
      // Una llamada por función: aceptar gasta un intento del cupo de Ana (10 en 10 minutos); la vista previa no
      // gasta ninguno (corrección I1). La cabecera de B en una y ninguna en la otra; la de A la prueba Mixta más abajo.
      const deniedBefore = await deniedFor(fx.orgs.B.tenantId, b.invitationId);
      const platformBefore = await platformDenied(fx.personas.ana.userId, b.invitationId);
      const failuresBefore = await failuresOf(fx.personas.ana.userId);
      for (const header of [fn === "accept_invitation" ? fx.orgs.B.tenantId : undefined]) {
        const res = await call("ana", fn, b.tokenSha256, header);
        expect(res.status, `${fn} ${header}`).toBe(200);
        expect(res.json, `${fn} ${header}`).toEqual({ result: "wrong_email" });
        for (const marker of [...orgMarkers("B"), b.email, b.invitationId, fx.orgs.B.name]) {
          expect(res.text, `${fn} ${header}`).not.toContain(marker);
        }
      }
      for (const name of BUSINESS_TABLES) {
        expect(await fingerprintB(name), `${name} de B cambió`).toBe(before.get(name));
      }
      if (fn === "invitation_preview") {
        // Ver la pantalla no deja NADA: ni registro en B ni un fallo para Ana.
        expect(await deniedFor(fx.orgs.B.tenantId, b.invitationId)).toBe(deniedBefore);
        expect(await platformDenied(fx.personas.ana.userId, b.invitationId)).toBe(platformBefore);
        expect(await failuresOf(fx.personas.ana.userId)).toBe(failuresBefore);
        return;
      }
      // Lo único que queda en B es que ALGUIEN DE FUERA lo intentó: sin autor (ni id, ni IP, ni navegador, ni
      // correlación), sin su correo ni el código. Ana es de otra organización, así que su id no queda en B.
      expect(await deniedFor(fx.orgs.B.tenantId, b.invitationId)).toBe(deniedBefore + 1);
      expect(await failuresOf(fx.personas.ana.userId)).toBe(failuresBefore + 1);
      const denied = await lastDenied(fx.orgs.B.tenantId, b.invitationId);
      expect(denied).toEqual(ANONYMOUS_ATTEMPT);
      expect(JSON.stringify(denied.details)).not.toContain(fx.personas.ana.email);
      expect(JSON.stringify(denied.details)).not.toContain(b.tokenSha256);
      await expectNoIdUnlessInsider(fx.orgs.B.tenantId, fx.personas.ana.userId, "ana en B");
      // La copia completa (con el id de Ana) queda solo en la organización «plataforma».
      expect(await platformDenied(fx.personas.ana.userId, b.invitationId)).toBe(platformBefore + 1);
      expect(
        await countWhere(
          db,
          "members",
          `tenant_id = '${fx.orgs.B.tenantId}' and user_id = '${fx.personas.ana.userId}'`,
        ),
      ).toBe(0);
      expect(
        await countWhere(db, "invitations", `id = '${b.invitationId}' and status = 'pending'`),
      ).toBe(1);
    },
  );

  it("Beto (Dueño de B) tampoco entra a A con el código de una invitación de A", async () => {
    const fx = fixture();
    const a = fx.orgs.A.invitation!;
    const deniedBefore = await deniedFor(fx.orgs.A.tenantId, a.invitationId);
    const platformBefore = await platformDenied(fx.personas.beto.userId, a.invitationId);
    const res = await call("beto", "accept_invitation", a.tokenSha256, fx.orgs.B.tenantId);
    expect(res.json).toEqual({ result: "wrong_email" });
    // Beto es de B, no de A: el intento queda en A sin su id; la copia con su id, en la plataforma.
    expect(await deniedFor(fx.orgs.A.tenantId, a.invitationId)).toBe(deniedBefore + 1);
    expect(await lastDenied(fx.orgs.A.tenantId, a.invitationId)).toEqual(ANONYMOUS_ATTEMPT);
    await expectNoIdUnlessInsider(fx.orgs.A.tenantId, fx.personas.beto.userId, "beto en A");
    expect(await platformDenied(fx.personas.beto.userId, a.invitationId)).toBe(platformBefore + 1);
    expect(
      await countWhere(
        db,
        "members",
        `tenant_id = '${fx.orgs.A.tenantId}' and user_id = '${fx.personas.beto.userId}'`,
      ),
    ).toBe(0);
    expect(
      await countWhere(db, "invitations", `id = '${a.invitationId}' and status = 'pending'`),
    ).toBe(1);
  });

  it("el rol de la invitación no se puede cambiar desde la petición: la función no admite otros argumentos", async () => {
    const fx = fixture();
    const b = fx.orgs.B.invitation!;
    const token = await tokenOf("ana");
    for (const extra of [
      { p_role: "owner" },
      { role: "owner" },
      { p_tenant_id: fx.orgs.B.tenantId },
      { tenant_id: fx.orgs.B.tenantId },
      { p_member_id: fx.personas.ana.userId },
    ]) {
      const res = await rpc(token, "accept_invitation", {
        p_token_sha256: b.tokenSha256,
        ...extra,
      });
      expect(res.status, JSON.stringify(extra)).toBeGreaterThanOrEqual(400);
    }
    expect(
      await countWhere(
        db,
        "members",
        `tenant_id = '${fx.orgs.B.tenantId}' and user_id = '${fx.personas.ana.userId}'`,
      ),
    ).toBe(0);
  });
});

describe("Ataque 2 · quien está en A y en B, quien fue quitada y quien solo mira no cruzan por una invitación", () => {
  it("Mixta (Administradora de A y B), parada en A, no puede usar la invitación de B", async () => {
    const fx = fixture();
    const b = fx.orgs.B.invitation!;
    const before = await snapshotB();
    const deniedBefore = await deniedFor(fx.orgs.B.tenantId, b.invitationId);
    const platformBefore = await platformDenied(fx.personas.mixta.userId, b.invitationId);
    const res = await call("mixta", "accept_invitation", b.tokenSha256, fx.orgs.A.tenantId);
    expect(res.json).toEqual({ result: "wrong_email" });
    // El intento queda en la auditoría de B (la organización de la invitación), no en la de A: exactamente uno. Mixta
    // también es de B, así que ahí SÍ conserva su id (no es «de fuera»).
    expect(await deniedFor(fx.orgs.B.tenantId, b.invitationId)).toBe(deniedBefore + 1);
    const mixtaRow = await lastDenied(fx.orgs.B.tenantId, b.invitationId);
    expect(mixtaRow.actor_user_id).toBe(fx.personas.mixta.userId);
    // Quien es de B conserva también su IP y su correlación: así queda probado que las cabeceras que manda `call`
    // llegan de verdad a la función, y que «nulo» en el intento de alguien de fuera es porque la función las descartó.
    expect(mixtaRow.origin_ip).toBe("203.0.113.7/32");
    expect(mixtaRow.user_agent).toBe(CLIENT_USER_AGENT);
    expect(mixtaRow.correlation_id).not.toBeNull();
    expect(await platformDenied(fx.personas.mixta.userId, b.invitationId)).toBe(platformBefore + 1);
    expect(
      await countWhere(
        db,
        "audit_log",
        `action = 'invitation.accept_denied' and actor_user_id = '${fx.personas.mixta.userId}' and tenant_id = '${fx.orgs.A.tenantId}'`,
      ),
    ).toBe(0);
    for (const name of BUSINESS_TABLES) {
      expect(await fingerprintB(name), `${name} de B cambió`).toBe(before.get(name));
    }
  });

  it("Ex, con su pase todavía vigente, no vuelve a A con el código de otra invitación", async () => {
    const fx = fixture();
    const a = fx.orgs.A.invitation!;
    const deniedInABefore = await deniedFor(fx.orgs.A.tenantId, a.invitationId);
    // El estado de Ex en A en ESTE momento (quitada, o miembro activa si todavía no corrió el ciclo de vida), leído justo
    // antes del intento: de él depende lo que debe quedar en la fila.
    const { rows: statusRows } = await db.query<{ status: string }>(
      "select status from public.members where tenant_id = $1 and user_id = $2",
      [fx.orgs.A.tenantId, fx.personas.ex.userId],
    );
    expect(statusRows, "Ex debe tener fila en `members` de A").toHaveLength(1);
    const res = await call("ex", "accept_invitation", a.tokenSha256, fx.orgs.A.tenantId);
    expect(res.json).toEqual({ result: "wrong_email" });
    // Ex tiene (o tuvo) una fila en `members` de A: no es «de fuera», conserva su id en el registro de A.
    expect(await deniedFor(fx.orgs.A.tenantId, a.invitationId)).toBe(deniedInABefore + 1);
    const last = await lastDenied(fx.orgs.A.tenantId, a.invitationId);
    expect(last.actor_user_id).toBe(fx.personas.ex.userId);
    // Su IP, su navegador y su correlación solo se guardan si hoy es miembro ACTIVA (menor 1 del PR #36), comprobado por
    // la API real (la función llega con las cabeceras que manda `call`).
    if (statusRows[0].status === "removed") {
      expect(last.origin_ip, "Ex quitada: sin IP").toBeNull();
      expect(last.user_agent, "Ex quitada: sin navegador").toBeNull();
      expect(last.correlation_id, "Ex quitada: sin correlación").toBeNull();
    } else {
      expect(statusRows[0].status).toBe("active");
      expect(last.origin_ip, "Ex activa: con IP").toBe("203.0.113.7/32");
      expect(last.user_agent, "Ex activa: con navegador").toBe(CLIENT_USER_AGENT);
      expect(last.correlation_id, "Ex activa: con correlación").not.toBeNull();
    }
    // Su estado en A es el que tenía (quitada, o miembro si todavía no corrió el ciclo de vida): no cambia por esto.
    expect(
      await countWhere(
        db,
        "audit_log",
        `action = 'invitation.accepted' and resource_id = '${a.invitationId}'`,
      ),
    ).toBe(0);
    // Y con la invitación de B tampoco.
    const b = fx.orgs.B.invitation!;
    const deniedBefore = await deniedFor(fx.orgs.B.tenantId, b.invitationId);
    const platformBefore = await platformDenied(fx.personas.ex.userId, b.invitationId);
    const inB = await call("ex", "accept_invitation", b.tokenSha256);
    expect(inB.json).toEqual({ result: "wrong_email" });
    // En B, Ex es de fuera: el intento queda sin autor y su id solo en la copia de la plataforma.
    expect(await deniedFor(fx.orgs.B.tenantId, b.invitationId)).toBe(deniedBefore + 1);
    expect(await lastDenied(fx.orgs.B.tenantId, b.invitationId)).toEqual(ANONYMOUS_ATTEMPT);
    await expectNoIdUnlessInsider(fx.orgs.B.tenantId, fx.personas.ex.userId, "ex en B");
    expect(await platformDenied(fx.personas.ex.userId, b.invitationId)).toBe(platformBefore + 1);
    expect(
      await countWhere(
        db,
        "members",
        `tenant_id = '${fx.orgs.B.tenantId}' and user_id = '${fx.personas.ex.userId}'`,
      ),
    ).toBe(0);
  });

  it("Dante (Observador de A) no ve nada de B por la vista previa de su invitación", async () => {
    const fx = fixture();
    const res = await call("dante", "invitation_preview", fx.orgs.B.invitation!.tokenSha256);
    expect(res.json).toEqual({ result: "wrong_email" });
    for (const marker of orgMarkers("B")) expect(res.text).not.toContain(marker);
  });

  it("nadie ve las invitaciones por la API de tablas a raíz de haber probado un código (siguen siendo privadas)", async () => {
    const fx = fixture();
    const res = await rest(await tokenOf("dante"), "invitations?select=id", {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    expect(res.json).toEqual([]);
  });
});

describe("Ataque 3 · la respuesta no delata a qué organización pertenece un código", () => {
  it("un código de A, uno de B y uno que no existe se ven distintos solo por «existe o no», nunca por organización", async () => {
    const fx = fixture();
    const fromA = await call("carla", "accept_invitation", fx.orgs.A.invitation!.tokenSha256);
    const fromB = await call("carla", "accept_invitation", fx.orgs.B.invitation!.tokenSha256);
    expect(fromA.json).toEqual({ result: "wrong_email" });
    expect(fromB.json).toEqual({ result: "wrong_email" });
    expect(fromA.text).toBe(fromB.text);
    const missing = await call("carla", "accept_invitation", randomSha());
    expect(missing.json).toEqual({ result: "not_found" });
  });
});

describe("Ataque 4 · adivinar códigos: el límite de aceptaciones fallidas", () => {
  it("Carla prueba 10 códigos al azar y a la 11 queda bloqueada, también con un código que existe", async () => {
    const fx = fixture();
    const before = await snapshotB();
    // Carla es de la organización C: en A y en B es de fuera y no deja su id (salvo que otra prueba la haya dejado como ex miembro). Se cuentan los intentos por invitación
    // (en los registros de A y B, sin autor) y sus copias en la plataforma (con su id).
    const a = fx.orgs.A.invitation!;
    const b = fx.orgs.B.invitation!;
    const deniedByCarla = async () =>
      (await deniedFor(fx.orgs.A.tenantId, a.invitationId)) +
      (await deniedFor(fx.orgs.B.tenantId, b.invitationId)) +
      (await platformDenied(fx.personas.carla.userId, a.invitationId)) +
      (await platformDenied(fx.personas.carla.userId, b.invitationId));
    // Carla ya gastó 2 fallos en la prueba anterior (A y B); se completan hasta el tope.
    let result: unknown = null;
    for (let n = 0; n < 12; n++) {
      result = (await call("carla", "accept_invitation", randomSha())).json;
      if ((result as { result: string }).result === "rate_limited") break;
    }
    expect(result).toEqual({ result: "rate_limited" });
    // Los códigos al azar no tienen organización: no dejaron ningún registro. Se cuentan los de antes del bloqueo
    // (los de Carla en A y B: dos por intento, uno en la organización y su copia en la plataforma).
    const deniedWhenLocked = await deniedByCarla();
    // Bloqueada: ni el código de una invitación real se prueba.
    const real = await call("carla", "accept_invitation", fx.orgs.A.invitation!.tokenSha256);
    expect(real.json).toEqual({ result: "rate_limited" });
    const preview = await call("carla", "invitation_preview", fx.orgs.B.invitation!.tokenSha256);
    expect(preview.json).toEqual({ result: "rate_limited" });
    // Bloqueada no se escribe NADA en la auditoría: el registro no crece más rápido que el límite.
    expect(await deniedByCarla()).toBe(deniedWhenLocked);
    // Y su id no está en el registro de A ni de B (solo en la copia de la plataforma), salvo que sea o haya sido de esa
    // organización (igual que arriba).
    await expectNoIdUnlessInsider(fx.orgs.A.tenantId, fx.personas.carla.userId, "carla en A");
    await expectNoIdUnlessInsider(fx.orgs.B.tenantId, fx.personas.carla.userId, "carla en B");
    for (const name of BUSINESS_TABLES) {
      expect(await fingerprintB(name), `${name} de B cambió`).toBe(before.get(name));
    }
    // El bloqueo es de ESA cuenta: otra persona sigue siendo atendida normalmente.
    const other = await call("beto", "accept_invitation", randomSha());
    expect(other.json).toEqual({ result: "not_found" });
  });
});

describe("Ataque 5 · sin sesión no responde nada", () => {
  it.each(["accept_invitation", "invitation_preview"] as const)(
    "%s sin pase (solo la llave pública) se rechaza",
    async (fn) => {
      const fx = fixture();
      const res = await rpc(
        null,
        fn,
        { p_token_sha256: fx.orgs.B.invitation!.tokenSha256 },
        tenantHeader(fx.orgs.A.tenantId),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      for (const marker of orgMarkers("B")) expect(res.text).not.toContain(marker);
    },
  );
});

describe("Ataque 6 · por GET no se pueden probar códigos saltándose el límite", () => {
  it("una invitación cancelada de A, consultada por GET con un pase real, no entrega ningún resultado", async () => {
    const fx = fixture();
    const { buildNewInvitation } = await import("@/lib/team/record");
    const mine = buildNewInvitation(
      fx.orgs.A.tenantId,
      `get-${fx.runId}@ejemplo.test`.toLowerCase(),
      "viewer",
    );
    const owner = await tokenOf("ana");
    const created = await rpc(
      owner,
      "create_invitation",
      mine.params,
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(created.status, created.text).toBe(200);
    const revoked = await rpc(
      owner,
      "revoke_invitation",
      { p_invitation_id: mine.invitationId },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(revoked.status, revoked.text).toBe(200);

    const sha = mine.params.p_token_sha256;
    const token = await tokenOf("dante");
    for (const fn of ["invitation_preview", "accept_invitation"]) {
      const res = await rest(token, `rpc/${fn}?p_token_sha256=${sha}`, { method: "GET" });
      expect(res.status, `${fn} por GET`).toBeGreaterThanOrEqual(400);
      expect((res.json as { code?: string }).code, `${fn} por GET`).toBe("25006");
      expect(res.text, `${fn} por GET`).not.toContain("result");
      expect(res.text, `${fn} por GET`).not.toContain("revoked");
    }
    // Por POST, en cambio, sí contesta; y como Dante no es la persona invitada, no se entera de que está cancelada
    // (la misma respuesta que con una invitación pendiente).
    const viaPost = await call("dante", "invitation_preview", sha);
    expect(viaPost.json).toEqual({ result: "wrong_email" });
  });
});

describe("Ataque 7 · mirar una invitación ajena (la vista previa) no escribe nada ni bloquea a la víctima", () => {
  it("Dante abre 15 códigos inventados y 15 veces la invitación de B: ni auditoría, ni fallos, ni cambios en B", async () => {
    const fx = fixture();
    const dante = fx.personas.dante.userId;
    const b = fx.orgs.B.invitation!;
    const allAudit = () =>
      db
        .query<{ n: string; h: string }>(
          `select count(*) as n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h
             from public.audit_log t`,
        )
        .then((r) => r.rows[0]);
    const auditBefore = await allAudit();
    const deniedBeforeB = await deniedFor(fx.orgs.B.tenantId, b.invitationId);
    const failuresBefore = await failuresOf(dante);
    const before = await snapshotB();
    for (let n = 0; n < 15; n++) {
      const invented = await call("dante", "invitation_preview", randomSha());
      expect(invented.json).toEqual({ result: "not_found" });
      const foreign = await call("dante", "invitation_preview", b.tokenSha256);
      expect(foreign.json).toEqual({ result: "wrong_email" });
    }
    // Ninguna fila nueva en la auditoría de NINGUNA organización, y el contador de Dante igual.
    expect(await allAudit()).toEqual(auditBefore);
    expect(await failuresOf(dante)).toBe(failuresBefore);
    expect(await deniedFor(fx.orgs.B.tenantId, b.invitationId)).toBe(deniedBeforeB);
    expect(await platformDenied(dante, b.invitationId)).toBe(0);
    for (const name of BUSINESS_TABLES) {
      expect(await fingerprintB(name), `${name} de B cambió`).toBe(before.get(name));
    }
    // Y sigue sin estar bloqueado: la vista previa de su propia invitación no dice «rate_limited».
    const own = await call("dante", "invitation_preview", fx.orgs.A.invitation!.tokenSha256);
    expect((own.json as { result: string }).result).not.toBe("rate_limited");
  });
});

describe("Ataque 8 · el id de alguien de fuera no queda en el registro de una organización, en ningún orden", () => {
  // Este bloque va AL FINAL de este archivo a propósito: así los intentos de los ataques anteriores ya ocurrieron y
  // se prueba siempre el orden malo (primero los intentos, después la lectura). Además `tables-read.test.ts` compara
  // quién es «visible» en cada organización con las filas de `members`: si el registro guardara el id de alguien de
  // fuera, esa prueba fallaría o pasaría según el orden de los archivos. Aquí se comprueba directo, sin depender de él.
  it("(a) en la base, ninguna fila de A, B ni C (en cualquier columna) guarda el id de alguien que no es ni fue de esa organización", async () => {
    const fx = fixture();
    for (const key of ["A", "B", "C"] as const) {
      const tenantId = fx.orgs[key].tenantId;
      // Se extraen los UUID del texto de la FILA ENTERA (autor, recurso, detalles...), no solo de `actor_user_id`, y se
      // comparan con las cuentas. «Ajena» = cuenta de `auth.users` sin ninguna fila en `members` de esa organización, en
      // cualquier estado. (Cada fila se recorre una vez, en vez de cruzar todas las cuentas con todas las filas.)
      const { rows } = await db.query<{ action: string; user_id: string }>(
        `with found as (
           select a.action, (regexp_matches(a::text, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g'))[1] as uuid
             from public.audit_log a where a.tenant_id = $1)
         select distinct f.action, u.id::text as user_id
           from found f join auth.users u on u.id::text = f.uuid
          where not exists (select 1 from public.members m where m.tenant_id = $1 and m.user_id = u.id)`,
        [tenantId],
      );
      expect(rows, `organización ${key}`).toEqual([]);
    }
  });

  it("(b) por la API: el Dueño de A y el de B leen su auditoría completa y no aparece el id ni el correo de nadie que no sea de su organización", async () => {
    const fx = fixture();
    for (const [persona, key] of [
      ["ana", "A"],
      ["beto", "B"],
    ] as const) {
      const tenantId = fx.orgs[key].tenantId;
      const res = await rest(await tokenOf(persona), "audit_log?select=*&order=id.desc", {
        headers: tenantHeader(tenantId),
      });
      expect(res.status, `${persona} ${key}`).toBe(200);
      const own = await peopleOfOrgs(db, [tenantId]);
      expect(Array.isArray(res.json) && res.json.length > 0, `${persona} ${key}`).toBe(true);
      // La API entrega como máximo 1.000 filas (`max_rows`): si llegan tantas, la lectura puede venir cortada y esta
      // comprobación se quedaría ciega en silencio.
      expect(
        (res.json as unknown[]).length,
        `${persona} ${key}: respuesta posiblemente cortada`,
      ).toBeLessThan(1000);
      for (const other of Object.values(fx.personas)) {
        if (own.has(other.userId)) continue;
        expect(res.text, `${persona} ${key}: id de ${other.email}`).not.toContain(other.userId);
        expect(res.text, `${persona} ${key}: correo de ${other.email}`).not.toContain(other.email);
      }
      // Y sí ve que alguien de fuera lo intentó: filas sin autor.
      const anonymous = (res.json as { action: string; actor_user_id: string | null }[]).filter(
        (r) => r.action === "invitation.accept_denied" && r.actor_user_id === null,
      );
      expect(anonymous.length, `${persona} ${key}`).toBeGreaterThan(0);
    }
  });
});
