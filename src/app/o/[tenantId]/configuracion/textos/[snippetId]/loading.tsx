import { BackHeaderSkeleton, FormSkeleton, SkeletonRegion } from "@/components/ui/skeleton";

/** Cargando «Editar texto»: volver, título y los campos. */
export default function Loading() {
  return (
    <SkeletonRegion className="max-w-5xl">
      <BackHeaderSkeleton />
      <FormSkeleton fields={4} />
    </SkeletonRegion>
  );
}
