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
import { createHash, randomBytes } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rest, rpc } from "../support/local-supabase";
import {
  countWhere,
  fingerprint,
  fixture,
  openDb,
  orgMarkers,
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

const deniedInB = async (userId: string) =>
  countWhere(
    db,
    "audit_log",
    `action = 'invitation.accept_denied' and tenant_id = '${fixture().orgs.B.tenantId}' and actor_user_id = '${userId}'`,
  );

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
) => rpc(await tokenOf(persona), fn, { p_token_sha256: sha }, tenantHeader(header));

describe("Ataque 1 · usar el código de una invitación de B (dirigida a otro correo) con el pase de A", () => {
  it.each(["accept_invitation", "invitation_preview"] as const)(
    "Ana, con %s, es rechazada: «wrong_email», B queda intacta y no se filtra nada de B",
    async (fn) => {
      const fx = fixture();
      const b = fx.orgs.B.invitation!;
      const before = await snapshotB();
      // Una llamada por función: aceptar gasta un intento del cupo de Ana (10 en 10 minutos); la vista previa no
      // gasta ninguno (corrección I1). La cabecera de B en una y ninguna en la otra; la de A la prueba Mixta más abajo.
      const deniedBefore = await deniedInB(fx.personas.ana.userId);
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
        expect(await deniedInB(fx.personas.ana.userId)).toBe(deniedBefore);
        expect(await failuresOf(fx.personas.ana.userId)).toBe(failuresBefore);
        return;
      }
      // Lo único que queda en B es el registro de que Ana lo intentó, sin su correo ni el código.
      expect(await deniedInB(fx.personas.ana.userId)).toBe(deniedBefore + 1);
      expect(await failuresOf(fx.personas.ana.userId)).toBe(failuresBefore + 1);
      const { rows: denied } = await db.query<{ details: unknown; result: string }>(
        `select details, result from public.audit_log
          where action = 'invitation.accept_denied' and tenant_id = $1 and actor_user_id = $2
          order by id desc limit 1`,
        [fx.orgs.B.tenantId, fx.personas.ana.userId],
      );
      expect(denied[0].result).toBe("denied");
      expect(JSON.stringify(denied[0].details)).not.toContain(fx.personas.ana.email);
      expect(JSON.stringify(denied[0].details)).not.toContain(b.tokenSha256);
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
    const res = await call("beto", "accept_invitation", a.tokenSha256, fx.orgs.B.tenantId);
    expect(res.json).toEqual({ result: "wrong_email" });
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
    const deniedBefore = await deniedInB(fx.personas.mixta.userId);
    const res = await call("mixta", "accept_invitation", b.tokenSha256, fx.orgs.A.tenantId);
    expect(res.json).toEqual({ result: "wrong_email" });
    // El intento queda en la auditoría de B (la organización de la invitación), no en la de A: exactamente uno.
    expect(await deniedInB(fx.personas.mixta.userId)).toBe(deniedBefore + 1);
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
    const res = await call("ex", "accept_invitation", a.tokenSha256, fx.orgs.A.tenantId);
    expect(res.json).toEqual({ result: "wrong_email" });
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
    const deniedBefore = await deniedInB(fx.personas.ex.userId);
    const inB = await call("ex", "accept_invitation", b.tokenSha256);
    expect(inB.json).toEqual({ result: "wrong_email" });
    expect(await deniedInB(fx.personas.ex.userId)).toBe(deniedBefore + 1);
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
    const deniedByCarla = () =>
      countWhere(
        db,
        "audit_log",
        `action = 'invitation.accept_denied' and actor_user_id = '${fx.personas.carla.userId}'`,
      );
    // Carla ya gastó 2 fallos en la prueba anterior (A y B); se completan hasta el tope.
    let result: unknown = null;
    for (let n = 0; n < 12; n++) {
      result = (await call("carla", "accept_invitation", randomSha())).json;
      if ((result as { result: string }).result === "rate_limited") break;
    }
    expect(result).toEqual({ result: "rate_limited" });
    // Los códigos al azar no tienen organización: no dejaron ningún registro. Se cuentan los de antes del bloqueo.
    const deniedWhenLocked = await deniedByCarla();
    // Bloqueada: ni el código de una invitación real se prueba.
    const real = await call("carla", "accept_invitation", fx.orgs.A.invitation!.tokenSha256);
    expect(real.json).toEqual({ result: "rate_limited" });
    const preview = await call("carla", "invitation_preview", fx.orgs.B.invitation!.tokenSha256);
    expect(preview.json).toEqual({ result: "rate_limited" });
    // Bloqueada no se escribe NADA en la auditoría: el registro no crece más rápido que el límite.
    expect(await deniedByCarla()).toBe(deniedWhenLocked);
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
    // Por POST, en cambio, sí contesta.
    const viaPost = await call("dante", "invitation_preview", sha);
    expect(viaPost.json).toEqual({ result: "revoked" });
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
    expect(await deniedInB(dante)).toBe(0);
    for (const name of BUSINESS_TABLES) {
      expect(await fingerprintB(name), `${name} de B cambió`).toBe(before.get(name));
    }
    // Y sigue sin estar bloqueado: la vista previa de su propia invitación no dice «rate_limited».
    const own = await call("dante", "invitation_preview", fx.orgs.A.invitation!.tokenSha256);
    expect((own.json as { result: string }).result).not.toBe("rate_limited");
  });
});
