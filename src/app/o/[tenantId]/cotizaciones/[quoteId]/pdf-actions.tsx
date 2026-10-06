"use client";

import { Download, Eye } from "lucide-react";
import { useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Select } from "@/components/ui/form-controls";
import { PDF_PAPER_SIZES, type PdfPaperSize } from "@/lib/pdf/types";
import { cn } from "@/lib/utils";

const PAPER_LABELS: Record<PdfPaperSize, string> = { letter: "Carta", a4: "A4" };

/**
 * Vista previa y descarga del PDF (H-028). El PDF se arma en el servidor con lo GUARDADO: si hay
 * cambios sin guardar, los botones se apagan y se explica por qué, para que nadie revise un
 * documento distinto del que está editando.
 */
export function PdfActions({
  tenantId,
  quoteId,
  unsaved = false,
  sent = false,
}: {
  tenantId: string;
  quoteId: string;
  unsaved?: boolean;
  /** Ya se envió: el PDF es el archivo congelado que recibió el cliente. */
  sent?: boolean;
}) {
  const [paper, setPaper] = useState<PdfPaperSize>("letter");
  const base = `/api/v1/tenants/${tenantId}/quotes/${quoteId}/pdf?size=${paper}`;
  const disabledClass = "pointer-events-none opacity-50";
  return (
    <section
      aria-label="Vista previa del PDF"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
      data-testid="pdf-actions"
    >
      <h2 className="text-lg">Documento para el cliente</h2>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="pdf-paper" className="text-sm font-semibold text-fg">
          Tamaño de hoja
        </label>
        <Select
          id="pdf-paper"
          value={paper}
          onChange={(event) => setPaper(event.target.value as PdfPaperSize)}
        >
          {PDF_PAPER_SIZES.map((size) => (
            <option key={size} value={size}>
              {PAPER_LABELS[size]}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <a
          href={base}
          target="_blank"
          rel="noopener"
          data-testid="pdf-preview"
          aria-disabled={unsaved}
          tabIndex={unsaved ? -1 : undefined}
          className={cn(buttonVariants({ variant: "secondary" }), unsaved && disabledClass)}
        >
          <Eye aria-hidden />
          Vista previa
        </a>
        <a
          href={`${base}&download=1`}
          data-testid="pdf-download"
          aria-disabled={unsaved}
          tabIndex={unsaved ? -1 : undefined}
          className={cn(buttonVariants({ variant: "secondary" }), unsaved && disabledClass)}
        >
          <Download aria-hidden />
          Descargar PDF
        </a>
      </div>
      <p className="text-sm text-fg-muted" data-testid="pdf-hint">
        {sent
          ? "Este es el PDF que recibió tu cliente, tal como se envió."
          : unsaved
            ? "Guarda la cotización para ver su PDF: se arma con lo guardado."
            : "Así lo recibirá tu cliente. La fecha del documento será la del día en que lo envíes."}
      </p>
    </section>
  );
}
