/**
 * Modelo de la protección contra abusos del formulario público (H-092). Solo cuentas: ningún dato
 * personal ni dirección de conexión pasa por aquí. Sin dependencias del servidor, para poder probarlo
 * y usarlo también en el navegador.
 */

/** Mismos límites que la base (`daily_cap between 1 and 200`, 50 por defecto, 300 por organización). */
export const DAILY_CAP_MIN = 1;
export const DAILY_CAP_MAX = 200;
export const DAILY_CAP_DEFAULT = 50;
export const ORGANIZATION_DAILY_CAP = 300;

/** Cuántos días hacia atrás se leen los contadores (hoy cuenta como el primero). */
export const PROTECTION_WINDOW_DAYS = 30;
export const PROTECTION_SHORT_WINDOW_DAYS = 7;

const CHILE_TIME_ZONE = "America/Santiago";

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: CHILE_TIME_ZONE,
});

/** El día de Chile (`aaaa-mm-dd`) de un instante: el cambio de día es a medianoche de Chile, no de UTC. */
export function chileDay(at: Date): string {
  return dayFormatter.format(at);
}

/** Suma (o resta) días a un `aaaa-mm-dd`. Trabaja con calendario puro: sin horas, sin zonas. */
export function addDays(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1, date + delta));
  return moved.toISOString().slice(0, 10);
}

/**
 * Lo que cuenta la base por formulario y día (columnas de `intake_daily_counters`). La columna
 * `blocked_paused` existe pero no se lee: con el formulario en pausa el servidor responde antes de contar, así
 * que casi siempre estaría en cero y mostrarla engañaría (revisión de H-092).
 */
export type CounterRow = {
  form_id: string;
  day: string;
  accepted: number;
  blocked_captcha: number;
  blocked_rate: number;
  blocked_cap: number;
  blocked_invalid: number;
};

export type CounterTotals = {
  accepted: number;
  blockedCaptcha: number;
  blockedRate: number;
  blockedCap: number;
  blockedInvalid: number;
  /** Todos los envíos que se bloquearon, por el motivo que sea. */
  blockedTotal: number;
};

export const EMPTY_TOTALS: CounterTotals = {
  accepted: 0,
  blockedCaptcha: 0,
  blockedRate: 0,
  blockedCap: 0,
  blockedInvalid: 0,
  blockedTotal: 0,
};

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** Suma las filas cuyo día cae entre `from` y `to` (ambos incluidos). */
export function sumCounters(rows: readonly CounterRow[], from: string, to: string): CounterTotals {
  const total = { ...EMPTY_TOTALS };
  for (const row of rows) {
    if (row.day < from || row.day > to) continue;
    total.accepted += num(row.accepted);
    total.blockedCaptcha += num(row.blocked_captcha);
    total.blockedRate += num(row.blocked_rate);
    total.blockedCap += num(row.blocked_cap);
    total.blockedInvalid += num(row.blocked_invalid);
  }
  total.blockedTotal =
    total.blockedCaptcha + total.blockedRate + total.blockedCap + total.blockedInvalid;
  return total;
}

export type ProtectionSummary = {
  today: CounterTotals;
  last7: CounterTotals;
  last30: CounterTotals;
};

/** Hoy, los últimos 7 días y los últimos 30 (contando hoy), según el día de Chile de `now`. */
export function summarize(rows: readonly CounterRow[], now: Date): ProtectionSummary {
  const today = chileDay(now);
  return {
    today: sumCounters(rows, today, today),
    last7: sumCounters(rows, addDays(today, -(PROTECTION_SHORT_WINDOW_DAYS - 1)), today),
    last30: sumCounters(rows, addDays(today, -(PROTECTION_WINDOW_DAYS - 1)), today),
  };
}

/** Las cinco cifras que se muestran, en el orden de la pantalla. */
export const COUNTER_LABELS: readonly {
  key: keyof Omit<CounterTotals, "blockedTotal">;
  label: string;
}[] = [
  { key: "accepted", label: "Aceptadas" },
  { key: "blockedCaptcha", label: "Bloqueadas por robot" },
  // Cuenta cada vez que una conexión llegó al límite; sus intentos siguientes no se suman (decisión de H-087).
  { key: "blockedRate", label: "Conexiones frenadas por enviar seguido" },
  { key: "blockedCap", label: "Por tope diario" },
  { key: "blockedInvalid", label: "Con datos inválidos" },
];

export type CapState =
  | { reached: false }
  | {
      reached: true;
      kind: "form";
      accepted: number;
      cap: number;
      /** La organización también llegó a su tope: subir el del formulario no serviría. */
      orgAlsoReached?: boolean;
    }
  | { reached: true; kind: "org"; accepted: number; cap: number };

/**
 * ¿Llegó el formulario a su tope de hoy? `formAccepted`: aceptadas hoy por este formulario; `orgAccepted`:
 * aceptadas hoy por toda la organización. Si se cumplen los dos, manda el del formulario (como la base).
 */
export function capStateOf(args: {
  formAccepted: number;
  dailyCap: number;
  orgAccepted: number;
}): CapState {
  if (args.formAccepted >= args.dailyCap) {
    return {
      reached: true,
      kind: "form",
      accepted: args.formAccepted,
      cap: args.dailyCap,
      orgAlsoReached: args.orgAccepted >= ORGANIZATION_DAILY_CAP,
    };
  }
  if (args.orgAccepted >= ORGANIZATION_DAILY_CAP) {
    return { reached: true, kind: "org", accepted: args.orgAccepted, cap: ORGANIZATION_DAILY_CAP };
  }
  return { reached: false };
}

export function formCapReachedText(accepted: number, cap: number): string {
  return `Este formulario llegó a su tope de hoy: recibió ${accepted} ${accepted === 1 ? "solicitud" : "solicitudes"} y su tope es ${cap}`;
}

export function organizationCapReachedText(cap: number): string {
  return `Tu organización llegó a su tope de hoy: ${cap} solicitudes entre todos tus formularios`;
}

export const DAILY_CAP_RANGE_MESSAGE = `Escribe un número entero entre ${DAILY_CAP_MIN} y ${DAILY_CAP_MAX}.`;

/** Valida lo que se escribió en el campo del tope. Devuelve el número o el mensaje de error. */
export function parseDailyCap(
  input: string | number | null | undefined,
): { ok: true; value: number } | { ok: false; message: string } {
  if (typeof input === "number") {
    return Number.isInteger(input) && input >= DAILY_CAP_MIN && input <= DAILY_CAP_MAX
      ? { ok: true, value: input }
      : { ok: false, message: DAILY_CAP_RANGE_MESSAGE };
  }
  const text = (input ?? "").trim();
  if (!/^\d{1,3}$/.test(text)) return { ok: false, message: DAILY_CAP_RANGE_MESSAGE };
  return parseDailyCap(Number(text));
}
