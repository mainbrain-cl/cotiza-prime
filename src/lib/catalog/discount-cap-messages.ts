/** Los mensajes de la acción de fijar el descuento máximo (aparte: un archivo `use server` solo exporta funciones). */
export const DISCOUNT_CAP_SAVED_MESSAGE = "Guardamos el descuento máximo de los Comerciales.";
export const DISCOUNT_CAP_UNCHANGED_MESSAGE =
  "El descuento máximo ya estaba así: no hay cambios que guardar.";
export const DISCOUNT_CAP_INVALID_MESSAGE =
  "El máximo debe ser un porcentaje menor que 100 %, o quedar vacío para no poner tope.";
export const DISCOUNT_CAP_GENERIC_FAILURE =
  "No pudimos guardar el descuento máximo. Intenta de nuevo en unos minutos.";

export type DiscountCapResult =
  | { status: "ok"; message: string; maxDiscountBp: number | null }
  | { status: "error"; message: string };
