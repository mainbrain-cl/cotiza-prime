"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { HOME_PATH, LOGIN_PATH } from "@/lib/auth/paths";
import { requireUser } from "@/lib/auth/session";
import { tenantPath } from "@/lib/tenant/constants";
import { acceptInvitation } from "./accept-service";
import {
  DEAD_RESULTS,
  type AcceptState,
  INVITATION_ACCEPT_PATH,
  INVITATION_GENERIC_FAILURE,
  INVITATION_NOTICES,
  INVITATION_VIEW_FIELD,
  MISSING_CODE_MESSAGE,
  messageForResult,
} from "./accept-model";
import { matchesInvitationView } from "./invitation-code";
import { clearInvitationCode, readInvitationCode } from "./invitation-cookie";

/**
 * Acciones de la pantalla `/invitacion` (H-009). Aceptar exige sesión y un clic: nada se acepta solo al abrir
 * el enlace. El código sale de la cookie (nunca del formulario), el rol y la organización los decide la base a
 * partir de la invitación, y la base vuelve a revisar sesión, correo verificado y que el correo de la cuenta sea
 * el de la invitación. La persona todavía no es miembro, así que estas acciones no tienen organización activa.
 */

/**
 * «Unirme»: acepta la invitación y entra a la organización.
 *
 * El formulario trae una sola cosa: la huella de la invitación que se MOSTRÓ (`invitationViewFingerprint`, nunca el
 * código). Si la cookie ya tiene otro código —otra página abrió `/invitacion/<otro código>` entre que la persona
 * miró y pulsó—, no se acepta nada, no se llama a la base (no suma un fallo) y se vuelve a mostrar la invitación
 * que hay ahora, con el aviso «La invitación cambió».
 */
export async function acceptInvitationAction(formData: FormData): Promise<AcceptState> {
  await requireUser();
  const code = await readInvitationCode();
  if (!code) return { status: "error", message: MISSING_CODE_MESSAGE, dead: true };
  if (!matchesInvitationView(code, formData.get(INVITATION_VIEW_FIELD))) {
    redirect(`${INVITATION_ACCEPT_PATH}?aviso=${INVITATION_NOTICES.changed}`);
  }

  const outcome = await acceptInvitation(code);
  if (outcome.status === "no_session") redirect(LOGIN_PATH);
  if (outcome.status === "failed") return { status: "error", message: INVITATION_GENERIC_FAILURE };
  if (outcome.status === "unavailable") {
    // Un código que ya no sirve no se vuelve a intentar, pero NO se borra aquí: cambiar la cookie en una acción
    // vuelve a dibujar la pantalla sin código y el motivo se perdería. Se borra con «Entendido»
    // (`leaveInvitationAction`), que es la única salida que se ofrece en ese caso.
    const dead = DEAD_RESULTS.has(outcome.result);
    return { status: "error", message: messageForResult(outcome.result), dead };
  }

  await clearInvitationCode();
  // La organización nueva entra al selector: se descarta lo que el navegador tenía guardado de las pantallas.
  revalidatePath("/", "layout");
  redirect(tenantPath(outcome.tenantId));
}

/** «Seguir sin unirme»: borra el código y vuelve al inicio. */
export async function leaveInvitationAction(): Promise<void> {
  await requireUser();
  await clearInvitationCode();
  redirect(HOME_PATH);
}
