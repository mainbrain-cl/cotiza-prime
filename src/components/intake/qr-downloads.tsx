import { Download } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Marca corta del enlace actual, solo para que el navegador pida de nuevo la vista previa si el enlace cambió. */
function versionOf(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

type Props = {
  tenantId: string;
  formId: string;
  /** El enlace público actual: solo cambia la marca de la vista previa, nunca el contenido del QR. */
  publicUrl: string;
  paused?: boolean;
  /** `false` en la lista: sin vista previa ni explicaciones largas. */
  compact?: boolean;
};

/**
 * Descarga del código QR del formulario (H-091). Solo se muestra a Dueño y Administrador, y solo si el
 * formulario está publicado o en pausa. La imagen y las descargas las entrega el servidor (la misma
 * ruta), con la dirección del formulario: aquí no se genera nada.
 */
export function QrDownloads({
  tenantId,
  formId,
  publicUrl,
  paused = false,
  compact = false,
}: Props) {
  const base = `/api/v1/tenants/${tenantId}/intake-forms/${formId}/qr`;
  return (
    <div data-testid="qr-section" className="flex min-w-0 flex-col gap-2">
      {compact ? null : <p className="text-sm font-semibold text-fg">Código QR</p>}
      {compact ? null : (
        // eslint-disable-next-line @next/next/no-img-element -- imagen servida por nuestra ruta, sin optimizar
        <img
          key={versionOf(publicUrl)}
          data-testid="qr-preview"
          src={`${base}?format=svg&v=${versionOf(publicUrl)}`}
          alt="Código QR del formulario público"
          width={144}
          height={144}
          className="bg-white size-36 rounded-sm border border-border"
        />
      )}
      <div className="flex flex-wrap gap-2">
        <a
          href={`${base}?format=png`}
          download
          data-testid="qr-download-png"
          className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
        >
          <Download aria-hidden />
          Descargar QR (PNG)
        </a>
        <a
          href={`${base}?format=svg`}
          download
          data-testid="qr-download-svg"
          className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
        >
          <Download aria-hidden />
          Descargar QR (SVG)
        </a>
      </div>
      {compact ? null : (
        <div className="flex flex-col gap-1 text-sm text-fg-muted">
          <p data-testid="qr-regenerate-note">
            Si regeneras el enlace, los QR ya impresos dejan de servir.
          </p>
          <p data-testid="qr-pause-note">
            Si pausas el formulario, quien escanee el QR verá que no está disponible.
          </p>
          {paused ? <p>Ahora está en pausa: el QR sigue siendo el mismo.</p> : null}
        </div>
      )}
    </div>
  );
}
