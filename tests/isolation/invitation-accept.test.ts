// Sprint 5 · H-009 · Aislamiento de aceptar una invitación: ataques con pases reales y `fetch` directo.
//  1. Una persona usa el código de una invitación de OTRA organización dirigida a otro correo: «wrong_email», la
//     otra organización queda intacta y no se entrega ni su nombre ni su id ni su canario.
//  2. Da igual la cabecera de organización que mande: aceptar no la lee (la organización sale de la invitación).
//  3. Quien está en A y en B (Mixta), quien fue quitada (Ex) y quien solo mira (Dante) tampoco entran por ahí.
//  4. La respuesta es idéntica sea cual sea la organización dueña del código: no delata a cuál pertenece.
//  5. El límite de aceptaciones fallidas por persona, por la API.
//  6. Sin sesión, nada responde.
import { randomBytes } from "node:crypto";
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

async function snapshotB() {
  const out = new Map<string, string>();
  for (const name of BUSINESS_TABLES) out.set(name, await fingerprint(db, spec(name)));
  return out;
}

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
      // Dos llamadas por función: cada intento fallido gasta el cupo de Ana (10 en 10 minutos).
      for (const header of [fx.orgs.B.tenantId, undefined]) {
        const res = await call("ana", fn, b.tokenSha256, header);
        expect(res.status, `${fn} ${header}`).toBe(200);
        expect(res.json, `${fn} ${header}`).toEqual({ result: "wrong_email" });
        for (const marker of [...orgMarkers("B"), b.email, b.invitationId, fx.orgs.B.name]) {
          expect(res.text, `${fn} ${header}`).not.toContain(marker);
        }
      }
      for (const name of BUSINESS_TABLES) {
        expect(await fingerprint(db, spec(name)), `${name} de B cambió`).toBe(before.get(name));
      }
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
    const res = await call("mixta", "accept_invitation", b.tokenSha256, fx.orgs.A.tenantId);
    expect(res.json).toEqual({ result: "wrong_email" });
    for (const name of BUSINESS_TABLES) {
      expect(await fingerprint(db, spec(name)), `${name} de B cambió`).toBe(before.get(name));
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
    const inB = await call("ex", "accept_invitation", b.tokenSha256);
    expect(inB.json).toEqual({ result: "wrong_email" });
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
    // Carla ya gastó 2 fallos en la prueba anterior (A y B); se completan hasta el tope.
    let result: unknown = null;
    for (let n = 0; n < 12; n++) {
      result = (await call("carla", "accept_invitation", randomSha())).json;
      if ((result as { result: string }).result === "rate_limited") break;
    }
    expect(result).toEqual({ result: "rate_limited" });
    // Bloqueada: ni el código de una invitación real se prueba.
    const real = await call("carla", "accept_invitation", fx.orgs.A.invitation!.tokenSha256);
    expect(real.json).toEqual({ result: "rate_limited" });
    const preview = await call("carla", "invitation_preview", fx.orgs.B.invitation!.tokenSha256);
    expect(preview.json).toEqual({ result: "rate_limited" });
    for (const name of BUSINESS_TABLES) {
      expect(await fingerprint(db, spec(name)), `${name} de B cambió`).toBe(before.get(name));
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
