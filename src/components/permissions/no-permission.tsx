import { Lock } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { NO_PERMISSION_MESSAGE } from "@/lib/permissions/matrix";
import { tenantPath } from "@/lib/tenant/constants";

/**
 * La pantalla para quien es miembro de la organización pero su rol no alcanza (H-011). Es un
 * componente propio y no la función `forbidden()` de Next 16, que es experimental (supuesto 20).
 * No revela nada de lo que hay detrás de la dirección. «No encontrado» queda solo para quien no es
 * miembro de la organización.
 */
export function NoPermission({ tenantId }: { tenantId: string }) {
  return (
    <div className="flex flex-col gap-6" data-testid="no-permission">
      <h1 className="text-xl md:text-2xl">Sin permiso</h1>
      <EmptyState
        icon={Lock}
        title={NO_PERMISSION_MESSAGE}
        description="Tu rol en esta organización no incluye esta pantalla. Si la necesitas, pídele al Dueño o a un Administrador que revise tu rol."
      >
        <Link href={tenantPath(tenantId)} className={buttonVariants({ variant: "secondary" })}>
          Volver al inicio
        </Link>
      </EmptyState>
    </div>
  );
}
