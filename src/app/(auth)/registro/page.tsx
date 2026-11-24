import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { FlowSteps } from "@/components/auth/flow-steps";
import { loadAntibotConfig } from "@/lib/antibot";
import { HOME_PATH, LOGIN_PATH } from "@/lib/auth/paths";
import { getOptionalUser } from "@/lib/auth/session";
import { hasPendingInvitation } from "@/lib/team/invitation-cookie";
import { SignUpForm } from "./signup-form";

export const metadata: Metadata = { title: "Crear cuenta · Cotiza Prime" };

export default async function SignUpPage() {
  if (await getOptionalUser()) redirect(HOME_PATH);
  const invited = await hasPendingInvitation();
  const antibot = loadAntibotConfig();

  return (
    <AuthCard
      title="Crea tu cuenta"
      description="Primero confirmamos tu correo. Después eliges tu nombre y tu contraseña."
      footer={
        <>
          ¿Ya tienes cuenta?{" "}
          <Link
            href={LOGIN_PATH}
            className="font-semibold text-accent underline-offset-4 hover:underline"
          >
            Ingresa
          </Link>
        </>
      }
    >
      <FlowSteps current={1} label="Tu correo" />
      {invited ? (
        // Sin nombrar la organización: aquí todavía no se sabe de quién es la invitación (ver `/invitacion`).
        <p
          data-testid="signup-invitation-hint"
          className="mb-5 rounded-sm bg-accent-soft px-3 py-2.5 text-sm font-medium text-fg"
        >
          Crea tu cuenta con el correo al que llegó la invitación: solo con ese podrás unirte.
        </p>
      ) : null}
      <SignUpForm
        antibot={{
          provider: antibot.provider,
          siteKey: antibot.provider === "turnstile" ? antibot.turnstileSiteKey : null,
        }}
      />
    </AuthCard>
  );
}
