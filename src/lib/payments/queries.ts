import "server-only";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import type { BankDetails } from "./bank";
import type { MilestoneKind, MilestoneStatus } from "./model";
import { decryptBankDetails } from "./notice";

/**
 * Lecturas del cobro con el pase de la persona (nunca la llave maestra): la RLS decide qué ve cada rol. La cuenta bancaria solo la
 * leen el Dueño y el Administrador; los hitos, todo miembro (todos ven todo dentro de su organización).
 */

export type BankAccountView = {
  id: string;
  revision: number;
  last4: string;
  updatedAt: string;
  /** `null` si no se pudo descifrar (se avisa en la pantalla, nunca se muestra a medias). */
  details: BankDetails | null;
};

export type BankAccountLookup =
  { status: "ok"; account: BankAccountView | null } | { status: "error" };

export async function loadBankAccount(active: ActiveTenant): Promise<BankAccountLookup> {
  const { data, error } = await active.supabase
    .from("bank_accounts")
    .select("id, details_enc, account_last4, revision, updated_at")
    .eq("tenant_id", active.tenantId)
    .maybeSingle();
  if (error) {
    await serverLog("error", "bank_account_read_failed", { code: error.code });
    return { status: "error" };
  }
  if (!data) return { status: "ok", account: null };
  const row = data as {
    id: string;
    details_enc: string;
    account_last4: string;
    revision: number;
    updated_at: string;
  };
  const details = decryptBankDetails(row.details_enc, active.tenantId, row.id);
  if (!details) await serverLog("error", "bank_account_unreadable");
  return {
    status: "ok",
    account: {
      id: row.id,
      revision: row.revision,
      last4: row.account_last4,
      updatedAt: row.updated_at,
      details,
    },
  };
}

/** ¿La organización tiene datos de transferencia? Cualquier miembro puede saberlo (sin ver los datos). `null` si falló. */
export async function tenantHasBankAccount(active: ActiveTenant): Promise<boolean | null> {
  const { data, error } = await active.supabase.rpc("tenant_has_bank_account");
  if (error) {
    await serverLog("error", "bank_account_exists_failed", { code: error.code });
    return null;
  }
  return data === true;
}

export type MilestoneView = {
  id: string;
  seq: number;
  kind: MilestoneKind;
  amountClp: number;
  status: MilestoneStatus;
  requestedAt: string | null;
  paidOn: string | null;
  paidAmountClp: number | null;
  paidNote: string | null;
};

type MilestoneRow = {
  id: string;
  seq: number;
  kind: MilestoneKind;
  amount_clp: number | string;
  status: MilestoneStatus;
  requested_at: string | null;
  paid_on: string | null;
  paid_amount_clp: number | string | null;
  paid_note: string | null;
};

export async function loadQuoteMilestones(
  active: ActiveTenant,
  quoteId: string,
): Promise<MilestoneView[]> {
  const { data, error } = await active.supabase
    .from("payment_milestones")
    .select("id, seq, kind, amount_clp, status, requested_at, paid_on, paid_amount_clp, paid_note")
    .eq("tenant_id", active.tenantId)
    .eq("quote_id", quoteId)
    .order("seq");
  if (error) {
    await serverLog("error", "payment_milestones_read_failed", { code: error.code });
    return [];
  }
  return ((data ?? []) as MilestoneRow[]).map((row) => ({
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    amountClp: Number(row.amount_clp),
    status: row.status,
    requestedAt: row.requested_at,
    paidOn: row.paid_on,
    paidAmountClp: row.paid_amount_clp === null ? null : Number(row.paid_amount_clp),
    paidNote: row.paid_note,
  }));
}

/** H-057: lo que falta por cobrar en toda la organización y en cuántas cotizaciones. `null` si falló la lectura. */
export async function loadOutstanding(
  active: ActiveTenant,
): Promise<{ totalClp: number; quotes: number } | null> {
  const { data, error } = await active.supabase
    .from("payment_milestones")
    .select("quote_id, amount_clp")
    .eq("tenant_id", active.tenantId)
    .neq("status", "paid");
  if (error) {
    await serverLog("error", "payment_outstanding_read_failed", { code: error.code });
    return null;
  }
  const rows = (data ?? []) as { quote_id: string; amount_clp: number | string }[];
  return {
    totalClp: rows.reduce((sum, row) => sum + Number(row.amount_clp), 0),
    quotes: new Set(rows.map((row) => row.quote_id)).size,
  };
}
