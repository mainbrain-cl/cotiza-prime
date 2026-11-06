import { HeaderSkeleton, ListSkeleton, SkeletonRegion } from "@/components/ui/skeleton";

/** Cargando la ficha de un miembro: el título y su tarjeta de datos. */
export default function Loading() {
  return (
    <SkeletonRegion>
      <HeaderSkeleton />
      <ListSkeleton rows={1} columns={3} />
    </SkeletonRegion>
  );
}
