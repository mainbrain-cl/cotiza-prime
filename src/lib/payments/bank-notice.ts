import "server-only";
import { buildBankChangeNotice } from "@/lib/email/bank-change-notice";
import { loadEmailConfig } from "@/lib/email/config";
import { getEmailTransport } from "@/lib/email/transport";
import { formatDateTime } from "@/lib/format-date";
import { getAppOrigin } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { can } from "@/lib/permissions/matrix";
import { sendWithRetry } from "@/lib/quotes/send/dispatch";
import { loadMembers } from "@/lib/team/members-queries";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";

const NOTICE_DEADLINE_MS = 20_000;
const MAX_RECIPIENTS = 10;

/**
 * H-051: avisa por correo a quienes manejan la cuenta bancaria (Dueño y Administradores, según la matriz) que alguien la registró o
 * la cambió. De mejor esfuerzo: corre después de responder y un fallo solo deja un código en el log. La lista de miembros la entrega
 * la base a quien maneja el equipo (quien cambia la cuenta siempre puede).
 */
export async function notifyBankAccountChange(
  active: ActiveTenant,
  change: { last4Before: string | null; last4After: string },
): Promise<void> {
  try {
    const list = await loadMembers(active);
    if (!list.ok) return;
    const recipients = list.members
      .filter((member) => can(member.role, "bank_account.manage") && member.email)
      .slice(0, MAX_RECIPIENTS);
    if (recipients.length === 0) return;
    const config = loadEmailConfig();
    const transport = getEmailTransport(config);
    const whenText = formatDateTime(new Date());
    for (const member of recipients) {
      const built = buildBankChangeNotice({
        recipientAddress: member.email!,
        fromAddress: config.fromAddress,
        organizationName: active.tenantName,
        actorEmail: active.user.email,
        whenText,
        last4Before: change.last4Before,
        last4After: change.last4After,
        settingsUrl: `${getAppOrigin()}${tenantPath(active.tenantId, "configuracion/pagos")}`,
      });
      if (!built.ok) continue;
      const result = await sendWithRetry(transport, built.message, {
        deadlineMs: Date.now() + NOTICE_DEADLINE_MS,
      });
      if (!result.ok) await serverLog("warn", "bank_change_notice_failed", { code: result.code });
    }
  } catch {
    await serverLog("error", "bank_change_notice_failed", { code: "unexpected" });
  }
}
