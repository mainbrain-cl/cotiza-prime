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
  requestCount: number;
  /** Solo si está publicado (o en pausa): nunca se muestra el identificador por separado. */
  publicUrl: string | null;
};

export type FormListResult = { ok: true; rows: FormListRow[] } | { ok: false };

function isLive(status: FormStatus): boolean {
  return status === "published" || status === "paused";
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
  const rows = await Promise.all(
    data.map(async (row) => {
      const { count } = await active.supabase
        .from("intake_requests")
        .select("id", { count: "exact", head: true })
        .eq("form_id", row.id as string);
      const status = row.status as FormStatus;
      return {
        id: row.id as string,
        name: row.name as string,
        status,
        requestCount: count ?? 0,
        publicUrl: isLive(status) ? publicFormUrl(origin, row.public_id as string) : null,
      } satisfies FormListRow;
    }),
  );
  return { ok: true, rows };
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

/** Lee un formulario con sus servicios. `null` si no existe en esta organización (la RLS lo decide). */
export async function loadForm(active: ActiveTenant, formId: string): Promise<LoadedForm | null> {
  const { data: row } = await active.supabase
    .from("intake_forms")
    .select(
      "id, public_id, status, revision, name, title, intro, success_message, fields, privacy_policy_url",
    )
    .eq("id", formId)
    .maybeSingle();
  if (!row) return null;
  const { data: items } = await active.supabase
    .from("intake_form_items")
    .select(
      "id, kind, catalog_item_id, public_name, public_description, unit, quantity_mode, min_qty_milli, max_qty_milli",
    )
    .eq("form_id", formId)
    .eq("is_active", true)
    .order("position", { ascending: true });

  const status = row.status as FormStatus;
  return {
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
      items: ((items ?? []) as ItemRow[]).map(toEditorItem),
    },
  };
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
