/** Qué cotizaciones muestra la lista: las que armó la propia persona o todas las de la organización. */
export const QUOTE_LIST_SCOPES = ["all", "mine"] as const;
export type QuoteListScope = (typeof QUOTE_LIST_SCOPES)[number];

/** Parámetro de la dirección (`?ver=mias`). */
export const QUOTE_SCOPE_PARAM = "ver";
const MINE_PARAM_VALUE = "mias";

/** Todas por defecto (decisión 009: todos ven todo); cualquier valor raro vuelve a "todas". */
export function parseQuoteScope(value: string | string[] | undefined): QuoteListScope {
  const first = Array.isArray(value) ? value[0] : value;
  return first === MINE_PARAM_VALUE ? "mine" : "all";
}

/** Dirección de la lista con el filtro aplicado. */
export function quoteListHref(basePath: string, scope: QuoteListScope): string {
  return scope === "mine" ? `${basePath}?${QUOTE_SCOPE_PARAM}=${MINE_PARAM_VALUE}` : basePath;
}
