import "server-only";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { getAppOrigin } from "@/lib/http/request-context";
import {
  DEFAULT_FIELD_MODES,
  publicFormUrl,
  type CatalogChoice,
  type EditorForm,
  type EditorItem,
  type FormStatus,
  type ItemUnit,
} from "./builder-model";
import type { FieldModes, QuantityMode } from "./field-modes";

/** Cuántos formularios y servicios del catálogo se leen como máximo (la base ya los acota). */
const MAX_FORMS_LISTED = 100;
const MAX_CATALOG_CHOICES = 500;

export type FormListRow = {
  id: string;
  name: string;
  status: FormStatus;
  /** `null` si no pudimos contar: la pantalla avisa, no dice «Sin solicitudes». */
  requestCount: number | null;
  /** El conteo llegó al tope de lectura: son «al menos» esa cantidad. */
  requestCountIsLowerBound: boolean;
  /** Solo si está publicado (o en pausa): nunca se muestra el identificador por separado. */
  publicUrl: string | null;
};

export type FormListResult =
  { ok: true; rows: FormListRow[]; totalActive: number | null } | { ok: false };

/** Filas de solicitudes que se leen para contar (PostgREST corta en 1.000 por respuesta). */
export const REQUEST_COUNT_READ_LIMIT = 1000;

function isLive(status: FormStatus): boolean {
  return status === "published" || status === "paused";
}

/** Cuenta solicitudes por formulario con UNA sola consulta. `null` si la consulta falla. */
async function countRequestsByForm(
  active: ActiveTenant,
  formIds: string[],
): Promise<{ counts: Map<string, number>; lowerBound: boolean } | null> {
  if (formIds.length === 0) return { counts: new Map(), lowerBound: false };
  const { data, error } = await active.supabase
    .from("intake_requests")
    .select("form_id")
    .in("form_id", formIds)
    .limit(REQUEST_COUNT_READ_LIMIT);
  if (error || !data) return null;
  const counts = new Map<string, number>();
  for (const row of data as { form_id: string }[]) {
    counts.set(row.form_id, (counts.get(row.form_id) ?? 0) + 1);
  }
  return { counts, lowerBound: data.length >= REQUEST_COUNT_READ_LIMIT };
}

export async function loadFormList(
  active: ActiveTenant,
  showArchived: boolean,
): Promise<FormListResult> {
  let query = active.supabase
    .from("intake_forms")
    .select("id, name, status, public_id")
    .order("created_at", { ascending: false })
    .limit(MAX_FORMS_LISTED);
  query = showArchived ? query.eq("status", "archived") : query.neq("status", "archived");
  const { data, error } = await query;
  if (error || !data) return { ok: false };

  const origin = getAppOrigin();
  const counted = await countRequestsByForm(
    active,
    data.map((row) => row.id as string),
  );
  const rows = data.map((row) => {
    const status = row.status as FormStatus;
    const id = row.id as string;
    return {
      id,
      name: row.name as string,
      status,
      requestCount: counted ? (counted.counts.get(id) ?? 0) : null,
      requestCountIsLowerBound: counted?.lowerBound ?? false,
      publicUrl: isLive(status) ? publicFormUrl(origin, row.public_id as string) : null,
    } satisfies FormListRow;
  });
  return { ok: true, rows, totalActive: showArchived ? null : rows.length };
}

export type LoadedForm = {
  id: string;
  status: FormStatus;
  revision: number;
  publicUrl: string | null;
  form: EditorForm;
};

type ItemRow = {
  id: string;
  kind: string;
  catalog_item_id: string | null;
  public_name: string;
  public_description: string | null;
  unit: string;
  quantity_mode: string;
  min_qty_milli: number | null;
  max_qty_milli: number | null;
};

function toEditorItem(row: ItemRow): EditorItem {
  return {
    id: row.id,
    kind: row.kind === "catalog" ? "catalog" : "free",
    catalogItemId: row.catalog_item_id,
    publicName: row.public_name,
    publicDescription: row.public_description ?? "",
    unit: row.unit as ItemUnit,
    quantityMode: row.quantity_mode as QuantityMode,
    minQtyMilli: row.min_qty_milli === null ? null : Number(row.min_qty_milli),
    maxQtyMilli: row.max_qty_milli === null ? null : Number(row.max_qty_milli),
  };
}

export type LoadFormResult =
  | { ok: true; loaded: LoadedForm }
  /** `not_found`: no existe en esta organización (la RLS lo decide). `error`: falló la lectura. */
  | { ok: false; reason: "not_found" | "error" };

/**
 * Lee un formulario con sus servicios. Si la lectura falla devuelve `error`: nunca un formulario con
 * la lista de servicios vacía (guardarlo así borraría los servicios) ni un «No encontrado» falso.
 */
export async function loadForm(active: ActiveTenant, formId: string): Promise<LoadFormResult> {
  const { data: row, error: formError } = await active.supabase
    .from("intake_forms")
    .select(
      "id, public_id, status, revision, name, title, intro, success_message, fields, privacy_policy_url",
    )
    .eq("id", formId)
    .maybeSingle();
  if (formError) return { ok: false, reason: "error" };
  if (!row) return { ok: false, reason: "not_found" };
  const { data: items, error: itemsError } = await active.supabase
    .from("intake_form_items")
    .select(
      "id, kind, catalog_item_id, public_name, public_description, unit, quantity_mode, min_qty_milli, max_qty_milli",
    )
    .eq("form_id", formId)
    .eq("is_active", true)
    .order("position", { ascending: true });
  if (itemsError || !items) return { ok: false, reason: "error" };

  const status = row.status as FormStatus;
  return {
    ok: true,
    loaded: {
      id: row.id as string,
      status,
      revision: row.revision as number,
      publicUrl: isLive(status) ? publicFormUrl(getAppOrigin(), row.public_id as string) : null,
      form: {
        name: row.name as string,
        title: row.title as string,
        intro: row.intro as string,
        successMessage: row.success_message as string,
        fields: { ...DEFAULT_FIELD_MODES, ...(row.fields as Partial<FieldModes>) },
        privacyPolicyUrl: (row.privacy_policy_url as string | null) ?? "",
        items: (items as ItemRow[]).map(toEditorItem),
      },
    },
  };
}

/** Un servicio que el formulario ya tenía y que la persona quitó, listo para guardarse como inactivo. */
export type DeactivatedItem = {
  id: string;
  kind: string;
  catalog_item_id: string | null;
  public_name: string;
  public_description: string | null;
  unit: string;
  quantity_mode: string;
  min_qty_milli: number | null;
  max_qty_milli: number | null;
  is_active: false;
};

/**
 * En un formulario publicado, un servicio que ya aparece en alguna solicitud no se borra: se guarda
 * inactivo, para que la solicitud siga apuntando a un servicio que existió. `null` si no se pudo leer
 * (quien llama no guarda: es preferible un error a borrar historia).
 */
export async function itemsToKeepInactive(
  active: ActiveTenant,
  formId: string,
  keptIds: readonly string[],
): Promise<DeactivatedItem[] | null> {
  const { data, error } = await active.supabase
    .from("intake_form_items")
    .select(
      "id, kind, catalog_item_id, public_name, public_description, unit, quantity_mode, min_qty_milli, max_qty_milli",
    )
    .eq("form_id", formId)
    .eq("is_active", true);
  if (error || !data) return null;
  const removed = (data as ItemRow[]).filter((row) => !keptIds.includes(row.id));
  const result: DeactivatedItem[] = [];
  for (const row of removed) {
    const { data: used, error: usedError } = await active.supabase
      .from("intake_requests")
      .select("id")
      .eq("form_id", formId)
      .contains("items", [{ form_item_id: row.id }])
      .limit(1);
    if (usedError || !used) return null;
    if (used.length > 0) {
      result.push({
        id: row.id,
        kind: row.kind,
        catalog_item_id: row.catalog_item_id,
        public_name: row.public_name,
        public_description: row.public_description,
        unit: row.unit,
        quantity_mode: row.quantity_mode,
        min_qty_milli: row.min_qty_milli === null ? null : Number(row.min_qty_milli),
        max_qty_milli: row.max_qty_milli === null ? null : Number(row.max_qty_milli),
        is_active: false,
      });
    }
  }
  return result;
}

/** Servicios activos del catálogo para elegir. Se piden SOLO nombre, descripción y unidad: nunca el precio. */
export async function loadCatalogChoices(active: ActiveTenant): Promise<CatalogChoice[]> {
  const { data } = await active.supabase
    .from("catalog_items")
    .select("id, name, description, unit")
    .eq("is_active", true)
    .order("name", { ascending: true })
    .limit(MAX_CATALOG_CHOICES);
  return ((data ?? []) as CatalogChoice[]).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    unit: row.unit,
  }));
}
