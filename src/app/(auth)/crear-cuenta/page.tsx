import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { TimerOff } from "lucide-react";
import { AuthCard } from "@/components/auth/auth-card";
import { FlowSteps } from "@/components/auth/flow-steps";
import { Button, buttonVariants } from "@/components/ui/button";
import { SETUP_EXPIRED_MESSAGE, VERIFIED_NOT_FINISHED_HELP } from "@/lib/auth/account-setup";
import { signOutAction } from "@/lib/auth/actions";
import {
  FORGOT_PASSWORD_PATH,
  NEW_TENANT_PATH,
  SECOND_STEP_PATH,
  SIGNUP_PATH,
} from "@/lib/auth/paths";
import { getSessionState, hasEmailLinkSession, isAccountReady } from "@/lib/auth/session";
import { legalDocuments } from "@/lib/legal/documents";
import { INVITATION_ACCEPT_PATH } from "@/lib/team/accept-model";
import { hasPendingInvitation } from "@/lib/team/invitation-cookie";
import { CreateAccountForm } from "./create-account-form";

export const metadata: Metadata = {
  title: "Termina de crear tu cuenta · Cotiza Prime",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/**
 * Tiempo máximo (segundos) de las acciones de servidor de esta pantalla: terminar la cuenta hace varias llamadas a Supabase
 * (validar, fijar la contraseña, cerrar las otras sesiones, terminar) y puede repetir dos. Next exige un LITERAL aquí.
 */
export const maxDuration = 60;

/** El enlace ya no sirve (o no hay sesión): se ofrece pedir otro. Sin sesión no hay nada que cerrar. */
function ExpiredView({ signedIn }: { signedIn: boolean }) {
  return (
    <AuthCard title="Tu enlace venció" description={SETUP_EXPIRED_MESSAGE}>
      <div className="flex flex-col gap-4" data-testid="create-account-expired">
        <div className="flex size-12 items-center justify-center rounded-md bg-warning-soft text-warning">
          <TimerOff aria-hidden strokeWidth={1.75} className="size-6" />
        </div>
        {signedIn ? (
          // Con una sesión que no sirve para terminar la cuenta, `/registro` mandaría de vuelta aquí: primero hay que salir.
          <form action={signOutAction}>
            <Button type="submit" size="lg" className="w-full">
              Cerrar sesión y pedir un enlace nuevo
            </Button>
          </form>
        ) : (
          <Link href={SIGNUP_PATH} className={buttonVariants({ size: "lg" })}>
            Pedir un enlace nuevo
          </Link>
        )}
        <p className="border-t border-border pt-4 text-sm text-fg-muted">
          {VERIFIED_NOT_FINISHED_HELP}
        </p>
        <Link
          href={FORGOT_PASSWORD_PATH}
          className="inline-flex min-h-11 w-fit items-center text-sm font-semibold text-accent underline-offset-4 hover:underline"
        >
          ¿Olvidaste tu contraseña?
        </Link>
      </div>
    </AuthCard>
  );
}

/**
 * Terminar de crear la cuenta (H-116): nombre, contraseña y términos, con el correo a la vista. Solo sirve con la sesión que
 * abrió el enlace del correo: sin sesión, o con una sesión de contraseña, se pide un enlace nuevo. Una cuenta ya terminada
 * sigue de largo. Es la única pantalla que acepta una cuenta sin terminar (`requireUser` manda aquí a todas las demás).
 */
export default async function CreateAccountPage() {
  const session = await getSessionState();
  if (session.status === "signed_out") return <ExpiredView signedIn={false} />;
  if (session.status === "second_step_pending") redirect(SECOND_STEP_PATH);

  if (await isAccountReady()) {
    redirect((await hasPendingInvitation()) ? INVITATION_ACCEPT_PATH : NEW_TENANT_PATH);
  }
  if (!(await hasEmailLinkSession())) return <ExpiredView signedIn />;

  return (
    <AuthCard
      title="Termina de crear tu cuenta"
      description="Elige tu nombre y tu contraseña. Es el último paso."
    >
      <FlowSteps current={2} label="Tu cuenta" />
      <CreateAccountForm
        email={session.user.email}
        termsVersion={legalDocuments.terms.version}
        privacyVersion={legalDocuments.privacy.version}
      />
    </AuthCard>
  );
}
