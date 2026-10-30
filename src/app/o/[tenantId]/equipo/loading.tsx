import {
  FormSkeleton,
  HeaderSkeleton,
  ListSkeleton,
  SkeletonRegion,
} from "@/components/ui/skeleton";

/** Cargando «Tu equipo»: el título, la lista de invitaciones y el formulario de invitar. */
export default function Loading() {
  return (
    <SkeletonRegion>
      <HeaderSkeleton />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <ListSkeleton rows={3} columns={3} />
        <FormSkeleton fields={3} />
      </div>
    </SkeletonRegion>
  );
}
