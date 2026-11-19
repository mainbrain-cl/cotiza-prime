import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-controls";
import { acceptLegalAction, signOutAction } from "@/lib/auth/actions";
import { PRIVACY_PATH, TERMS_PATH } from "@/lib/auth/paths";
import { requireUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Acepta la nueva versión · Cotiza Prime" };

export default async function AcceptTermsPage({ searchParams }: PageProps<"/aceptar-terminos">) {
  // Esta pantalla es justamente la que resuelve la puerta de términos: no puede exigirla.
  await requireUser({ skipLegalGate: true });
  const { error } = await searchParams;

  return (
    <AuthCard
      title="Acepta la nueva versión"
      description="Actualizamos los términos y la política de privacidad. Para seguir usando Cotiza Prime necesitamos que los revises y los aceptes."
    >
      {error ? <FormAlert>No pudimos registrar tu aceptación. Intenta de nuevo.</FormAlert> : null}
      <ul className="flex flex-col gap-2 text-fg-muted">
        <li>
          <Link
            href={TERMS_PATH}
            target="_blank"
            className="inline-flex min-h-11 items-center font-semibold text-accent underline-offset-4 hover:underline"
          >
            Términos y condiciones
          </Link>
        </li>
        <li>
          <Link
            href={PRIVACY_PATH}
            target="_blank"
            className="inline-flex min-h-11 items-center font-semibold text-accent underline-offset-4 hover:underline"
          >
            Política de privacidad
          </Link>
        </li>
      </ul>
      <form action={acceptLegalAction} className="flex flex-col gap-3">
        <Button type="submit" size="lg">
          Acepto la nueva versión
        </Button>
      </form>
      <form action={signOutAction}>
        <Button type="submit" variant="ghost" className="w-full">
          Cerrar sesión
        </Button>
      </form>
    </AuthCard>
  );
}
