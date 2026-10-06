import type { CSSProperties } from "react";
import {
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_SECONDARY_COLOR,
  HEX_COLOR_PATTERN,
} from "@/lib/brand/colors";
import { resolvePdfBrand } from "@/lib/pdf/brand-colors";
import type { PdfBrand } from "@/lib/pdf/types";

/**
 * Colores de la marca de la organización para la pantalla del cliente, a partir de la copia
 * congelada del paquete (los mismos que dibuja el PDF). Cada color se vuelve a comprobar: si algo
 * no es un `#rrggbb` válido se usa el color por defecto en su lugar, así que nunca llega texto libre
 * a un estilo.
 */
const isHex = (value: string) => HEX_COLOR_PATTERN.test(value);

export function safeBrand(brand: PdfBrand): PdfBrand {
  const allValid = [
    brand.primary,
    brand.secondary,
    brand.primaryText,
    brand.onPrimary,
    brand.primaryTint,
  ].every(isHex);
  if (allValid) return brand;
  const primary = isHex(brand.primary) ? brand.primary : DEFAULT_PRIMARY_COLOR;
  const secondary = isHex(brand.secondary) ? brand.secondary : DEFAULT_SECONDARY_COLOR;
  return resolvePdfBrand(primary, secondary);
}

/** Variables CSS que usa la pantalla del cliente: `--brand`, `--brand-text`, `--on-brand`, `--brand-tint`. */
export function brandStyle(brand: PdfBrand): CSSProperties {
  const safe = safeBrand(brand);
  return {
    "--brand": safe.primary,
    "--brand-accent": safe.secondary,
    "--brand-text": safe.primaryText,
    "--on-brand": safe.onPrimary,
    "--brand-tint": safe.primaryTint,
  } as CSSProperties;
}
