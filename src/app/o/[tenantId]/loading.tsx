/** Estado "cargando" de las pantallas de una organización: esqueleto con la forma de una lista. */
export default function TenantLoading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col gap-6">
      <span className="sr-only">Cargando…</span>
      <div aria-hidden className="flex flex-col gap-2">
        <div className="h-8 w-48 animate-pulse rounded-sm bg-surface-2 motion-reduce:animate-none" />
        <div className="h-5 w-72 max-w-full animate-pulse rounded-sm bg-surface-2 motion-reduce:animate-none" />
      </div>
      <div
        aria-hidden
        className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-1"
      >
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2 px-4 py-4">
            <div className="h-5 w-1/3 animate-pulse rounded-sm bg-surface-2 motion-reduce:animate-none" />
            <div className="h-4 w-2/3 animate-pulse rounded-sm bg-surface-2 motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </div>
  );
}
