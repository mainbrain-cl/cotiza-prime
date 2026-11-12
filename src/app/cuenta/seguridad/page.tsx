import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/auth-card";
import { ACCOUNT_SECURITY_NOTICES, HOME_PATH } from "@/lib/auth/paths";
import { getSessionState, requireUser } from "@/lib/auth/session";
import { formatDate } from "@/lib/format-date";
import { TwoStepPanel } from "./two-step-panel";

export const metadata: Metadata = {
  title: "Seguridad de tu cuenta · Cotiza Prime",
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
 * Seguridad de la cuenta (H-004a): activar la verificación en dos pasos. Es de la persona, no de una organización:
 * cualquiera de los cinco roles la ve y la activa en su propia cuenta; no consulta rol ni organización activa.
 */
export default async function AccountSecurityPage({
  searchParams,
}: PageProps<"/cuenta/seguridad">) {
  const user = await requireUser();
  const state = await getSessionState();
  const { aviso } = await searchParams;
  const secondStep =
    state.status === "complete" ? state.secondStep : { active: false, since: null };

  return (
    <AuthCard
      title="Seguridad de tu cuenta"
      footer={
        <Link
          href={HOME_PATH}
          className="inline-flex min-h-11 items-center font-semibold text-accent underline-offset-4 hover:underline"
        >
          Volver a Cotiza Prime
        </Link>
      }
    >
      <TwoStepPanel
        active={secondStep.active}
        sinceLabel={secondStep.since ? formatDate(secondStep.since) : null}
        justEnabled={aviso === ACCOUNT_SECURITY_NOTICES.enabled}
        noticeEmail={user.email || null}
      />
    </AuthCard>
  );
}
