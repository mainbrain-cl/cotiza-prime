"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { fieldErrorsOf } from "@/lib/auth/schemas";
import { serverLog } from "@/lib/log/server-log";
import { parseClp } from "@/lib/money/clp";
import { NO_PERMISSION_MESSAGE } from "@/lib/permissions/matrix";
import { requirePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { isUuid, tenantPath } from "@/lib/tenant/constants";
import { accountLast4, bankDetailsSchema } from "./bank";
import { notifyBankAccountChange } from "./bank-notice";
import { isPaymentTerms } from "./model";
import { encryptBankDetails, paymentContextSchema, sendPaymentEmail } from "./notice";

/**
 * Acciones del cobro (H-050, H-052, H-054, H-055 y H-056). Cada una resuelve la organización activa, exige el permiso con la matriz
 * ANTES de tocar la base y llama a una función que lo vuelve a exigir (con el pase de la persona, nunca la llave maestra). A los
 * logs solo van códigos: nunca datos bancarios, montos escritos ni correos.
 */

const SQLSTATE_FORBIDDEN = "42501";
const SQLSTATE_CONFLICT = "CP409";
const SQLSTATE_NOT_ALLOWED = "CP423";
const SQLSTATE_INVALID = "CP422";

const MSG_UNEXPECTED = "No pudimos guardar el cambio. Inténtalo de nuevo en unos minutos.";

export type PaymentActionResult =
  { status: "ok"; message?: string } | { status: "error"; message: string };

const failure = (message: string): { status: "error"; message: string } => ({
  status: "error",
  message,
});

function revalidateQuote(tenantId: string, quoteId: string) {
  revalidatePath(tenantPath(tenantId, "cotizaciones"));
  revalidatePath(tenantPath(tenantId, `cotizaciones/${quoteId}`));
  revalidatePath(tenantPath(tenantId, ""));
}

// ---------------------------------------------------------------------------------------------
// H-050 · Datos de transferencia
// ---------------------------------------------------------------------------------------------

export type BankAccountFormState = {
  status: "idle" | "saved" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
  revision?: number;
  bankAccountId?: string;
};

function readText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function saveBankAccountAction(
  tenantId: string,
  _previous: BankAccountFormState,
  formData: FormData,
): Promise<BankAccountFormState> {
  const active = await requireActiveTenant(tenantId);
  const denied = requirePermission(active, "bank_account.manage");
  if (denied) return { status: "error", message: denied };

  const parsed = bankDetailsSchema.safeParse({
    bank: readText(formData, "bank"),
    accountType: readText(formData, "accountType"),
    accountNumber: readText(formData, "accountNumber"),
    holderName: readText(formData, "holderName"),
    holderRut: readText(formData, "holderRut"),
    email: readText(formData, "email"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: "Revisa los datos marcados.",
      fieldErrors: fieldErrorsOf(parsed.error),
    };
  }
  const expectedRevision = Number(readText(formData, "expectedRevision"));
  const existingId = readText(formData, "bankAccountId");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    return failure(MSG_UNEXPECTED);
  if (existingId && !isUuid(existingId)) return failure(MSG_UNEXPECTED);
  const bankAccountId = existingId || randomUUID();

  let detailsEnc: string;
  try {
    detailsEnc = encryptBankDetails(parsed.data, active.tenantId, bankAccountId);
  } catch {
    await serverLog("error", "bank_account_encrypt_failed");
    return failure(MSG_UNEXPECTED);
  }
  const { data, error } = await active.supabase.rpc("set_bank_account", {
    p_bank_account_id: bankAccountId,
    p_details_enc: detailsEnc,
    p_account_last4: accountLast4(parsed.data.accountNumber),
    p_expected_revision: expectedRevision,
  });
  if (error) {
    if (error.code === SQLSTATE_FORBIDDEN) return failure(NO_PERMISSION_MESSAGE);
    if (error.code === SQLSTATE_CONFLICT) {
      return failure(
        "Otra persona cambió los datos de transferencia mientras los editabas. Recarga la página para ver los actuales.",
      );
    }
    await serverLog("error", "set_bank_account_failed", { code: error.code });
    return failure(MSG_UNEXPECTED);
  }
  const saved = data as {
    id?: string;
    revision?: number;
    account_last4_before?: string | null;
  } | null;
  // H-051: aviso al Dueño y a los Administradores, después de responder (no frena el guardado).
  const last4After = accountLast4(parsed.data.accountNumber);
  after(() =>
    notifyBankAccountChange(active, {
      last4Before: saved?.account_last4_before ?? null,
      last4After,
    }),
  );
  revalidatePath(tenantPath(active.tenantId, "configuracion/pagos"));
  return {
    status: "saved",
    message: "Datos de transferencia guardados.",
    revision: saved?.revision,
    bankAccountId: saved?.id,
  };
}

// ---------------------------------------------------------------------------------------------
// H-052 · Condición de pago de un borrador
// ---------------------------------------------------------------------------------------------

export async function setPaymentTermsAction(
  tenantId: string,
  quoteId: string,
  terms: string | null,
): Promise<PaymentActionResult> {
  const active = await requireActiveTenant(tenantId);
  if (!isUuid(quoteId)) return failure("No encontramos la cotización.");
  const denied = requirePermission(active, "quote.send");
  if (denied) return failure(denied);
  if (terms !== null && !isPaymentTerms(terms)) return failure(MSG_UNEXPECTED);
  const { error } = await active.supabase.rpc("set_quote_payment_terms", {
    p_quote_id: quoteId,
    p_terms: terms,
  });
  if (error) {
    if (error.code === SQLSTATE_FORBIDDEN) return failure(NO_PERMISSION_MESSAGE);
    if (error.code === SQLSTATE_INVALID && (error.message ?? "").startsWith("no_bank_account")) {
      return failure(
        "Tu organización todavía no tiene datos de transferencia. Pide al Dueño o a un Administrador que los registre en Configuración.",
      );
    }
    if (error.code === SQLSTATE_NOT_ALLOWED) {
      return failure("Esta cotización ya no se puede cambiar: ya se envió o se está enviando.");
    }
    await serverLog("error", "set_payment_terms_failed", { code: error.code });
    return failure(MSG_UNEXPECTED);
  }
  revalidatePath(tenantPath(active.tenantId, `cotizaciones/${quoteId}/enviar`));
  return { status: "ok" };
}

// ---------------------------------------------------------------------------------------------
// H-054 · Marcar un pago como recibido · H-055 · Deshacerlo
// ---------------------------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const recordInputSchema = z.object({
  paidOn: z.string().regex(ISO_DATE, "Elige la fecha en que llegó el pago."),
  amount: z.string(),
  note: z
    .string()
    .trim()
    .max(500, "La nota no puede pasar de 500 caracteres.")
    .transform((value) => (value === "" ? null : value)),
});

export async function recordPaymentAction(
  tenantId: string,
  quoteId: string,
  milestoneId: string,
  input: { paidOn: string; amount: string; note: string },
): Promise<PaymentActionResult> {
  const active = await requireActiveTenant(tenantId);
  if (!isUuid(quoteId) || !isUuid(milestoneId)) return failure("No encontramos el pago.");
  const denied = requirePermission(active, "payment.confirm");
  if (denied) return failure(denied);
  const parsed = recordInputSchema.safeParse(input);
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? MSG_UNEXPECTED);
  const amount = parseClp(parsed.data.amount);
  if (!amount.ok) return failure("Escribe el monto recibido en pesos, sin decimales.");
  const { error } = await active.supabase.rpc("record_payment", {
    p_milestone_id: milestoneId,
    p_paid_on: parsed.data.paidOn,
    p_amount_clp: amount.value,
    p_note: parsed.data.note,
  });
  if (error) {
    if (error.code === SQLSTATE_FORBIDDEN) return failure(NO_PERMISSION_MESSAGE);
    const reason = error.message ?? "";
    if (reason.startsWith("already_paid"))
      return failure("Este pago ya estaba marcado como recibido.");
    if (reason.startsWith("deposit_first"))
      return failure("Primero marca el anticipo como recibido.");
    if (error.code === SQLSTATE_INVALID) {
      return failure("Revisa la fecha (no puede ser futura) y el monto.");
    }
    await serverLog("error", "record_payment_failed", { code: error.code });
    return failure(MSG_UNEXPECTED);
  }
  revalidateQuote(active.tenantId, quoteId);
  return { status: "ok", message: "Pago registrado." };
}

export async function reversePaymentAction(
  tenantId: string,
  quoteId: string,
  milestoneId: string,
  reason: string,
): Promise<PaymentActionResult> {
  const active = await requireActiveTenant(tenantId);
  if (!isUuid(quoteId) || !isUuid(milestoneId)) return failure("No encontramos el pago.");
  const denied = requirePermission(active, "payment.confirm");
  if (denied) return failure(denied);
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < 3 || text.length > 200) {
    return failure("Escribe el motivo (entre 3 y 200 caracteres).");
  }
  const { error } = await active.supabase.rpc("reverse_payment", {
    p_milestone_id: milestoneId,
    p_reason: text,
  });
  if (error) {
    if (error.code === SQLSTATE_FORBIDDEN) return failure(NO_PERMISSION_MESSAGE);
    const code = error.message ?? "";
    if (code.startsWith("reverse_balance_first")) {
      return failure("Primero deshaz el saldo: ya se pidió o se registró.");
    }
    if (code.startsWith("not_paid")) return failure("Este pago no estaba marcado como recibido.");
    await serverLog("error", "reverse_payment_failed", { code: error.code });
    return failure(MSG_UNEXPECTED);
  }
  revalidateQuote(active.tenantId, quoteId);
  return { status: "ok", message: "Pago deshecho. Quedó registrado con su motivo." };
}

// ---------------------------------------------------------------------------------------------
// H-056 · Pedir el segundo pago (correo 3)
// ---------------------------------------------------------------------------------------------

const requestResultSchema = z.object({
  first_request: z.boolean(),
  milestone_id: z.uuid(),
  amount_clp: z.number().int().nonnegative(),
  context: paymentContextSchema,
});

export async function requestSecondPaymentAction(
  tenantId: string,
  quoteId: string,
  milestoneId: string,
): Promise<PaymentActionResult> {
  const active = await requireActiveTenant(tenantId);
  if (!isUuid(quoteId) || !isUuid(milestoneId)) return failure("No encontramos el pago.");
  const denied = requirePermission(active, "payment.second.request");
  if (denied) return failure(denied);
  const { data, error } = await active.supabase.rpc("request_second_payment", {
    p_milestone_id: milestoneId,
  });
  if (error) {
    if (error.code === SQLSTATE_FORBIDDEN) return failure(NO_PERMISSION_MESSAGE);
    const code = error.message ?? "";
    if (code.startsWith("deposit_not_paid")) {
      return failure("Primero tiene que estar registrado el anticipo.");
    }
    if (code.startsWith("already_paid")) return failure("El saldo ya está pagado.");
    await serverLog("error", "request_second_payment_failed", { code: error.code });
    return failure(MSG_UNEXPECTED);
  }
  revalidateQuote(active.tenantId, quoteId);
  const parsed = requestResultSchema.safeParse(data);
  if (!parsed.success) {
    await serverLog("error", "request_second_payment_failed", { code: "shape" });
    return failure(
      "Se registró la solicitud, pero no pudimos enviar el correo. Inténtalo de nuevo.",
    );
  }
  const outcome = await sendPaymentEmail(parsed.data.context, "payment_2", {
    kind: "balance",
    amountClp: parsed.data.amount_clp,
  });
  if (outcome.status === "skipped") {
    await serverLog("warn", "second_payment_email_skipped", { code: outcome.code });
    return failure(
      "Se registró la solicitud, pero no pudimos enviar el correo. Inténtalo de nuevo.",
    );
  }
  const { error: recordError } = await active.supabase.rpc("record_second_payment_email", {
    p_milestone_id: milestoneId,
    p_email_id: outcome.emailId,
    p_to_email_enc: outcome.toEmailEnc,
    p_to_email_hash: outcome.toEmailHash,
    p_provider: outcome.sent?.provider ?? null,
    p_provider_message_id: outcome.sent?.providerMessageId ?? null,
    p_error_code: outcome.sent ? null : (outcome.errorCode ?? "unknown"),
  });
  if (recordError) {
    await serverLog("warn", "second_payment_email_record_failed", { code: recordError.code });
  }
  revalidateQuote(active.tenantId, quoteId);
  if (!outcome.sent) {
    await serverLog("warn", "second_payment_email_failed", {
      code: outcome.errorCode ?? "unknown",
    });
    return failure(
      "Se registró la solicitud, pero el correo no salió. Inténtalo de nuevo en unos minutos.",
    );
  }
  const changedNote = parsed.data.context.bank?.changed
    ? " Se usaron los datos de transferencia con que el cliente aceptó (cambiaron después)."
    : "";
  return {
    status: "ok",
    message: `Le enviamos al cliente el correo con el saldo.${changedNote}`,
  };
}
