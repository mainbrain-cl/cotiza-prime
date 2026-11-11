import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { signOutAction } from "@/lib/auth/actions";
import { requirePendingSecondStep } from "@/lib/auth/session";
import { SecondStepForm } from "./second-step-form";

export const metadata: Metadata = {
  title: "Ingresa tu código · Cotiza Prime",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * Tras la contraseña, para cuentas con la verificación en dos pasos activa (H-004a). Es la ÚNICA pantalla que acepta una
 * sesión parcial: no redirige a ninguna otra (sin bucles). Sin sesión va a ingresar; con sesión completa, al inicio.
 */
export default async function SecondStepPage() {
  const user = await requirePendingSecondStep();

  return (
    <AuthCard
      title="Ingresa tu código"
      description="Abre tu aplicación de códigos y escribe el código de 6 números de Cotiza Prime."
      footer={
        <div className="flex flex-col items-center gap-2">
          <p>
            Si ya no tienes la aplicación, cierra sesión y pide ayuda al equipo de Cotiza Prime.
          </p>
          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="sm">
              Cerrar sesión
            </Button>
          </form>
        </div>
      }
    >
      <p className="text-sm text-fg-muted">
        Ingresaste como <strong className="font-semibold break-all text-fg">{user.email}</strong>.
      </p>
      <SecondStepForm />
    </AuthCard>
  );
}
