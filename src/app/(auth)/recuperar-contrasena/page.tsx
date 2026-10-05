import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { HOME_PATH, LOGIN_PATH } from "@/lib/auth/paths";
import { getOptionalUser } from "@/lib/auth/session";
import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Recuperar contraseña · Cotiza Prime" };

export default async function ForgotPasswordPage() {
  if (await getOptionalUser()) redirect(HOME_PATH);

  return (
    <AuthCard
      title="Recupera tu contraseña"
      description="Escribe tu correo y te enviaremos un enlace para elegir una contraseña nueva."
      footer={
        <Link
          href={LOGIN_PATH}
          className="font-semibold text-accent underline-offset-4 hover:underline"
        >
          Volver a ingresar
        </Link>
      }
    >
      <ForgotPasswordForm />
    </AuthCard>
  );
}
