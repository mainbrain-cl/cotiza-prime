import { z } from "zod";
import { parseRut } from "@/lib/chile/rut";
import { normalizeEmail } from "@/lib/normalize/email";

/** Largo máximo de lo que se escribe en el buscador. */
export const CUSTOMER_SEARCH_MAX_LENGTH = 100;

/** Qué quiso buscar la persona. El RUT y el correo se buscan completos; el nombre, por partes. */
export type CustomerSearch =
  | { kind: "none" }
  | { kind: "rut"; rut: string }
  | { kind: "email"; email: string }
  | { kind: "text"; text: string };

// Solo números, puntos, espacios y guion, terminando en dígito o K: así "Pedro 2" no se confunde con un RUT.
const RUT_SHAPE = /^[0-9][0-9.\s-]*[0-9kK]$/;

/**
 * Decide, desde el servidor, cómo buscar lo que se escribió: un correo completo y válido o un RUT
 * completo y válido se buscan por huella (sin descifrar nada); cualquier otra cosa es parte de un nombre.
 */
export function detectCustomerSearch(raw: string | null | undefined): CustomerSearch {
  const term = (raw ?? "").trim().replace(/\s+/g, " ").slice(0, CUSTOMER_SEARCH_MAX_LENGTH);
  if (term === "") return { kind: "none" };
  if (term.includes("@") && z.email().safeParse(term).success) {
    return { kind: "email", email: normalizeEmail(term) };
  }
  if (RUT_SHAPE.test(term)) {
    const rut = parseRut(term);
    if (rut) return { kind: "rut", rut };
  }
  return { kind: "text", text: term };
}

/** Escapa `%`, `_` y `\` para que lo escrito se busque tal cual dentro de un `ilike`. */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}
