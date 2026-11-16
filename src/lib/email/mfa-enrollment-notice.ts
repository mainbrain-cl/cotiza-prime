/**
 * Aviso de que se activó la verificación en dos pasos en la cuenta (H-118). Es un correo de seguridad de Cotiza Prime, no de
 * la marca de una organización. Lleva: cuándo se activó (dd-mm-aaaa hh:mm, hora de Chile), «Si fuiste tú, no hagas nada.»,
 * el botón «No fui yo: anular la activación» con su vencimiento, y «No lo reenvíes.» Todo el texto se escapa.
 *
 * El destinatario es SIEMPRE el correo que Supabase Auth tiene de la cuenta, leído al enviar: nunca uno que venga de una
 * petición. El enlace lleva el código en la parte «#» (ver `mfa-annul-token.ts`): solo está en la dirección del botón y en la
 * versión de texto; no se registra en ningún otro lugar.
 */
import { z } from "zod";
import { formatDateTime } from "@/lib/format-date";
import { escapeHtml } from "./basic-format";
import type { EmailMessage } from "./types";

export const MFA_NOTICE_SENDER_NAME = "Cotiza Prime";
export const MFA_NOTICE_SUBJECT = "Se activó la verificación en dos pasos en tu cuenta";
export const MFA_NOTICE_BUTTON_LABEL = "No fui yo: anular la activación";
export const MFA_NOTICE_IF_YOU = "Si fuiste tú, no hagas nada.";
export const MFA_NOTICE_DO_NOT_FORWARD = "No lo reenvíes.";
export const MFA_NOTICE_AFTER = "Después de anular, revisa «Tu equipo» y el registro de actividad.";
const emailSchema = z.email().max(254);

export type MfaEnrollmentNoticeInput = {
  recipientAddress: string;
  fromAddress: string;
  /** Cuándo se activó. */
  enrolledAt: string | Date;
  /** La dirección completa del botón, con el código tras el «#». */
  annulUrl: string;
  /** Hasta cuándo vale el enlace (72 horas desde el envío). */
  expiresAt: string | Date;
  idempotencyKey?: string;
};

export type MfaEnrollmentNoticeResult =
  { ok: true; message: EmailMessage } | { ok: false; code: "invalid_input" };

export function buildMfaEnrollmentNotice(
  input: MfaEnrollmentNoticeInput,
): MfaEnrollmentNoticeResult {
  if (
    !emailSchema.safeParse(input.recipientAddress).success ||
    !emailSchema.safeParse(input.fromAddress).success
  ) {
    return { ok: false, code: "invalid_input" };
  }
  let url: URL;
  try {
    url = new URL(input.annulUrl);
  } catch {
    return { ok: false, code: "invalid_input" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { ok: false, code: "invalid_input" };
  // Sin el código el botón no sirve: el aviso no se manda con un enlace vacío.
  if (url.hash.length <= 1) return { ok: false, code: "invalid_input" };
  const enrolledAt = new Date(input.enrolledAt);
  const expiresAt = new Date(input.expiresAt);
  if (Number.isNaN(enrolledAt.getTime()) || Number.isNaN(expiresAt.getTime())) {
    return { ok: false, code: "invalid_input" };
  }

  const lines = [
    `Se activó la verificación en dos pasos en tu cuenta de Cotiza Prime (${input.recipientAddress}) el ${formatDateTime(enrolledAt)}, hora de Chile.`,
    MFA_NOTICE_IF_YOU,
    "Si no fuiste tú, es posible que alguien más haya entrado a tu cuenta con tu contraseña. Anula la activación con el botón: cerraremos todas las sesiones y te pediremos elegir una contraseña nueva.",
    `El botón vale hasta el ${formatDateTime(expiresAt)}, hora de Chile. ${MFA_NOTICE_DO_NOT_FORWARD} Quien tenga este correo puede anular la activación.`,
    MFA_NOTICE_AFTER,
  ];
  const footer = "Aviso de seguridad automático de Cotiza Prime.";
  const paragraphs = lines.map((line) => `<p style="margin:0 0 12px 0;">${escapeHtml(line)}</p>`);
  const link = escapeHtml(url.href);
  const html = `<!doctype html>
<html lang="es-CL"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(MFA_NOTICE_SUBJECT)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;font-family:Arial,Helvetica,sans-serif;color:#0f1729;font-size:16px;line-height:1.55;">
<tr><td style="padding:28px 28px 8px 28px;">${paragraphs.join("")}</td></tr>
<tr><td align="left" style="padding:8px 28px 28px 28px;"><a href="${link}" style="display:inline-block;background:#c2312b;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:8px;">${escapeHtml(MFA_NOTICE_BUTTON_LABEL)}</a></td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e2e6ee;font-size:12px;color:#6b7489;">${escapeHtml(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [...lines, "", `${MFA_NOTICE_BUTTON_LABEL}: ${url.href}`, "", footer].join("\n");
  return {
    ok: true,
    message: {
      from: { name: MFA_NOTICE_SENDER_NAME, address: input.fromAddress },
      to: input.recipientAddress,
      subject: MFA_NOTICE_SUBJECT,
      html,
      text,
      idempotencyKey: input.idempotencyKey,
    },
  };
}
