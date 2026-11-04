import { HeaderSkeleton, ListSkeleton, SkeletonRegion } from "@/components/ui/skeleton";

/** Cargando «Textos listos»: el título con su botón y las tarjetas de textos. */
export default function Loading() {
  return (
    <SkeletonRegion className="max-w-3xl">
      <HeaderSkeleton action />
      <ListSkeleton rows={4} columns={3} />
    </SkeletonRegion>
  );
}
