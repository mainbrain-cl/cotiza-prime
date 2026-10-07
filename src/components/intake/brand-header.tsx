import { cn } from "@/lib/utils";

/**
 * Encabezado de la marca de la organización (logo y nombre) del formulario público. Es un componente de
 * SERVIDOR (sin estado ni efectos): la página pública lo dibuja y se lo entrega ya armado al formulario del
 * navegador, así el logo no viaja como dato de la pantalla interactiva. La vista previa del constructor lo
 * usa igual, con la dirección del logo de la aplicación.
 */
export const BRAND_BG = "bg-[var(--brand)] text-[var(--on-brand)]";

export function BrandHeader({
  organizationName,
  logoSrc,
}: {
  organizationName: string;
  /** Dirección de la aplicación o `data:` ya reducido; `null` si no hay logo. */
  logoSrc: string | null;
}) {
  return (
    <header className={cn("flex min-w-0 items-center gap-3 p-4 sm:p-6", BRAND_BG)}>
      {logoSrc ? (
        // Logo de la organización: una dirección de la aplicación o `data:` (no se descarga de afuera).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoSrc}
          alt={`Logo de ${organizationName}`}
          className="max-h-12 max-w-32 shrink-0 rounded-xs bg-surface object-contain p-1"
        />
      ) : null}
      <p className="min-w-0 text-lg font-semibold break-words">{organizationName}</p>
    </header>
  );
}
