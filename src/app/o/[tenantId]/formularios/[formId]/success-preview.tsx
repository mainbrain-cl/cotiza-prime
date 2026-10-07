import type { CSSProperties } from "react";
import { brandStyle } from "@/lib/share/brand-vars";
import type { PdfBrand } from "@/lib/pdf/types";
import { cn } from "@/lib/utils";

/** Texto de la vista previa cuando no se escribió un «Mensaje al enviar». */
export const SUCCESS_PLACEHOLDER = "Recibimos tu solicitud. Te responderemos pronto.";

/**
 * Vista previa de la confirmación que ve quien envía el formulario. Es una vista aparte del editor
 * (no toca `FormView`): solo textos, con la marca de la organización y sin ningún monto.
 */
export function SuccessPreview({
  brand,
  organizationName,
  logoSrc,
  message,
}: {
  brand: PdfBrand;
  organizationName: string;
  logoSrc: string | null;
  message: string;
}) {
  return (
    <div
      className="customer-light overflow-hidden rounded-lg border border-border shadow-2"
      style={brandStyle(brand) as CSSProperties}
      data-testid="success-view"
    >
      <header className="flex min-w-0 items-center gap-3 bg-[var(--brand)] p-4 text-[var(--on-brand)] sm:p-6">
        {logoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoSrc}
            alt={`Logo de ${organizationName}`}
            className="max-h-12 max-w-32 shrink-0 rounded-xs bg-surface object-contain p-1"
          />
        ) : null}
        <p className="min-w-0 text-lg font-semibold break-words">{organizationName}</p>
      </header>
      <div className="flex flex-col gap-3 bg-surface p-4 sm:p-6">
        <p className="text-xl font-semibold text-fg">Solicitud enviada</p>
        <p className={cn("break-words whitespace-pre-line", message ? "text-fg" : "text-fg-muted")}>
          {message || SUCCESS_PLACEHOLDER}
        </p>
        {message ? null : (
          <p className="text-sm text-fg-subtle">
            No escribiste un mensaje: aquí se muestra un texto de ejemplo.
          </p>
        )}
      </div>
    </div>
  );
}
