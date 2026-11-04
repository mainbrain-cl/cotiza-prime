import { ChevronLeft, FileText, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SnippetList } from "@/components/snippets/snippet-list";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormAlert } from "@/components/ui/form-controls";
import { pagePermission } from "@/lib/permissions/require";
import { SNIPPETS_MAX_PER_TENANT } from "@/lib/snippets/model";
import { loadSnippets } from "@/lib/snippets/queries";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";

export const metadata: Metadata = { title: "Textos listos · Cotiza Prime" };

export default async function SnippetsPage({
  params,
}: PageProps<"/o/[tenantId]/configuracion/textos">) {
  const active = await requireActiveTenant((await params).tenantId);
  // Antes de leer cualquier dato: quien no administra la organización ve «No tienes permiso» y nada más.
  const denied = pagePermission(active, "settings.manage");
  if (denied) return denied;

  const list = await loadSnippets(active);
  const newHref = tenantPath(active.tenantId, "configuracion/textos/nuevo");
  const atLimit = list.ok && list.total >= SNIPPETS_MAX_PER_TENANT;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={tenantPath(active.tenantId, "configuracion")}
          className="inline-flex min-h-11 w-fit items-center gap-1 rounded-sm text-sm font-medium text-fg-muted outline-none hover:text-fg focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Configuración
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-xl md:text-2xl">Textos listos</h1>
            <p className="text-fg-muted">
              Escribe una vez el correo base, las condiciones, las exclusiones y las notas al pie.
              Pronto podrás usarlos al cotizar.
            </p>
          </div>
          {atLimit ? null : (
            <Link
              href={newHref}
              data-testid="snippet-new"
              className={buttonVariants({ className: "w-full sm:w-auto" })}
            >
              <Plus aria-hidden />
              Nuevo texto
            </Link>
          )}
        </div>
        {list.ok ? (
          <p data-testid="snippet-count" className="text-sm text-fg-muted">
            {list.total} de {SNIPPETS_MAX_PER_TENANT} textos guardados
            {atLimit ? ". Elimina alguno para crear otro." : ""}
          </p>
        ) : null}
      </header>

      {!list.ok ? (
        <FormAlert>
          No pudimos cargar los textos. Recarga la página; si sigue igual, intenta en unos minutos.
        </FormAlert>
      ) : list.total === 0 ? (
        <EmptyState
          icon={FileText}
          title="Aún no tienes textos guardados"
          description="Guarda los textos que repites en cada cotización, como las condiciones de pago o lo que no incluyes. Pronto podrás usarlos al cotizar."
        >
          <Link
            href={newHref}
            data-testid="snippet-new-empty"
            className={buttonVariants({ size: "lg" })}
          >
            <Plus aria-hidden />
            Crear texto
          </Link>
        </EmptyState>
      ) : (
        <SnippetList
          groups={list.groups}
          hrefFor={(id) => tenantPath(active.tenantId, `configuracion/textos/${id}`)}
        />
      )}
    </div>
  );
}
