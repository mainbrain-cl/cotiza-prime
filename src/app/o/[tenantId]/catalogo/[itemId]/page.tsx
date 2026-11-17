import { ChevronLeft, Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FormAlert } from "@/components/ui/form-controls";
import { unitLabel } from "@/lib/catalog/schemas";
import { formatClp } from "@/lib/money/clp";
import { can } from "@/lib/permissions/matrix";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { EditCatalogItemForm, ToggleActiveForm } from "./edit-forms";

export const metadata: Metadata = { title: "Servicio · Cotiza Prime" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ItemRow = {
  id: string;
  name: string;
  description: string | null;
  unit: string;
  unit_price_clp: number;
  tax_treatment: "taxable" | "exempt";
  is_active: boolean;
  price_locked: boolean;
};

export default async function CatalogItemPage({
  params,
}: PageProps<"/o/[tenantId]/catalogo/[itemId]">) {
  const { tenantId, itemId } = await params;
  const active = await requireActiveTenant(tenantId);
  if (!UUID_PATTERN.test(itemId)) notFound();

  // El filtro por organización lo pone la base (RLS); un servicio de otra organización no aparece.
  const { data } = await active.supabase
    .from("catalog_items")
    .select("id, name, description, unit, unit_price_clp, tax_treatment, is_active, price_locked")
    .eq("id", itemId)
    .maybeSingle();
  if (!data) notFound();
  const item = data as ItemRow;
  const canEdit = can(active.role, "catalog.manage");

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={tenantPath(active.tenantId, "catalogo")}
          className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-fg-muted hover:text-fg"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Catálogo
        </Link>
        <h1 className="text-xl md:text-2xl">{item.name}</h1>
        {item.is_active ? null : (
          <div data-testid="inactive-notice">
            <FormAlert tone="warning">
              Este servicio está desactivado: no aparece al cotizar, pero se conserva.
            </FormAlert>
          </div>
        )}
      </header>

      {canEdit ? (
        <>
          <section
            aria-labelledby="editar-titulo"
            className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6"
          >
            <h2 id="editar-titulo" className="text-lg">
              Editar servicio
            </h2>
            <EditCatalogItemForm
              tenantId={active.tenantId}
              item={{
                id: item.id,
                name: item.name,
                description: item.description,
                unit: item.unit,
                unitPriceClp: String(item.unit_price_clp),
                taxTreatment: item.tax_treatment,
                priceLocked: item.price_locked ? "1" : "",
              }}
            />
          </section>
          <section
            aria-labelledby="estado-titulo"
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6"
          >
            <h2 id="estado-titulo" className="text-lg">
              {item.is_active ? "Dejar de ofrecer" : "Volver a ofrecer"}
            </h2>
            <p className="text-fg-muted">
              {item.is_active
                ? "Si lo desactivas, deja de aparecer al cotizar. No se borra: las cotizaciones que ya hiciste lo conservan y puedes reactivarlo cuando quieras."
                : "Si lo reactivas, vuelve a aparecer al cotizar."}
            </p>
            <ToggleActiveForm
              tenantId={active.tenantId}
              itemId={item.id}
              isActive={item.is_active}
            />
          </section>
        </>
      ) : (
        <section className="rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6">
          <dl className="grid gap-x-8 gap-y-5 md:grid-cols-2">
            <div>
              <dt className="text-sm text-fg-muted">Unidad</dt>
              <dd className="font-semibold">{unitLabel(item.unit)}</dd>
            </div>
            <div>
              <dt className="text-sm text-fg-muted">Precio neto</dt>
              <dd className="flex items-center gap-1.5 font-semibold tabular-nums">
                {formatClp(item.unit_price_clp)}
                {item.price_locked ? (
                  <>
                    <Lock aria-hidden className="size-4 text-fg-muted" />
                    <span className="sr-only">Precio bloqueado</span>
                  </>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-fg-muted">IVA</dt>
              <dd className="font-semibold">
                {item.tax_treatment === "taxable" ? "Afecto a IVA" : "Exento de IVA"}
              </dd>
            </div>
            {item.description ? (
              <div className="md:col-span-2">
                <dt className="text-sm text-fg-muted">Descripción</dt>
                <dd>{item.description}</dd>
              </div>
            ) : null}
          </dl>
        </section>
      )}
    </div>
  );
}
