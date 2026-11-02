import "server-only";
import { serverLog } from "@/lib/log/server-log";
import { can } from "@/lib/permissions/matrix";
import { addDaysIso, todayInChile } from "@/lib/quotes/validity";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { readDailyCaps } from "./builder-queries";
import {
  ORGANIZATION_DAILY_CAP,
  PROTECTION_WINDOW_DAYS,
  capStateOf,
  sumCounters,
  summarize,
  type CapState,
  type CounterRow,
  type ProtectionSummary,
} from "./protection-model";

/** Filas de contadores que se leen como máximo (formularios × días; la base ya los acota). */
const MAX_COUNTER_ROWS = 3000;

export type ProtectionData =
  | {
      ok: true;
      now: Date;
      rows: CounterRow[];
      /** Tope diario de cada formulario de la organización, por id. */
      caps: Map<string, number>;
    }
  | { ok: false; reason: "forbidden" | "error" };

/** Quién ve bloqueos y topes (plan §6): lo decide la matriz (`intake.protection.read`). */
export function canSeeProtection(role: string): boolean {
  return can(role, "intake.protection.read");
}

/**
 * Lee los contadores de los últimos 30 días de TODA la organización (la RLS de la tabla ya limita a Dueño
 * y Administrador; aquí además se corta antes de consultar para los demás roles). Solo cuentas: ni una
 * dirección de conexión ni un dato de contacto.
 *
 * El tope diario de cada formulario NO se lee de la tabla (la columna `daily_cap` es privada desde la
 * migración `intake_daily_cap_column`): lo entrega `readDailyCaps`, que la base solo ejecuta con el
 * permiso `intake.forms.manage`. Hoy ese permiso y `intake.protection.read` son de los mismos roles
 * (hay una prueba que lo vigila); si algún día se separan, quien lea la protección sin poder manejar
 * formularios recibiría «error» aquí en vez de un tope.
 */
export async function loadProtection(active: ActiveTenant): Promise<ProtectionData> {
  if (!canSeeProtection(active.role)) return { ok: false, reason: "forbidden" };
  const now = new Date();
  const since = addDaysIso(todayInChile(now), -(PROTECTION_WINDOW_DAYS - 1));
  const [counters, caps] = await Promise.all([
    active.supabase
      .from("intake_daily_counters")
      .select("form_id, day, accepted, blocked_captcha, blocked_rate, blocked_cap, blocked_invalid")
      .gte("day", since)
      .order("day", { ascending: false })
      .limit(MAX_COUNTER_ROWS),
    readDailyCaps(active),
  ]);
  if (counters.error || !counters.data || !caps.ok) {
    // Solo el código: nunca el mensaje de la base ni datos de nadie.
    void serverLog("error", "intake_protection_load_failed", {
      code: counters.error?.code ?? (caps.ok ? "unknown" : caps.code),
    });
    return { ok: false, reason: "error" };
  }
  return { ok: true, now, rows: counters.data as CounterRow[], caps: caps.caps };
}

/** Los contadores de hoy, 7 y 30 días de un solo formulario. */
export function summaryOfForm(
  data: Extract<ProtectionData, { ok: true }>,
  formId: string,
): ProtectionSummary {
  return summarize(
    data.rows.filter((row) => row.form_id === formId),
    data.now,
  );
}

/** Los contadores de toda la organización (todos sus formularios juntos). */
export function summaryOfOrganization(
  data: Extract<ProtectionData, { ok: true }>,
): ProtectionSummary {
  return summarize(data.rows, data.now);
}

/** ¿Llegó este formulario (o la organización) a su tope de hoy? */
export function capStateOfForm(
  data: Extract<ProtectionData, { ok: true }>,
  formId: string,
): CapState {
  const today = todayInChile(data.now);
  const formAccepted = sumCounters(
    data.rows.filter((row) => row.form_id === formId),
    today,
    today,
  ).accepted;
  const orgAccepted = sumCounters(data.rows, today, today).accepted;
  const dailyCap = data.caps.get(formId);
  if (dailyCap === undefined) return { reached: false };
  return capStateOf({ formAccepted, dailyCap, orgAccepted });
}

/** ¿La organización completa llegó hoy a su tope diario (entre todos sus formularios)? */
export function organizationCapState(data: Extract<ProtectionData, { ok: true }>): CapState {
  const today = todayInChile(data.now);
  const accepted = sumCounters(data.rows, today, today).accepted;
  return accepted >= ORGANIZATION_DAILY_CAP
    ? { reached: true, kind: "org", accepted, cap: ORGANIZATION_DAILY_CAP }
    : { reached: false };
}
