/**
 * Colores de la marca de una organización: formato, normalización y legibilidad (WCAG 2.1).
 * Sin dependencias: lo usan el navegador (muestra al instante) y el servidor (valida y guarda).
 */

/** Forma que acepta la base de datos: `#rrggbb` en minúsculas. */
export const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/** Colores de partida que se muestran mientras la organización no elige los suyos. */
export const DEFAULT_PRIMARY_COLOR = "#2b54e0";
export const DEFAULT_SECONDARY_COLOR = "#0f1729";

/** WCAG 2.1 AA: relación mínima de contraste para texto normal. */
export const MIN_TEXT_CONTRAST = 4.5;

const WHITE = "#ffffff";
const DARK_TEXT = "#0f1729";
const SHORT_HEX = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const LONG_HEX = /^#?([0-9a-f]{6})$/i;

/** `#ABC`, `abc` o `#AABBCC` pasan a `#aabbcc`. Si no es un color válido, devuelve `null`. */
export function normalizeHexColor(input: string): string | null {
  const value = input.trim();
  const short = SHORT_HEX.exec(value);
  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  }
  const long = LONG_HEX.exec(value);
  return long ? `#${long[1].toLowerCase()}` : null;
}

function channel(hex: string, start: number): number {
  const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Luminancia relativa según WCAG 2.1. Espera `#rrggbb`. */
export function relativeLuminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** Relación de contraste entre dos colores `#rrggbb`: de 1 (iguales) a 21 (negro sobre blanco). */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const [light, dark] = first >= second ? [first, second] : [second, first];
  return (light + 0.05) / (dark + 0.05);
}

export function contrastOnWhite(hex: string): number {
  return contrastRatio(hex, WHITE);
}

/** ¿Un texto de este color se lee bien sobre blanco? (AA, 4,5:1). */
export function readsWellOnWhite(hex: string): boolean {
  return contrastOnWhite(hex) >= MIN_TEXT_CONTRAST;
}

/** Texto blanco u oscuro: el que mejor se lea sobre este color de fondo. */
export function readableTextOn(hex: string): string {
  return contrastRatio(hex, WHITE) >= contrastRatio(hex, DARK_TEXT) ? WHITE : DARK_TEXT;
}
