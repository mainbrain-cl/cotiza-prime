/**
 * Estructura común de los avisos de seguridad de la cuenta del segundo paso (H-004b): «se pidió desactivarlo», «se usó un
 * código de respaldo» y «se crearon códigos de respaldo nuevos». Son correos de seguridad de Cotiza Prime, no de la marca de
 * una organización. Cada aviso dice cuándo pasó (dd-mm-aaaa hh:mm, hora de Chile) y en qué cuenta, «Si fuiste tú, no hagas
 * nada.» y «¿No fuiste tú? Cambia tu contraseña ahora» con el botón a la pantalla pública de recuperar la contraseña. Todo el
 * texto se escapa.
 *
 * El destinatario es SIEMPRE el correo que Supabase Auth tiene de la cuenta, leído por quien envía: nunca uno que venga de una
 * petición. Estos correos NUNCA llevan un código de respaldo (ni parte de uno), un enlace con código ni una huella: solo la
 * dirección pública de recuperar la contraseña, que no lleva consulta ni «#».
 */
import { z } from "zod";
import { formatDateTime } from "@/lib/format-date";
import { escapeHtml } from "./basic-format";
import type { EmailMessage } from "./types";

export const MFA_ACCOUNT_NOTICE_SENDER_NAME = "Cotiza Prime";
export const MFA_ACCOUNT_NOTICE_IF_YOU = "Si fuiste tú, no hagas nada.";
export const MFA_ACCOUNT_NOTICE_IF_NOT_YOU = "¿No fuiste tú? Cambia tu contraseña ahora.";
export const MFA_ACCOUNT_NOTICE_BUTTON_LABEL = "Cambiar mi contraseña";
const FOOTER = "Aviso de seguridad automático de Cotiza Prime.";
const emailSchema = z.email().max(254);

export type MfaAccountNoticeInput = {
  recipientAddress: string;
  fromAddress: string;
  /** Cuándo pasó lo que se avisa. */
  happenedAt: string | Date;
  /** Adonde lleva el botón: la pantalla pública de «¿Olvidaste tu contraseña?» (`{APP_ORIGIN}/recuperar-contrasena`). */
  forgotPasswordUrl: string;
  idempotencyKey?: string;
};

export type MfaAccountNoticeResult =
  { ok: true; message: EmailMessage } | { ok: false; code: "invalid_input" };

/** Lo que cada aviso aporta: su asunto y las líneas propias (la fecha y la cuenta ya vienen formateadas). */
export type MfaAccountNoticeSpec = {
  subject: string;
  describe: (context: { when: string; account: string }) => string[];
};

export function buildMfaAccountNotice(
  input: MfaAccountNoticeInput,
  spec: MfaAccountNoticeSpec,
): MfaAccountNoticeResult {
  if (
    !emailSchema.safeParse(input.recipientAddress).success ||
    !emailSchema.safeParse(input.fromAddress).success
  ) {
    return { ok: false, code: "invalid_input" };
  }
  let url: URL;
  try {
    url = new URL(input.forgotPasswordUrl);
  } catch {
    return { ok: false, code: "invalid_input" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, code: "invalid_input" };
  }
  // El botón no lleva ningún código: ni consulta ni «#». Un enlace con código no es de este aviso.
  if (url.search !== "" || url.hash !== "") return { ok: false, code: "invalid_input" };
  const happenedAt = new Date(input.happenedAt);
  if (Number.isNaN(happenedAt.getTime())) return { ok: false, code: "invalid_input" };

  const lines = [
    ...spec.describe({ when: formatDateTime(happenedAt), account: input.recipientAddress }),
    MFA_ACCOUNT_NOTICE_IF_YOU,
    MFA_ACCOUNT_NOTICE_IF_NOT_YOU,
  ];
  const paragraphs = lines.map((line) => `<p style="margin:0 0 12px 0;">${escapeHtml(line)}</p>`);
  const link = escapeHtml(url.href);
  const html = `<!doctype html>
<html lang="es-CL"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(spec.subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;font-family:Arial,Helvetica,sans-serif;color:#0f1729;font-size:16px;line-height:1.55;">
<tr><td style="padding:28px 28px 8px 28px;">${paragraphs.join("")}</td></tr>
<tr><td align="left" style="padding:8px 28px 28px 28px;"><a href="${link}" style="display:inline-block;background:#c2312b;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:8px;">${escapeHtml(MFA_ACCOUNT_NOTICE_BUTTON_LABEL)}</a></td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e2e6ee;font-size:12px;color:#6b7489;">${escapeHtml(FOOTER)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [...lines, "", `${MFA_ACCOUNT_NOTICE_BUTTON_LABEL}: ${url.href}`, "", FOOTER].join(
    "\n",
  );
  return {
    ok: true,
    message: {
      from: { name: MFA_ACCOUNT_NOTICE_SENDER_NAME, address: input.fromAddress },
      to: input.recipientAddress,
      subject: spec.subject,
      html,
      text,
      idempotencyKey: input.idempotencyKey,
    },
  };
}
