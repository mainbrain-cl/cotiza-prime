import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { FormAlert } from "@/components/ui/form-controls";
import { HOME_PATH, LOGIN_NOTICES, SIGNUP_PATH } from "@/lib/auth/paths";
import { getOptionalUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Ingresar · Cotiza Prime" };

const NOTICES: Record<string, { tone: "success" | "warning"; text: string }> = {
  [LOGIN_NOTICES.linkNotUsable]: {
    tone: "warning",
    text: "Si ya verificaste tu correo, ingresa con tu contraseña. Si no, pide un enlace nuevo.",
  },
  [LOGIN_NOTICES.linkExpired]: {
    tone: "warning",
    text: "El enlace no sirve: caducó o ya se usó. Si tu correo ya está verificado, ingresa; si no, crea tu cuenta de nuevo.",
  },
  [LOGIN_NOTICES.signedOut]: { tone: "success", text: "Cerraste sesión." },
  [LOGIN_NOTICES.signOutIncomplete]: {
    tone: "warning",
    text: "Cerramos la sesión en este navegador, pero no pudimos confirmarlo en nuestros servidores. Si usas un equipo compartido, vuelve a ingresar y cierra sesión de nuevo.",
  },
};

export default async function LoginPage({ searchParams }: PageProps<"/ingresar">) {
  if (await getOptionalUser()) redirect(HOME_PATH);

  const { aviso } = await searchParams;
  const notice = typeof aviso === "string" ? NOTICES[aviso] : undefined;

  return (
    <AuthCard
      title="Ingresa a tu cuenta"
      footer={
        <>
          ¿Eres nuevo?{" "}
          <Link
            href={SIGNUP_PATH}
            className="font-semibold text-accent underline-offset-4 hover:underline"
          >
            Crea tu cuenta
          </Link>
        </>
      }
    >
      {notice ? <FormAlert tone={notice.tone}>{notice.text}</FormAlert> : null}
      <LoginForm />
    </AuthCard>
  );
}
