/**
 * Por qué una cotización se ve solo para leer (pura, sin base de datos). Cuando el borrador es de otra persona, el
 * mensaje depende de si esa persona sigue en el equipo: quien se fue no puede editar nada, y decir «Solo <nombre>
 * puede editar» sería falso.
 */
export const AUTHOR_GONE_MESSAGE =
  "Quien armó este borrador ya no está en el equipo; queda solo para leer.";
/** Si no se pudo saber si el autor sigue en el equipo: verdadero en ambos casos, sin nombrar a nadie. */
export const AUTHOR_UNKNOWN_MESSAGE =
  "Solo quien armó este borrador puede editarlo. Tú puedes verlo.";

export function readOnlyReason(input: {
  editable: boolean;
  statusAllowsEdit: boolean;
  /** El rol de quien mira puede editar cotizaciones propias en algún caso. */
  roleCanEdit: boolean;
  authorName: string;
  /** El autor es miembro activo de la organización; `null` si no se pudo saber (la consulta falló). */
  authorIsActive: boolean | null;
}): string | null {
  if (input.editable) return null;
  if (!input.statusAllowsEdit) return "Esta cotización ya no se puede editar.";
  if (!input.roleCanEdit) return "Tu rol solo permite ver las cotizaciones.";
  if (input.authorIsActive === null) return AUTHOR_UNKNOWN_MESSAGE;
  if (!input.authorIsActive) return AUTHOR_GONE_MESSAGE;
  return `Solo ${input.authorName} puede editar este borrador. Tú puedes verlo.`;
}
