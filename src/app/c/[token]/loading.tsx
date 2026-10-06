import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";

/** Mientras se arma la cotización del cliente: esqueleto neutro (todavía no se sabe de qué empresa es). */
export default function Loading() {
  return (
    <div className="customer-light min-h-dvh">
      <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        <SkeletonRegion className="rounded-lg border border-border bg-surface p-5 shadow-2 sm:p-8">
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-8 w-28" />
          </div>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="ml-auto h-24 w-full sm:w-72" />
        </SkeletonRegion>
      </main>
    </div>
  );
}
