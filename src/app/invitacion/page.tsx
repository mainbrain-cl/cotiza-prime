import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/auth-card";
import {
  AcceptInvitationForm,
  LeaveInvitationButton,
} from "@/components/team/accept-invitation-form";
import { Button, buttonVariants } from "@/components/ui/button";
import { signOutAction } from "@/lib/auth/actions";
import { HOME_PATH, LOGIN_PATH, SIGNUP_PATH } from "@/lib/auth/paths";
import { getOptionalUser, requireUser } from "@/lib/auth/session";
import {
  FALLBACK_INVITER_NAME,
  FALLBACK_ORGANIZATION_NAME,
  cleanName,
} from "@/lib/email/invitation-names";
import { formatDate } from "@/lib/format-date";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/permissions/matrix";
import { previewInvitation } from "@/lib/team/accept-service";
import {
  INVITATION_ACCEPT_PATH,
  INVITATION_GENERIC_FAILURE,
  INVITATION_NOTICE_MESSAGES,
  MISSING_CODE_MESSAGE,
  RETRY_RESULTS,
  alreadyMemberSentence,
  invitationSentence,
  invitedRole,
  messageForResult,
} from "@/lib/team/accept-model";
import { readInvitationCode } from "@/lib/team/invitation-cookie";

export const metadata: Metadata = {
  title: "Tu invitación · Cotiza Prime",
  // La dirección de esta pantalla no lleva el código, pero igual no se indexa ni se manda a otros sitios.
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/**
 * Aceptar una invitación (H-009). El código llega en una cookie (la dejó `/invitacion/[código]`); aquí nunca se ve
 * en la barra de direcciones.
 *  - Sin sesión: se pide ingresar o crear la cuenta CON EL CORREO AL QUE LLEGÓ LA INVITACIÓN. No se consulta la
 *    base, no se dice si ese correo tiene cuenta y no se muestra el nombre de la organización.
 *  - Con sesión: la base dice si la invitación es para esta cuenta; solo entonces se ve quién invitó, a qué
 *    organización y con qué rol, y se acepta con un clic.
 */
export default async function InvitationPage({ searchParams }: PageProps<"/invitacion">) {
  const { aviso } = await searchParams;
  const notice = typeof aviso === "string" ? INVITATION_NOTICE_MESSAGES[aviso] : undefined;
  const code = await readInvitationCode();
  const sessionUser = await getOptionalUser();

  if (!code) {
    return (
      <AuthCard title="Falta tu invitación" description={notice ?? MISSING_CODE_MESSAGE}>
        <Link
          href={sessionUser ? HOME_PATH : LOGIN_PATH}
          className={buttonVariants({ size: "lg", variant: "secondary" })}
          data-testid="invitation-missing-action"
        >
          {sessionUser ? "Ir a mi cuenta" : "Ingresar"}
        </Link>
      </AuthCard>
    );
  }

  if (!sessionUser) return <SignedOutView />;

  // El resto exige sesión y que estén aceptados los términos vigentes.
  const user = await requireUser();
  const preview = await previewInvitation(code);

  if (preview.status === "no_session") return <SignedOutView />;
  // Si la base falla, se muestra un mensaje de reintento (nunca un detalle técnico).
  if (preview.status === "failed") {
    return (
      <AuthCard title="No pudimos abrir tu invitación" description={INVITATION_GENERIC_FAILURE}>
        <Link href="/invitacion" className={buttonVariants({ size: "lg", variant: "secondary" })}>
          Intentar de nuevo
        </Link>
      </AuthCard>
    );
  }

  if (preview.status === "already_member") {
    // Ya entró con esta invitación (por ejemplo, desde otra pestaña): un clic la lleva a su organización.
    return (
      <AuthCard
        title="Ya eres parte de esta organización"
        description="Esta invitación ya la aceptaste con tu cuenta."
      >
        <AcceptInvitationForm label="Entrar" pendingLabel="Entrando…" />
      </AuthCard>
    );
  }

  if (preview.status === "unavailable") {
    const result = preview.result;
    const wrongAccount = result === "wrong_email";
    return (
      <AuthCard
        title={
          wrongAccount ? "Esta invitación es para otro correo" : "No podemos abrir esta invitación"
        }
        description={messageForResult(result)}
      >
        <div
          className="flex flex-col gap-3"
          data-testid="invitation-unavailable"
          data-result={result}
        >
          <p className="text-sm text-fg-muted">
            Ingresaste como <strong className="break-all text-fg">{user.email}</strong>.
          </p>
          {wrongAccount ? (
            <form action={signOutAction}>
              <Button type="submit" size="lg" className="w-full">
                Cerrar sesión e ingresar con otro correo
              </Button>
            </form>
          ) : null}
          {RETRY_RESULTS.has(result) ? (
            // Se arregla esperando o verificando el correo: el código se queda guardado para el reintento.
            <Link
              href={INVITATION_ACCEPT_PATH}
              className={buttonVariants({ size: "lg", variant: "secondary" })}
            >
              Intentar de nuevo
            </Link>
          ) : null}
          <LeaveInvitationButton
            label={wrongAccount || RETRY_RESULTS.has(result) ? "Seguir sin unirme" : "Entendido"}
          />
        </div>
      </AuthCard>
    );
  }

  const role = invitedRole(preview.role);
  const organizationName = cleanName(preview.organizationName, FALLBACK_ORGANIZATION_NAME);
  const sentence = invitationSentence({
    inviterName: cleanName(preview.inviterName, FALLBACK_INVITER_NAME),
    organizationName,
    roleLabel: role ? ROLE_LABELS[role] : "miembro",
  });
  // Si ya eres miembro, aceptar no te cambia el rol: se dice cuál tienes en vez de prometer el de la invitación.
  const currentRole = invitedRole(preview.currentRole ?? undefined);
  const alreadyMemberNote =
    preview.alreadyMember && currentRole
      ? alreadyMemberSentence({ organizationName, roleLabel: ROLE_LABELS[currentRole] })
      : null;

  return (
    <AuthCard title="Te invitaron a unirte a un equipo">
      <div className="flex flex-col gap-5" data-testid="invitation-ready">
        <p className="text-md font-medium" data-testid="invitation-sentence">
          {sentence}
        </p>
        {alreadyMemberNote ? (
          <p className="font-medium text-fg" data-testid="invitation-already-member">
            {alreadyMemberNote}
          </p>
        ) : role ? (
          <p className="text-fg-muted">{ROLE_DESCRIPTIONS[role]}</p>
        ) : null}
        {preview.expiresAt ? (
          <p className="text-sm text-fg-subtle">
            La invitación vale hasta el {formatDate(preview.expiresAt)}.
          </p>
        ) : null}
        <AcceptInvitationForm
          label={alreadyMemberNote ? "Entrar" : "Unirme"}
          pendingLabel={alreadyMemberNote ? "Entrando…" : "Uniéndote…"}
        />
        <p className="border-t border-border pt-4 text-sm text-fg-muted">
          Ingresaste como <strong className="break-all text-fg">{user.email}</strong>.
        </p>
      </div>
    </AuthCard>
  );
}

/** Sin sesión: ni se consulta la invitación ni se dice nada de ella (ni de quién tiene cuenta). */
function SignedOutView() {
  return (
    <AuthCard
      title="Te invitaron a Cotiza Prime"
      description="Te invitaron a una organización de Cotiza Prime. Ingresa o crea tu cuenta con el correo al que llegó la invitación."
    >
      <div className="flex flex-col gap-3 sm:flex-row" data-testid="invitation-signed-out">
        <Link href={LOGIN_PATH} className={buttonVariants({ size: "lg", className: "sm:flex-1" })}>
          Ingresar
        </Link>
        <Link
          href={SIGNUP_PATH}
          className={buttonVariants({ size: "lg", variant: "secondary", className: "sm:flex-1" })}
        >
          Crear mi cuenta
        </Link>
      </div>
    </AuthCard>
  );
}
