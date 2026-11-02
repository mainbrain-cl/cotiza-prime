"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { HOME_PATH, LOGIN_PATH } from "@/lib/auth/paths";
import { requireUser } from "@/lib/auth/session";
import { tenantPath } from "@/lib/tenant/constants";
import { acceptInvitation } from "./accept-service";
import {
  DEAD_RESULTS,
  INVITATION_GENERIC_FAILURE,
  MISSING_CODE_MESSAGE,
  messageForResult,
} from "./accept-model";
import { clearInvitationCode, readInvitationCode } from "./invitation-cookie";

/**
 * Acciones de la pantalla `/invitacion` (H-009). Aceptar exige sesión y un clic: nada se acepta solo al abrir
 * el enlace. El código sale de la cookie (nunca del formulario), el rol y la organización los decide la base a
 * partir de la invitación, y la base vuelve a revisar sesión, correo verificado y que el correo de la cuenta sea
 * el de la invitación. La persona todavía no es miembro, así que estas acciones no tienen organización activa.
 */

export type AcceptState = {
  status: "idle" | "error";
  message?: string;
  /** El código ya no sirve para nada: la pantalla ofrece salir en vez de reintentar. */
  dead?: boolean;
};

export const INITIAL_ACCEPT_STATE: AcceptState = { status: "idle" };

/** «Unirme»: acepta la invitación y entra a la organización. */
export async function acceptInvitationAction(): Promise<AcceptState> {
  await requireUser();
  const code = await readInvitationCode();
  if (!code) return { status: "error", message: MISSING_CODE_MESSAGE, dead: true };

  const outcome = await acceptInvitation(code);
  if (outcome.status === "no_session") redirect(LOGIN_PATH);
  if (outcome.status === "failed") return { status: "error", message: INVITATION_GENERIC_FAILURE };
  if (outcome.status === "unavailable") {
    // Un código que no sirve no se vuelve a intentar: se borra para que no vuelva a aparecer al ingresar.
    const dead = DEAD_RESULTS.has(outcome.result);
    if (dead) await clearInvitationCode();
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
