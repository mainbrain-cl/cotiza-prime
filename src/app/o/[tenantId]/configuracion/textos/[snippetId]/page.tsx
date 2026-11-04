import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SnippetForm } from "@/components/snippets/snippet-form";
import { FormAlert } from "@/components/ui/form-controls";
import { pagePermission } from "@/lib/permissions/require";
import { loadSnippet } from "@/lib/snippets/queries";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";

export const metadata: Metadata = { title: "Editar texto · Cotiza Prime" };

export default async function EditSnippetPage({
  params,
}: PageProps<"/o/[tenantId]/configuracion/textos/[snippetId]">) {
  const { tenantId, snippetId } = await params;
  const active = await requireActiveTenant(tenantId);
  // Primero el permiso (sin consultar nada); después el texto. Uno de otra organización da lo mismo que uno
  // que no existe: «No encontrado».
  const denied = pagePermission(active, "settings.manage");
  if (denied) return denied;

  const found = await loadSnippet(active, snippetId);
  if (found.status === "missing") notFound();

  const listHref = tenantPath(active.tenantId, "configuracion/textos");
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={listHref}
          className="inline-flex min-h-11 w-fit items-center gap-1 rounded-sm text-sm font-medium text-fg-muted outline-none hover:text-fg focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Textos listos
        </Link>
        <h1 className="text-xl md:text-2xl">Editar texto</h1>
      </header>
      {found.status === "error" ? (
        <FormAlert>
          No pudimos cargar este texto. Recarga la página; si sigue igual, intenta en unos minutos.
        </FormAlert>
      ) : (
        <SnippetForm
          // Si otra persona lo cambia y se recarga, el formulario parte de la versión nueva.
          key={`${found.row.id}-${found.row.revision}`}
          mode="edit"
          tenantId={active.tenantId}
          listHref={listHref}
          snippet={{
            id: found.row.id,
            kind: found.row.kind,
            name: found.row.name,
            body: found.row.body,
            isDefault: found.row.isDefault,
            revision: found.row.revision,
          }}
        />
      )}
    </div>
  );
}
