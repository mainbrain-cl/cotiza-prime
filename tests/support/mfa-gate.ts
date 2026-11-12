// Ayudas para las pruebas que activan la verificación en dos pasos DIRECTO contra Supabase Auth local (GoTrue).
//
// Desde H-118a la base rechaza que un factor pase a «verificado» si NUESTRO servidor no dejó antes el «permiso»
// (`public.mfa_alert_expect`, vive 2 minutos). Una prueba que verifica un factor por la API debe pedir el permiso primero con
// `grantEnrollmentPermit`, que lo crea con la llave maestra (la que usa la aplicación). Solo pruebas, solo base local.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { freshTotp } from "../../src/test/totp";
import { adminCreateUser, localEnv, signIn, type Session } from "./local-supabase";

/** Lo que de verdad usan las pruebas de las respuestas de GoTrue. */
export type AuthJson = {
  id: string;
  error_code: string;
  msg?: string;
  message?: string;
  access_token: string;
  totp: { qr_code: string; uri: string; secret: string };
  factors: { id: string; status: string }[];
};
export type AuthResult = { status: number; json: AuthJson | null };

/** Pedido directo a GoTrue con un pase (no `supabase-js`: se quieren ver los códigos de error tal cual). */
export async function gotrue(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<AuthResult> {
  const { apiUrl, publishableKey } = localEnv();
  const res = await fetch(`${apiUrl}/auth/v1/${path}`, {
    method,
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: AuthJson | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

export const claimsOf = (accessToken: string) =>
  JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8")) as {
    aal: string;
    amr: { method: string }[];
    session_id: string;
  };

/** Una cuenta nueva `@ejemplo.test` (nunca las de la semilla ni las de la fixture de aislamiento). */
export async function newMfaAccount(): Promise<{ email: string; id: string }> {
  const email = `mfa-${randomUUID().slice(0, 8)}@ejemplo.test`;
  return { email, id: await adminCreateUser(email) };
}

/** Deja el «permiso» de activación (lo que hace la acción del servidor justo antes de verificar). Devuelve si se concedió. */
export async function grantEnrollmentPermit(
  db: Client,
  userId: string,
  factorId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>("select public.mfa_alert_expect($1, $2) as ok", [
    userId,
    factorId,
  ]);
  return rows[0].ok;
}

/** Empieza una activación TOTP con el pase de la persona. Devuelve el factor y la clave. */
export async function startEnrollment(
  session: Session,
  friendlyName?: string,
): Promise<{ factorId: string; secret: string }> {
  const enrolled = await gotrue(session.accessToken, "POST", "factors", {
    factor_type: "totp",
    issuer: "Cotiza Prime",
    ...(friendlyName ? { friendly_name: friendlyName } : {}),
  });
  if (enrolled.status !== 200) throw new Error(`enroll respondió ${enrolled.status}`);
  return { factorId: enrolled.json!.id, secret: enrolled.json!.totp.secret };
}

/** Pide el desafío y verifica con un código de verdad. NO deja el permiso: sirve para probar el rechazo. */
export async function challengeAndVerifyRaw(
  session: Session,
  factorId: string,
  secret: string,
): Promise<AuthResult & { step: number }> {
  const challenge = await gotrue(session.accessToken, "POST", `factors/${factorId}/challenge`, {});
  if (challenge.status !== 200) throw new Error(`challenge respondió ${challenge.status}`);
  const { code, step } = await freshTotp(secret);
  const verified = await gotrue(session.accessToken, "POST", `factors/${factorId}/verify`, {
    challenge_id: challenge.json!.id,
    code,
  });
  return { ...verified, step };
}

/** Activa un factor TOTP CON el permiso y lo verifica con un código de verdad (lo que hace la pantalla). */
export async function enrollAndVerifyWithPermit(
  db: Client,
  session: Session,
  friendlyName?: string,
): Promise<{ factorId: string; secret: string; aal2: string; step: number }> {
  const { factorId, secret } = await startEnrollment(session, friendlyName);
  if (!(await grantEnrollmentPermit(db, session.userId, factorId))) {
    throw new Error("la base no concedió el permiso de activación");
  }
  const verified = await challengeAndVerifyRaw(session, factorId, secret);
  if (verified.status !== 200) {
    throw new Error(`verify respondió ${verified.status} ${verified.json?.error_code ?? ""}`);
  }
  return { factorId, secret, aal2: verified.json!.access_token, step: verified.step };
}

export { signIn };
