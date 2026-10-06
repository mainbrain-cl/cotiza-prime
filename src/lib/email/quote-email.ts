/**
 * Arma el correo 1 (la cotización): remitente con el nombre de la organización, cuerpo con su
 * marca, botón hacia el enlace del cliente y el PDF adjunto. NUNCA lleva datos bancarios: esos
 * solo salen en el correo 2, después de aceptar (PROYECTO.md §6.5).
 */
import { z } from "zod";
import { resolvePdfBrand } from "@/lib/pdf/brand-colors";
import { escapeHtml, parseBasicFormat, type BasicFormatErrorCode } from "./basic-format";
import type { EmailMessage } from "./types";
import { HEADER_UNSAFE } from "./unsafe-characters";

export const MAX_SENDER_NAME_LENGTH = 60;
export const MAX_SUBJECT_LENGTH = 150;
export const FALLBACK_SENDER_NAME = "Cotizaciones";
export const BUTTON_LABEL = "Revisar y aceptar la cotización";
export const PDF_CONTENT_TYPE = "application/pdf";
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CONTROL_CHARACTERS = HEADER_UNSAFE;
const CONTROL_CHARACTERS_GLOBAL = new RegExp(HEADER_UNSAFE.source, "g");
const emailSchema = z.email().max(254);

export type QuoteEmailErrorCode =
  | "invalid_recipient"
  | "invalid_sender"
  | "invalid_subject"
  | "invalid_link"
  | "invalid_pdf"
  | BasicFormatErrorCode;

export type QuoteEmailResult =
  { ok: true; message: EmailMessage } | { ok: false; code: QuoteEmailErrorCode };

export type QuoteEmailInput = {
  organizationName: string;
  /** Colores de marca de la organización (hex); si faltan o son inválidos se usan los de Cotiza Prime. */
  brandPrimary: string | null;
  brandSecondary: string | null;
  recipientAddress: string;
  /** Si no viene, se usa `Cotización {número} de {organización}`. */
  subject?: string;
  quoteNumber: string;
  /** Texto del comercial, en el formato básico. */
  body: string;
  /** Enlace del cliente (`{APP_ORIGIN}/c/{token}`): lo arma quien llama. */
  viewUrl: string;
  fromAddress: string;
  pdf: { filename: string; bytes: Uint8Array };
  idempotencyKey?: string;
};

/**
 * Nombre visible del remitente: sin comillas, saltos de línea ni caracteres que permitan armar
 * una dirección falsa dentro del nombre (`<`, `>`, `@`), y de 60 caracteres como máximo.
 */
export function cleanSenderName(raw: string): string {
  const cleaned = raw
    .replace(CONTROL_CHARACTERS_GLOBAL, " ")
    .replace(/["'`<>@,;:\\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const clipped = [...cleaned].slice(0, MAX_SENDER_NAME_LENGTH).join("").trim();
  return clipped || FALLBACK_SENDER_NAME;
}

function safeFileName(raw: string): string {
  const base = raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
  const withoutExt = base.replace(/\.pdf$/i, "").slice(0, 80);
  return `${withoutExt || "cotizacion"}.pdf`;
}

function validViewUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const secure = url.protocol === "https:";
    const local = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
    if ((!secure && !local) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function isPdf(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength > PDF_MAGIC.length &&
    bytes.byteLength <= MAX_PDF_BYTES &&
    PDF_MAGIC.every((byte, index) => bytes[index] === byte)
  );
}

export function buildQuoteEmail(input: QuoteEmailInput): QuoteEmailResult {
  if (!emailSchema.safeParse(input.recipientAddress).success) {
    return { ok: false, code: "invalid_recipient" };
  }
  if (!emailSchema.safeParse(input.fromAddress).success)
    return { ok: false, code: "invalid_sender" };

  const senderName = cleanSenderName(input.organizationName);
  const quoteNumber = input.quoteNumber.replace(CONTROL_CHARACTERS_GLOBAL, " ").trim();
  const subject = input.subject ?? `Cotización ${quoteNumber} de ${senderName}`;
  if (
    CONTROL_CHARACTERS.test(subject) ||
    subject.trim().length === 0 ||
    subject.length > MAX_SUBJECT_LENGTH
  ) {
    return { ok: false, code: "invalid_subject" };
  }

  const url = validViewUrl(input.viewUrl);
  if (!url) return { ok: false, code: "invalid_link" };
  if (!isPdf(input.pdf.bytes)) return { ok: false, code: "invalid_pdf" };

  const brand = resolvePdfBrand(input.brandPrimary, input.brandSecondary);
  const formatted = parseBasicFormat(input.body, { linkColor: brand.primaryText });
  if (!formatted.ok) return { ok: false, code: formatted.code };

  const orgHtml = escapeHtml(senderName);
  const link = escapeHtml(url.href);
  const html = `<!doctype html>
<html lang="es-CL"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#0f1729;font-size:16px;line-height:1.55;">
<tr><td style="background:${brand.primary};color:${brand.onPrimary};padding:20px 28px;font-size:18px;font-weight:bold;">${orgHtml}</td></tr>
<tr><td style="padding:28px 28px 8px 28px;">${formatted.html}</td></tr>
<tr><td align="left" style="padding:8px 28px 8px 28px;"><a href="${link}" style="display:inline-block;background:${brand.primary};color:${brand.onPrimary};text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:8px;">${BUTTON_LABEL}</a></td></tr>
<tr><td style="padding:12px 28px 4px 28px;font-size:14px;color:#4b5468;">También puedes abrir este enlace en tu navegador:<br><a href="${link}" style="color:${brand.primaryText};word-break:break-all;">${link}</a></td></tr>
<tr><td style="padding:16px 28px 28px 28px;font-size:14px;color:#4b5468;">Adjuntamos la cotización ${escapeHtml(quoteNumber)} en PDF.</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e2e6ee;font-size:12px;color:#6b7489;">Este correo fue enviado por ${orgHtml}.</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    formatted.text,
    `${BUTTON_LABEL}: ${url.href}`,
    `Adjuntamos la cotización ${quoteNumber} en PDF.`,
    `Este correo fue enviado por ${senderName}.`,
  ].join("\n\n");

  return {
    ok: true,
    message: {
      from: { name: senderName, address: input.fromAddress },
      to: input.recipientAddress,
      subject,
      html,
      text,
      attachments: [
        {
          filename: safeFileName(input.pdf.filename),
          contentType: PDF_CONTENT_TYPE,
          content: input.pdf.bytes,
        },
      ],
      idempotencyKey: input.idempotencyKey,
    },
  };
}
