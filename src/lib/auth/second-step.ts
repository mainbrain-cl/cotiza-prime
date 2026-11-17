/** Piezas puras de la verificación en dos pasos (H-004a): sin red ni base de datos, fáciles de probar. */
import { HOME_PATH, RESET_PASSWORD_PATH } from "@/lib/auth/paths";
import { INVITATION_ACCEPT_PATH } from "@/lib/team/accept-model";

/** Nombre con que la aplicación de códigos de la persona muestra a Cotiza Prime. */
export const MFA_ISSUER = "Cotiza Prime";

/** Nombre visible del factor en Supabase (H-004b; estaba pendiente desde el punto (d) de H-004a). */
export const MFA_FACTOR_FRIENDLY_NAME = "Aplicación de códigos";

/** Tipo de verificación que existe hoy (aplicación de códigos). Va en la auditoría. */
export const MFA_FACTOR_TYPE = "totp";

const MANUAL_KEY_GROUP_SIZE = 4;

/**
 * A dónde va la persona después de escribir bien el código: si venía de abrir el enlace de recuperar la contraseña,
 * a elegir la nueva; si venía de abrir una invitación, a unirse; y si no, al inicio. La recuperación manda sobre la
 * invitación (es lo que acaba de abrir).
 */
export function afterSecondStepPath(context: { recovery: boolean; invitation: boolean }): string {
  if (context.recovery) return RESET_PASSWORD_PATH;
  if (context.invitation) return INVITATION_ACCEPT_PATH;
  return HOME_PATH;
}

/** La clave para escribir a mano, en mayúsculas y en grupos de 4 («ABCD EFGH …»); ignora espacios y guiones. */
export function formatManualKey(secret: string): string {
  const clean = secret.replace(/[\s-]/g, "").toUpperCase();
  const groups: string[] = [];
  for (let index = 0; index < clean.length; index += MANUAL_KEY_GROUP_SIZE) {
    groups.push(clean.slice(index, index + MANUAL_KEY_GROUP_SIZE));
  }
  return groups.join(" ");
}
