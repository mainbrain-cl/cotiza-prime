import { ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import {
  COUNTER_LABELS,
  type CounterTotals,
  type ProtectionSummary,
} from "@/lib/intake/protection-model";

/**
 * Piezas de «Protección contra abusos» (H-092). Solo cuentas: ninguna de estas piezas recibe ni muestra un
 * nombre, un correo, una dirección de conexión ni el identificador público de un formulario.
 */

const PERIODS: readonly { id: "today" | "last7" | "last30"; label: string }[] = [
  { id: "today", label: "Hoy" },
  { id: "last7", label: "Últimos 7 días" },
  { id: "last30", label: "Últimos 30 días" },
];

function Stats({ period, totals }: { period: string; totals: CounterTotals }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
      {COUNTER_LABELS.map((counter) => (
        <div key={counter.key} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs font-semibold text-fg-muted">{counter.label}</dt>
          <dd
            data-testid={`protection-${period}-${counter.key}`}
            className="text-lg font-semibold text-fg tabular-nums"
          >
            {totals[counter.key]}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Los contadores de hoy y de los últimos 7 y 30 días. Con todo en cero muestra el estado vacío. */
export function ProtectionCounters({
  summary,
  emptyText,
}: {
  summary: ProtectionSummary;
  emptyText: string;
}) {
  const empty = summary.last30.accepted === 0 && summary.last30.blockedTotal === 0;
  if (empty) {
    return (
      <p
        data-testid="protection-empty"
        className="rounded-md border border-dashed border-border-strong p-4 text-sm text-fg-muted"
      >
        {emptyText}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4" data-testid="protection-counters">
      {PERIODS.map((period) => (
        <section
          key={period.id}
          aria-label={period.label}
          className="flex flex-col gap-2 rounded-md bg-surface-2 p-3"
        >
          <h3 className="text-sm font-semibold text-fg">
            {period.label}{" "}
            <span className="font-normal text-fg-muted">
              ·{" "}
              <span data-testid={`protection-${period.id}-blocked`}>
                {summary[period.id].blockedTotal}
              </span>{" "}
              {summary[period.id].blockedTotal === 1 ? "bloqueado" : "bloqueados"}
            </span>
          </h3>
          <Stats period={period.id} totals={summary[period.id]} />
        </section>
      ))}
    </div>
  );
}

/** Qué protege cada defensa, en lenguaje simple. Sin cifras por conexión ni detalles de cómo se detecta un robot. */
export function ProtectionExplainer() {
  return (
    <details
      data-testid="protection-explainer"
      className="rounded-md border border-border p-3 text-sm text-fg-muted"
    >
      <summary className="min-h-11 cursor-pointer text-sm font-semibold text-fg md:min-h-0">
        ¿Qué protege tu formulario?
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        <li>
          <span className="font-semibold text-fg">Verificación anti-robot.</span> Antes de guardar
          una solicitud se comprueba que la envíe una persona. Si no lo parece, se descarta y no se
          guarda nada.
        </li>
        <li>
          <span className="font-semibold text-fg">Límite de envíos seguidos.</span> Desde una misma
          conexión no se aceptan muchos envíos en poco tiempo. Quien llega al límite ve un mensaje
          para esperar unos minutos. El panel cuenta cada conexión frenada, no cada intento
          siguiente.
        </li>
        <li>
          <span className="font-semibold text-fg">Tope diario.</span> Cada formulario recibe como
          máximo cierta cantidad de solicitudes al día, y tu organización tiene un tope para todos
          sus formularios juntos. Al llegar, se te avisa por correo.
        </li>
        <li>
          <span className="font-semibold text-fg">Revisión de los datos.</span> Lo que no calza con
          el formulario (datos vacíos, textos raros) se rechaza antes de guardarse.
        </li>
        <li>
          Si igual te llega basura, descártala como spam y, si se repite, crea un enlace nuevo para
          el formulario.
        </li>
      </ul>
    </details>
  );
}

/** Marco de la sección, con su título. */
export function ProtectionShell({
  id = "protection",
  testId = "protection-panel",
  description,
  children,
}: {
  id?: string;
  /** El esqueleto de carga usa otro, para que no se confunda con el panel real mientras la página se arma. */
  testId?: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="flex items-center gap-2 text-lg">
          <ShieldCheck aria-hidden className="size-5 text-accent" strokeWidth={1.75} />
          Protección contra abusos
        </h2>
        <p className="text-sm text-fg-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function ProtectionError() {
  return (
    <p
      role="alert"
      data-testid="protection-error"
      className="rounded-sm bg-danger-soft px-3 py-2.5 text-sm font-medium text-danger"
    >
      No pudimos cargar los contadores. Recarga la página en unos minutos.
    </p>
  );
}

/** Estado de carga mientras se leen los contadores. */
export function ProtectionSkeleton() {
  return (
    <ProtectionShell testId="protection-skeleton" description="Cargando los contadores…">
      <div role="status" aria-label="Cargando protección" className="flex flex-col gap-3">
        {[0, 1, 2].map((n) => (
          <div key={n} className="h-20 animate-pulse rounded-md bg-surface-2" />
        ))}
      </div>
    </ProtectionShell>
  );
}
