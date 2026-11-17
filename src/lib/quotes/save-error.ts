import { lineRuleFieldErrors, parseLineRulesError } from "./line-rules";

/**
 * Cómo se lee un error de `save_quote_draft` (H-026, H-041). Vive aparte de las acciones porque un archivo `use server` solo
 * puede exportar funciones y esta lectura se prueba sin base de datos. Es pura: no registra nada; dice, si hace falta, qué
 * evento registrar (`log`) y quien llama lo registra, con el código del error y nada más.
 */

export type SaveQuoteResult =
  | { status: "saved"; revision: number }
  | { status: "conflict"; message: string }
  | { status: "not_editable"; message: string }
  | { status: "forbidden"; message: string }
  | { status: "not_found"; message: string }
  | { status: "invalid"; message: string; fieldErrors: Record<string, string> }
  | { status: "error"; message: string };

export const SAVE_FAILED = "No pudimos guardar los cambios. Intenta de nuevo en unos minutos.";
export const SAVE_CONFLICT_MESSAGE =
  "Esta cotización cambió en otra pestaña. Recarga para ver la última versión.";
/** Las reglas de precio y descuento cambiaron entre que se abrió la cotización y se guardó (H-041). */
export const LINE_RULES_CHANGED_MESSAGE =
  "Tu organización cambió sus reglas de precio. Recarga para ver las vigentes.";

const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";
const SQLSTATE_NOT_FOUND = "CP404";
const SQLSTATE_REVISION_CONFLICT = "CP409";
const SQLSTATE_INVALID = "CP422";
const SQLSTATE_NOT_EDITABLE = "CP423";
const SQLSTATE_CALC_MISMATCH = "CP500";

function invalidMessage(rpcMessage: string): string {
  if (rpcMessage.startsWith("catalog_item_unavailable")) {
    return "Un servicio de la cotización ya no está disponible en el catálogo. Quítalo o usa una línea libre.";
  }
  if (rpcMessage.startsWith("catalog_item_changed")) {
    return "El servicio cambió en el catálogo; vuelve a agregarlo.";
  }
  if (rpcMessage.startsWith("validity_in_past")) {
    return "La fecha de vigencia no puede estar en el pasado.";
  }
  if (rpcMessage.startsWith("customer_not_found") || rpcMessage.startsWith("invalid_customer")) {
    return "El cliente ya no está disponible. Elige otro.";
  }
  return "Revisa los datos de la cotización e intenta de nuevo.";
}

export function mapSaveRpcError(error: { code?: string; message?: string }): {
  result: SaveQuoteResult;
  /** El evento que hay que registrar (solo con el código del error), o `undefined` si es un error esperado. */
  log?: "quote_calc_mismatch" | "quote_save_failed";
} {
  switch (error.code) {
    case SQLSTATE_REVISION_CONFLICT:
      return { result: { status: "conflict", message: SAVE_CONFLICT_MESSAGE } };
    case SQLSTATE_NOT_EDITABLE:
      return {
        result: { status: "not_editable", message: "Esta cotización ya no se puede editar." },
      };
    case SQLSTATE_INSUFFICIENT_PRIVILEGE:
      return {
        result: { status: "forbidden", message: "Solo quien creó este borrador puede editarlo." },
      };
    case SQLSTATE_NOT_FOUND:
      return { result: { status: "not_found", message: "No encontramos esta cotización." } };
    case SQLSTATE_INVALID: {
      const message = error.message ?? "";
      // Las reglas de precio y descuento (H-041): el error trae cada problema con su línea (`price_locked@0,...`).
      const ruleIssues = parseLineRulesError(message);
      if (ruleIssues !== null) {
        return {
          result: {
            status: "invalid",
            message: LINE_RULES_CHANGED_MESSAGE,
            fieldErrors: lineRuleFieldErrors(ruleIssues),
          },
        };
      }
      return {
        result: {
          status: "invalid",
          message: invalidMessage(message),
          fieldErrors: message.startsWith("validity_in_past")
            ? { validity: "La fecha de vigencia no puede estar en el pasado." }
            : {},
        },
      };
    }
    case SQLSTATE_CALC_MISMATCH:
      // El cálculo de la aplicación y el de la base no coinciden: error grave, sin datos personales.
      return {
        result: {
          status: "error",
          message:
            "No pudimos confirmar los totales de esta cotización, así que no se guardó nada. Ya avisamos al equipo.",
        },
        log: "quote_calc_mismatch",
      };
    default:
      return { result: { status: "error", message: SAVE_FAILED }, log: "quote_save_failed" };
  }
}
