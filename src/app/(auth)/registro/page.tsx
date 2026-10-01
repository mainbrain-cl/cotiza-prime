import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { HOME_PATH, LOGIN_PATH } from "@/lib/auth/paths";
import { getOptionalUser } from "@/lib/auth/session";
import { SignUpForm } from "./signup-form";

export const metadata: Metadata = { title: "Crear cuenta · Cotiza Prime" };

export default async function SignUpPage() {
  if (await getOptionalUser()) redirect(HOME_PATH);

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
      <SignUpForm />
    </AuthCard>
  );
}
