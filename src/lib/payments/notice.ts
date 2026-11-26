import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decryptPii, encryptPii } from "@/lib/crypto/pii";
import { searchHash } from "@/lib/crypto/search-hash";
import { loadEmailConfig } from "@/lib/email/config";
import { buildPaymentEmail, type PaymentEmailKind } from "@/lib/email/payment-email";
import { EmailConfigError, getEmailTransport } from "@/lib/email/transport";
import { normalizeEmail } from "@/lib/normalize/email";
import { formatQuoteNumber } from "@/lib/quotes/format";
import { sendWithRetry } from "@/lib/quotes/send/dispatch";
import { bankDetailLines, parseBankDetails, type BankDetails } from "./bank";
import { MILESTONE_LABELS, type MilestoneKind } from "./model";

/**
 * Lo común de los dos correos de cobro (H-053 al aceptar y H-056 al pedir el saldo): lee lo que entregó la base
 * (`app.payment_email_context`), abre en el servidor lo cifrado (correo del cliente, su nombre y los datos bancarios CONGELADOS),
 * arma el correo con la marca de la organización y lo envía. Nunca registra correos, nombres ni datos bancarios: solo códigos.
 */

const uuid = z.uuid();
const milestoneSchema = z.object({
  id: uuid,
  seq: z.number().int(),
  kind: z.enum(["full", "deposit", "balance"]),
  amount_clp: z.number().int().nonnegative(),
  status: z.enum(["pending", "requested", "paid"]),
});

export const paymentContextSchema = z.object({
  tenant_id: uuid,
  quote_id: uuid,
  number_display: z.string(),
  version: z.number().int(),
  payment_terms: z.enum(["full", "split_50_50"]).nullable(),
  total_clp: z.number().int(),
  milestones: z.array(milestoneSchema),
  bank: z
    .object({ bank_account_id: uuid, details_enc: z.string(), changed: z.boolean() })
    .nullable(),
  to_email_enc: z.string().nullable(),
  email_message_id: uuid.nullable(),
  package_id: uuid.nullable(),
  customer_snapshot_enc: z.string().nullable(),
  organization_name: z.string().nullable(),
  brand: z.object({ primary: z.string(), secondary: z.string() }).partial().nullable(),
});
export type PaymentContext = z.infer<typeof paymentContextSchema>;

const bankSeal = (tenantId: string, bankAccountId: string) => ({
  table: "bank_accounts",
  field: "details",
  tenantId,
  rowId: bankAccountId,
});

export function encryptBankDetails(
  details: BankDetails,
  tenantId: string,
  bankAccountId: string,
): string {
  return encryptPii(JSON.stringify(details), bankSeal(tenantId, bankAccountId));
}

/** Abre los datos bancarios (de la cuenta o de su copia congelada: es el mismo sello). `null` si no se pueden leer. */
export function decryptBankDetails(
  enc: string,
  tenantId: string,
  bankAccountId: string,
): BankDetails | null {
  try {
    return parseBankDetails(decryptPii(enc, bankSeal(tenantId, bankAccountId)));
  } catch {
    return null;
  }
}

export type PaymentEmailOutcome =
  | {
      status: "attempted";
      emailId: string;
      toEmailEnc: string;
      toEmailHash: string;
      sent: { provider: string; providerMessageId: string } | null;
      errorCode: string | null;
    }
  | { status: "skipped"; code: string };

const NOTICE_DEADLINE_MS = 20_000;

function customerNameOf(ctx: PaymentContext): string | null {
  if (!ctx.customer_snapshot_enc || !ctx.package_id) return null;
  try {
    const plain = decryptPii(ctx.customer_snapshot_enc, {
      table: "quote_packages",
      field: "customer_snapshot",
      tenantId: ctx.tenant_id,
      rowId: ctx.package_id,
    });
    const name = (JSON.parse(plain) as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

/** Envía el correo de cobro del hito indicado. Nunca lanza por el correo: devuelve qué pasó para anotarlo. */
export async function sendPaymentEmail(
  ctx: PaymentContext,
  kind: PaymentEmailKind,
  milestone: { kind: MilestoneKind; amountClp: number },
): Promise<PaymentEmailOutcome> {
  if (!ctx.to_email_enc || !ctx.email_message_id)
    return { status: "skipped", code: "no_recipient" };
  let toEmail: string;
  try {
    toEmail = normalizeEmail(
      decryptPii(ctx.to_email_enc, {
        table: "email_messages",
        field: "to_email",
        tenantId: ctx.tenant_id,
        rowId: ctx.email_message_id,
      }),
    );
  } catch {
    return { status: "skipped", code: "recipient_unreadable" };
  }
  const bank = ctx.bank
    ? decryptBankDetails(ctx.bank.details_enc, ctx.tenant_id, ctx.bank.bank_account_id)
    : null;
  if (ctx.bank && !bank) return { status: "skipped", code: "bank_unreadable" };

  let config: ReturnType<typeof loadEmailConfig>;
  try {
    config = loadEmailConfig();
  } catch (cause) {
    if (cause instanceof EmailConfigError) return { status: "skipped", code: "email_config" };
    throw cause;
  }
  const emailId = randomUUID();
  const built = buildPaymentEmail({
    kind,
    recipientAddress: toEmail,
    fromAddress: config.fromAddress,
    organizationName: ctx.organization_name ?? "",
    brandPrimary: ctx.brand?.primary ?? null,
    brandSecondary: ctx.brand?.secondary ?? null,
    customerName: customerNameOf(ctx),
    quoteNumber: formatQuoteNumber(ctx.number_display, ctx.version),
    amountClp: milestone.amountClp,
    milestoneLabel: MILESTONE_LABELS[milestone.kind],
    bankLines: bank ? bankDetailLines(bank) : null,
    idempotencyKey: emailId,
  });
  const toEmailEnc = encryptPii(toEmail, {
    table: "email_messages",
    field: "to_email",
    tenantId: ctx.tenant_id,
    rowId: emailId,
  });
  const toEmailHash = searchHash("email", ctx.tenant_id, toEmail);
  if (!built.ok) {
    return {
      status: "attempted",
      emailId,
      toEmailEnc,
      toEmailHash,
      sent: null,
      errorCode: built.code,
    };
  }
  const transport = getEmailTransport(config);
  const result = await sendWithRetry(transport, built.message, {
    deadlineMs: Date.now() + NOTICE_DEADLINE_MS,
  });
  return result.ok
    ? {
        status: "attempted",
        emailId,
        toEmailEnc,
        toEmailHash,
        sent: { provider: transport.provider, providerMessageId: result.providerMessageId },
        errorCode: null,
      }
    : { status: "attempted", emailId, toEmailEnc, toEmailHash, sent: null, errorCode: result.code };
}
