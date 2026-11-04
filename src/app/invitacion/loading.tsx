import { AuthCard } from "@/components/auth/auth-card";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";

/** Mientras se abre la invitación: un esqueleto neutro (todavía no se sabe de qué organización es). */
export default function Loading() {
  return (
    <AuthCard title="Abriendo tu invitación…">
      <SkeletonRegion className="flex flex-col gap-3">
        <Skeleton className="h-6 w-4/5" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-12 w-full" />
      </SkeletonRegion>
    </AuthCard>
  );
}
