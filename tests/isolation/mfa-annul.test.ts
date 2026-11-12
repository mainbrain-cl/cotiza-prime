// H-118b · Anular la activación del segundo paso: el enlace de la cuenta A usado mientras la cuenta B tiene su sesión abierta
// solo afecta a A. B conserva su sesión, su factor, sus avisos y sus enlaces; la anulación nunca recibe una cuenta de la
// petición (la cuenta sale de la fila del enlace). Usa el código real de los porteros (`src/lib/security/`) con la llave
// maestra, igual que la acción de servidor, contra la Supabase local. Solo cuentas nuevas `@ejemplo.test`.
import { createHash, randomBytes } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { lockAccountAndRemoveFactors } from "@/lib/security/mfa-admin-gateway";
import {
  claimAnnulLink,
  completeAnnulLink,
  releaseAnnulLink,
  revokeRemainingSessions,
} from "@/lib/security/mfa-alerts-gateway";
import { adminCreateUser, rest, signIn } from "../support/local-supabase";
import { enrollAndVerifyWithPermit, gotrue } from "../support/mfa-gate";
import { openDb } from "./context";

vi.setConfig({ testTimeout: 90_000 });

let db: Client;
const created: string[] = [];
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  if (created.length > 0) await db.query("delete from auth.users where id = any($1)", [created]);
  await db.end();
});

async function account(label: string): Promise<{ email: string; id: string }> {
  const email = `anula-${label}-${randomBytes(4).toString("hex")}@ejemplo.test`;
  const id = await adminCreateUser(email);
  created.push(id);
  return { email, id };
}

/** Un aviso `sent` con su enlace abierto. Devuelve el código (como el que viajaría en el correo) y su huella. */
async function sentAlert(userId: string): Promise<{ token: string; hash: string; linkId: string }> {
  const alert = await db.query<{ id: string }>(
    `insert into public.mfa_enrollment_alerts (user_id, factor_id, state, expected_until, verified_at, sent_at)
     values ($1, gen_random_uuid(), 'sent', now(), now(), now()) returning id`,
    [userId],
  );
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  const link = await db.query<{ id: string }>(
    `insert into public.mfa_annul_links (alert_id, user_id, token_sha256, expires_at)
     values ($1, $2, $3, now() + interval '72 hours') returning id`,
    [alert.rows[0].id, userId, hash],
  );
  return { token, hash, linkId: link.rows[0].id };
}

describe("H-118b · el enlace de A usado con la sesión de B abierta solo afecta a A", () => {
  it("A queda sin acceso (sesiones, factores y contraseña); B conserva su sesión, su factor, sus avisos y sus enlaces", async () => {
    const a = await account("a");
    const b = await account("b");
    // A: dos sesiones abiertas y un aviso con su enlace. B: una cuenta CON el segundo paso y su propio aviso y enlace.
    const aSession = await signIn(a.email);
    const aOther = await signIn(a.email);
    const aLink = await sentAlert(a.id);
    const bFull = await enrollAndVerifyWithPermit(db, await signIn(b.email));
    const bLink = await sentAlert(b.id);
    expect((await gotrue(bFull.aal2, "GET", "user")).status).toBe(200);

    // La persona de B abre y aprieta el enlace de A (con su sesión abierta): lo que se toma es la fila del enlace de A.
    const claimed = await claimAnnulLink(aLink.hash);
    expect(claimed).toEqual({ linkId: aLink.linkId, userId: a.id });
    await lockAccountAndRemoveFactors(claimed!.userId);
    expect(await revokeRemainingSessions(claimed!.userId)).toBe(0);
    const done = await completeAnnulLink(claimed!.linkId);
    expect(done).toEqual({ userId: a.id, email: a.email });

    // A: sin sesiones, contraseña inutilizada.
    for (const session of [aSession, aOther]) {
      expect((await gotrue(session.accessToken, "GET", "user")).json?.error_code).toBe(
        "session_not_found",
      );
    }
    await expect(signIn(a.email)).rejects.toThrow();
    // B: nada cambió.
    expect((await gotrue(bFull.aal2, "GET", "user")).status).toBe(200);
    expect(
      (
        await db.query(
          "select 1 from auth.mfa_factors where user_id = $1 and status = 'verified'",
          [b.id],
        )
      ).rowCount,
    ).toBe(1);
    const bState = await db.query<{ state: string; used: boolean }>(
      `select a.state, l.used_at is not null as used from public.mfa_enrollment_alerts a
         join public.mfa_annul_links l on l.alert_id = a.id where a.user_id = $1`,
      [b.id],
    );
    expect(bState.rows.at(-1)).toEqual({ state: "sent", used: false });
    // El enlace de B sigue sirviendo, y el de A ya no sirve a nadie.
    expect(await claimAnnulLink(aLink.hash)).toBeNull();
    const bClaimed = await claimAnnulLink(bLink.hash);
    expect(bClaimed?.userId).toBe(b.id);
    await releaseAnnulLink(bClaimed!.linkId);
    // Y ningún pase (el de B, con su segundo paso hecho) puede leer ni tocar las tablas de enlaces.
    const read = await rest(bFull.aal2, "mfa_annul_links?select=*");
    expect(read.status).toBeGreaterThanOrEqual(400);
  });

  it("con una huella cualquiera (de otra cuenta, inventada o sin la forma) no se afecta a nadie", async () => {
    const c = await account("c");
    const session = await signIn(c.email);
    const mine = await sentAlert(c.id);
    for (const hash of [randomBytes(32).toString("hex"), "no-es-una-huella", "", "A".repeat(64)]) {
      expect(await claimAnnulLink(hash)).toBeNull();
    }
    expect((await gotrue(session.accessToken, "GET", "user")).status).toBe(200);
    expect(
      (
        await db.query("select claimed_until from public.mfa_annul_links where id = $1", [
          mine.linkId,
        ])
      ).rows[0].claimed_until,
    ).toBeNull();
  });
});
