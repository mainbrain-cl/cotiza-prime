"use client";

import { ChevronDown, ChevronUp, Loader2, Plus, Save, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormAlert, Input, Select } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { TAX_TREATMENTS, unitLabel } from "@/lib/catalog/schemas";
import { formatClp } from "@/lib/money/clp";
import {
  saveQuoteDraftAction,
  searchQuoteCatalogAction,
  type SaveQuoteResult,
} from "@/lib/quotes/actions";
import type { QuotableCatalogItem } from "@/lib/quotes/catalog-source";
import { QUOTE_MAX_LINES } from "@/lib/quotes/calc";
import {
  contentKey,
  evaluateEditor,
  moveLine,
  newCatalogLine,
  newFreeLine,
  type DiscountKind,
  type EditorLine,
  type EditorState,
} from "@/lib/quotes/editor-model";
import type { SaveQuotePayload } from "@/lib/quotes/schemas";
import { cn } from "@/lib/utils";
import { TotalsPanel, type TotalsView } from "./totals-panel";
import { useQuoteSaver } from "./use-quote-saver";

const SEARCH_DELAY_MS = 250;
const DISCOUNT_KINDS: { value: DiscountKind; label: string }[] = [
  { value: "none", label: "Sin descuento" },
  { value: "percent", label: "Porcentaje (%)" },
  { value: "amount", label: "Monto ($)" },
];
const taxLabel = (value: string) => TAX_TREATMENTS.find((t) => t.value === value)?.label ?? value;

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm text-danger">
      {message}
    </p>
  );
}

export function QuoteEditor({
  tenantId,
  quoteId,
  initialState,
  initialRevision,
  taxRateBp,
  initialCatalog,
}: {
  tenantId: string;
  quoteId: string;
  initialState: EditorState;
  initialRevision: number;
  taxRateBp: number;
  initialCatalog: QuotableCatalogItem[];
}) {
  const [state, setState] = useState<EditorState>(initialState);
  const [catalog, setCatalog] = useState<QuotableCatalogItem[]>(initialCatalog);
  const [catalogTerm, setCatalogTerm] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const searchTimer = useRef<number | undefined>(undefined);

  const view = useMemo(() => evaluateEditor(state, taxRateBp), [state, taxRateBp]);
  const [initialKey] = useState(() => {
    const initial = evaluateEditor(initialState, taxRateBp);
    return initial.content ? contentKey(initial.content) : "";
  });

  const save = useCallback(
    (payload: SaveQuotePayload): Promise<SaveQuoteResult> =>
      saveQuoteDraftAction(tenantId, quoteId, payload),
    [tenantId, quoteId],
  );
  const saver = useQuoteSaver({ initialRevision, initialSavedKey: initialKey, save });

  const currentKey = view.content ? contentKey(view.content) : null;
  const dirty = currentKey === null || currentKey !== saver.savedKey;
  const hasErrors = Object.keys(view.errors).length > 0;
  const blocked = saver.state.status === "conflict" || saver.state.status === "not_editable";

  // Avisa antes de cerrar la pestaña con cambios sin guardar.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => () => window.clearTimeout(searchTimer.current), []);

  function updateLine(index: number, patch: Partial<EditorLine>) {
    setState((current) => ({
      ...current,
      lines: current.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    }));
  }

  function addLine(line: EditorLine, message: string) {
    setState((current) =>
      current.lines.length >= QUOTE_MAX_LINES
        ? current
        : { ...current, lines: [...current.lines, line] },
    );
    setAnnouncement(message);
  }

  function onCatalogSearch(value: string) {
    setCatalogTerm(value);
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(async () => {
      try {
        setCatalog(await searchQuoteCatalogAction(tenantId, value));
      } catch {
        // Sin conexión: se queda la lista anterior.
      }
    }, SEARCH_DELAY_MS);
  }

  function removeLine(index: number) {
    const name = state.lines[index]?.name.trim() || `línea ${index + 1}`;
    setState((current) => ({ ...current, lines: current.lines.filter((_, i) => i !== index) }));
    setAnnouncement(`Se quitó ${name}.`);
  }

  function move(index: number, direction: -1 | 1) {
    setState((current) => ({ ...current, lines: moveLine(current.lines, index, direction) }));
    setAnnouncement(`Línea ${index + 1} movida a la posición ${index + 1 + direction}.`);
  }

  const totals = view.totals;
  const totalsView: TotalsView | null = totals
    ? {
        subtotalClp: totals.subtotalClp,
        globalDiscountClp: totals.globalDiscountClp,
        netTaxableClp: totals.netTaxableClp,
        netExemptClp: totals.netExemptClp,
        taxClp: totals.taxClp,
        totalClp: totals.totalClp,
        appliedDiscountsClp: totals.lineDiscountsClp + totals.globalDiscountClp,
        taxRateBp,
      }
    : null;

  const saverMessage =
    saver.state.status === "idle" ||
    saver.state.status === "saving" ||
    saver.state.status === "saved"
      ? null
      : saver.state.message;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]" data-testid="quote-editor">
      <div className="flex min-w-0 flex-col gap-6">
        <OfflineNotice />
        {saverMessage ? (
          <FormAlert>
            {saverMessage}
            {saver.state.status === "conflict" ? (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="font-semibold underline underline-offset-4"
                >
                  Recargar ahora
                </button>
              </>
            ) : null}
          </FormAlert>
        ) : null}

        <section
          aria-label="Agregar servicios"
          className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
        >
          <h2 className="text-lg">Agregar servicios</h2>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle"
            />
            <Input
              type="search"
              aria-label="Buscar en tu catálogo"
              placeholder="Buscar en tu catálogo"
              autoComplete="off"
              value={catalogTerm}
              onChange={(event) => onCatalogSearch(event.target.value)}
              className="pl-9"
              disabled={blocked}
            />
          </div>
          {catalog.length === 0 ? (
            <p className="text-sm text-fg-muted" data-testid="catalog-empty">
              {catalogTerm.trim() === ""
                ? "Tu catálogo no tiene servicios activos. Puedes agregar una línea libre."
                : "No encontramos servicios con ese nombre."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="catalog-results">
              {catalog.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-sm border border-border p-3"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-semibold text-fg">{item.name}</span>
                    <span className="text-sm text-fg-muted">
                      {formatClp(item.unitPriceClp)} · {unitLabel(item.unit)} ·{" "}
                      {taxLabel(item.taxTreatment)}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={blocked || state.lines.length >= QUOTE_MAX_LINES}
                    aria-label={`Agregar ${item.name}`}
                    onClick={() =>
                      addLine(newCatalogLine(crypto.randomUUID(), item), `Se agregó ${item.name}.`)
                    }
                  >
                    <Plus aria-hidden />
                    Agregar
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button
              type="button"
              variant="ghost"
              disabled={blocked || state.lines.length >= QUOTE_MAX_LINES}
              onClick={() =>
                addLine(newFreeLine(crypto.randomUUID()), "Se agregó una línea libre.")
              }
            >
              <Plus aria-hidden />
              Agregar línea libre
            </Button>
          </div>
        </section>

        <section aria-label="Líneas de la cotización" className="flex flex-col gap-3">
          <h2 className="text-lg">Líneas</h2>
          {state.lines.length === 0 ? (
            <p
              data-testid="no-lines"
              className="rounded-lg border border-dashed border-border-strong bg-surface p-6 text-center text-fg-muted"
            >
              Aún no hay líneas. Agrega un servicio de tu catálogo o una línea libre.
            </p>
          ) : (
            <ol className="flex flex-col gap-3">
              {state.lines.map((line, index) => {
                const err = (field: string) => view.errors[`items.${index}.${field}`];
                const lineTotal = totals?.lines[index]?.totalClp;
                const fromCatalog = line.catalogItemId !== null;
                const idFor = (field: string) => `${line.id}-${field}`;
                return (
                  <li
                    key={line.id}
                    data-testid="quote-line"
                    className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-1"
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <label htmlFor={idFor("name")} className="text-sm font-semibold text-fg">
                          Nombre de la línea {index + 1}
                        </label>
                        <Input
                          id={idFor("name")}
                          value={line.name}
                          onChange={(event) => updateLine(index, { name: event.target.value })}
                          aria-invalid={Boolean(err("name"))}
                          aria-describedby={err("name") ? idFor("name-error") : undefined}
                          autoComplete="off"
                          disabled={blocked}
                        />
                        <FieldError id={idFor("name-error")} message={err("name")} />
                      </div>
                      <div className="mt-6 flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Subir la línea ${index + 1}`}
                          disabled={blocked || index === 0}
                          onClick={() => move(index, -1)}
                        >
                          <ChevronUp aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Bajar la línea ${index + 1}`}
                          disabled={blocked || index === state.lines.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          <ChevronDown aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="danger"
                          size="icon-sm"
                          aria-label={`Quitar la línea ${index + 1}`}
                          disabled={blocked}
                          onClick={() => removeLine(index)}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label
                        htmlFor={idFor("description")}
                        className="text-sm font-semibold text-fg"
                      >
                        Detalle (opcional)
                      </label>
                      <Input
                        id={idFor("description")}
                        value={line.description}
                        onChange={(event) => updateLine(index, { description: event.target.value })}
                        aria-invalid={Boolean(err("description"))}
                        autoComplete="off"
                        disabled={blocked}
                      />
                      <FieldError id={idFor("description-error")} message={err("description")} />
                    </div>

                    <div className="grid grid-cols-2 gap-3 md:grid-cols-[110px_1fr_1fr_1fr]">
                      <div className="flex flex-col gap-1.5">
                        <label
                          htmlFor={idFor("quantity")}
                          className="text-sm font-semibold text-fg"
                        >
                          Cantidad
                        </label>
                        <Input
                          id={idFor("quantity")}
                          inputMode="decimal"
                          value={line.quantity}
                          onChange={(event) => updateLine(index, { quantity: event.target.value })}
                          aria-invalid={Boolean(err("quantity"))}
                          aria-describedby={err("quantity") ? idFor("quantity-error") : undefined}
                          autoComplete="off"
                          disabled={blocked}
                          className="tabular-nums"
                        />
                        <FieldError id={idFor("quantity-error")} message={err("quantity")} />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor={idFor("price")} className="text-sm font-semibold text-fg">
                          Precio unitario (neto)
                        </label>
                        <Input
                          id={idFor("price")}
                          inputMode="numeric"
                          value={line.price}
                          onChange={(event) => updateLine(index, { price: event.target.value })}
                          aria-invalid={Boolean(err("price"))}
                          aria-describedby={err("price") ? idFor("price-error") : undefined}
                          autoComplete="off"
                          disabled={blocked}
                          className="tabular-nums"
                        />
                        <FieldError id={idFor("price-error")} message={err("price")} />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor={idFor("unit")} className="text-sm font-semibold text-fg">
                          Unidad
                        </label>
                        {fromCatalog ? (
                          <p id={idFor("unit")} className="flex h-10 items-center text-fg">
                            {unitLabel(line.unit)}
                          </p>
                        ) : (
                          <Select
                            id={idFor("unit")}
                            value={line.unit}
                            onChange={(event) => updateLine(index, { unit: event.target.value })}
                            disabled={blocked}
                          >
                            {["service", "hour", "km", "m2", "day", "unit"].map((value) => (
                              <option key={value} value={value}>
                                {unitLabel(value)}
                              </option>
                            ))}
                          </Select>
                        )}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor={idFor("tax")} className="text-sm font-semibold text-fg">
                          IVA
                        </label>
                        {fromCatalog ? (
                          <p id={idFor("tax")} className="flex h-10 items-center text-fg">
                            {taxLabel(line.taxTreatment)}
                          </p>
                        ) : (
                          <Select
                            id={idFor("tax")}
                            value={line.taxTreatment}
                            onChange={(event) =>
                              updateLine(index, {
                                taxTreatment: event.target.value as "taxable" | "exempt",
                              })
                            }
                            disabled={blocked}
                          >
                            {TAX_TREATMENTS.map((tax) => (
                              <option key={tax.value} value={tax.value}>
                                {tax.label}
                              </option>
                            ))}
                          </Select>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 md:grid-cols-[1fr_1fr_1fr]">
                      <div className="flex flex-col gap-1.5">
                        <label
                          htmlFor={idFor("discount-kind")}
                          className="text-sm font-semibold text-fg"
                        >
                          Descuento
                        </label>
                        <Select
                          id={idFor("discount-kind")}
                          value={line.discountKind}
                          onChange={(event) =>
                            updateLine(index, {
                              discountKind: event.target.value as DiscountKind,
                              discount: "",
                            })
                          }
                          disabled={blocked}
                        >
                          {DISCOUNT_KINDS.map((kind) => (
                            <option key={kind.value} value={kind.value}>
                              {kind.label}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label
                          htmlFor={idFor("discount")}
                          className="text-sm font-semibold text-fg"
                        >
                          {line.discountKind === "percent" ? "Porcentaje" : "Monto del descuento"}
                        </label>
                        <Input
                          id={idFor("discount")}
                          inputMode="decimal"
                          value={line.discount}
                          onChange={(event) => updateLine(index, { discount: event.target.value })}
                          disabled={blocked || line.discountKind === "none"}
                          aria-invalid={Boolean(err("discount"))}
                          aria-describedby={err("discount") ? idFor("discount-error") : undefined}
                          autoComplete="off"
                          className="tabular-nums"
                        />
                        <FieldError id={idFor("discount-error")} message={err("discount")} />
                      </div>
                      <div className="col-span-2 flex flex-col gap-1.5 md:col-span-1">
                        <span className="text-sm font-semibold text-fg">Total de la línea</span>
                        <output
                          data-testid="line-total"
                          className="flex h-10 items-center text-lg font-semibold text-fg tabular-nums"
                        >
                          {lineTotal === undefined ? "—" : formatClp(lineTotal)}
                        </output>
                      </div>
                    </div>
                    {line.catalogInactive ? (
                      <p className="text-sm text-fg-muted">Ya no está en el catálogo.</p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
        </section>
      </div>

      <aside className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
        <TotalsPanel totals={totalsView}>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="global-discount-kind" className="text-sm font-semibold text-fg">
                Descuento global
              </label>
              <Select
                id="global-discount-kind"
                value={state.globalDiscountKind}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    globalDiscountKind: event.target.value as DiscountKind,
                    globalDiscount: "",
                  }))
                }
                disabled={blocked}
              >
                {DISCOUNT_KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="global-discount" className="text-sm font-semibold text-fg">
                {state.globalDiscountKind === "percent" ? "Porcentaje" : "Monto"}
              </label>
              <Input
                id="global-discount"
                inputMode="decimal"
                value={state.globalDiscount}
                onChange={(event) =>
                  setState((current) => ({ ...current, globalDiscount: event.target.value }))
                }
                disabled={blocked || state.globalDiscountKind === "none"}
                aria-invalid={Boolean(view.errors.globalDiscount)}
                aria-describedby={view.errors.globalDiscount ? "global-discount-error" : undefined}
                autoComplete="off"
                className="tabular-nums"
              />
            </div>
            <div className="col-span-2">
              <FieldError id="global-discount-error" message={view.errors.globalDiscount} />
            </div>
          </div>
        </TotalsPanel>

        {view.errors.form ? <FormAlert>{view.errors.form}</FormAlert> : null}

        <div className="flex flex-col gap-2">
          <Button
            type="button"
            size="lg"
            data-testid="save-quote"
            disabled={saver.saving || blocked || view.content === null}
            aria-disabled={saver.saving || blocked || view.content === null}
            onClick={() => {
              if (view.content) void saver.run(view.content);
            }}
          >
            {saver.saving ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                Guardando…
              </>
            ) : (
              <>
                <Save aria-hidden />
                Guardar cotización
              </>
            )}
          </Button>
          <p
            role="status"
            data-testid="save-status"
            className={cn("text-sm", dirty || hasErrors ? "text-fg-muted" : "text-success")}
          >
            {saver.saving
              ? "Guardando…"
              : hasErrors
                ? "Corrige los datos marcados para poder guardar."
                : dirty
                  ? "Hay cambios sin guardar."
                  : "Guardado."}
          </p>
        </div>
      </aside>
    </div>
  );
}
