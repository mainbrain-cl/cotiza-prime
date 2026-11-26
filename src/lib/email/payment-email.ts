/**
 * Los correos de cobro al cliente final (H-053 y H-056): «datos para pagar» al aceptar (correo 2) y «saldo» al pedir el segundo
 * pago (correo 3). Llevan la marca de la organización (no la de Cotiza Prime), el monto a pagar y los datos de transferencia
 * CONGELADOS en la cotización. Texto fijo: aquí no entra nada escrito a mano.
 */
import { z } from "zod";
import { formatClp } from "@/lib/money/clp";
import { resolvePdfBrand } from "@/lib/pdf/brand-colors";
import { escapeHtml } from "./basic-format";
import { cleanSenderName } from "./quote-email";
import type { EmailMessage } from "./types";
import { HEADER_UNSAFE } from "./unsafe-characters";

const MAX_SUBJECT_LENGTH = 150;
const UNSAFE_GLOBAL = new RegExp(HEADER_UNSAFE.source, "g");
const emailSchema = z.email().max(254);

export type PaymentEmailKind = "payment_1" | "payment_2";

export type PaymentEmailInput = {
  kind: PaymentEmailKind;
  recipientAddress: string;
  fromAddress: string;
  organizationName: string;
  brandPrimary: string | null;
  brandSecondary: string | null;
  customerName: string | null;
  quoteNumber: string;
  amountClp: number;
  /** «Anticipo (50 %)», «Pago total (100 %)» o «Saldo (50 %)». */
  milestoneLabel: string;
  /** Los datos de transferencia ya listos para mostrar; `null` si la organización no tenía cuenta al aceptar. */
  bankLines: { label: string; value: string }[] | null;
  idempotencyKey?: string;
};

export type PaymentEmailResult =
  { ok: true; message: EmailMessage } | { ok: false; code: "invalid_input" };

const clean = (value: string) => value.replace(UNSAFE_GLOBAL, " ").replace(/\s+/g, " ").trim();

export function paymentEmailSubject(kind: PaymentEmailKind, quoteNumber: string): string {
  const number = clean(quoteNumber);
  return kind === "payment_1"
    ? `Datos para pagar la cotización ${number}`
    : `Saldo de la cotización ${number}`;
}

export function buildPaymentEmail(input: PaymentEmailInput): PaymentEmailResult {
  if (
    !emailSchema.safeParse(input.recipientAddress).success ||
    !emailSchema.safeParse(input.fromAddress).success ||
    !Number.isSafeInteger(input.amountClp)
  ) {
    return { ok: false, code: "invalid_input" };
  }
  const senderName = cleanSenderName(input.organizationName);
  const number = clean(input.quoteNumber);
  const subject = paymentEmailSubject(input.kind, number);
  if (subject.length > MAX_SUBJECT_LENGTH) return { ok: false, code: "invalid_input" };
  const amount = formatClp(input.amountClp);
  const customer = input.customerName ? clean(input.customerName).slice(0, 120) : "";

  const lines: string[] = [customer ? `Estimado/a ${customer}:` : "Estimado/a cliente:"];
  if (input.kind === "payment_1") {
    lines.push(`Gracias por aceptar la cotización ${number}.`);
    lines.push(
      input.bankLines
        ? `Para confirmarla, transfiere ${amount} (${clean(input.milestoneLabel)}) a la cuenta que aparece abajo.`
        : `Corresponde pagar ${amount} (${clean(input.milestoneLabel)}). ${senderName} te enviará los datos para transferir.`,
    );
  } else {
    lines.push(
      input.bankLines
        ? `Corresponde pagar el saldo de la cotización ${number}: ${amount}. Transfiérelo a la cuenta que aparece abajo.`
        : `Corresponde pagar el saldo de la cotización ${number}: ${amount}. ${senderName} te enviará los datos para transferir.`,
    );
  }
  const closing = `En el comentario de la transferencia indica el número ${number}. Si ya pagaste, no hace falta que hagas nada más.`;

  const brand = resolvePdfBrand(input.brandPrimary, input.brandSecondary);
  const orgHtml = escapeHtml(senderName);
  const paragraphs = lines.map((line) => `<p style="margin:0 0 12px 0;">${escapeHtml(line)}</p>`);
  const rows = (input.bankLines ?? [])
    .map(
      ({ label, value }) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#4b5468;font-size:14px;white-space:nowrap;">${escapeHtml(label)}</td><td style="padding:6px 0;font-weight:bold;font-size:15px;word-break:break-all;">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const bankTable = rows
    ? `<tr><td style="padding:4px 28px 12px 28px;"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #e2e6ee;border-radius:8px;padding:8px 16px;">${rows}</table></td></tr>`
    : "";
  const html = `<!doctype html>
<html lang="es-CL"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#0f1729;font-size:16px;line-height:1.55;">
<tr><td style="background:${brand.primary};color:${brand.onPrimary};padding:20px 28px;font-size:18px;font-weight:bold;">${orgHtml}</td></tr>
<tr><td style="padding:28px 28px 8px 28px;">${paragraphs.join("")}</td></tr>
<tr><td style="padding:0 28px 12px 28px;"><p style="margin:0;font-size:14px;color:#4b5468;">Monto a pagar</p><p style="margin:0;font-size:26px;font-weight:bold;color:${brand.primaryText};">${escapeHtml(amount)}</p></td></tr>
${bankTable}
<tr><td style="padding:8px 28px 28px 28px;font-size:14px;color:#4b5468;">${escapeHtml(closing)}</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e2e6ee;font-size:12px;color:#6b7489;">Este correo fue enviado por ${orgHtml}.</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    ...lines,
    "",
    `Monto a pagar: ${amount}`,
    ...(input.bankLines ?? []).map(({ label, value }) => `${label}: ${value}`),
    "",
    closing,
    "",
    `Este correo fue enviado por ${senderName}.`,
  ].join("\n");

  return {
    ok: true,
    message: {
      from: { name: senderName, address: input.fromAddress },
      to: input.recipientAddress,
      subject,
      html,
      text,
      idempotencyKey: input.idempotencyKey,
    },
  };
}
