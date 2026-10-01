import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { signOutAction } from "@/lib/auth/actions";
import { requireUser } from "@/lib/auth/session";
import { listMemberships } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { TenantForm } from "./tenant-form";

export const metadata: Metadata = { title: "Crear organización · Cotiza Prime" };

export default async function NewTenantPage() {
  const user = await requireUser();
  const memberships = await listMemberships(user.id);
  const isFirst = memberships.length === 0;

  return (
    <AuthCard
      title={isFirst ? "Crea tu primera organización" : "Crea otra organización"}
      description={
        isFirst
          ? "Es el espacio de tu empresa: con su marca, sus precios y sus reglas. Quedas como Dueño."
          : "Cada organización es independiente: nada se comparte con las demás. Quedas como Dueño."
      }
      footer={
        isFirst ? (
          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="sm">
              Cerrar sesión
            </Button>
          </form>
        ) : (
          <Link
            href={tenantPath(memberships[0].tenantId)}
            className="font-semibold text-accent underline-offset-4 hover:underline"
          >
            Volver a mis organizaciones
          </Link>
        )
      }
    >
      <TenantForm />
    </AuthCard>
  );
}
