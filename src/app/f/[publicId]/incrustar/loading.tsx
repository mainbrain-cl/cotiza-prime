import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";

/** Mientras se arma el formulario incrustado: esqueleto neutro, sin alto de pantalla completa ni fondo propio. */
export default function Loading() {
  return (
    <div className="customer-light">
      <style>{`html,body{background:transparent!important;height:auto!important;min-height:0!important;color-scheme:light}`}</style>
      <main className="mx-auto w-full max-w-2xl py-2">
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
        </SkeletonRegion>
      </main>
    </div>
  );
}
