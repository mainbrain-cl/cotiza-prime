import type { SnippetGroup } from "./groups";
import type { SnippetKind } from "./model";

/**
 * Qué textos guardados se ofrecen en cada campo de la cotización (H-048b). Cada campo toma SOLO los de su tipo: las condiciones, los
 * de «Condiciones»; las exclusiones, los de «Exclusiones»; las notas al pie, los de «Notas al pie». Las observaciones no tienen tipo
 * propio, y el texto del correo se usa en «Enviar» (no aquí).
 */
export type QuoteFieldSnippetKind = Extract<
  SnippetKind,
  "conditions" | "exclusions" | "footer_note"
>;
export type QuoteFieldSnippet = { id: string; name: string; body: string };
export type QuoteFieldSnippets = {
  /** `false` si no se pudieron leer los textos guardados (el menú lo dice en vez de mostrarse como si no hubiera). */
  available: boolean;
  byKind: Readonly<Record<QuoteFieldSnippetKind, readonly QuoteFieldSnippet[]>>;
};

export const NO_SNIPPETS: QuoteFieldSnippets = {
  available: true,
  byKind: { conditions: [], exclusions: [], footer_note: [] },
};

/** `groups` es `null` cuando la lectura falló. */
export function quoteFieldSnippets(groups: readonly SnippetGroup[] | null): QuoteFieldSnippets {
  if (groups === null) return { ...NO_SNIPPETS, available: false };
  const rowsOf = (kind: QuoteFieldSnippetKind): QuoteFieldSnippet[] =>
    (groups.find((group) => group.kind === kind)?.rows ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      body: row.body,
    }));
  return {
    available: true,
    byKind: {
      conditions: rowsOf("conditions"),
      exclusions: rowsOf("exclusions"),
      footer_note: rowsOf("footer_note"),
    },
  };
}
