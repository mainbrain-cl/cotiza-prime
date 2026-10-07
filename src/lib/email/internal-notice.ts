/**
 * Aviso interno al autor de una cotización cuando el cliente la acepta o la rechaza (H-031).
 * Es un correo para una persona del equipo, no para el cliente: lleva el número, la decisión (con el
 * motivo de la lista si fue un rechazo) y un botón hacia la cotización dentro de la aplicación. NUNCA
 * lleva datos bancarios, el enlace del cliente, ni nada escrito por el cliente (su nombre y su comentario
 * libre se ven solo dentro de la aplicación, a los miembros de la organización).
 */
import { z } from "zod";
import { escapeHtml } from "./basic-format";
import type { EmailMessage } from "./types";
import { HEADER_UNSAFE } from "./unsafe-characters";

export const INTERNAL_SENDER_NAME = "Cotiza Prime";
export const NOTICE_BUTTON_LABEL = "Ver la cotización";
export const FREE_TEXT_NOTICE = "El cliente dejó un comentario; míralo en la cotización.";
const MAX_SUBJECT_LENGTH = 150;
const UNSAFE_GLOBAL = new RegExp(HEADER_UNSAFE.source, "g");
const emailSchema = z.email().max(254);

export type InternalNoticeInput = {
  recipientAddress: string;
  fromAddress: string;
  quoteNumber: string;
  decision: "accepted" | "rejected";
  /** Motivo de la lista, ya traducido a texto (solo en rechazos). */
  reasonLabel?: string | null;
  /** `true` si el cliente dejó un comentario libre: el correo solo avisa que existe, no lo copia. */
  hasFreeText?: boolean;
  /** Dirección de la cotización dentro de la aplicación. */
  quoteUrl: string;
  idempotencyKey?: string;
};

export type InternalNoticeResult =
  { ok: true; message: EmailMessage } | { ok: false; code: "invalid_input" };

const clean = (value: string) => value.replace(UNSAFE_GLOBAL, " ").replace(/\s+/g, " ").trim();

export function buildInternalNotice(input: InternalNoticeInput): InternalNoticeResult {
  if (
    !emailSchema.safeParse(input.recipientAddress).success ||
    !emailSchema.safeParse(input.fromAddress).success
  ) {
    return { ok: false, code: "invalid_input" };
  }
  let url: URL;
  try {
    url = new URL(input.quoteUrl);
  } catch {
    return { ok: false, code: "invalid_input" };
  }
  const number = clean(input.quoteNumber);
  const accepted = input.decision === "accepted";
  const subject = accepted
    ? `El cliente aceptó la cotización ${number}`
    : `El cliente rechazó la cotización ${number}`;
  if (subject.length > MAX_SUBJECT_LENGTH) return { ok: false, code: "invalid_input" };

  const lines: string[] = [
    accepted
      ? `Tu cliente aceptó la cotización ${number}.`
      : `Tu cliente rechazó la cotización ${number}.`,
  ];
  if (!accepted) {
    const reason = input.reasonLabel ? clean(input.reasonLabel) : "";
    if (reason) lines.push(`Motivo: ${reason}.`);
    if (input.hasFreeText) lines.push(FREE_TEXT_NOTICE);
  }
  lines.push("Puedes revisar el detalle y el historial en la cotización.");

  const paragraphs = lines.map((line) => `<p style="margin:0 0 12px 0;">${escapeHtml(line)}</p>`);
  const link = escapeHtml(url.href);
  const html = `<!doctype html>
<html lang="es-CL"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;font-family:Arial,Helvetica,sans-serif;color:#0f1729;font-size:16px;line-height:1.55;">
<tr><td style="padding:28px 28px 8px 28px;">${paragraphs.join("")}</td></tr>
<tr><td align="left" style="padding:8px 28px 28px 28px;"><a href="${link}" style="display:inline-block;background:#2b54e0;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:8px;">${NOTICE_BUTTON_LABEL}</a></td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e2e6ee;font-size:12px;color:#6b7489;">Aviso automático de Cotiza Prime para el equipo. No lo reenvíes al cliente.</td></tr>
</table></td></tr></table></body></html>`;

  const text = [...lines, "", `${NOTICE_BUTTON_LABEL}: ${url.href}`].join("\n");
  return {
    ok: true,
    message: {
      from: { name: INTERNAL_SENDER_NAME, address: input.fromAddress },
      to: input.recipientAddress,
      subject,
      html,
      text,
      idempotencyKey: input.idempotencyKey,
    },
  };
}
