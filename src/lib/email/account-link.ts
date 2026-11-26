/**
 * Correo del registro en dos pasos (H-116): el enlace para confirmar el correo y terminar de crear la cuenta. Lo envía Cotiza
 * Prime con su propia marca (quien lo recibe todavía no es parte de ninguna organización).
 *
 * El enlace lleva el código del registro en la dirección del botón y en la versión de texto: no se registra en ningún otro
 * lugar. Todo el texto se escapa. Los textos son los de `docs/arquitectura/h-116-registro-seguro.md` §3.3.
 */
import { z } from "zod";
import { escapeHtml } from "./basic-format";
import type { EmailMessage } from "./types";

export const ACCOUNT_LINK_SENDER_NAME = "Cotiza Prime";
export const ACCOUNT_LINK_SUBJECT = "Confirma tu correo para crear tu cuenta en Cotiza Prime";
export const ACCOUNT_LINK_BUTTON_LABEL = "Confirmar mi correo";
export const ACCOUNT_LINK_FOOTER =
  "Si no lo pediste tú, ignora este mensaje: sin tu clic la cuenta no se activa.";
/** Lo que vive el enlace. Es `otp_expiry` de `supabase/config.toml` (3600 s): si cambia ese valor, cambia también este texto. */
export const ACCOUNT_LINK_VALIDITY_TEXT = "1 hora";
const emailSchema = z.email().max(254);

export type AccountLinkEmailInput = {
  recipientAddress: string;
  fromAddress: string;
  /** La dirección completa del botón (`/confirmar-correo?token_hash=…&type=invite`). */
  confirmUrl: string;
  idempotencyKey?: string;
};

export type AccountLinkEmailResult =
  { ok: true; message: EmailMessage } | { ok: false; code: "invalid_input" };

export function buildAccountLinkEmail(input: AccountLinkEmailInput): AccountLinkEmailResult {
  if (
    !emailSchema.safeParse(input.recipientAddress).success ||
    !emailSchema.safeParse(input.fromAddress).success
  ) {
    return { ok: false, code: "invalid_input" };
  }
  let url: URL;
  try {
    url = new URL(input.confirmUrl);
  } catch {
    return { ok: false, code: "invalid_input" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, code: "invalid_input" };
  }
  // Sin el código el botón no sirve: el correo no sale con un enlace vacío.
  if (!url.searchParams.get("token_hash")) return { ok: false, code: "invalid_input" };

  const lines = [
    `Recibimos una solicitud para crear una cuenta en Cotiza Prime con este correo (${input.recipientAddress}).`,
    `Confirma que el correo es tuyo con el botón. El enlace sirve una sola vez y vale ${ACCOUNT_LINK_VALIDITY_TEXT}. Después elegirás tu nombre y tu contraseña.`,
  ];

  const paragraphs = lines.map((line) => `<p style="margin:0 0 12px 0;">${escapeHtml(line)}</p>`);
  const link = escapeHtml(url.href);
  const html = `<!doctype html>
<html lang="es-CL"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(ACCOUNT_LINK_SUBJECT)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;font-family:Arial,Helvetica,sans-serif;color:#0f1729;font-size:16px;line-height:1.55;">
<tr><td style="padding:28px 28px 8px 28px;"><h2 style="margin:0 0 12px 0;font-size:20px;">Confirma tu correo</h2>${paragraphs.join("")}</td></tr>
<tr><td align="left" style="padding:8px 28px 20px 28px;"><a href="${link}" style="display:inline-block;background:#2b54e0;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:8px;">${ACCOUNT_LINK_BUTTON_LABEL}</a></td></tr>
<tr><td style="padding:0 28px 20px 28px;font-size:14px;color:#4b5468;">
<p style="margin:0 0 8px 0;">Si el botón no funciona, copia esta dirección en tu navegador:</p>
<p style="margin:0;word-break:break-all;">${link}</p>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e2e6ee;font-size:12px;color:#6b7489;">${escapeHtml(ACCOUNT_LINK_FOOTER)}</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    ...lines,
    "",
    `${ACCOUNT_LINK_BUTTON_LABEL}: ${url.href}`,
    "",
    ACCOUNT_LINK_FOOTER,
  ].join("\n");
  return {
    ok: true,
    message: {
      from: { name: ACCOUNT_LINK_SENDER_NAME, address: input.fromAddress },
      to: input.recipientAddress,
      subject: ACCOUNT_LINK_SUBJECT,
      html,
      text,
      idempotencyKey: input.idempotencyKey,
    },
  };
}
