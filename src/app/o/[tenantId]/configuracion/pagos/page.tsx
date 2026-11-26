import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { FormAlert } from "@/components/ui/form-controls";
import { ACCOUNT_SECURITY_PATH } from "@/lib/auth/paths";
import { getSessionState } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format-date";
import { pagePermission } from "@/lib/permissions/require";
import { loadBankAccount } from "@/lib/payments/queries";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { BankAccountForm } from "./bank-account-form";

export const metadata: Metadata = { title: "Datos de transferencia · Cotiza Prime" };

/**
 * H-050: la cuenta donde la organización recibe las transferencias. Solo el Dueño y el Administrador la ven y la cambian
 * (`bank_account.manage`, en la pantalla, en la acción y en la base). Los datos viajan cifrados y se abren solo en el servidor.
 */
export default async function BankAccountPage({
  params,
}: PageProps<"/o/[tenantId]/configuracion/pagos">) {
  const active = await requireActiveTenant((await params).tenantId);
  const denied = pagePermission(active, "bank_account.manage");
  if (denied) return denied;
  // La base solo deja cambiar la cuenta con el segundo paso hecho (pase aal2). Una sesión completa con la verificación activa lo es.
  const session = await getSessionState();
  const secondStepDone = session.status === "complete" && session.secondStep.active;
  const lookup = await loadBankAccount(active);

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
        <h1 className="text-xl md:text-2xl">Datos de transferencia</h1>
        <p className="text-fg-muted">
          La cuenta donde tus clientes te pagan. Se la enviamos recién cuando aceptan una
          cotización; antes no la ve nadie fuera de tu organización.
        </p>
      </div>

      {!secondStepDone ? (
        <div data-testid="bank-second-step-required">
          <FormAlert tone="warning">
            Para ver y cambiar los datos de transferencia necesitas la verificación en dos pasos
            activa: así nadie con solo tu contraseña puede desviar los pagos de tus clientes.{" "}
            <Link
              href={ACCOUNT_SECURITY_PATH}
              className="inline-flex min-h-11 items-center underline underline-offset-2"
            >
              Activar la verificación en dos pasos
            </Link>
          </FormAlert>
        </div>
      ) : lookup.status === "error" ? (
        <FormAlert>
          No pudimos cargar los datos de transferencia. Recarga la página en unos minutos.
        </FormAlert>
      ) : lookup.account && !lookup.account.details ? (
        <FormAlert>
          No pudimos leer los datos guardados. Avisa al equipo de Cotiza Prime antes de cambiarlos.
        </FormAlert>
      ) : (
        <>
          <BankAccountForm
            tenantId={active.tenantId}
            bankAccountId={lookup.account?.id ?? null}
            revision={lookup.account?.revision ?? 0}
            initial={lookup.account?.details ?? null}
          />
          <p className="text-sm text-fg-subtle" data-testid="bank-last-change">
            {lookup.account
              ? `Último cambio: ${formatDateTime(lookup.account.updatedAt)}. Cada cambio queda en el registro de actividad.`
              : "Todavía no hay datos de transferencia. Sin ellos, tus cotizaciones se envían sin condición de pago."}
          </p>
        </>
      )}
    </div>
  );
}
