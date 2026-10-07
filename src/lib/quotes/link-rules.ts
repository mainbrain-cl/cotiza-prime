/**
 * Quién puede revocar el enlace del cliente y cuándo (H-035). Reglas puras: las usan la pantalla
 * (para mostrar la opción) y la acción del servidor (para exigirla). La base vuelve a verificar al
 * autor, al Dueño y al Administrador en `revoke_quote_links`.
 */

/**
 * Estados en los que se puede revocar: la cotización salió y el cliente todavía no respondió.
 * Una cotización ya aceptada NO se revoca: el cliente perdería la página con los datos de pago.
 * Decisión pendiente de Aarón (docs/arquitectura/sprint-3-envio-y-enlace.md §12).
 */
export const REVOCABLE_STATUSES: readonly string[] = ["sent", "viewed"];

const AUTHOR_ROLES: readonly string[] = ["owner", "admin", "sales"];
const MANAGER_ROLES: readonly string[] = ["owner", "admin"];

export function canRevokeLinks(params: {
  role: string;
  isAuthor: boolean;
  status: string;
}): boolean {
  if (!REVOCABLE_STATUSES.includes(params.status)) return false;
  return (
    MANAGER_ROLES.includes(params.role) || (AUTHOR_ROLES.includes(params.role) && params.isAuthor)
  );
}
