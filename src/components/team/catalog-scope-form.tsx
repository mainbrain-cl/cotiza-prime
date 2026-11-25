"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FormAlert, Input } from "@/components/ui/form-controls";
import { OfflineNotice, useOnline } from "@/components/ui/offline-notice";
import { formatDate } from "@/lib/format-date";
import { formatClp } from "@/lib/money/clp";
import { saveCatalogScopeAction } from "@/lib/team/catalog-scope-actions";
import { SCOPE_CATALOG_LIMIT } from "@/lib/team/catalog-scope-model";
import {
  CATALOG_SCOPE_MAX_ITEMS,
  CATALOG_SCOPE_UNCHANGED_MESSAGE,
  filterCatalog,
  savedMessage,
  scopeProblem,
  scopeSummary,
  selectVisible,
  toggleSelection,
  type CatalogScopeMode,
  type CatalogScopeRecord,
  type ScopeCatalogItem,
} from "@/lib/team/catalog-scope-model";
import { tenantPath } from "@/lib/tenant/constants";
import { cn } from "@/lib/utils";

const SAVED_TOAST_ID = "member-catalog-scope-saved";
const OFFLINE_FAILURE =
  "No pudimos comunicarnos con el servidor. Revisa tu conexión; lo que elegiste sigue aquí.";
const HAND_WRITTEN_NOTE = "Las líneas escritas a mano no se limitan.";

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((id) => b.has(id));

/**
 * «Servicios que puede cotizar» en la ficha de un Comercial (H-042): todos los servicios del catálogo o solo los que se elijan. Lo
 * cambian quienes manejan el equipo; la base lo exige al guardar una línea nueva del catálogo (esta pantalla solo lo ordena). Es una
 * pantalla de trabajo: superficie sólida, sin vidrio.
 */
export function CatalogScopeForm({
  tenantId,
  memberId,
  memberName,
  initial,
  catalog,
  catalogTruncated = false,
}: {
  tenantId: string;
  memberId: string;
  memberName: string;
  initial: CatalogScopeRecord;
  catalog: ScopeCatalogItem[];
  /** El catálogo es más largo que lo que se trajo: se avisa. */
  catalogTruncated?: boolean;
}) {
  const [saved, setSaved] = useState(initial);
  const [mode, setMode] = useState<CatalogScopeMode>(initial.mode);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial.itemIds));
  const [term, setTerm] = useState("");
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const online = useOnline();
  const groupId = useId();

  const activeItems = useMemo(() => catalog.filter((item) => item.isActive), [catalog]);
  const byId = useMemo(() => new Map(catalog.map((item) => [item.id, item])), [catalog]);
  // Los servicios elegidos que hoy están desactivados: no se pueden cotizar, pero siguen en la lista hasta que se quiten.
  const savedIds = useMemo(() => new Set(saved.itemIds), [saved.itemIds]);
  const inactiveSelected = useMemo(
    () =>
      catalog.filter((item) => !item.isActive && (selected.has(item.id) || savedIds.has(item.id))),
    [catalog, selected, savedIds],
  );
  const visibleActive = useMemo(() => filterCatalog(activeItems, term), [activeItems, term]);
  const visibleInactive = useMemo(
    () => filterCatalog(inactiveSelected, term),
    [inactiveSelected, term],
  );
  // Elegidos que no están entre los servicios que se trajeron (un catálogo de más de 1.000): no se ven, pero siguen en la regla y cuentan.
  const hiddenSelected = [...selected].filter((id) => !byId.has(id)).length;
  const selectedActiveCount = activeItems.filter((item) => selected.has(item.id)).length;

  const dirty = mode !== saved.mode || (mode === "list" && !sameSet(selected, savedIds));
  const problem = scopeProblem(mode, selected.size);
  const canSave = dirty && problem === null && !saving && online;

  // La frase de cómo está HOY la regla guardada (solo cuentan los servicios activos).
  const savedActiveNames = saved.itemIds.flatMap((id) => {
    const item = byId.get(id);
    return item?.isActive ? [item.name] : [];
  });
  const summary = scopeSummary(memberName, saved.mode, savedActiveNames);
  const noActiveServices = activeItems.length === 0;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setBanner(null);
    setSaving(true);
    const submitted = { mode, ids: [...selected] };
    try {
      const result = await saveCatalogScopeAction(tenantId, {
        memberId,
        mode: submitted.mode,
        itemIds: submitted.mode === "list" ? submitted.ids : [],
        expectedRevision: saved.revision,
      });
      if (result.status === "error") {
        setBanner(result.message);
        return;
      }
      setSaved({
        mode: result.mode,
        revision: result.revision,
        itemIds: result.mode === "list" ? submitted.ids : [],
        updatedByName: result.result === "changed" ? "ti" : saved.updatedByName,
        updatedAt: result.result === "changed" ? new Date().toISOString() : saved.updatedAt,
      });
      toast.success(
        result.result === "unchanged"
          ? CATALOG_SCOPE_UNCHANGED_MESSAGE
          : savedMessage(memberName, result.mode, result.count),
        { id: SAVED_TOAST_ID },
      );
    } catch {
      setBanner(OFFLINE_FAILURE);
    } finally {
      setSaving(false);
    }
  }

  const changedNote = saved.updatedAt
    ? `Cambiado${saved.updatedByName ? ` por ${saved.updatedByName}` : ""} el ${formatDate(saved.updatedAt)}`
    : null;

  return (
    <section
      aria-label="Servicios que puede cotizar"
      data-testid="catalog-scope"
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-lg">Servicios que puede cotizar</h2>
        <p aria-live="polite" data-testid="catalog-scope-summary" className="text-fg-muted">
          {summary}
        </p>
      </div>

      <form
        data-testid="catalog-scope-form"
        onSubmit={(event) => void submit(event)}
        noValidate
        className="flex flex-col gap-4"
      >
        <OfflineNotice />
        {banner ? (
          <div data-testid="catalog-scope-banner">
            <FormAlert>{banner}</FormAlert>
          </div>
        ) : null}

        <fieldset className="flex flex-col gap-2" disabled={saving}>
          <legend className="sr-only">Qué servicios puede cotizar {memberName}</legend>
          {(
            [
              {
                value: "all",
                label: "Todos los servicios del catálogo",
                hint: "Incluye los que agregues después.",
                disabled: false,
              },
              {
                value: "list",
                label: "Solo los que elijas",
                hint: "Los servicios nuevos no se suman solos.",
                disabled: noActiveServices && saved.mode !== "list" && mode !== "list",
              },
            ] as const
          ).map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-border p-3 text-sm",
                mode === option.value && "border-accent bg-accent-soft",
                option.disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="radio"
                name={groupId}
                value={option.value}
                checked={mode === option.value}
                disabled={option.disabled}
                onChange={() => {
                  setMode(option.value);
                  setBanner(null);
                }}
                data-testid={`catalog-scope-mode-${option.value}`}
                className="mt-0.5 size-5 shrink-0 accent-(--accent)"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-semibold text-fg">{option.label}</span>
                <span className="text-fg-muted">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {noActiveServices ? (
          <p data-testid="catalog-scope-empty" className="text-sm text-fg-muted">
            Tu catálogo no tiene servicios activos.{" "}
            <Link
              href={tenantPath(tenantId, "catalogo")}
              className="inline-flex min-h-11 items-center font-semibold text-accent hover:underline"
            >
              Ir al catálogo
            </Link>
          </p>
        ) : null}

        {mode === "list" && !noActiveServices ? (
          <div className="flex flex-col gap-3" data-testid="catalog-scope-picker">
            <Input
              type="search"
              inputMode="search"
              autoComplete="off"
              aria-label="Buscar un servicio"
              placeholder="Buscar un servicio"
              enterKeyHint="search"
              // Enter (o «Buscar» del teléfono) NO envía el formulario: guardaría una lista a medias y dejaría limitada a la persona.
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              data-testid="catalog-scope-search"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p
                aria-live="polite"
                data-testid="catalog-scope-count"
                className="text-sm text-fg-muted tabular-nums"
              >
                {selectedActiveCount} de {activeItems.length} elegidos
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setSelected((current) => selectVisible(current, visibleActive))}
                  disabled={visibleActive.length === 0}
                  data-testid="catalog-scope-select-visible"
                >
                  Marcar los que se ven
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected(new Set())}
                  disabled={selected.size === 0}
                  data-testid="catalog-scope-clear"
                >
                  Desmarcar todos
                </Button>
              </div>
            </div>

            <ul
              tabIndex={0}
              aria-label="Servicios del catálogo"
              data-testid="catalog-scope-list"
              className="flex max-h-80 flex-col overflow-y-auto rounded-md border border-border"
            >
              {visibleActive.length === 0 ? (
                <li className="px-3 py-3 text-sm text-fg-muted">
                  Ningún servicio coincide con esa búsqueda.
                </li>
              ) : (
                visibleActive.map((item) => (
                  <ScopeRow
                    key={item.id}
                    item={item}
                    checked={selected.has(item.id)}
                    onToggle={() => setSelected((current) => toggleSelection(current, item.id))}
                  />
                ))
              )}
            </ul>

            {visibleInactive.length > 0 ? (
              <div className="flex flex-col gap-1" data-testid="catalog-scope-inactive">
                <h3 className="text-sm font-semibold text-fg">
                  Desactivados en el catálogo (no se pueden cotizar)
                </h3>
                <ul className="flex flex-col rounded-md border border-border">
                  {visibleInactive.map((item) => (
                    <ScopeRow
                      key={item.id}
                      item={item}
                      checked={selected.has(item.id)}
                      onToggle={() => setSelected((current) => toggleSelection(current, item.id))}
                    />
                  ))}
                </ul>
              </div>
            ) : null}

            {catalogTruncated ? (
              <p data-testid="catalog-scope-truncated" className="text-sm text-fg-muted">
                Se muestran solo los primeros {SCOPE_CATALOG_LIMIT.toLocaleString("es-CL")}{" "}
                servicios del catálogo, por nombre: el buscador filtra esos.
                {hiddenSelected > 0
                  ? ` Hay ${hiddenSelected === 1 ? "1 servicio elegido" : `${hiddenSelected} servicios elegidos`} que no se ${hiddenSelected === 1 ? "ve" : "ven"} aquí y cuenta${hiddenSelected === 1 ? "" : "n"} en el máximo.`
                  : ""}
              </p>
            ) : null}
            {problem ? (
              <p role="alert" data-testid="catalog-scope-problem" className="text-sm text-danger">
                {problem}
              </p>
            ) : selected.size >= CATALOG_SCOPE_MAX_ITEMS ? (
              <p className="text-sm text-fg-muted">
                Llegaste al máximo de {CATALOG_SCOPE_MAX_ITEMS} servicios.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-1 border-t border-border pt-3 text-sm text-fg-muted">
          <p data-testid="catalog-scope-hand-written">{HAND_WRITTEN_NOTE}</p>
          {changedNote ? <p data-testid="catalog-scope-changed">{changedNote}</p> : null}
        </div>

        <div className="flex">
          <Button
            type="submit"
            disabled={!canSave}
            aria-disabled={!canSave}
            className="w-full sm:w-auto"
            data-testid="catalog-scope-save"
          >
            {saving ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function ScopeRow({
  item,
  checked,
  onToggle,
}: {
  item: ScopeCatalogItem;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="border-b border-border last:border-b-0">
      <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-surface-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          data-testid="catalog-scope-item"
          className="size-5 shrink-0 accent-(--accent)"
        />
        <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
          <span className="min-w-0 font-medium break-words text-fg">{item.name}</span>
          <span className="shrink-0 text-xs text-fg-muted tabular-nums">
            {item.unitLabel} · {formatClp(item.unitPriceClp)}
          </span>
        </span>
      </label>
    </li>
  );
}
