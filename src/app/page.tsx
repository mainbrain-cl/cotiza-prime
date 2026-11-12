import Link from "next/link";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { buttonVariants } from "@/components/ui/button";
import { LegalFooter } from "@/components/legal/legal-footer";
import { AuroraBackground } from "@/components/ui/aurora-background";
import { LOGIN_PATH, NEW_TENANT_PATH, SECOND_STEP_PATH, SIGNUP_PATH } from "@/lib/auth/paths";
import { getSessionState, requireUser } from "@/lib/auth/session";
import { INVITATION_ACCEPT_PATH } from "@/lib/team/accept-model";
import { hasPendingInvitation } from "@/lib/team/invitation-cookie";
import { resolveLandingTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";

export default async function Home() {
  // Quien ya tiene sesión va directo a su organización (o a crear la primera). Si falta el código de la verificación
  // en dos pasos, va a escribirlo.
  const session = await getSessionState();
  if (session.status === "second_step_pending") redirect(SECOND_STEP_PATH);
  if (session.status === "complete") {
    const user = await requireUser();
    const tenantId = await resolveLandingTenant(user);
    if (tenantId) redirect(tenantPath(tenantId));
    // Sin organizaciones y con una invitación esperando en este navegador: se va a unirse, no a crear una (H-009).
    redirect((await hasPendingInvitation()) ? INVITATION_ACCEPT_PATH : NEW_TENANT_PATH);
  }

  return (
    <>
      <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden p-6 text-center md:p-12">
        <AuroraBackground />
        <div className="relative flex max-w-xl animate-enter flex-col items-center gap-6">
          <BrandMark compact />
          <div className="flex flex-col gap-3">
            <h1 className="text-2xl md:text-3xl">Cotiza Prime</h1>
            <p className="text-md text-fg-muted">
              Cotiza en minutos, con tu marca, sin perder el control.
            </p>
          </div>
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            <Link href={SIGNUP_PATH} className={buttonVariants({ size: "lg" })}>
              Crear mi cuenta
            </Link>
            <Link
              href={LOGIN_PATH}
              className={buttonVariants({ size: "lg", variant: "secondary" })}
            >
              Ingresar
            </Link>
          </div>
        </div>
      </main>
      <LegalFooter />
    </>
  );
}
