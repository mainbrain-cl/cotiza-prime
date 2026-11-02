/**
 * Correo de invitación a una organización (H-008). Lo envía Cotiza Prime con su propia marca, no la de la
 * organización: quien lo recibe todavía no es parte de ninguna. Lleva quién invita, a qué organización, con
 * qué rol (y la frase que explica ese rol), hasta cuándo vale y un botón hacia `/invitacion/{código}`.
 *
 * El nombre de la organización y el de quien invita son TEXTO escrito por personas: se limpian de
 * caracteres de control (cabeceras) y se escapan en el HTML. Nunca se interpretan como código.
 * El código del enlace solo está en la dirección del botón; no se registra en ningún otro lugar.
 */
import { z } from "zod";
import { formatDate } from "@/lib/format-date";
import { escapeHtml } from "./basic-format";
import type { EmailMessage } from "./types";
import {
  FALLBACK_INVITER_NAME,
  FALLBACK_ORGANIZATION_NAME,
  cleanName,
  fitSubject,
  cleanText,
} from "./invitation-names";

export const INVITATION_SENDER_NAME = "Cotiza Prime";
export const INVITATION_BUTTON_LABEL = "Aceptar la invitación";
const emailSchema = z.email().max(254);

export type InvitationEmailInput = {
  recipientAddress: string;
  fromAddress: string;
  /** Nombre de quien invita (texto de una persona). */
  inviterName: string;
  /** Nombre de la organización (texto de una persona). */
  organizationName: string;
  /** Cómo se llama el rol en la interfaz, p. ej. «Comercial». */
  roleLabel: string;
  /** La frase que explica qué puede hacer ese rol. */
  roleDescription: string;
  /** Hasta cuándo vale el enlace. */
  expiresAt: string | Date;
  /** La dirección completa del botón, con el código. */
  inviteUrl: string;
  idempotencyKey?: string;
};

export type InvitationEmailResult =
  { ok: true; message: EmailMessage } | { ok: false; code: "invalid_input" };

export function buildInvitationEmail(input: InvitationEmailInput): InvitationEmailResult {
  if (
    !emailSchema.safeParse(input.recipientAddress).success ||
    !emailSchema.safeParse(input.fromAddress).success
  ) {
    return { ok: false, code: "invalid_input" };
  }
  let url: URL;
  try {
    url = new URL(input.inviteUrl);
  } catch {
    return { ok: false, code: "invalid_input" };
  }
  const expires = new Date(input.expiresAt);
  if (Number.isNaN(expires.getTime())) return { ok: false, code: "invalid_input" };

  // Un nombre que queda vacío al limpiarlo no impide el correo: se usa el texto de respaldo.
  const inviter = cleanName(input.inviterName, FALLBACK_INVITER_NAME);
  const organization = cleanName(input.organizationName, FALLBACK_ORGANIZATION_NAME);
  const roleLabel = cleanText(input.roleLabel);
  const roleDescription = cleanText(input.roleDescription);
  if (!roleLabel) return { ok: false, code: "invalid_input" };

  // Los nombres se recortan por caracteres hasta que el asunto cabe: un nombre largo o con emojis no impide el correo.
  const subject = fitSubject(
    (shorten) => `${shorten(inviter)} te invitó a ${shorten(organization)} en Cotiza Prime`,
  );

  const lines: string[] = [
    `${inviter} te invitó a ${organization} en Cotiza Prime, con el rol de ${roleLabel}.`,
    roleDescription,
    `La invitación vence el ${formatDate(expires)}. Si no la aceptas antes, tendrás que pedir otra.`,
  ].filter(Boolean);
  const footer = "Si no esperabas esta invitación, puedes ignorar este correo: no pasará nada.";

  const paragraphs = lines.map((line) => `<p style="margin:0 0 12px 0;">${escapeHtml(line)}</p>`);
  const link = escapeHtml(url.href);
  const html = `<!doctype html>
<html lang="es-CL"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;font-family:Arial,Helvetica,sans-serif;color:#0f1729;font-size:16px;line-height:1.55;">
<tr><td style="padding:28px 28px 8px 28px;">${paragraphs.join("")}</td></tr>
<tr><td align="left" style="padding:8px 28px 28px 28px;"><a href="${link}" style="display:inline-block;background:#2b54e0;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:8px;">${INVITATION_BUTTON_LABEL}</a></td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e2e6ee;font-size:12px;color:#6b7489;">${escapeHtml(footer)}</td></tr>
</table></td></tr></table></body></html>`;

  const text = [...lines, "", `${INVITATION_BUTTON_LABEL}: ${url.href}`, "", footer].join("\n");
  return {
    ok: true,
    message: {
      from: { name: INVITATION_SENDER_NAME, address: input.fromAddress },
      to: input.recipientAddress,
      subject,
      html,
      text,
      idempotencyKey: input.idempotencyKey,
    },
  };
}
