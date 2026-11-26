/**
 * H-051: aviso al Dueño y a los Administradores cuando alguien crea o cambia los datos de transferencia de la organización
 * (PROYECTO.md §13.2: el blanco clásico de una estafa es cambiar la cuenta para desviar los pagos). Dice quién, cuándo y los
 * últimos 4 del número antes y después; nunca el número completo ni los demás datos bancarios.
 */
import { z } from "zod";
import { escapeHtml } from "./basic-format";
import { INTERNAL_SENDER_NAME } from "./internal-notice";
import type { EmailMessage } from "./types";
import { HEADER_UNSAFE } from "./unsafe-characters";

const UNSAFE_GLOBAL = new RegExp(HEADER_UNSAFE.source, "g");
const emailSchema = z.email().max(254);
const BUTTON_LABEL = "Revisar los datos de transferencia";

export type BankChangeNoticeInput = {
  recipientAddress: string;
  fromAddress: string;
  organizationName: string;
  /** Correo de quien hizo el cambio. */
  actorEmail: string;
  /** Fecha y hora ya formateadas (Chile). */
  whenText: string;
  /** Últimos 4 del número antes (`null` si es la primera vez) y después. */
  last4Before: string | null;
  last4After: string;
  settingsUrl: string;
};

const clean = (value: string) => value.replace(UNSAFE_GLOBAL, " ").replace(/\s+/g, " ").trim();

export function buildBankChangeNotice(
  input: BankChangeNoticeInput,
): { ok: true; message: EmailMessage } | { ok: false } {
  if (
    !emailSchema.safeParse(input.recipientAddress).success ||
    !emailSchema.safeParse(input.fromAddress).success
  ) {
    return { ok: false };
  }
  let url: URL;
  try {
    url = new URL(input.settingsUrl);
  } catch {
    return { ok: false };
  }
  const organization = clean(input.organizationName).slice(0, 80);
  const subject = `Cambiaron los datos de transferencia de ${organization}`.slice(0, 150);
  const lines = [
    `${clean(input.actorEmail)} ${input.last4Before ? "cambió" : "registró"} los datos de transferencia de ${organization} el ${clean(input.whenText)}.`,
    input.last4Before
      ? `Cuenta terminada en ${input.last4Before} → cuenta terminada en ${input.last4After}.`
      : `Cuenta terminada en ${input.last4After}.`,
    "Si no reconoces este cambio, revísalo de inmediato: tus clientes recibirán estos datos para pagarte.",
  ];
  const paragraphs = lines.map((line) => `<p style="margin:0 0 12px 0;">${escapeHtml(line)}</p>`);
  const link = escapeHtml(url.href);
  const html = `<!doctype html>
<html lang="es-CL"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;font-family:Arial,Helvetica,sans-serif;color:#0f1729;font-size:16px;line-height:1.55;">
<tr><td style="padding:28px 28px 8px 28px;">${paragraphs.join("")}</td></tr>
<tr><td align="left" style="padding:8px 28px 28px 28px;"><a href="${link}" style="display:inline-block;background:#2b54e0;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:8px;">${BUTTON_LABEL}</a></td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e2e6ee;font-size:12px;color:#6b7489;">Aviso automático de Cotiza Prime para el Dueño y los Administradores.</td></tr>
</table></td></tr></table></body></html>`;
  return {
    ok: true,
    message: {
      from: { name: INTERNAL_SENDER_NAME, address: input.fromAddress },
      to: input.recipientAddress,
      subject,
      html,
      text: [...lines, "", `${BUTTON_LABEL}: ${url.href}`].join("\n"),
    },
  };
}
