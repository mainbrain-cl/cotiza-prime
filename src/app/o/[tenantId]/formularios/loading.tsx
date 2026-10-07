import { HeaderSkeleton, ListSkeleton, SkeletonRegion } from "@/components/ui/skeleton";

/** Cargando la lista de formularios. */
export default function Loading() {
  return (
    <SkeletonRegion>
      <HeaderSkeleton action />
      <ListSkeleton rows={4} columns={4} />
    </SkeletonRegion>
  );
}
