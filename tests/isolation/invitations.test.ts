// Sprint 5 · H-008 · Aislamiento de las invitaciones: ataques con pases reales y `fetch` directo.
//  1. Apuntar a B con el pase de A (cabecera de B) para invitar, reenviar o cancelar: «No encontrado» y B intacta.
//  2. Quien está en A y en B (Mixta) no puede tocar una invitación de B estando en A.
//  3. Nadie, ni el Administrador, lee la huella del código, el vínculo ni la huella del correo.
//  4. Ninguna persona de A ve invitaciones de B (ni el correo de B), y quien no maneja el equipo no ve ninguna.
//  5. El correo de la invitación (registro de correos) tampoco se filtra a quien no maneja el equipo.
//  6. (H-010) Un Administrador no invita Administradores ni redirige, reenviándola con otro vínculo, la invitación a
//     Administrador del Dueño: «solo el Dueño» (`owner_only`) y nada cambia.
//  7. (H-010, revisión del 2026-11-06) Quitar a quien reenvió cancela lo que reenvió en ESA organización y nada de la otra.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rest, rpc } from "../support/local-supabase";
import { countWhere, fingerprint, fixture, openDb, tenantHeader, tokenOf } from "./context";
import { ISOLATION_TABLES } from "./registry";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

const codeOf = (res: { json: unknown }) => (res.json as { code?: string } | null)?.code;
const spec = (name: string) => ISOLATION_TABLES.find((t) => t.name === name)!;
const HEX64 = "a".repeat(64);

describe("Ataque 1 · invitar, reenviar o cancelar en B con el pase de A", () => {
  it("Ana, con la cabecera de B, no puede crear, reenviar ni cancelar: no es miembro de B (CP404) y B queda intacta", async () => {
    const fx = fixture();
    const b = fx.orgs.B.invitation!;
    const token = await tokenOf("ana");
    const tables = ["invitations", "email_messages", "audit_log", "members"].map(spec);
    const before = new Map<string, string>();
    for (const t of tables) before.set(t.name, await fingerprint(db, t));

    const calls: [string, object][] = [
      [
        "create_invitation",
        {
          p_invitation_id: randomUUID(),
          p_email_enc: "ataque",
          p_email_hash: HEX64,
          p_email_binding: HEX64,
          p_token_sha256: "1".repeat(64),
          p_role: "admin",
          p_email_message_id: randomUUID(),
          p_to_email_enc: "ataque",
        },
      ],
      [
        "resend_invitation",
        {
          p_invitation_id: b.invitationId,
          p_email_binding: HEX64,
          p_token_sha256: "2".repeat(64),
          p_email_message_id: randomUUID(),
          p_to_email_enc: "ataque",
        },
      ],
      ["revoke_invitation", { p_invitation_id: b.invitationId }],
    ];
    for (const [name, args] of calls) {
      for (const header of [fx.orgs.B.tenantId, undefined, ""]) {
        const res = await rpc(token, name, args, tenantHeader(header));
        expect(res.status, `${name} ${header}`).toBeGreaterThanOrEqual(400);
        expect(codeOf(res), `${name} ${header}`).toBe("CP404");
        expect(res.text).not.toContain(b.email);
      }
    }
    for (const t of tables)
      expect(await fingerprint(db, t), `${t.name} cambió`).toBe(before.get(t.name));
  });

  it("Beto (Dueño de B) no puede tocar la invitación de A usando la cabecera de A ni la de B", async () => {
    const fx = fixture();
    const a = fx.orgs.A.invitation!;
    const token = await tokenOf("beto");
    const invitations = spec("invitations");
    const before = await fingerprint(db, spec("invitations"));
    const asA = await rpc(
      token,
      "revoke_invitation",
      { p_invitation_id: a.invitationId },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(codeOf(asA)).toBe("CP404");
    // Con su propia organización, el id de A no existe para él.
    const asB = await rpc(
      token,
      "revoke_invitation",
      { p_invitation_id: a.invitationId },
      tenantHeader(fx.orgs.B.tenantId),
    );
    expect(codeOf(asB)).toBe("CP404");
    const resend = await rpc(
      token,
      "resend_invitation",
      {
        p_invitation_id: a.invitationId,
        p_email_binding: HEX64,
        p_token_sha256: "3".repeat(64),
        p_email_message_id: randomUUID(),
        p_to_email_enc: "ataque",
      },
      tenantHeader(fx.orgs.B.tenantId),
    );
    expect(codeOf(resend)).toBe("CP404");
    expect(await fingerprint(db, invitations)).toBe(before);
    expect(
      await countWhere(db, "invitations", `id = '${a.invitationId}' and status = 'pending'`),
    ).toBe(1);
  });
});

describe("Ataque 2 · quien está en A y en B no cruza de una a otra", () => {
  it("Mixta (Administradora de A y de B), parada en A, no puede cancelar ni reenviar la invitación de B", async () => {
    const fx = fixture();
    const b = fx.orgs.B.invitation!;
    const token = await tokenOf("mixta");
    const before = await fingerprint(db, spec("invitations"));
    const revoke = await rpc(
      token,
      "revoke_invitation",
      { p_invitation_id: b.invitationId },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(codeOf(revoke)).toBe("CP404");
    const resend = await rpc(
      token,
      "resend_invitation",
      {
        p_invitation_id: b.invitationId,
        p_email_binding: HEX64,
        p_token_sha256: "4".repeat(64),
        p_email_message_id: randomUUID(),
        p_to_email_enc: "ataque",
      },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(codeOf(resend)).toBe("CP404");
    expect(await fingerprint(db, spec("invitations"))).toBe(before);
  });

  it("Mixta invita a un correo ya invitado en B: en A es una invitación nueva y la de B no cambia", async () => {
    const fx = fixture();
    const b = fx.orgs.B.invitation!;
    const before = await fingerprint(db, spec("invitations"));
    const token = await tokenOf("mixta");
    // Mismo correo normalizado que la invitación de B, pero otra organización: la huella lleva la organización.
    const { buildNewInvitation } = await import("@/lib/team/record");
    const mine = buildNewInvitation(fx.orgs.A.tenantId, b.email, "viewer");
    const res = await rpc(
      token,
      "create_invitation",
      mine.params,
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(res.status, res.text).toBe(200);
    expect((res.json as { result: string }).result).toBe("created");
    expect(await fingerprint(db, spec("invitations"))).toBe(before);
    // Se deja la fixture como estaba para las demás pruebas.
    const cancel = await rpc(
      token,
      "revoke_invitation",
      { p_invitation_id: mine.invitationId },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(cancel.status, cancel.text).toBe(200);
  });
});

describe("Ataque 3 · las huellas y el vínculo no los lee nadie con un pase", () => {
  it.each(["ana", "mixta"] as const)(
    "%s (Dueña o Administradora) lee las columnas permitidas pero no las privadas",
    async (persona) => {
      const fx = fixture();
      const token = await tokenOf(persona);
      const headers = tenantHeader(fx.orgs.A.tenantId);
      const ok = await rest(
        token,
        "invitations?select=id,tenant_id,email_enc,role,status,expires_at,send_count",
        { headers },
      );
      expect(ok.status, ok.text).toBe(200);
      expect((ok.json as unknown[]).length).toBeGreaterThan(0);
      for (const column of [
        "token_sha256",
        "email_binding",
        "email_hash",
        "owner_notice_state",
        "owner_notice_attempts",
        "owner_notice_last_attempt_at",
        "resent_by",
        "*",
      ]) {
        const res = await rest(token, `invitations?select=${column}`, { headers });
        expect(res.status, `${persona} ${column}`).toBeGreaterThanOrEqual(400);
        expect(res.text).not.toContain(fx.orgs.A.invitation!.tokenSha256);
      }
      // Ni escribir en las columnas del aviso al Dueño (darlo por enviado, vaciar los intentos…).
      for (const body of [
        { owner_notice_state: "sent" },
        { owner_notice_attempts: 0 },
        { owner_notice_last_attempt_at: null },
        // Ni anotarse (o borrar) quién reenvió: es lo que decide a quién cancela la limpieza.
        { resent_by: fixture().personas[persona].userId },
        { resent_by: null },
      ]) {
        const patch = await rest(token, `invitations?id=eq.${fx.orgs.A.invitation!.invitationId}`, {
          method: "PATCH",
          headers: { ...headers, Prefer: "return=representation" },
          body,
        });
        expect(patch.status, `${persona} escribir ${Object.keys(body)[0]}`).toBeGreaterThanOrEqual(
          400,
        );
      }
      // Tampoco sirve filtrar por ellas para adivinar su valor.
      for (const column of ["token_sha256", "email_hash", "email_binding"]) {
        const probe = await rest(
          token,
          `invitations?select=id&${column}=eq.${fx.orgs.A.invitation!.tokenSha256}`,
          { headers },
        );
        expect(probe.status, `${persona} filtrar por ${column}`).toBeGreaterThanOrEqual(400);
      }
      // Ni filtrar por `resent_by` para averiguar quién reenvió.
      const byResender = await rest(
        token,
        `invitations?select=id&resent_by=eq.${fx.personas.mixta.userId}`,
        { headers },
      );
      expect(byResender.status, `${persona} filtrar por resent_by`).toBeGreaterThanOrEqual(400);
    },
  );
});

describe("Ataque 4 · quién ve las invitaciones", () => {
  it("Ana y Mixta, en A, ven solo las de A; el correo y el id de B no aparecen", async () => {
    const fx = fixture();
    for (const persona of ["ana", "mixta"] as const) {
      const res = await rest(
        await tokenOf(persona),
        "invitations?select=id,tenant_id,email_enc,role",
        {
          headers: tenantHeader(fx.orgs.A.tenantId),
        },
      );
      const rows = res.json as { id: string; tenant_id: string }[];
      expect(rows.length, persona).toBeGreaterThan(0);
      expect(
        rows.every((r) => r.tenant_id === fx.orgs.A.tenantId),
        persona,
      ).toBe(true);
      expect(
        rows.map((r) => r.id),
        persona,
      ).toContain(fx.orgs.A.invitation!.invitationId);
      expect(
        rows.map((r) => r.id),
        persona,
      ).not.toContain(fx.orgs.B.invitation!.invitationId);
      expect(res.text).not.toContain(fx.orgs.B.invitation!.email);
      expect(res.text).not.toContain(fx.orgs.B.tenantId);
    }
  });

  it("Ana con la cabecera de B (no es miembro) no ve nada; tampoco el id de la invitación de B", async () => {
    const fx = fixture();
    const res = await rest(
      await tokenOf("ana"),
      `invitations?select=id&id=eq.${fx.orgs.B.invitation!.invitationId}`,
      {
        headers: tenantHeader(fx.orgs.B.tenantId),
      },
    );
    expect(res.json).toEqual([]);
  });

  it("Dante (Observador de A) no ve ninguna invitación, ni siquiera las de su propia organización", async () => {
    const fx = fixture();
    const res = await rest(await tokenOf("dante"), "invitations?select=id", {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    expect(res.json).toEqual([]);
  });

  it("Beto solo ve la de B", async () => {
    const fx = fixture();
    const res = await rest(await tokenOf("beto"), "invitations?select=id,tenant_id", {
      headers: tenantHeader(fx.orgs.B.tenantId),
    });
    const rows = res.json as { id: string; tenant_id: string }[];
    expect(rows.map((r) => r.id)).toEqual([fx.orgs.B.invitation!.invitationId]);
  });

  it("nadie con un pase crea, edita ni borra una invitación por la API de tablas", async () => {
    const fx = fixture();
    const a = fx.orgs.A.invitation!;
    const before = await fingerprint(db, spec("invitations"));
    for (const persona of ["ana", "mixta"] as const) {
      const token = await tokenOf(persona);
      const headers = { ...tenantHeader(fx.orgs.A.tenantId), Prefer: "return=representation" };
      const patch = await rest(token, `invitations?id=eq.${a.invitationId}`, {
        method: "PATCH",
        headers,
        body: { role: "admin" },
      });
      expect(
        patch.status >= 400 || (patch.json as unknown[]).length === 0,
        `${persona} PATCH`,
      ).toBe(true);
      const del = await rest(token, `invitations?id=eq.${a.invitationId}`, {
        method: "DELETE",
        headers,
      });
      expect(del.status >= 400 || (del.json as unknown[]).length === 0, `${persona} DELETE`).toBe(
        true,
      );
    }
    expect(await fingerprint(db, spec("invitations"))).toBe(before);
  });
});

describe("Ataque 5 · el registro de correos no filtra el correo de la invitación", () => {
  it("el Observador no ve el correo de la invitación; la Dueña ve el de A y nunca el de B", async () => {
    const fx = fixture();
    const select = "email_messages?select=id,tenant_id,kind,to_email_enc&kind=eq.invitation";
    const viewer = await rest(await tokenOf("dante"), select, {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    expect(viewer.json).toEqual([]);
    const owner = await rest(await tokenOf("ana"), select, {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    const rows = owner.json as { id: string; tenant_id: string }[];
    expect(rows.map((r) => r.id)).toContain(fx.orgs.A.invitation!.emailMessageId);
    expect(rows.map((r) => r.id)).not.toContain(fx.orgs.B.invitation!.emailMessageId);
    expect(rows.every((r) => r.tenant_id === fx.orgs.A.tenantId)).toBe(true);
  });

  it("la huella del correo del registro tampoco: `to_email_hash` no sirve para adivinar a quién se invitó", async () => {
    // El registro de correos ya es legible por columnas para los miembros; la huella lleva la clave del
    // servidor, así que no se puede calcular desde fuera. Aquí solo se comprueba que el Observador no la ve.
    const fx = fixture();
    const res = await rest(
      await tokenOf("dante"),
      "email_messages?select=to_email_hash&kind=eq.invitation",
      {
        headers: tenantHeader(fx.orgs.A.tenantId),
      },
    );
    expect(res.json).toEqual([]);
  });
});

describe("Ataque 6 · un Administrador redirige a un cómplice la invitación a Administrador del Dueño (H-010)", () => {
  it("Mixta (Administradora de A) no puede invitar a un Administrador ni reenviar con otro vínculo la invitación a Administrador de Ana: «solo el Dueño» y nada cambia", async () => {
    const fx = fixture();
    const { buildNewInvitation, buildResend } = await import("@/lib/team/record");
    const ana = await tokenOf("ana");
    const mixta = await tokenOf("mixta");
    const headers = tenantHeader(fx.orgs.A.tenantId);

    // Directo por la API: invitar como Administrador.
    const direct = buildNewInvitation(
      fx.orgs.A.tenantId,
      `complice-${fx.runId}@ejemplo.test`.toLowerCase(),
      "admin",
    );
    const denied = await rpc(mixta, "create_invitation", direct.params, headers);
    expect(denied.status).toBe(403);
    expect(codeOf(denied)).toBe("42501");
    expect((denied.json as { message?: string }).message).toBe("owner_only");
    expect(await countWhere(db, "invitations", `id = '${direct.invitationId}'`)).toBe(0);

    // La Dueña invita a un Administrador; Mixta intenta reenviarla atada al correo de un cómplice.
    const owners = buildNewInvitation(
      fx.orgs.A.tenantId,
      `admin-de-ana-${fx.runId}@ejemplo.test`.toLowerCase(),
      "admin",
    );
    const created = await rpc(ana, "create_invitation", owners.params, headers);
    expect(created.status, created.text).toBe(200);
    try {
      const before = await fingerprint(db, spec("invitations"));
      const forged = buildResend(
        fx.orgs.A.tenantId,
        owners.invitationId,
        `complice-${fx.runId}@ejemplo.test`.toLowerCase(),
      );
      const resend = await rpc(mixta, "resend_invitation", forged.params, headers);
      expect(resend.status).toBe(403);
      expect(codeOf(resend)).toBe("42501");
      expect((resend.json as { message?: string }).message).toBe("owner_only");
      expect(await fingerprint(db, spec("invitations"))).toBe(before);
      expect(await countWhere(db, "email_messages", `id = '${forged.emailMessageId}'`)).toBe(0);
    } finally {
      // Se deja la fixture como estaba: Mixta sí puede cancelarla.
      const cancel = await rpc(
        mixta,
        "revoke_invitation",
        { p_invitation_id: owners.invitationId },
        headers,
      );
      expect(cancel.status, cancel.text).toBe(200);
    }
  });
});

describe("Ataque 7 · quitar a quien reenvió cancela lo suyo en esa organización y nada de la otra (revisión del 2026-11-06)", () => {
  it("Mixta (Administradora de A y de B) reenvía una invitación en cada una; Ana la quita de A y solo se cancela la de A", async () => {
    const fx = fixture();
    const { buildNewInvitation, buildResend } = await import("@/lib/team/record");
    const ana = await tokenOf("ana");
    const beto = await tokenOf("beto");
    const mixta = await tokenOf("mixta");
    const mixtaId = fx.personas.mixta.userId;
    const headersA = tenantHeader(fx.orgs.A.tenantId);
    const headersB = tenantHeader(fx.orgs.B.tenantId);

    const inA = buildNewInvitation(
      fx.orgs.A.tenantId,
      `reenvio-a-${fx.runId}@ejemplo.test`,
      "sales",
    );
    const inB = buildNewInvitation(
      fx.orgs.B.tenantId,
      `reenvio-b-${fx.runId}@ejemplo.test`,
      "sales",
    );
    expect((await rpc(ana, "create_invitation", inA.params, headersA)).status).toBe(200);
    expect((await rpc(beto, "create_invitation", inB.params, headersB)).status).toBe(200);
    const memberRow = await db.query<{ id: string }>(
      "select id from public.members where tenant_id = $1 and user_id = $2",
      [fx.orgs.A.tenantId, mixtaId],
    );
    const mixtaMemberInA = memberRow.rows[0].id;
    try {
      // Pasa el tiempo mínimo entre envíos y Mixta reenvía las dos, atadas a otro correo.
      await db.query(
        "update public.invitations set last_sent_at = now() - interval '1 hour' where id = any($1::uuid[])",
        [[inA.invitationId, inB.invitationId]],
      );
      const forgedA = buildResend(
        fx.orgs.A.tenantId,
        inA.invitationId,
        `otro-a-${fx.runId}@ejemplo.test`,
      );
      const forgedB = buildResend(
        fx.orgs.B.tenantId,
        inB.invitationId,
        `otro-b-${fx.runId}@ejemplo.test`,
      );
      expect((await rpc(mixta, "resend_invitation", forgedA.params, headersA)).status).toBe(200);
      expect((await rpc(mixta, "resend_invitation", forgedB.params, headersB)).status).toBe(200);
      const resenders = await db.query<{ id: string; resent_by: string }>(
        "select id, resent_by from public.invitations where id = any($1::uuid[])",
        [[inA.invitationId, inB.invitationId]],
      );
      expect(resenders.rows.map((r) => r.resent_by)).toEqual([mixtaId, mixtaId]);

      // Ana la quita de A (con el pase de Ana, por la API).
      const removed = await rpc(
        ana,
        "remove_member",
        { p_member_id: mixtaMemberInA, p_expected_role: "admin" },
        headersA,
      );
      expect(removed.status, removed.text).toBe(200);
      expect(removed.json).toMatchObject({ result: "removed", cancelled_invitations: 1 });

      const states = await db.query<{ id: string; status: string; revoke_reason: string | null }>(
        "select id, status, revoke_reason from public.invitations where id = any($1::uuid[])",
        [[inA.invitationId, inB.invitationId]],
      );
      const byId = new Map(states.rows.map((r) => [r.id, r]));
      expect(byId.get(inA.invitationId)).toMatchObject({
        status: "revoked",
        revoke_reason: "inviter_removed",
      });
      expect(byId.get(inB.invitationId)).toMatchObject({ status: "pending", revoke_reason: null });
    } finally {
      // Se deja la fixture como estaba: Mixta de nuevo Administradora de A y las dos invitaciones cerradas.
      await db.query(
        `update public.members set status = 'active', removed_at = null, removed_by = null where id = $1`,
        [mixtaMemberInA],
      );
      await rpc(beto, "revoke_invitation", { p_invitation_id: inB.invitationId }, headersB);
      await rpc(ana, "revoke_invitation", { p_invitation_id: inA.invitationId }, headersA);
    }
  });
});
