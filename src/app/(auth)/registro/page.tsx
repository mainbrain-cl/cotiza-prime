import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { HOME_PATH, LOGIN_PATH } from "@/lib/auth/paths";
import { getOptionalUser } from "@/lib/auth/session";
import { hasPendingInvitation } from "@/lib/team/invitation-cookie";
import { SignUpForm } from "./signup-form";

export const metadata: Metadata = { title: "Crear cuenta · Cotiza Prime" };

export default async function SignUpPage() {
  if (await getOptionalUser()) redirect(HOME_PATH);
  const invited = await hasPendingInvitation();

  return (
    <AuthCard
      title="Crea tu cuenta"
      description="Cotiza en minutos, con tu marca, sin perder el control."
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
      {invited ? (
        // Sin nombrar la organización: aquí todavía no se sabe de quién es la invitación (ver `/invitacion`).
        <p
          data-testid="signup-invitation-hint"
          className="mb-5 rounded-sm bg-accent-soft px-3 py-2.5 text-sm font-medium text-fg"
        >
          Crea tu cuenta con el correo al que llegó la invitación: solo con ese podrás unirte.
        </p>
      ) : null}
      <SignUpForm />
    </AuthCard>
  );
}
