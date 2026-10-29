import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { FormAlert } from "@/components/ui/form-controls";
import { minimumFor, loadNumberingState } from "@/lib/numbering/service";
import { pagePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { NumberingForm } from "./numbering-form";

export const metadata: Metadata = { title: "Numeración · Cotiza Prime" };

export default async function NumberingPage({
  params,
}: PageProps<"/o/[tenantId]/configuracion/numeracion">) {
  const active = await requireActiveTenant((await params).tenantId);
  // Solo quien maneja la organización (supuesto 12): los demás roles no ven «Configuración».
  const denied = pagePermission(active, "settings.manage");
  if (denied) return denied;
  const state = await loadNumberingState(active);

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
        <h1 className="text-xl md:text-2xl">Numeración de cotizaciones</h1>
        <p className="text-fg-muted">
          Elige cómo se ven los números de tus cotizaciones. El número nunca retrocede, así no se
          repite uno que ya enviaste a un cliente.
        </p>
      </div>

      {state ? (
        <NumberingForm
          tenantId={active.tenantId}
          initial={{
            prefix: state.settings.prefix,
            mode: state.settings.mode,
            startNumber: minimumFor(state, state.settings.mode),
          }}
        />
      ) : (
        <FormAlert>
          No pudimos cargar la numeración. Recarga la página; si sigue igual, intenta en unos
          minutos.
        </FormAlert>
      )}
    </div>
  );
}
