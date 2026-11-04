import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SnippetForm } from "@/components/snippets/snippet-form";
import { buttonVariants } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-controls";
import { pagePermission } from "@/lib/permissions/require";
import { SNIPPETS_MAX_PER_TENANT } from "@/lib/snippets/model";
import { loadSnippets } from "@/lib/snippets/queries";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";

export const metadata: Metadata = { title: "Nuevo texto · Cotiza Prime" };

export default async function NewSnippetPage({
  params,
}: PageProps<"/o/[tenantId]/configuracion/textos/nuevo">) {
  const active = await requireActiveTenant((await params).tenantId);
  const denied = pagePermission(active, "settings.manage");
  if (denied) return denied;

  const listHref = tenantPath(active.tenantId, "configuracion/textos");
  // Con el máximo de textos no se deja escribir uno que luego no se podría guardar. Si la lectura falla, se
  // muestra el formulario igual: la base vuelve a exigir el tope.
  const list = await loadSnippets(active);
  const atLimit = list.ok && list.total >= SNIPPETS_MAX_PER_TENANT;
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
        <h1 className="text-xl md:text-2xl">Nuevo texto</h1>
        <p className="text-fg-muted">
          Elige para qué sirve, ponle un nombre y escribe el texto. Pronto podrás usarlo al cotizar.
        </p>
      </header>
      {atLimit ? (
        <div data-testid="snippet-limit" className="flex flex-col items-start gap-3">
          <FormAlert tone="warning">
            Llegaste al máximo de {SNIPPETS_MAX_PER_TENANT} textos guardados. Elimina alguno para
            crear otro.
          </FormAlert>
          <Link href={listHref} className={buttonVariants({ variant: "secondary" })}>
            Volver a Textos listos
          </Link>
        </div>
      ) : (
        // El identificador se genera aquí, al abrir la pantalla: un doble clic en «Guardar» no crea dos textos.
        <SnippetForm
          mode="create"
          tenantId={active.tenantId}
          snippetId={crypto.randomUUID()}
          listHref={listHref}
        />
      )}
    </div>
  );
}
