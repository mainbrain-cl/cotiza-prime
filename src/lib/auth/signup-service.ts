import "server-only";
import { randomUUID } from "node:crypto";
import { loadEmailConfig } from "@/lib/email/config";
import { buildAccountLinkEmail } from "@/lib/email/account-link";
import { EmailConfigError, getEmailTransport } from "@/lib/email/transport";
import { getAppOrigin } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { sendWithRetry } from "@/lib/quotes/send/dispatch";
import { CONFIRM_EMAIL_PATH } from "./paths";
import { SignupGatewayError, prepareSignupLink } from "./signup-gateway";

/**
 * El trabajo caro del registro en dos pasos (H-116): preparar la cuenta y el enlace en la pasarela y enviar el correo. La
 * acción lo hace DESPUÉS de responder (`after`), para que lo que ve la persona no dependa de si el correo ya tenía cuenta.
 *
 * Reglas que no se pueden olvidar:
 *  - El enlace se arma SIEMPRE con `APP_ORIGIN` (`getAppOrigin()`), nunca con la dirección de la petición: nadie puede hacer
 *    que el correo apunte a un sitio ajeno.
 *  - NUNCA lanza: lo que falle queda como un código en el registro (jamás el correo, el enlace ni el código del enlace).
 *  - Si el correo ya tiene una cuenta verificada no se envía nada (decisión A2).
 */

/** Cuánto se espera, como máximo, para enviar el correo. */
const SEND_DEADLINE_MS = 20_000;

/** Lo que pasó (sin datos personales): para pruebas y para el registro. */
export type SignupWorkOutcome = "sent" | "already_registered" | "not_sent";

const codeOf = (cause: unknown): string =>
  cause instanceof SignupGatewayError
    ? cause.message
    : cause instanceof EmailConfigError
      ? "email_config"
      : "unexpected";

/** La dirección del botón del correo: nuestra pantalla de confirmar, con el código y el tipo. */
export function confirmEmailUrl(tokenHash: string): string {
  const url = new URL(CONFIRM_EMAIL_PATH, getAppOrigin());
  url.searchParams.set("token_hash", tokenHash);
  url.searchParams.set("type", "invite");
  return url.href;
}

/** Prepara el enlace y envía el correo a `email` (ya normalizado y validado). Nunca lanza. */
export async function sendSignupLink(email: string): Promise<SignupWorkOutcome> {
  try {
    const link = await prepareSignupLink(email);
    if (link.status === "already_registered") return "already_registered";

    const config = loadEmailConfig();
    const built = buildAccountLinkEmail({
      recipientAddress: email,
      fromAddress: config.fromAddress,
      confirmUrl: confirmEmailUrl(link.tokenHash),
      // Cada enlace es distinto: una clave nueva por correo (con la misma, el proveedor descartaría el reenvío).
      idempotencyKey: randomUUID(),
    });
    if (!built.ok) {
      await serverLog("warn", "signup_email_failed", { code: built.code });
      return "not_sent";
    }
    const result = await sendWithRetry(getEmailTransport(config), built.message, {
      deadlineMs: Date.now() + SEND_DEADLINE_MS,
    });
    if (!result.ok) {
      await serverLog("warn", "signup_email_failed", { code: result.code });
      return "not_sent";
    }
    return "sent";
  } catch (cause) {
    await serverLog("warn", "signup_email_failed", { code: codeOf(cause) });
    return "not_sent";
  }
}
