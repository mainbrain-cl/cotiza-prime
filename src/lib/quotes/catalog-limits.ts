/**
 * Los topes de `public.quotable_catalog_items` (lo que ofrece el cotizador). Viven aparte de `catalog-source.ts` (que es solo del
 * servidor) para que una prueba de la base los compare con los de la función: si una cambia sin la otra, la prueba cae.
 */
/** Servicios que devuelve una búsqueda. */
export const QUOTABLE_CATALOG_LIMIT = 20;
/** Largo máximo de lo que se busca (el resto se corta). */
export const QUOTABLE_SEARCH_MAX_LENGTH = 100;
/** Servicios que se piden por identificador de una vez (convertir una solicitud). */
export const QUOTABLE_IDS_LIMIT = 200;
