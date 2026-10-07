/**
 * Traduce los errores de las funciones de la base del constructor (H-086) a mensajes claros, sin
 * detalle técnico. `fixPath` indica a qué parte de la aplicación ir para corregirlo.
 */

import { FORM_ITEMS_MAX, FORMS_PER_ORGANIZATION_MAX } from "./builder-model";

export type BuilderErrorKind = "conflict" | "forbidden" | "not_found" | "other";

export type BuilderError = {
  kind: BuilderErrorKind;
  message: string;
  /** Subruta dentro de la organización donde se corrige (por ejemplo `configuracion/empresa`). */
  fixPath?: string;
  fixLabel?: string;
};

export const SQLSTATE_FORBIDDEN = "42501";
export const SQLSTATE_NOT_FOUND = "CP404";
export const SQLSTATE_CONFLICT = "CP409";
export const SQLSTATE_INVALID = "CP422";
export const SQLSTATE_STATE = "CP423";

export const GENERIC_FAILURE =
  "No pudimos completar la acción. Intenta de nuevo en unos minutos; si sigue igual, avísanos.";
export const NO_PERMISSION = "Solo el Dueño y los Administradores pueden cambiar los formularios.";
export const CONFLICT_MESSAGE =
  "Otra persona guardó cambios en este formulario. Recarga la página para verlos; lo que escribiste sigue en pantalla y no se perdió.";

const BY_MESSAGE: Record<string, BuilderError> = {
  needs_item: {
    kind: "other",
    message: "Para publicar, agrega al menos un servicio que se pueda pedir y guarda los cambios.",
  },
  needs_contact_email: {
    kind: "other",
    message:
      "Para publicar, tu organización necesita un correo de contacto: ahí le escribirán a quien pida una cotización. Agrégalo en «Datos de tu empresa» y vuelve a publicar.",
    fixPath: "configuracion/empresa",
    fixLabel: "Ir a Datos de tu empresa",
  },
  too_many_forms: {
    kind: "other",
    message: `Llegaste al máximo de ${FORMS_PER_ORGANIZATION_MAX} formularios. Archiva alguno que ya no uses para crear otro.`,
  },
  archived: {
    kind: "other",
    message: "Este formulario está archivado y ya no se puede cambiar.",
  },
  invalid_status_change: {
    kind: "other",
    message: "Ese cambio ya no es posible con el estado actual del formulario. Recarga la página.",
  },
  catalog_item_inactive: {
    kind: "other",
    message:
      "Uno de los servicios que elegiste del catálogo está desactivado. Actívalo en el catálogo o quítalo del formulario.",
  },
  catalog_item_not_found: {
    kind: "other",
    message:
      "Uno de los servicios del catálogo ya no existe. Quítalo del formulario y vuelve a guardar.",
  },
  too_many_items: {
    kind: "other",
    message: `Un formulario admite hasta ${FORM_ITEMS_MAX} servicios.`,
  },
  form_id_taken: { kind: "other", message: GENERIC_FAILURE },
};

/** Al guardar un formulario que ya está publicado o en pausa, `needs_item` no habla de «publicar». */
export const NEEDS_ITEM_ON_SAVE_MESSAGE =
  "Un formulario publicado necesita al menos un servicio. Agrega uno o pausa el formulario antes de quitar el último.";

export function mapBuilderError(
  error: { code?: string | null; message?: string | null },
  context: "save" | "other" = "other",
): BuilderError {
  const code = error.code ?? "";
  if (code === SQLSTATE_FORBIDDEN) return { kind: "forbidden", message: NO_PERMISSION };
  if (code === SQLSTATE_CONFLICT) return { kind: "conflict", message: CONFLICT_MESSAGE };
  if (context === "save" && error.message === "needs_item") {
    return { kind: "other", message: NEEDS_ITEM_ON_SAVE_MESSAGE };
  }
  const known = BY_MESSAGE[error.message ?? ""];
  if (known) return known;
  if (code === SQLSTATE_NOT_FOUND) {
    return {
      kind: "not_found",
      message: "No encontramos este formulario. Puede que ya no exista.",
    };
  }
  if (code === SQLSTATE_INVALID) {
    return {
      kind: "other",
      message:
        "Hay algo en el formulario que no pudimos aceptar. Revisa los textos y vuelve a guardar.",
    };
  }
  return { kind: "other", message: GENERIC_FAILURE };
}
