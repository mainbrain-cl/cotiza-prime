import { HeaderSkeleton, ListSkeleton, SkeletonRegion } from "@/components/ui/skeleton";

/** Cargando la lista de solicitudes. */
export default function Loading() {
  return (
    <SkeletonRegion>
      <HeaderSkeleton />
      <ListSkeleton rows={5} columns={4} />
    </SkeletonRegion>
  );
}
