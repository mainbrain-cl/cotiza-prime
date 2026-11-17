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
 * Tiempo máximo (segundos) de las acciones de servidor de esta pantalla. Una de ellas puede enviar hasta 3 avisos de la
 * activación del segundo paso de 15 segundos cada uno (H-118): 45 s más un margen. Next exige un LITERAL aquí (no una
 * constante importada); una guardia estática (14i) vigila que valga al menos 60. El plazo del hosting debe respetarlo.
 */
export const maxDuration = 60;

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
            Si no tienes la aplicación ni tus códigos de respaldo, cierra sesión y pide ayuda al
            equipo de Cotiza Prime.
          </p>
          <p>
            ¿No activaste tú la verificación? Busca en tu correo el aviso «Se activó la verificación
            en dos pasos» y usa su botón para anularla.
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
