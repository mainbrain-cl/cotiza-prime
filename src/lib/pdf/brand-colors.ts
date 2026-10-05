import {
  contrastOnWhite,
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_SECONDARY_COLOR,
  MIN_TEXT_CONTRAST,
  normalizeHexColor,
} from "@/lib/brand/colors";
import type { PdfBrand } from "./types";

const TINT_TOWARD_WHITE = 0.9;
const DARKEN_START = 0.95;
const DARKEN_STEP = 0.05;
const DARK_ON_BRAND = "#111111";
const WHITE = "#ffffff";
const BLACK = "#000000";

const toHex = (value: number) => Math.round(value).toString(16).padStart(2, "0");
const channels = (hex: string) =>
  [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));

/** Multiplica cada canal por `factor` (0 a 1): un color más oscuro. */
export function darken(hex: string, factor: number): string {
  return `#${channels(hex)
    .map((c) => toHex(c * factor))
    .join("")}`;
}

/** Mezcla el color con blanco: `0,9` deja un fondo casi blanco con un toque del color. */
export function tint(hex: string, towardWhite: number = TINT_TOWARD_WHITE): string {
  return `#${channels(hex)
    .map((c) => toHex(c + (255 - c) * towardWhite))
    .join("")}`;
}

/**
 * Colores de la marca para el PDF (misma regla que la vista previa aprobada): las franjas y las
 * bandas usan el color tal cual; los textos de marca usan una versión oscurecida si el color no
 * llega a 4,5:1 sobre blanco; y el texto sobre la banda pasa a oscuro si el blanco no se lee.
 */
export function resolvePdfBrand(primary: string | null, secondary: string | null): PdfBrand {
  const main = (primary && normalizeHexColor(primary)) || DEFAULT_PRIMARY_COLOR;
  const accent = (secondary && normalizeHexColor(secondary)) || DEFAULT_SECONDARY_COLOR;

  let text = main;
  let factor = DARKEN_START;
  while (contrastOnWhite(text) < MIN_TEXT_CONTRAST && factor > 0) {
    text = darken(main, factor);
    factor = Math.max(0, factor - DARKEN_STEP);
  }
  if (contrastOnWhite(text) < MIN_TEXT_CONTRAST) text = BLACK;

  return {
    primary: main,
    secondary: accent,
    primaryText: text,
    onPrimary: contrastOnWhite(main) >= MIN_TEXT_CONTRAST ? WHITE : DARK_ON_BRAND,
    primaryTint: tint(main),
  };
}
