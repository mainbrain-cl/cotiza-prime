import { z } from "zod";
import { can, canEver, NO_PERMISSION_MESSAGE } from "@/lib/permissions/matrix";

/**
 * Lo que la sección «Servicios que puede cotizar» de la ficha de un miembro necesita saber, sin base de datos ni servidor (H-042).
 * Los nombres de los roles viven solo en `src/lib/permissions/`; aquí se decide con la matriz. La base vuelve a exigir cada regla en
 * `set_member_catalog_scope`.
 */

/** El tope de servicios de una lista. Igual a `app.member_catalog_scope_max_items()` (una prueba de la base lo compara). */
export const CATALOG_SCOPE_MAX_ITEMS = 500;

/** Cuántos servicios del catálogo se traen para elegir en la ficha (un catálogo más largo avisa que se cortó). */
export const SCOPE_CATALOG_LIMIT = 1_000;

export const CATALOG_SCOPE_MODES = ["all", "list"] as const;
export type CatalogScopeMode = (typeof CATALOG_SCOPE_MODES)[number];

/**
 * ¿A este rol se le puede limitar la lista de servicios? A quien puede cotizar y no maneja el catálogo (hoy, solo el Comercial). Es la
 * misma cuenta que hace la base con `app.role_can`, sin escribir ningún nombre de rol; una prueba compara las dos para los cinco roles.
 */
export function roleCanBeLimited(role: string): boolean {
  return canEver(role, "quote.create") && !can(role, "catalog.manage");
}

/**
 * Lo que dice la sección para un rol al que NO se le limita: «Su rol no tiene límite de servicios» (maneja el catálogo: Dueño y
 * Administrador) o «Su rol no cotiza» (Aprobador y Observador). Si quedó una lista guardada de antes (D4: se conserva), lo avisa.
 */
export function notLimitableNote(role: string, hasStoredList: boolean): string {
  const base = canEver(role, "quote.create")
    ? "Su rol no tiene límite de servicios."
    : "Su rol no cotiza.";
  return hasStoredList
    ? `${base} Tiene una lista guardada que se aplicará si vuelve a ser Comercial.`
    : base;
}

/** La regla guardada de un miembro. Sin fila en la base equivale a «todos» y versión 0. */
export type CatalogScopeRecord = {
  mode: CatalogScopeMode;
  /** La versión que la persona ve: 0 si todavía no hay regla. */
  revision: number;
  itemIds: string[];
  /** Quién y cuándo la cambió por última vez (`null` si todavía no hay regla). */
  updatedByName: string | null;
  updatedAt: string | null;
};

export const NO_CATALOG_SCOPE: CatalogScopeRecord = {
  mode: "all",
  revision: 0,
  itemIds: [],
  updatedByName: null,
  updatedAt: null,
};

/** Un servicio del catálogo, como lo muestra la lista de la ficha. */
export type ScopeCatalogItem = {
  id: string;
  name: string;
  unitLabel: string;
  unitPriceClp: number;
  isActive: boolean;
};

const fold = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es-CL").trim();

/** Los servicios que coinciden con lo escrito en el buscador (sin distinguir mayúsculas ni tildes); vacío = todos. */
export function filterCatalog(
  items: readonly ScopeCatalogItem[],
  term: string,
): ScopeCatalogItem[] {
  const wanted = fold(term);
  return wanted === "" ? [...items] : items.filter((item) => fold(item.name).includes(wanted));
}

/** Marca o desmarca un servicio; devuelve un conjunto nuevo (no cambia el que recibe). */
export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** «Marcar los que se ven»: suma los servicios visibles a lo ya elegido. */
export function selectVisible(
  selected: ReadonlySet<string>,
  visible: readonly ScopeCatalogItem[],
): Set<string> {
  const next = new Set(selected);
  for (const item of visible) next.add(item.id);
  return next;
}

export const EMPTY_LIST_MESSAGE =
  "Elige al menos un servicio. Si esta persona no debe cotizar, cambia su rol a Observador.";
export const TOO_MANY_ITEMS_MESSAGE = `Puedes elegir hasta ${CATALOG_SCOPE_MAX_ITEMS} servicios.`;

/** Por qué lo elegido no se puede guardar todavía (para decirlo antes de enviar); `null` si está bien. */
export function scopeProblem(mode: CatalogScopeMode, selectedCount: number): string | null {
  if (mode === "all") return null;
  if (selectedCount === 0) return EMPTY_LIST_MESSAGE;
  if (selectedCount > CATALOG_SCOPE_MAX_ITEMS) return TOO_MANY_ITEMS_MESSAGE;
  return null;
}

const NAMES_IN_SUMMARY = 3;

/**
 * La frase de cómo quedó la regla: «Carla puede cotizar todos los servicios» o «Carla puede cotizar 3 servicios: A, B y C» (con más de
 * tres, los tres primeros y «y N más»). Solo cuentan los servicios ACTIVOS: uno desactivado no se puede cotizar.
 */
export function scopeSummary(
  name: string,
  mode: CatalogScopeMode,
  activeNames: readonly string[],
): string {
  if (mode === "all") return `${name} puede cotizar todos los servicios`;
  const count = activeNames.length;
  if (count === 0) return `${name} no tiene servicios activos que cotizar`;
  const shown = activeNames.slice(0, NAMES_IN_SUMMARY);
  const rest = count - shown.length;
  const list =
    rest > 0
      ? `${shown.join(", ")} y ${rest} más`
      : shown.length > 1
        ? `${shown.slice(0, -1).join(", ")} y ${shown[shown.length - 1]}`
        : shown[0];
  return `${name} puede cotizar ${count === 1 ? "1 servicio" : `${count} servicios`}: ${list}`;
}

/** El aviso al guardar con éxito (el del diseño: «Listo: Carla solo puede cotizar 3 servicios.»). */
export function savedMessage(name: string, mode: CatalogScopeMode, count: number): string {
  if (mode === "all") return `Listo: ${name} puede cotizar todos los servicios.`;
  return `Listo: ${name} solo puede cotizar ${count === 1 ? "1 servicio" : `${count} servicios`}.`;
}

/** Lo que llega al guardar: la persona, el modo, los servicios elegidos y la versión que se vio en pantalla. */
export const saveCatalogScopeSchema = z
  .object({
    memberId: z.uuid({ error: "Esta persona ya no está en tu equipo." }),
    mode: z.enum(CATALOG_SCOPE_MODES, { error: "Elige una de las dos opciones." }),
    itemIds: z.array(z.uuid({ error: "Un servicio no es válido. Recarga la página." })),
    expectedRevision: z.number().int().min(0).max(2_147_483_647),
  })
  .superRefine((value, ctx) => {
    const problem = scopeProblem(value.mode, new Set(value.itemIds).size);
    if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["itemIds"] });
    if (value.mode === "all" && value.itemIds.length > 0) {
      ctx.addIssue({ code: "custom", message: "Elige una de las dos opciones.", path: ["mode"] });
    }
  });
export type SaveCatalogScopeInput = z.infer<typeof saveCatalogScopeSchema>;

// --- Mensajes ---------------------------------------------------------------------------------------------

export const CATALOG_SCOPE_CONFLICT_MESSAGE =
  "Otra persona cambió esta lista mientras la editabas. Recarga para ver la última versión.";
export const CATALOG_SCOPE_MEMBER_GONE_MESSAGE =
  "No encontramos a esta persona en tu equipo. Puede que ya no esté: recarga la página.";
export const CATALOG_SCOPE_NOT_LIMITABLE_MESSAGE =
  "Esta persona cambió de rol y ya no se le puede limitar. Recarga la página.";
export const CATALOG_SCOPE_SELF_MESSAGE = "No puedes cambiar tu propia lista de servicios.";
export const CATALOG_SCOPE_ITEM_GONE_MESSAGE =
  "Uno de los servicios ya no existe en el catálogo. Recarga la página para ver la lista al día.";
export const CATALOG_SCOPE_UNCHANGED_MESSAGE = "No había cambios que guardar.";
export const CATALOG_SCOPE_GENERIC_FAILURE =
  "No pudimos guardar los cambios. Intenta de nuevo en unos minutos.";

export type CatalogScopeErrorKind =
  "forbidden" | "not_found" | "conflict" | "invalid" | "not_limitable" | "other";

/** Traduce un error de `set_member_catalog_scope` a un mensaje para la persona, sin repetir lo que dijo la base. */
export function mapCatalogScopeError(error: { code?: string | null; message?: string | null }): {
  kind: CatalogScopeErrorKind;
  message: string;
} {
  const code = error.code ?? "";
  const reason = (error.message ?? "").trim();
  if (code === "42501") return { kind: "forbidden", message: NO_PERMISSION_MESSAGE };
  if (code === "CP404") return { kind: "not_found", message: CATALOG_SCOPE_MEMBER_GONE_MESSAGE };
  if (code === "CP409") return { kind: "conflict", message: CATALOG_SCOPE_CONFLICT_MESSAGE };
  if (code === "CP423" && reason === "cannot_target_self") {
    return { kind: "invalid", message: CATALOG_SCOPE_SELF_MESSAGE };
  }
  if (code === "CP422") {
    if (reason === "empty_list") return { kind: "invalid", message: EMPTY_LIST_MESSAGE };
    if (reason === "too_many_items") return { kind: "invalid", message: TOO_MANY_ITEMS_MESSAGE };
    if (reason === "member_removed") {
      return { kind: "not_found", message: CATALOG_SCOPE_MEMBER_GONE_MESSAGE };
    }
    if (reason === "member_not_limitable") {
      return { kind: "not_limitable", message: CATALOG_SCOPE_NOT_LIMITABLE_MESSAGE };
    }
    if (reason === "catalog_item_not_found") {
      return { kind: "invalid", message: CATALOG_SCOPE_ITEM_GONE_MESSAGE };
    }
  }
  return { kind: "other", message: CATALOG_SCOPE_GENERIC_FAILURE };
}
