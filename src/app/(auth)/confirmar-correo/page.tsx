import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { FlowSteps } from "@/components/auth/flow-steps";
import { CONFIRM_EXPIRED_TITLE } from "@/lib/auth/account-setup";
import { ConfirmEmailForm } from "./confirm-email-form";
import { ExpiredLink } from "./expired-link";

export const metadata: Metadata = {
  title: "Confirma tu correo · Cotiza Prime",
  // La dirección lleva el código del enlace: nada en buscadores y nada se manda a otros sitios.
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/** El código del enlace (`token_hash`): el hexadecimal o base64 de GoTrue, sin nada más. */
const TOKEN_HASH_PATTERN = /^[A-Za-z0-9._-]{8,256}$/;
/** El único tipo de enlace que envía el registro. */
const LINK_TYPE = "invite";

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Llegada desde el correo del registro (H-116). Abrir esta página NO gasta el código del enlace: los antivirus y las vistas
 * previas de los correos abren los enlaces antes que la persona. Solo el clic en «Continuar» (un POST) lo canjea por una
 * sesión (`confirmEmailLinkAction`). Si falta algo en la dirección, se muestra «Este enlace ya se usó o venció», igual que
 * cuando el código ya no sirve: no se dice cuál fue el motivo.
 */
export default async function ConfirmEmailPage({ searchParams }: PageProps<"/confirmar-correo">) {
  const params = await searchParams;
  const tokenHash = single(params.token_hash);

  if (
    tokenHash === undefined ||
    !TOKEN_HASH_PATTERN.test(tokenHash) ||
    single(params.type) !== LINK_TYPE
  ) {
    return (
      <AuthCard title={CONFIRM_EXPIRED_TITLE}>
        <ExpiredLink />
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Confirma tu correo"
      description="Un clic más y seguimos con tu nombre y tu contraseña."
    >
      <FlowSteps current={1} label="Confirmar correo" />
      <ConfirmEmailForm tokenHash={tokenHash} />
    </AuthCard>
  );
}
