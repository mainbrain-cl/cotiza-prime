"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { encryptPii } from "@/lib/crypto/pii";
import { searchHash } from "@/lib/crypto/search-hash";
import { getCustomer } from "@/lib/customers/queries";
import { BASIC_FORMAT_ERROR_MESSAGES, parseBasicFormat } from "@/lib/email/basic-format";
import { buildQuoteEmail } from "@/lib/email/quote-email";
import { EmailConfigError, getEmailTransport } from "@/lib/email/transport";
import { loadEmailConfig } from "@/lib/email/config";
import type { EmailMessage, EmailSendResult, EmailTransport } from "@/lib/email/types";
import { serverLog } from "@/lib/log/server-log";
import { getAppOrigin } from "@/lib/http/request-context";
import { normalizeEmail } from "@/lib/normalize/email";
import { quotePdfFileName } from "@/lib/pdf/file-name";
import { loadQuoteDocumentData } from "@/lib/pdf/quote-document-data";
import { renderQuotePdf } from "@/lib/pdf/render";
import { getQuote } from "@/lib/quotes/queries";
import { hashShareToken, newShareToken } from "@/lib/share/token";
import { requireActiveTenant, type ActiveTenant } from "@/lib/tenant/active-tenant";
import { isUuid, tenantPath } from "@/lib/tenant/constants";
import { resendQuoteInputSchema, sendQuoteInputSchema } from "./content";
import { loadSendContext } from "./context";
import {
  packageLogoPath,
  packagePdfPath,
  readPackagePdf,
  sha256Hex,
  uploadPackageLogo,
  uploadPackagePdf,
} from "./document-storage";
import { buildCustomerSnapshot, buildDocumentSnapshot, contentSha256 } from "./snapshot";

// ---------------------------------------------------------------------------------------------
// Enviar la cotización por correo (H-029). Diseño: docs/arquitectura/sprint-3-envio-y-enlace.md §4.
// Orden: organización activa → rol → zod → formato del texto → correo del cliente → ids y token →
// datos personales cifrados → `prepare_quote_send` (congela y toma el candado) → PDF con las fechas
// congeladas → subirlo → `attach_quote_package_document` → enviar con clave anti-duplicado →
// `confirm_email_dispatch` o `fail_email_dispatch`. Si falla, la cotización NO cambia de estado.
// Nunca se registran correos, textos ni el token: solo códigos.
// ---------------------------------------------------------------------------------------------

export type SendQuoteResult =
  | { status: "sent" }
  /** Otro clic del mismo envío todavía está en curso: no se hace nada, no se duplica. */
  | { status: "in_progress" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string> };

const WRITER_ROLES: readonly string[] = ["owner", "admin", "sales"];
const RESEND_ROLES: readonly string[] = ["owner", "admin", "sales"];
const SEND_TIMEOUT_MS = 15_000;

const SQLSTATE_FORBIDDEN = "42501";
const SQLSTATE_NOT_FOUND = "CP404";
const SQLSTATE_CONFLICT = "CP409";
const SQLSTATE_INVALID = "CP422";
const SQLSTATE_NOT_ALLOWED = "CP423";
const SQLSTATE_LIMIT = "CP429";

const MSG_NOT_FOUND = "No encontramos esta cotización.";
const MSG_FORBIDDEN_SEND = "Solo quien creó esta cotización puede enviarla.";
const MSG_ROLE = "Tu rol no permite enviar cotizaciones.";
const MSG_NOT_DRAFT =
  "Esta cotización ya no está en borrador, así que no se puede enviar de nuevo.";
const MSG_NO_EMAIL =
  "Este cliente no tiene correo. Agrégalo en la ficha del cliente para poder enviarle la cotización.";
const MSG_UNREADABLE_CUSTOMER =
  "No pudimos leer los datos del cliente. Revisa su ficha e inténtalo de nuevo.";
const MSG_NO_LINES = "Agrega al menos una línea a la cotización antes de enviarla.";
const MSG_ANONYMIZED = "Este cliente ya no está disponible. Elige otro en la cotización.";
const MSG_VALIDITY_PAST = "La vigencia de la cotización ya pasó. Cambia la fecha y guarda.";
const MSG_CHANGED = "La cotización cambió mientras la enviabas. Recarga la página y revísala.";
const MSG_IN_PROGRESS_OTHER = "Esta cotización ya se está enviando. Espera unos segundos.";
const MSG_FAILED =
  "No pudimos enviar el correo. La cotización sigue como borrador: revisa el correo del cliente e inténtalo de nuevo.";
const MSG_FAILED_RESEND =
  "No pudimos reenviar el correo. La cotización no cambió: inténtalo de nuevo en unos minutos.";
const MSG_UNEXPECTED = "No pudimos enviar la cotización. Intenta de nuevo en unos minutos.";
const MSG_EMAIL_NOT_CONFIGURED =
  "El envío de correos no está configurado todavía. Avisa al equipo de Cotiza Prime.";
const MSG_PDF_FAILED =
  "No pudimos armar el PDF de la cotización. No se envió nada: inténtalo de nuevo.";
const MSG_NOT_SENT_YET = "Esta cotización todavía no se ha enviado.";
const MSG_RESEND_CLOSED = "Esta cotización ya no se puede reenviar.";
const MSG_RESEND_LIMIT = "Llegaste al máximo de reenvíos de esta cotización por hoy.";
const MSG_FILE_MISSING =
  "No encontramos el PDF guardado de esta cotización. No se reenvió nada. Avisa al equipo.";
const MSG_CONFIRM_FAILED =
  "El correo salió, pero no pudimos registrarlo. Avisa al equipo antes de volver a enviarlo.";

type SupabaseError = { code?: string; message?: string };

const failure = (message: string, fieldErrors?: Record<string, string>): SendQuoteResult => ({
  status: "error",
  message,
  fieldErrors,
});

function revalidateQuote(tenantId: string, quoteId: string) {
  revalidatePath(tenantPath(tenantId, "cotizaciones"));
  revalidatePath(tenantPath(tenantId, `cotizaciones/${quoteId}`));
}

async function withTimeout(transport: EmailTransport, message: EmailMessage) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<EmailSendResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, retryable: true, code: "timeout" }),
      SEND_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([transport.send(message), timeout]);
  } catch {
    return { ok: false, retryable: true, code: "network_error" } satisfies EmailSendResult;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function prepareErrorMessage(error: SupabaseError): string {
  const message = error.message ?? "";
  switch (error.code) {
    case SQLSTATE_FORBIDDEN:
      return MSG_FORBIDDEN_SEND;
    case SQLSTATE_NOT_FOUND:
      return MSG_NOT_FOUND;
    case SQLSTATE_NOT_ALLOWED:
      return MSG_NOT_DRAFT;
    case SQLSTATE_CONFLICT:
      return message.startsWith("send_in_progress") ? MSG_IN_PROGRESS_OTHER : MSG_CHANGED;
    case SQLSTATE_INVALID:
      if (message.startsWith("no_lines")) return MSG_NO_LINES;
      if (message.startsWith("customer_anonymized")) return MSG_ANONYMIZED;
      if (message.startsWith("validity_past")) return MSG_VALIDITY_PAST;
      return MSG_UNEXPECTED;
    default:
      return MSG_UNEXPECTED;
  }
}

/** El correo no salió: queda registrado como fallido y se suelta el candado. */
async function failDispatch(
  active: ActiveTenant,
  emailMessageId: string,
  tokenSha256: string,
  code: string,
): Promise<void> {
  const { error } = await active.supabase.rpc("fail_email_dispatch", {
    p_email_message_id: emailMessageId,
    p_error_code: code,
    p_token_sha256: tokenSha256,
  });
  if (error) await serverLog("error", "quote_send_fail_record_failed", { code: error.code });
}

/** Envía el correo y, según la respuesta del proveedor, lo confirma o lo marca como fallido. */
async function dispatchAndConfirm(params: {
  active: ActiveTenant;
  quoteId: string;
  transport: EmailTransport;
  message: EmailMessage;
  emailMessageId: string;
  tokenSha256: string;
  failedMessage: string;
}): Promise<SendQuoteResult> {
  const { active, transport, emailMessageId, tokenSha256 } = params;
  const sent = await withTimeout(transport, params.message);
  if (!sent.ok) {
    await serverLog("warn", "quote_send_provider_failed", {
      provider: transport.provider,
      code: sent.code,
    });
    await failDispatch(active, emailMessageId, tokenSha256, sent.code);
    revalidateQuote(active.tenantId, params.quoteId);
    return failure(params.failedMessage);
  }
  const { error } = await active.supabase.rpc("confirm_email_dispatch", {
    p_email_message_id: emailMessageId,
    p_provider: transport.provider,
    p_provider_message_id: sent.providerMessageId,
    p_token_sha256: tokenSha256,
  });
  if (error) {
    // El proveedor aceptó el correo pero la base no lo pudo registrar: no se marca como fallido.
    // TODO(reconciliación): la tarea que revisa paquetes en `ready` lo resolverá (plan §4).
    await serverLog("error", "quote_send_confirm_failed", { code: error.code });
    revalidateQuote(active.tenantId, params.quoteId);
    return failure(MSG_CONFIRM_FAILED);
  }
  revalidateQuote(active.tenantId, params.quoteId);
  return { status: "sent" };
}

function loadTransport():
  { ok: true; transport: EmailTransport; fromAddress: string } | { ok: false } {
  try {
    const config = loadEmailConfig();
    return { ok: true, transport: getEmailTransport(config), fromAddress: config.fromAddress };
  } catch (cause) {
    if (!(cause instanceof EmailConfigError)) throw cause;
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------------------------
// Primer envío
// ---------------------------------------------------------------------------------------------

export async function sendQuoteAction(
  tenantId: string,
  quoteId: string,
  input: unknown,
): Promise<SendQuoteResult> {
  const active = await requireActiveTenant(tenantId);
  if (!isUuid(quoteId)) return failure(MSG_NOT_FOUND);
  if (!WRITER_ROLES.includes(active.role)) return failure(MSG_ROLE);

  // 1-2. Forma de lo que llegó y formato básico del texto.
  const parsed = sendQuoteInputSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "");
      if ((field === "subject" || field === "body") && !fieldErrors[field]) {
        fieldErrors[field] = issue.message;
      }
    }
    return failure(
      Object.keys(fieldErrors).length > 0 ? "Revisa los datos marcados." : MSG_UNEXPECTED,
      fieldErrors,
    );
  }
  const { subject, body, expectedRevision, sendKey } = parsed.data;
  const formatted = parseBasicFormat(body);
  if (!formatted.ok) {
    return failure("Revisa el texto del correo.", {
      body: BASIC_FORMAT_ERROR_MESSAGES[formatted.code],
    });
  }

  const mail = loadTransport();
  if (!mail.ok) {
    await serverLog("error", "quote_send_email_not_configured");
    return failure(MSG_EMAIL_NOT_CONFIGURED);
  }

  // 3. La cotización y el correo del cliente.
  const detail = await getQuote(active, quoteId);
  if (detail === null) return failure(MSG_NOT_FOUND);
  if (detail.quote.created_by !== active.userId) return failure(MSG_FORBIDDEN_SEND);
  if (detail.quote.status !== "draft") return failure(MSG_NOT_DRAFT);
  if (detail.items.length === 0) return failure(MSG_NO_LINES);
  const customer = await getCustomer(active, detail.quote.customer_id);
  if (customer === null) return failure(MSG_ANONYMIZED);
  if (customer === "unreadable") return failure(MSG_UNREADABLE_CUSTOMER);
  if (!customer.email) return failure(MSG_NO_EMAIL);
  const toEmail = normalizeEmail(customer.email);

  // 4. Ids, token y datos personales cifrados: todo se genera aquí, en la aplicación.
  const packageId = randomUUID();
  const emailMessageId = randomUUID();
  const shareLinkId = randomUUID();
  const token = newShareToken();
  const tokenSha256 = hashShareToken(token);
  let toEmailEnc: string;
  let snapshotEnc: string;
  try {
    toEmailEnc = encryptPii(toEmail, {
      table: "email_messages",
      field: "to_email",
      tenantId: active.tenantId,
      rowId: emailMessageId,
    });
    snapshotEnc = encryptPii(JSON.stringify(buildCustomerSnapshot(customer)), {
      table: "quote_packages",
      field: "customer_snapshot",
      tenantId: active.tenantId,
      rowId: packageId,
    });
  } catch {
    await serverLog("error", "quote_send_encrypt_failed");
    return failure(MSG_UNEXPECTED);
  }
  const toEmailHash = searchHash("email", active.tenantId, toEmail);

  // 5. Congela lo que se enviará y toma el candado.
  const { data: prepared, error: prepareError } = await active.supabase.rpc("prepare_quote_send", {
    p_quote_id: quoteId,
    p_expected_revision: expectedRevision,
    p_send_key: sendKey,
    p_package_id: packageId,
    p_email_message_id: emailMessageId,
    p_share_link_id: shareLinkId,
    p_token_sha256: tokenSha256,
    p_email_subject: subject,
    p_email_body_md: body,
    p_to_email_enc: toEmailEnc,
    p_to_email_hash: toEmailHash,
    p_customer_snapshot_enc: snapshotEnc,
  });
  if (prepareError) {
    if (prepareError.code !== SQLSTATE_CONFLICT && prepareError.code !== SQLSTATE_FORBIDDEN) {
      await serverLog("warn", "quote_send_prepare_failed", { code: prepareError.code });
    }
    return failure(prepareErrorMessage(prepareError));
  }
  const result = prepared as {
    status: "prepared" | "in_progress" | "already_sent";
    issue_date?: string;
    valid_until?: string;
  };
  if (result.status === "already_sent") {
    revalidateQuote(active.tenantId, quoteId);
    return { status: "sent" };
  }
  if (result.status === "in_progress") return { status: "in_progress" };
  if (!result.issue_date || !result.valid_until) {
    await failDispatch(active, emailMessageId, tokenSha256, "prepare_incomplete");
    return failure(MSG_UNEXPECTED);
  }

  // 6. El PDF, con la fecha de emisión y la vigencia congeladas.
  const loaded = await loadQuoteDocumentData(active, quoteId, "letter", {
    issueDate: result.issue_date,
    validUntil: result.valid_until,
  });
  if (!loaded.ok) {
    await failDispatch(active, emailMessageId, tokenSha256, "document_unavailable");
    return failure(MSG_PDF_FAILED);
  }
  if (loaded.revision !== expectedRevision) {
    await failDispatch(active, emailMessageId, tokenSha256, "quote_changed");
    return failure(MSG_CHANGED);
  }
  let pdf: Uint8Array;
  try {
    pdf = new Uint8Array(await renderQuotePdf(loaded.data));
  } catch {
    await serverLog("error", "quote_send_pdf_render_failed");
    await failDispatch(active, emailMessageId, tokenSha256, "pdf_render_failed");
    return failure(MSG_PDF_FAILED);
  }
  const pdfSha256 = sha256Hex(pdf);

  // 7. Subir el PDF (y el logo) al almacenamiento privado, sin reemplazar nada.
  const pdfPath = packagePdfPath(active.tenantId, quoteId, packageId);
  const logo = loaded.data.organization.logo;
  const logoPath = logo ? packageLogoPath(active.tenantId, quoteId, packageId, logo.format) : null;
  const uploaded =
    (await uploadPackagePdf(pdfPath, pdf)) &&
    (logo && logoPath ? await uploadPackageLogo(logoPath, logo.data, logo.format) : true);
  if (!uploaded) {
    await serverLog("error", "quote_send_upload_failed");
    await failDispatch(active, emailMessageId, tokenSha256, "upload_failed");
    return failure(MSG_UNEXPECTED);
  }

  // 8. Registrar el documento en el paquete.
  const snapshot = buildDocumentSnapshot(loaded.data);
  const { error: attachError } = await active.supabase.rpc("attach_quote_package_document", {
    p_package_id: packageId,
    p_pdf_path: pdfPath,
    p_pdf_sha256: pdfSha256,
    p_pdf_bytes: pdf.byteLength,
    p_logo_path: logoPath,
    p_document_snapshot: snapshot,
    p_content_sha256: contentSha256({
      subject,
      body,
      issueDate: result.issue_date,
      validUntil: result.valid_until,
      pdfSha256,
      snapshot,
    }),
    p_token_sha256: tokenSha256,
  });
  if (attachError) {
    await serverLog("error", "quote_send_attach_failed", { code: attachError.code });
    await failDispatch(active, emailMessageId, tokenSha256, "attach_failed");
    return failure(attachError.code === SQLSTATE_CONFLICT ? MSG_CHANGED : MSG_UNEXPECTED);
  }

  // 9. Armar el correo y enviarlo, con clave anti-duplicado.
  const email = buildQuoteEmail({
    organizationName: loaded.organizationName,
    brandPrimary: loaded.data.brand.primary,
    brandSecondary: loaded.data.brand.secondary,
    recipientAddress: toEmail,
    replyTo: loaded.organizationContactEmail ?? (active.user.email || undefined),
    subject,
    quoteNumber: loaded.data.quote.number,
    body,
    viewUrl: `${getAppOrigin()}/c/${token}`,
    fromAddress: mail.fromAddress,
    pdf: { filename: quotePdfFileName(loaded.numberDisplay, loaded.version), bytes: pdf },
    idempotencyKey: emailMessageId,
  });
  if (!email.ok) {
    await serverLog("warn", "quote_send_email_build_failed", { code: email.code });
    await failDispatch(active, emailMessageId, tokenSha256, email.code);
    return failure(MSG_FAILED);
  }

  // 10. Aceptado por el proveedor → confirmar; si no, fallido y la cotización sigue en borrador.
  return dispatchAndConfirm({
    active,
    quoteId,
    transport: mail.transport,
    message: email.message,
    emailMessageId,
    tokenSha256,
    failedMessage: MSG_FAILED,
  });
}

// ---------------------------------------------------------------------------------------------
// Reenvío: el MISMO PDF congelado y un enlace nuevo
// ---------------------------------------------------------------------------------------------

function resendErrorMessage(error: SupabaseError): string {
  switch (error.code) {
    case SQLSTATE_FORBIDDEN:
      return "Solo quien creó la cotización, el Dueño o un Administrador pueden reenviarla.";
    case SQLSTATE_NOT_FOUND:
      return MSG_NOT_FOUND;
    case SQLSTATE_NOT_ALLOWED:
      return MSG_RESEND_CLOSED;
    case SQLSTATE_LIMIT:
      return MSG_RESEND_LIMIT;
    case SQLSTATE_INVALID:
      return (error.message ?? "").startsWith("quote_expired")
        ? "La vigencia de la cotización ya pasó: extiéndela antes de reenviar."
        : MSG_UNEXPECTED;
    default:
      return MSG_UNEXPECTED;
  }
}

export async function resendQuoteAction(
  tenantId: string,
  quoteId: string,
  input: unknown,
): Promise<SendQuoteResult> {
  const active = await requireActiveTenant(tenantId);
  if (!isUuid(quoteId)) return failure(MSG_NOT_FOUND);
  if (!RESEND_ROLES.includes(active.role)) return failure(MSG_ROLE);
  const parsed = resendQuoteInputSchema.safeParse(input);
  if (!parsed.success) return failure(MSG_UNEXPECTED);

  const mail = loadTransport();
  if (!mail.ok) {
    await serverLog("error", "quote_send_email_not_configured");
    return failure(MSG_EMAIL_NOT_CONFIGURED);
  }
  const detail = await getQuote(active, quoteId);
  if (detail === null) return failure(MSG_NOT_FOUND);
  if (detail.quote.status === "draft") return failure(MSG_NOT_SENT_YET);
  const context = await loadSendContext(active);
  if (context === null) return failure(MSG_UNEXPECTED);
  // El correo actual de la ficha del cliente: así se puede corregir un correo mal escrito y reenviar.
  const customer = await getCustomer(active, detail.quote.customer_id);
  if (customer === null) return failure(MSG_ANONYMIZED);
  if (customer === "unreadable") return failure(MSG_UNREADABLE_CUSTOMER);
  if (!customer.email) return failure(MSG_NO_EMAIL);
  const toEmail = normalizeEmail(customer.email);

  // El id del correo es la clave de este reenvío: repetir el clic no crea otro.
  const emailMessageId = parsed.data.resendKey;
  const shareLinkId = randomUUID();
  const token = newShareToken();
  const tokenSha256 = hashShareToken(token);
  let toEmailEnc: string;
  try {
    toEmailEnc = encryptPii(toEmail, {
      table: "email_messages",
      field: "to_email",
      tenantId: active.tenantId,
      rowId: emailMessageId,
    });
  } catch {
    await serverLog("error", "quote_send_encrypt_failed");
    return failure(MSG_UNEXPECTED);
  }

  const { data: prepared, error } = await active.supabase.rpc("prepare_quote_resend", {
    p_quote_id: quoteId,
    p_resend_key: emailMessageId,
    p_email_message_id: emailMessageId,
    p_share_link_id: shareLinkId,
    p_token_sha256: tokenSha256,
    p_to_email_enc: toEmailEnc,
    p_to_email_hash: searchHash("email", active.tenantId, toEmail),
  });
  if (error) {
    await serverLog("warn", "quote_resend_prepare_failed", { code: error.code });
    return failure(resendErrorMessage(error));
  }
  const info = prepared as {
    status: "prepared" | "replayed";
    pdf_path: string;
    pdf_sha256: string;
    email_subject: string;
    email_body_md: string;
  };
  if (info.status === "replayed") return { status: "in_progress" };

  // Lo que se reenvía es exactamente el archivo congelado: si no coincide su sello, no se envía.
  const pdf = await readPackagePdf(info.pdf_path, info.pdf_sha256);
  if (pdf === null) {
    await serverLog("error", "quote_resend_file_unavailable");
    await failDispatch(active, emailMessageId, tokenSha256, "file_unavailable");
    return failure(MSG_FILE_MISSING);
  }
  const email = buildQuoteEmail({
    organizationName: context.organizationName,
    brandPrimary: context.brandPrimary,
    brandSecondary: context.brandSecondary,
    recipientAddress: toEmail,
    replyTo: context.contactEmail ?? (active.user.email || undefined),
    subject: info.email_subject,
    quoteNumber: detail.quote.number_display,
    body: info.email_body_md,
    viewUrl: `${getAppOrigin()}/c/${token}`,
    fromAddress: mail.fromAddress,
    pdf: {
      filename: quotePdfFileName(detail.quote.number_display, detail.quote.version),
      bytes: pdf,
    },
    idempotencyKey: emailMessageId,
  });
  if (!email.ok) {
    await serverLog("warn", "quote_send_email_build_failed", { code: email.code });
    await failDispatch(active, emailMessageId, tokenSha256, email.code);
    return failure(MSG_FAILED_RESEND);
  }
  return dispatchAndConfirm({
    active,
    quoteId,
    transport: mail.transport,
    message: email.message,
    emailMessageId,
    tokenSha256,
    failedMessage: MSG_FAILED_RESEND,
  });
}
