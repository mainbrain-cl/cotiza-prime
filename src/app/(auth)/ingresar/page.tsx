import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { FormAlert } from "@/components/ui/form-controls";
import { HOME_PATH, LOGIN_NOTICES, SECOND_STEP_PATH, SIGNUP_PATH } from "@/lib/auth/paths";
import { getSessionState } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Ingresar · Cotiza Prime" };

/**
 * Tiempo máximo (segundos) de las acciones de servidor de esta pantalla. Una de ellas puede enviar hasta 3 avisos de la
 * activación del segundo paso de 15 segundos cada uno (H-118): 45 s más un margen. Next exige un LITERAL aquí (no una
 * constante importada); una guardia estática (14i) vigila que valga al menos 60. El plazo del hosting debe respetarlo.
 */
export const maxDuration = 60;

const NOTICES: Record<string, { tone: "success" | "warning"; text: string }> = {
  [LOGIN_NOTICES.linkNotUsable]: {
    tone: "warning",
    text: "Si ya verificaste tu correo, ingresa con tu contraseña. Si no, pide un enlace nuevo.",
  },
  [LOGIN_NOTICES.linkExpired]: {
    tone: "warning",
    text: "El enlace no sirve: caducó o ya se usó. Si tu correo ya está verificado, ingresa; si no, crea tu cuenta de nuevo.",
  },
  [LOGIN_NOTICES.resetLinkExpired]: {
    tone: "warning",
    text: "El enlace para cambiar tu contraseña caducó, ya se usó o se abrió en otro navegador. Pide uno nuevo desde “¿Olvidaste tu contraseña?”.",
  },
  [LOGIN_NOTICES.signedOut]: { tone: "success", text: "Cerraste sesión." },
  [LOGIN_NOTICES.signOutIncomplete]: {
    tone: "warning",
    text: "Cerramos la sesión en este navegador, pero no pudimos confirmarlo en nuestros servidores. Si usas un equipo compartido, vuelve a ingresar y cierra sesión de nuevo.",
  },
};

export default async function LoginPage({ searchParams }: PageProps<"/ingresar">) {
  // Con la contraseña ya correcta pero sin el código, se sigue en la pantalla del código; con sesión completa, al inicio.
  const session = await getSessionState();
  if (session.status === "second_step_pending") redirect(SECOND_STEP_PATH);
  if (session.status === "complete") redirect(HOME_PATH);

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
      <p
        className="border-t border-border pt-4 text-sm text-fg-muted"
        data-testid="login-unfinished-help"
      >
        ¿Empezaste a crear tu cuenta y no la terminaste? Pide otro enlace en{" "}
        <Link
          href={SIGNUP_PATH}
          className="font-semibold text-accent underline-offset-4 hover:underline"
        >
          «Crear cuenta»
        </Link>
        . Si ya habías confirmado tu correo, usa «¿Olvidaste tu contraseña?».
      </p>
    </AuthCard>
  );
}
