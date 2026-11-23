"use client";

import { Menu } from "@base-ui/react/menu";
import { BookText, ChevronDown, Settings } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { snippetExcerpt } from "@/lib/snippets/groups";
import { appendSnippet, tooLongMessage } from "@/lib/snippets/insert";
import { cn } from "@/lib/utils";

/** Un texto guardado, tal como lo necesita el menú (sin la revisión ni las fechas). */
export type InsertableSnippet = { id: string; name: string; body: string };

export const INSERT_SNIPPET_LABEL = "Insertar texto guardado";
export const NO_SNIPPETS_MESSAGE = "Aún no hay textos guardados";
export const SNIPPET_ALREADY_ADDED = "Ya agregado";
export const SNIPPETS_UNAVAILABLE_MESSAGE = "No pudimos cargar los textos guardados";
export const SNIPPET_INSERTED_ANNOUNCEMENT = "Texto agregado al final del campo.";

/**
 * «Insertar texto guardado» (H-048b): un menú con los textos guardados del tipo del campo. Elegir uno lo agrega AL FINAL del campo,
 * separado por una línea en blanco. Un texto que ya está queda apagado con «Ya agregado», y uno que haría pasar del máximo queda
 * apagado diciendo cuánto quedaría. Sin textos guardados, lo dice y, a quien puede administrarlos, le ofrece ir a Configuración.
 * El menú no escribe nada en la base: solo cambia el campo de la pantalla (se guarda con «Guardar cotización»).
 */
export function InsertSnippetMenu({
  fieldLabel,
  snippets,
  value,
  onInsert,
  manageHref,
  unavailable = false,
}: {
  /** Para el nombre accesible del botón («… en Exclusiones»). */
  fieldLabel: string;
  snippets: readonly InsertableSnippet[];
  /** Lo que hay escrito hoy en el campo. */
  value: string;
  onInsert: (text: string) => void;
  /** A dónde ir para crear textos, solo si esta persona puede administrarlos. */
  manageHref: string | null;
  /** `true` si no se pudieron leer los textos guardados: el menú lo dice y no se hace pasar por vacío. */
  unavailable?: boolean;
}) {
  // Un aviso para quien usa lector de pantalla: el foco vuelve al botón y el campo cambió sin que se oiga nada.
  const [announcement, setAnnouncement] = useState("");

  return (
    <div className="flex">
      <Menu.Root>
        <Menu.Trigger
          aria-label={`${INSERT_SNIPPET_LABEL} en ${fieldLabel}`}
          className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "w-full sm:w-auto")}
        >
          <BookText aria-hidden strokeWidth={1.75} />
          {INSERT_SNIPPET_LABEL}
          <ChevronDown aria-hidden strokeWidth={1.75} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" sideOffset={8} align="start" className="z-50">
            <Menu.Popup
              data-testid="insert-snippet-menu"
              className="max-h-[min(24rem,60dvh)] w-[min(24rem,calc(100vw-2rem))] menu-popup overflow-y-auto rounded-md p-1.5 glass outline-none"
            >
              {unavailable ? (
                <div className="flex flex-col gap-1 px-3 py-2 text-sm">
                  <p className="font-semibold text-fg">{SNIPPETS_UNAVAILABLE_MESSAGE}</p>
                  <p className="text-fg-muted">Recarga la página para intentar de nuevo.</p>
                </div>
              ) : snippets.length === 0 ? (
                <div className="flex flex-col gap-1 px-3 py-2 text-sm">
                  <p className="font-semibold text-fg">{NO_SNIPPETS_MESSAGE}</p>
                  {manageHref ? null : (
                    <p className="text-fg-muted">
                      El Dueño o un Administrador los crea en Configuración.
                    </p>
                  )}
                </div>
              ) : (
                snippets.map((snippet) => {
                  const result = appendSnippet(value, snippet.body);
                  const blocked = result.status !== "ok";
                  const note =
                    result.status === "already_added"
                      ? SNIPPET_ALREADY_ADDED
                      : result.status === "too_long"
                        ? tooLongMessage(result.resultingLength, result.max)
                        : null;
                  return (
                    <Menu.Item
                      key={snippet.id}
                      disabled={blocked}
                      onClick={() => {
                        if (result.status !== "ok") return;
                        onInsert(result.text);
                        setAnnouncement(SNIPPET_INSERTED_ANNOUNCEMENT);
                      }}
                      className="flex min-h-11 cursor-pointer flex-col justify-center gap-0.5 rounded-sm px-3 py-2 text-sm outline-none data-highlighted:bg-accent-soft data-highlighted:text-accent data-disabled:cursor-not-allowed data-disabled:opacity-60"
                    >
                      <span className="block truncate font-semibold">{snippet.name}</span>
                      {note ? (
                        <span className="block text-xs text-fg-muted">{note}</span>
                      ) : (
                        <span className="block truncate text-xs text-fg-muted">
                          {snippetExcerpt(snippet.body, 80)}
                        </span>
                      )}
                    </Menu.Item>
                  );
                })
              )}
              {manageHref ? (
                <>
                  <Menu.Separator className="my-1.5 h-px bg-border" />
                  <Menu.LinkItem
                    // Otra pestaña: el editor no guarda solo, y navegar aquí perdería lo que está sin guardar.
                    render={<Link href={manageHref} target="_blank" rel="noopener" />}
                    className="flex min-h-11 items-center gap-3 rounded-sm px-3 py-2 text-sm font-semibold outline-none data-highlighted:bg-accent-soft data-highlighted:text-accent"
                  >
                    <Settings aria-hidden strokeWidth={1.75} className="size-[18px]" />
                    {snippets.length === 0 && !unavailable
                      ? "Crear textos en Configuración"
                      : "Administrar textos"}
                    <span className="sr-only"> (se abre en otra pestaña)</span>
                  </Menu.LinkItem>
                </>
              ) : null}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
