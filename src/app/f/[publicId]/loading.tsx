import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";

/**
 * Mientras se arma el formulario público: esqueleto neutro (todavía no se sabe de qué empresa es).
 *
 * Sin JavaScript el formulario ya armado nunca reemplaza al esqueleto (Next lo cambia con un script), así
 * que el aviso de «activa JavaScript» tiene que estar AQUÍ para que se vea.
 */
export default function Loading() {
  return (
    <div className="customer-light min-h-dvh">
      <main className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-10">
        <noscript>
          <p
            data-testid="intake-noscript"
            className="mb-4 rounded-md bg-danger-soft p-3 text-sm text-danger"
          >
            Para enviar este formulario necesitas activar JavaScript.
          </p>
        </noscript>
        <SkeletonRegion className="rounded-lg border border-border bg-surface p-5 shadow-2 sm:p-8">
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </SkeletonRegion>
      </main>
    </div>
  );
}
