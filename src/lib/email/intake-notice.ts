/**
 * Avisos al equipo del formulario público (H-087): «Llegó una solicitud» y «Tu formulario llegó al tope de
 * hoy». Son correos para personas de la organización, nunca para quien llenó el formulario. NUNCA llevan
 * datos del visitante (nombre, correo, teléfono, mensaje ni servicios pedidos): solo el nombre interno del
 * formulario y un botón hacia la aplicación, donde sí se ven con la sesión de un miembro.
 */
import { z } from "zod";
import { escapeHtml } from "./basic-format";
import type { EmailMessage } from "./types";
import { HEADER_UNSAFE } from "./unsafe-characters";

export const INTAKE_SENDER_NAME = "Cotiza Prime";
export const REQUEST_RECEIVED_SUBJECT = "Llegó una solicitud";
export const REQUEST_RECEIVED_BUTTON = "Ver las solicitudes";
export const CAP_FORM_SUBJECT = "Tu formulario llegó al tope de hoy";
export const CAP_ORG_SUBJECT = "Tu organización llegó al tope diario de solicitudes";
export const CAP_BUTTON = "Ver el formulario";
const MAX_FORM_NAME_LENGTH = 120;
const UNSAFE_GLOBAL = new RegExp(HEADER_UNSAFE.source, "g");
const emailSchema = z.email().max(254);

export type IntakeNoticeInput = {
  recipientAddress: string;
  fromAddress: string;
  /** Nombre interno del formulario (lo escribió la propia organización). */
  formName: string;
  /** Dirección dentro de la aplicación a la que lleva el botón. */
  appUrl: string;
  idempotencyKey?: string;
} & ({ kind: "request_received" } | { kind: "intake_cap_reached"; capKind: "form" | "org" });

export type IntakeNoticeResult =
  { ok: true; message: EmailMessage } | { ok: false; code: "invalid_input" };

const clean = (value: string) => value.replace(UNSAFE_GLOBAL, " ").replace(/\s+/g, " ").trim();

function copyFor(input: IntakeNoticeInput, formName: string) {
  if (input.kind === "request_received") {
    return {
      subject: REQUEST_RECEIVED_SUBJECT,
      button: REQUEST_RECEIVED_BUTTON,
      lines: [
        `Llegó una solicitud nueva por tu formulario «${formName}».`,
        "Los datos de quien la envió se ven dentro de la aplicación.",
      ],
    };
  }
  if (input.capKind === "org") {
    return {
      subject: CAP_ORG_SUBJECT,
      button: CAP_BUTTON,
      lines: [
        "Tu organización llegó hoy al tope diario de solicitudes de todos sus formularios.",
        `La última solicitud rechazada fue por «${formName}». Mañana vuelven a recibirse.`,
      ],
    };
  }
  return {
    subject: CAP_FORM_SUBJECT,
    button: CAP_BUTTON,
    lines: [
      `Tu formulario «${formName}» llegó hoy a su tope de solicitudes y no recibirá más hasta mañana.`,
      "Si fue por mucha demanda, puedes subir el tope en el formulario. Si fue por mensajes basura, puedes descartarlos o crear un enlace nuevo.",
    ],
  };
}

export function buildIntakeNotice(input: IntakeNoticeInput): IntakeNoticeResult {
  if (
    !emailSchema.safeParse(input.recipientAddress).success ||
    !emailSchema.safeParse(input.fromAddress).success
  ) {
    return { ok: false, code: "invalid_input" };
  }
  let url: URL;
  try {
    url = new URL(input.appUrl);
  } catch {
    return { ok: false, code: "invalid_input" };
  }
  const formName = clean(input.formName).slice(0, MAX_FORM_NAME_LENGTH);
  if (formName === "") return { ok: false, code: "invalid_input" };
  const { subject, button, lines } = copyFor(input, formName);

  const paragraphs = lines.map((line) => `<p style="margin:0 0 12px 0;">${escapeHtml(line)}</p>`);
  const link = escapeHtml(url.href);
  const html = `<!doctype html>
<html lang="es-CL"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;font-family:Arial,Helvetica,sans-serif;color:#0f1729;font-size:16px;line-height:1.55;">
<tr><td style="padding:28px 28px 8px 28px;">${paragraphs.join("")}</td></tr>
<tr><td align="left" style="padding:8px 28px 28px 28px;"><a href="${link}" style="display:inline-block;background:#2b54e0;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:8px;">${button}</a></td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e2e6ee;font-size:12px;color:#6b7489;">Aviso automático de Cotiza Prime para el equipo. No lleva datos de quien llenó el formulario.</td></tr>
</table></td></tr></table></body></html>`;

  const text = [...lines, "", `${button}: ${url.href}`].join("\n");
  return {
    ok: true,
    message: {
      from: { name: INTAKE_SENDER_NAME, address: input.fromAddress },
      to: input.recipientAddress,
      subject,
      html,
      text,
      idempotencyKey: input.idempotencyKey,
    },
  };
}
