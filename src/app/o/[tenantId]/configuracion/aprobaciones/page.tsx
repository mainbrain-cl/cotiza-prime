import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { FormAlert } from "@/components/ui/form-controls";
import { formatDateTime } from "@/lib/format-date";
import {
  countActiveApprovers,
  loadCurrentApprovalRule,
  loadRuleAuthorName,
} from "@/lib/approvals/queries";
import { ruleToFormValues } from "@/lib/approvals/schemas";
import { canEver } from "@/lib/permissions/matrix";
import { pagePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { ApprovalRuleForm } from "./approval-rule-form";

export const metadata: Metadata = { title: "Aprobaciones · Cotiza Prime" };

export default async function ApprovalRulePage({
  params,
}: PageProps<"/o/[tenantId]/configuracion/aprobaciones">) {
  const active = await requireActiveTenant((await params).tenantId);
  // Solo quien maneja la organización: los demás roles no ven «Configuración» (D9: se reutiliza `settings.manage`).
  const denied = pagePermission(active, "settings.manage");
  if (denied) return denied;

  const lookup = await loadCurrentApprovalRule(active);
  const [authorName, approvers] =
    lookup.status === "ok"
      ? await Promise.all([
          loadRuleAuthorName(active, lookup.current.createdBy),
          countActiveApprovers(active),
        ])
      : [null, null];

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href={tenantPath(active.tenantId, "configuracion")}
          className="inline-flex min-h-11 w-fit items-center gap-1 rounded-sm text-sm font-medium text-fg-muted outline-none hover:text-fg focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Configuración
        </Link>
        <h1 className="text-xl md:text-2xl">Aprobaciones</h1>
        <p className="text-fg-muted">
          Elige cuándo una cotización necesita visto bueno antes de salir hacia tu cliente.
        </p>
      </div>

      {lookup.status === "ok" ? (
        <>
          <ApprovalRuleForm
            tenantId={active.tenantId}
            version={lookup.current.version}
            initial={ruleToFormValues(lookup.current.rule)}
            // «Nadie más puede aprobar»: solo si quien configura puede aprobar y no hay otra persona que pueda.
            onlyApproverIsYou={
              canEver(active.role, "quote.approve") && approvers !== null && approvers < 2
            }
          />
          <p className="text-sm text-fg-subtle" data-testid="approval-last-change">
            {lookup.current.createdBy === null
              ? "Todavía nadie ha cambiado esta regla."
              : `Último cambio: ${formatDateTime(lookup.current.createdAt)}${
                  authorName ? ` por ${authorName}` : ""
                }.`}
          </p>
        </>
      ) : (
        <FormAlert>
          No pudimos cargar la regla de aprobación. Recarga la página; si sigue igual, intenta en
          unos minutos.
        </FormAlert>
      )}
    </div>
  );
}
