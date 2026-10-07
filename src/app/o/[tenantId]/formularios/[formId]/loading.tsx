import {
  BackHeaderSkeleton,
  FormSkeleton,
  Skeleton,
  SkeletonRegion,
} from "@/components/ui/skeleton";

/** Cargando el editor del formulario. */
export default function Loading() {
  return (
    <SkeletonRegion>
      <BackHeaderSkeleton />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem] 2xl:grid-cols-[minmax(0,1fr)_32rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <div className="rounded-lg border border-border bg-surface p-5 shadow-1">
            <FormSkeleton fields={4} />
          </div>
          <div className="rounded-lg border border-border bg-surface p-5 shadow-1">
            <FormSkeleton fields={3} />
          </div>
        </div>
        <Skeleton className="h-96 w-full rounded-lg" />
      </div>
    </SkeletonRegion>
  );
}
