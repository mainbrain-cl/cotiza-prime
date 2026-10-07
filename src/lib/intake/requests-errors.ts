/**
 * Traduce los errores de las funciones de solicitudes (H-089) a mensajes claros, sin detalle técnico.
 * Los códigos son los de la base: 42501 sin permiso, CP404 no existe en esta organización, CP422 dato
 * inválido y CP423 estado que no admite el cambio.
 */

export type RequestAction = "assign" | "discard" | "restore" | "anonymize";

export type RequestErrorKind = "forbidden" | "not_found" | "state" | "invalid" | "other";

export type RequestError = { kind: RequestErrorKind; message: string };

export const REQUEST_GENERIC_FAILURE =
  "No pudimos completar la acción. Intenta de nuevo en unos minutos; si sigue igual, avísanos.";

export const REQUEST_NOT_FOUND = "No encontramos esta solicitud. Puede que ya no exista.";

const FORBIDDEN_BY_ACTION: Record<RequestAction, string> = {
  assign: "Solo el Dueño y los Administradores pueden asignar solicitudes.",
  discard:
    "Solo el Dueño, los Administradores o la persona a cargo de la solicitud pueden descartarla.",
  restore:
    "Solo el Dueño, los Administradores o la persona a cargo de la solicitud pueden restaurarla.",
  anonymize: "Solo el Dueño y los Administradores pueden eliminar los datos de una solicitud.",
};

export function mapRequestError(
  error: { code?: string | null; message?: string | null },
  action: RequestAction,
): RequestError {
  const code = error.code ?? "";
  if (code === "42501") return { kind: "forbidden", message: FORBIDDEN_BY_ACTION[action] };
  if (code === "CP404") return { kind: "not_found", message: REQUEST_NOT_FOUND };
  if (code === "CP423") {
    return {
      kind: "state",
      message: "La solicitud ya cambió de estado. Recarga la página para ver cómo quedó.",
    };
  }
  if (code === "CP422") {
    if (error.message === "assignee_not_eligible") {
      return {
        kind: "invalid",
        message: "Esa persona ya no puede recibir solicitudes. Elige a otra.",
      };
    }
    if (error.message === "invalid_note") {
      return {
        kind: "invalid",
        message: "La nota tiene caracteres que no podemos aceptar. Escríbela de nuevo más simple.",
      };
    }
    return {
      kind: "invalid",
      message: "Hay algo en lo que enviaste que no pudimos aceptar. Revisa y vuelve a intentar.",
    };
  }
  return { kind: "other", message: REQUEST_GENERIC_FAILURE };
}
