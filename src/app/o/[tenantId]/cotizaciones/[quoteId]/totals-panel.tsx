import type { ReactNode } from "react";
import { formatClp } from "@/lib/money/clp";
import { formatTaxRate } from "@/lib/quotes/format";

/** Lo que muestra el panel de totales (§3.2): cuadra al peso, Subtotal − descuento global + IVA = Total. */
export type TotalsView = {
  subtotalClp: number;
  globalDiscountClp: number;
  netTaxableClp: number;
  netExemptClp: number;
  taxClp: number;
  totalClp: number;
  /** Informativo: suma de los descuentos de línea más el descuento global. */
  appliedDiscountsClp: number;
  taxRateBp: number;
};

function Row({
  label,
  value,
  testId,
  strong,
}: {
  label: ReactNode;
  value: string;
  testId: string;
  strong?: boolean;
}) {
  return (
    <div
      className={
        strong
          ? "flex items-baseline justify-between gap-3 text-lg font-semibold"
          : "flex items-baseline justify-between gap-3"
      }
    >
      <dt className={strong ? "text-fg" : "text-fg-muted"}>{label}</dt>
      <dd data-testid={testId} className="text-fg tabular-nums">
        {value}
      </dd>
    </div>
  );
}

/** Panel de totales. Sin totales (hay datos por corregir), muestra guiones y no inventa un monto. */
export function TotalsPanel({
  totals,
  children,
}: {
  totals: TotalsView | null;
  /** Control del descuento global (solo en el editor). */
  children?: ReactNode;
}) {
  const show = (value: (t: TotalsView) => number) => (totals ? formatClp(value(totals)) : "—");
  return (
    <section
      aria-label="Totales de la cotización"
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
    >
      <h2 className="text-lg">Totales</h2>
      {children}
      <dl className="flex flex-col gap-2 text-sm md:text-base" data-testid="totals">
        <Row label="Subtotal" value={show((t) => t.subtotalClp)} testId="total-subtotal" />
        <Row
          label="Descuento global"
          value={totals ? `−${formatClp(totals.globalDiscountClp)}` : "—"}
          testId="total-global-discount"
        />
        <Row label="Neto afecto" value={show((t) => t.netTaxableClp)} testId="total-net-taxable" />
        {totals === null || totals.netExemptClp > 0 ? (
          <Row label="Exento" value={show((t) => t.netExemptClp)} testId="total-exempt" />
        ) : null}
        <Row
          label={`IVA ${totals ? formatTaxRate(totals.taxRateBp) : ""}`.trim()}
          value={show((t) => t.taxClp)}
          testId="total-tax"
        />
        <div className="my-1 border-t border-border" />
        <Row label="Total" value={show((t) => t.totalClp)} testId="total-total" strong />
      </dl>
      <p className="text-sm text-fg-subtle" data-testid="total-applied-discounts">
        Descuentos aplicados: {totals ? formatClp(totals.appliedDiscountsClp) : "—"}
      </p>
    </section>
  );
}
