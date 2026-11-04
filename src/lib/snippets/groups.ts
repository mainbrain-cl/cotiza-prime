import { SNIPPET_KINDS, SNIPPET_KIND_LABELS, type SnippetKind } from "./model";

/** Un texto guardado tal como lo muestran las pantallas. */
export type SnippetRow = {
  id: string;
  kind: SnippetKind;
  name: string;
  body: string;
  isDefault: boolean;
  revision: number;
  updatedAt: string;
};

export type SnippetGroup = { kind: SnippetKind; label: string; rows: SnippetRow[] };

const collator = new Intl.Collator("es-CL", { sensitivity: "base", numeric: true });

/**
 * Agrupa por tipo (en el orden de la pantalla: correo, condiciones, exclusiones, notas) y ordena cada grupo
 * por nombre, sin distinguir mayúsculas ni tildes. Los tipos sin textos no aparecen.
 */
export function groupSnippets(rows: readonly SnippetRow[]): SnippetGroup[] {
  return SNIPPET_KINDS.flatMap((kind) => {
    const ofKind = rows
      .filter((row) => row.kind === kind)
      .sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
    return ofKind.length === 0 ? [] : [{ kind, label: SNIPPET_KIND_LABELS[kind], rows: ofKind }];
  });
}

/** Cuántos caracteres de un texto se ven en la lista antes de cortarlo. */
export const SNIPPET_EXCERPT_LENGTH = 140;

/** Vista breve de un texto: una sola línea, cortada con «…» si es larga. */
export function snippetExcerpt(body: string, max = SNIPPET_EXCERPT_LENGTH): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const characters = Array.from(flat);
  return characters.length <= max ? flat : `${characters.slice(0, max).join("").trimEnd()}…`;
}
