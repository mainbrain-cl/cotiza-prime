import {
  BackHeaderSkeleton,
  FormSkeleton,
  Skeleton,
  SkeletonRegion,
} from "@/components/ui/skeleton";

/** Cargando el detalle de una solicitud. */
export default function Loading() {
  return (
    <SkeletonRegion>
      <BackHeaderSkeleton />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="rounded-lg border border-border bg-surface p-5 shadow-1">
          <FormSkeleton fields={5} />
        </div>
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    </SkeletonRegion>
  );
}
