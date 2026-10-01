/** Normaliza un correo para comparar y sellar: recorta, NFC y minúsculas. No toca puntos ni `+`. */
export function normalizeEmail(input: string): string {
  return input.trim().normalize("NFC").toLowerCase();
}
