import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Bloque de carga. Con "reducir movimiento" queda quieto (no pulsa). */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-sm bg-surface-2 motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

/** Contenedor de un esqueleto: avisa a los lectores de pantalla una sola vez. */
export function SkeletonRegion({ className, children }: ComponentProps<"div">) {
  return (
    <div role="status" aria-busy="true" className={cn("flex flex-col gap-6", className)}>
      <span className="sr-only">Cargando…</span>
      {children}
    </div>
  );
}

/** Título y subtítulo de una pantalla, con o sin botón a la derecha. */
export function HeaderSkeleton({ action = false }: { action?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-5 w-72 max-w-full" />
      </div>
      {action ? <Skeleton className="h-11 w-36 md:h-9" /> : null}
    </div>
  );
}

/** Campo de búsqueda (etiqueta, caja y ayuda). */
export function SearchSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-4 w-32" />
      <div className="flex gap-2">
        <Skeleton className="h-11 flex-1 md:h-10" />
        <Skeleton className="h-11 w-24 md:h-9" />
      </div>
    </div>
  );
}

/** Lista: tarjetas en teléfono y tabla con encabezado desde tableta, como las pantallas reales. */
export function ListSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <>
      <ul className="flex flex-col gap-3 md:hidden">
        {Array.from({ length: Math.min(rows, 4) }, (_, index) => (
          <li
            key={index}
            className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 shadow-1"
          >
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </li>
        ))}
      </ul>
      <div className="hidden overflow-hidden rounded-lg border border-border bg-surface shadow-1 md:block">
        <div className="flex gap-6 bg-surface-2 px-4 py-3">
          {Array.from({ length: columns }, (_, index) => (
            <Skeleton key={index} className="h-4 flex-1 bg-border" />
          ))}
        </div>
        <div className="divide-y divide-border">
          {Array.from({ length: rows }, (_, index) => (
            <div key={index} className="flex gap-6 px-4 py-3.5">
              {Array.from({ length: columns }, (_, column) => (
                <Skeleton key={column} className={cn("h-4 flex-1", column === 0 && "max-w-48")} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** Formulario: etiquetas y campos apilados, y el botón de guardar. */
export function FormSkeleton({ fields = 4 }: { fields?: number }) {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: fields }, (_, index) => (
        <div key={index} className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-11 w-full md:h-10" />
        </div>
      ))}
      <Skeleton className="h-12 w-40 md:h-11" />
    </div>
  );
}

/** Ficha de detalle: panel con pares de etiqueta y valor. */
export function DetailSkeleton({ items = 6 }: { items?: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6">
      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        {Array.from({ length: items }, (_, index) => (
          <div key={index} className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-5 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Enlace de "volver" más título, para las pantallas de detalle y de formulario. */
export function BackHeaderSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-5 w-28" />
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-5 w-80 max-w-full" />
    </div>
  );
}
