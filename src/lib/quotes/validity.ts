/**
 * Vigencia de una cotización (H-027). Fechas como texto `aaaa-mm-dd` (el formato de `<input type="date">`
 * y de la columna `date` de la base) y siempre en la hora de Chile. Puro y sin React.
 *
 * Con vigencia "en días", el plazo se cuenta desde el ENVÍO: `valid_until` queda vacío hasta que se
 * envía la cotización (H-029). Aquí solo se calcula "si la envías hoy, vence el …".
 */

export const VALIDITY_DAYS_MIN = 1;
export const VALIDITY_DAYS_MAX = 365;
/** Largo máximo de las observaciones y de las condiciones. Igual al de la base (`quotes`). */
export const QUOTE_TEXT_MAX_LENGTH = 4000;

const CHILE_TIME_ZONE = "America/Santiago";
const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DIGITS_ONLY = /^\d+$/;

export type Validity = { mode: "days"; days: number } | { mode: "date"; date: string };

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** Fecha de hoy en Chile, `aaaa-mm-dd`. */
export function todayInChile(now: Date = new Date()): string {
  // "en-CA" entrega `aaaa-mm-dd`.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CHILE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** ¿Es una fecha real del calendario (`2026-02-30` no lo es)? */
export function isValidIsoDate(text: string): boolean {
  const match = ISO_DATE.exec(text);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Suma días a una fecha `aaaa-mm-dd`. */
export function addDaysIso(iso: string, days: number): string {
  const match = ISO_DATE.exec(iso);
  if (!match) throw new RangeError("Fecha inválida.");
  const base = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(base + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** `2026-10-05` -> `05-10-2026` (formato chileno). */
export function isoToDisplay(iso: string): string {
  const match = ISO_DATE.exec(iso);
  if (!match) return iso;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

/** Días de vigencia escritos por la persona: entero entre 1 y 365. */
export function parseValidityDays(input: string): Parsed<number> {
  const text = input.trim();
  if (text === "") return { ok: false, message: "Escribe cuántos días vale la cotización." };
  if (!DIGITS_ONLY.test(text)) {
    return { ok: false, message: "Usa solo números enteros. Por ejemplo, 15." };
  }
  const days = Number(text);
  if (days < VALIDITY_DAYS_MIN || days > VALIDITY_DAYS_MAX) {
    return {
      ok: false,
      message: `La vigencia debe estar entre ${VALIDITY_DAYS_MIN} y ${VALIDITY_DAYS_MAX} días.`,
    };
  }
  return { ok: true, value: days };
}

/**
 * Fecha de vigencia escrita por la persona. No puede estar en el pasado, salvo que sea la misma que
 * ya estaba guardada (una cotización vieja se puede seguir editando sin tocar su fecha).
 */
export function parseValidityDate(
  input: string,
  today: string,
  savedValidUntil: string | null,
): Parsed<string> {
  const text = input.trim();
  if (text === "") return { ok: false, message: "Elige hasta qué fecha vale la cotización." };
  if (!isValidIsoDate(text)) return { ok: false, message: "Elige una fecha válida." };
  if (text < today && text !== savedValidUntil) {
    return { ok: false, message: "La fecha de vigencia no puede estar en el pasado." };
  }
  return { ok: true, value: text };
}

/** Texto que explica cuándo vence, para mostrar antes de enviar. */
export function describeValidity(validity: Validity, today: string): string {
  if (validity.mode === "date") return `Vence el ${isoToDisplay(validity.date)}.`;
  const unit = validity.days === 1 ? "día" : "días";
  return (
    `Vence ${validity.days} ${unit} después de enviarla. ` +
    `Si la envías hoy, vence el ${isoToDisplay(addDaysIso(today, validity.days))}.`
  );
}
