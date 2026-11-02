/**
 * Aviso al Dueño cuando alguien que NO es el Dueño invita a una persona con un rol que puede manejar el equipo
 * (hoy, Administrador) (H-008). Es un correo interno de Cotiza Prime, no de la marca de la organización.
 * Lleva: quién invitó, a qué organización, con qué rol, la fecha (dd-mm-aaaa) y un botón hacia «Tu equipo».
 * NUNCA lleva el correo del invitado: para verlo y, si hace falta, cancelar la invitación, el Dueño entra a la
 * pantalla. Los nombres (de la organización y de quien invita) son texto de personas: se limpian y se escapan.
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

export const OWNER_NOTICE_SENDER_NAME = "Cotiza Prime";
/** Invitación pendiente o vencida: el botón lleva a «Tu equipo», donde se ve y se puede cancelar. */
export const OWNER_NOTICE_BUTTON_LABEL = "Ver tu equipo";
/** Invitación ya aceptada: «Tu equipo» solo lista las pendientes, así que el botón no promete nada de eso. */
export const OWNER_NOTICE_ACCEPTED_BUTTON_LABEL = "Abrir Cotiza Prime";
const emailSchema = z.email().max(254);

export type InvitationOwnerNoticeInput = {
  recipientAddress: string;
  fromAddress: string;
  inviterName: string;
  organizationName: string;
  /** Cómo se llama el rol en la interfaz, p. ej. «Administrador». */
  roleLabel: string;
  invitedAt: string | Date;
  /** Adonde lleva el botón: «Tu equipo» (pendiente o vencida) o el inicio de la organización (ya aceptada). */
  teamUrl: string;
  /** La persona ya aceptó antes de que saliera el aviso: el texto no promete cancelar nada. */
  invitationAccepted?: boolean;
  idempotencyKey?: string;
};

export type InvitationOwnerNoticeResult =
  { ok: true; message: EmailMessage } | { ok: false; code: "invalid_input" };

export function buildInvitationOwnerNotice(
  input: InvitationOwnerNoticeInput,
): InvitationOwnerNoticeResult {
  if (
    !emailSchema.safeParse(input.recipientAddress).success ||
    !emailSchema.safeParse(input.fromAddress).success
  ) {
    return { ok: false, code: "invalid_input" };
  }
  let url: URL;
  try {
    url = new URL(input.teamUrl);
  } catch {
    return { ok: false, code: "invalid_input" };
  }
  const invitedAt = new Date(input.invitedAt);
  if (Number.isNaN(invitedAt.getTime())) return { ok: false, code: "invalid_input" };
  // Un nombre que queda vacío al limpiarlo (espacios, caracteres invisibles) no puede silenciar el aviso: se usa
  // el texto de respaldo.
  const inviter = cleanName(input.inviterName, FALLBACK_INVITER_NAME);
  const organization = cleanName(input.organizationName, FALLBACK_ORGANIZATION_NAME);
  const roleLabel = cleanText(input.roleLabel);
  if (!roleLabel) return { ok: false, code: "invalid_input" };

  // Los nombres se recortan por caracteres hasta que el asunto cabe: un nombre largo o con emojis no silencia el aviso.
  const subject = fitSubject(
    (shorten) =>
      `${shorten(inviter)} invitó a una persona a ${shorten(organization)} como ${roleLabel}`,
  );

  const accepted = input.invitationAccepted === true;
  const lines = [
    `${inviter} invitó a una persona a ${organization} con el rol de ${roleLabel}, el ${formatDate(invitedAt)}.`,
    accepted
      ? `La persona ya aceptó y es ${roleLabel} de tu organización. Revisa tu equipo.`
      : "Como ese rol puede manejar el equipo, te avisamos. Puedes ver la invitación y cancelarla, si no corresponde, en «Tu equipo».",
  ];
  const buttonLabel = accepted ? OWNER_NOTICE_ACCEPTED_BUTTON_LABEL : OWNER_NOTICE_BUTTON_LABEL;
  const footer = "Aviso automático de Cotiza Prime para el Dueño de la organización.";
  const paragraphs = lines.map((line) => `<p style="margin:0 0 12px 0;">${escapeHtml(line)}</p>`);
  const link = escapeHtml(url.href);
  const html = `<!doctype html>
<html lang="es-CL"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;font-family:Arial,Helvetica,sans-serif;color:#0f1729;font-size:16px;line-height:1.55;">
<tr><td style="padding:28px 28px 8px 28px;">${paragraphs.join("")}</td></tr>
<tr><td align="left" style="padding:8px 28px 28px 28px;"><a href="${link}" style="display:inline-block;background:#2b54e0;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:8px;">${buttonLabel}</a></td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e2e6ee;font-size:12px;color:#6b7489;">${escapeHtml(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [...lines, "", `${buttonLabel}: ${url.href}`, "", footer].join("\n");
  return {
    ok: true,
    message: {
      from: { name: OWNER_NOTICE_SENDER_NAME, address: input.fromAddress },
      to: input.recipientAddress,
      subject,
      html,
      text,
      idempotencyKey: input.idempotencyKey,
    },
  };
}
