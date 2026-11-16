import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/auth-card";
import { ACCOUNT_SECURITY_NOTICES, HOME_PATH } from "@/lib/auth/paths";
import { getSessionState, requireUser } from "@/lib/auth/session";
import { formatDate } from "@/lib/format-date";
import { serverLog } from "@/lib/log/server-log";
import { getRecoveryCodesStatus } from "@/lib/security/mfa-recovery-gateway";
import { TwoStepPanel, type RecoveryInfo } from "./two-step-panel";

export const metadata: Metadata = {
  title: "Seguridad de tu cuenta · Cotiza Prime",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * Tiempo máximo (segundos) de las acciones de servidor de esta pantalla. Peor caso teórico, si TODO se agota a la vez:
 * activar = contraseña de nuevo (hasta 10 s de `confirmPassword`, H-004b) + hasta 3 avisos de la activación de 15 s cada uno
 * (H-118) = 55 s, más las llamadas a Supabase (unas décimas de segundo cada una): toca el tope de 60 s. Desactivar y crear
 * códigos nuevos son menos (10 s + un aviso de 15 s = 25 s). Lo normal es de 1 a 3 s. Mitigación si el plazo se corta: nada
 * queda a medias sin remedio (la activación se revierte o sus avisos pendientes se reintentan en el próximo ingreso, H-118; un
 * código de respaldo tomado vence solo a los 2 minutos) y la persona ve el error y reintenta. Si el hosting da más plazo, se
 * sube; si da menos de 60 s, hay que bajar el plazo de `confirmPassword` o repartir los avisos (anotado en «Antes del piloto»).
 * Next exige un LITERAL aquí (no una constante importada); una guardia estática (14i) vigila que valga al menos 60.
 */
export const maxDuration = 60;

/**
 * El estado de los códigos de respaldo de la cuenta (solo cuántos hay, si se confirmó que se guardaron y cuándo se crearon:
 * nunca los códigos). Si no se puede leer, `null`: la pantalla lo dice y deja generar otros.
 */
async function loadRecoveryInfo(userId: string): Promise<RecoveryInfo | null> {
  try {
    const status = await getRecoveryCodesStatus(userId);
    if (!("setId" in status)) return { total: 0, acknowledged: false, createdLabel: null };
    return {
      total: status.total,
      acknowledged: status.acknowledged,
      createdLabel: formatDate(status.createdAt),
    };
  } catch (cause) {
    await serverLog("error", "mfa_recovery_status_failed", {
      code: cause instanceof Error ? cause.name : "unexpected",
    });
    return null;
  }
}

/**
 * Seguridad de la cuenta (H-004a y H-004b): activar la verificación en dos pasos y sus códigos de respaldo. Es de la persona, no de una organización:
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
  const recovery = secondStep.active ? await loadRecoveryInfo(user.id) : null;

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
        justCodesCreated={aviso === ACCOUNT_SECURITY_NOTICES.codesCreated}
        justRecoveryUsed={aviso === ACCOUNT_SECURITY_NOTICES.recoveryUsed}
        justDisabled={aviso === ACCOUNT_SECURITY_NOTICES.disabled}
        noticeEmail={user.email || null}
        accountEmail={user.email || null}
        recovery={recovery}
      />
    </AuthCard>
  );
}
