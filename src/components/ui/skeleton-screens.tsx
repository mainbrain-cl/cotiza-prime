import {
  BackHeaderSkeleton,
  DetailSkeleton,
  FormSkeleton,
  HeaderSkeleton,
  ListSkeleton,
  SearchSkeleton,
  Skeleton,
  SkeletonRegion,
} from "@/components/ui/skeleton";

/** Esqueletos con la forma de cada pantalla de una organización (se usan desde cada `loading.tsx`). */

/** Inicio y pantallas sin forma propia: título, las cuatro tarjetas del resumen y un panel. */
export function PanelScreenSkeleton() {
  return (
    <SkeletonRegion>
      <HeaderSkeleton />
      <div className="grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-32 w-full rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-40 w-full rounded-lg md:h-56" />
    </SkeletonRegion>
  );
}

/** Lista de clientes: título con botón, búsqueda y tabla (tarjetas en teléfono). */
export function CustomersListSkeleton() {
  return (
    <SkeletonRegion>
      <HeaderSkeleton action />
      <SearchSkeleton />
      <ListSkeleton rows={6} columns={5} />
    </SkeletonRegion>
  );
}

/** Ficha de un cliente. */
export function CustomerDetailSkeleton() {
  return (
    <SkeletonRegion className="max-w-3xl">
      <BackHeaderSkeleton />
      <DetailSkeleton items={6} />
    </SkeletonRegion>
  );
}

/** Pantallas con un formulario (nuevo cliente, editar, empresa, marca, numeración, servicio). */
export function FormScreenSkeleton({ fields = 5 }: { fields?: number }) {
  return (
    <SkeletonRegion className="max-w-2xl">
      <BackHeaderSkeleton />
      <FormSkeleton fields={fields} />
    </SkeletonRegion>
  );
}

/** Catálogo: búsqueda, filtros y lista a la izquierda; formulario de alta a la derecha en escritorio. */
export function CatalogSkeleton() {
  return (
    <SkeletonRegion>
      <HeaderSkeleton />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] 2xl:grid-cols-[minmax(0,1fr)_28rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Skeleton className="h-11 w-full md:h-10" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-24 rounded-full" />
            <Skeleton className="h-9 w-28 rounded-full" />
            <Skeleton className="h-9 w-20 rounded-full" />
          </div>
          <ListSkeleton rows={5} columns={4} />
        </div>
        <div className="hidden rounded-lg border border-border bg-surface p-6 shadow-1 lg:block">
          <FormSkeleton fields={4} />
        </div>
      </div>
    </SkeletonRegion>
  );
}

/** Índice de configuración: una fila por sección. */
export function SettingsIndexSkeleton() {
  return (
    <SkeletonRegion className="max-w-2xl">
      <HeaderSkeleton />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }, (_, index) => (
          <div
            key={index}
            className="flex items-center gap-4 rounded-lg border border-border bg-surface px-4 py-4 shadow-1"
          >
            <Skeleton className="size-10 shrink-0 rounded-md" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/** Lista de cotizaciones: título con botón y tabla (tarjetas en teléfono). */
export function QuotesListSkeleton() {
  return (
    <SkeletonRegion>
      <HeaderSkeleton action />
      <ListSkeleton rows={6} columns={5} />
    </SkeletonRegion>
  );
}

/** Registro de actividad: volver, título, filtros y tabla (tarjetas en teléfono). */
export function AuditLogSkeleton() {
  return (
    <SkeletonRegion>
      <BackHeaderSkeleton />
      <div className="flex flex-wrap gap-3">
        <Skeleton className="h-11 w-full md:h-10 md:w-56" />
        <Skeleton className="h-11 w-full md:h-10 md:w-72" />
        <Skeleton className="h-11 w-24 md:h-9" />
      </div>
      <ListSkeleton rows={8} columns={5} />
    </SkeletonRegion>
  );
}

/** Nueva cotización: volver, título y el selector de cliente (búsqueda y lista corta). */
export function NewQuoteSkeleton() {
  return (
    <SkeletonRegion className="max-w-3xl">
      <BackHeaderSkeleton />
      <SearchSkeleton />
      <ListSkeleton rows={4} columns={3} />
    </SkeletonRegion>
  );
}

/** Editor de una cotización: líneas a la izquierda; panel de totales a la derecha en escritorio. */
export function QuoteEditorSkeleton() {
  return (
    <SkeletonRegion>
      <BackHeaderSkeleton />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Skeleton className="h-16 w-full rounded-lg" />
          {Array.from({ length: 3 }, (_, index) => (
            <div
              key={index}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-1"
            >
              <Skeleton className="h-5 w-2/3" />
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            </div>
          ))}
          <Skeleton className="h-11 w-48 rounded-md" />
        </div>
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5 shadow-1">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-8 w-40" />
        </div>
      </div>
    </SkeletonRegion>
  );
}
