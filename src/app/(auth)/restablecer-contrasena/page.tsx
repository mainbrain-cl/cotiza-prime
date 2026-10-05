import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { LOGIN_NOTICES, LOGIN_PATH } from "@/lib/auth/paths";
import { getOptionalUser } from "@/lib/auth/session";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "Elige tu contraseña nueva · Cotiza Prime" };

export default async function ResetPasswordPage() {
  // Se llega con la sesión que abre el enlace del correo. Sin ella, no hay nada que restablecer.
  if (!(await getOptionalUser())) redirect(`${LOGIN_PATH}?aviso=${LOGIN_NOTICES.resetLinkExpired}`);

  return (
    <AuthCard
      title="Elige tu contraseña nueva"
      description="Al cambiarla, cerraremos tu sesión en los demás dispositivos."
    >
      <ResetPasswordForm />
    </AuthCard>
  );
}
