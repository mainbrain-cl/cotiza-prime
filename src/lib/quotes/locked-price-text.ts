import { formatClp } from "@/lib/money/clp";

/**
 * Cómo se cuenta que alguien con permiso cambió un precio bloqueado (H-041). Los datos son los del evento `locked_price_overridden`
 * de la línea de tiempo y de la auditoría `quote.locked_price_overridden`: `{count, lines: [{position, catalog_item_id,
 * old_price_clp, new_price_clp}]}` (`position` desde 1; `old_price_clp` es `null` si la línea es nueva). Nunca lleva nombres de línea.
 */

export const LOCKED_PRICE_TEXT = "Se cambió un precio bloqueado";

type Change = { position: number; oldPriceClp: number | null; newPriceClp: number };

function isMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readChanges(data: unknown): { count: number; changes: Change[] } | null {
  if (typeof data !== "object" || data === null) return null;
  const { count, lines } = data as { count?: unknown; lines?: unknown };
  if (!Array.isArray(lines)) return null;
  const changes: Change[] = [];
  for (const raw of lines) {
    if (typeof raw !== "object" || raw === null) return null;
    const {
      position,
      old_price_clp: oldPrice,
      new_price_clp: newPrice,
    } = raw as Record<string, unknown>;
    if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 1)
      return null;
    if (!isMoney(newPrice) || !(oldPrice === null || isMoney(oldPrice))) return null;
    changes.push({ position, oldPriceClp: oldPrice, newPriceClp: newPrice });
  }
  const total = typeof count === "number" && Number.isSafeInteger(count) ? count : changes.length;
  return { count: Math.max(total, changes.length), changes };
}

function describeChange(change: Change): string {
  return change.oldPriceClp === null
    ? `línea ${change.position}: agregada a ${formatClp(change.newPriceClp)}`
    : `línea ${change.position}: ${formatClp(change.oldPriceClp)} → ${formatClp(change.newPriceClp)}`;
}

/** Las líneas cambiadas, una por una (`línea 2: $10.000 → $8.000; línea 4: …`), con cuántas más hubo si el registro no las trae todas. */
export function describeLockedPriceChanges(data: unknown): string | null {
  const read = readChanges(data);
  if (read === null || read.changes.length === 0) return null;
  const parts = read.changes.map(describeChange);
  const rest = read.count - read.changes.length;
  if (rest > 0) parts.push(rest === 1 ? "y 1 más" : `y ${rest} más`);
  return parts.join("; ");
}

/** La frase completa de la línea de tiempo. Sin datos legibles, solo «Se cambió un precio bloqueado». */
export function describeLockedPriceOverride(data: unknown): string {
  const read = readChanges(data);
  const detail = describeLockedPriceChanges(data);
  if (read === null || detail === null) return LOCKED_PRICE_TEXT;
  const lead = read.count > 1 ? `Se cambiaron ${read.count} precios bloqueados` : LOCKED_PRICE_TEXT;
  return `${lead} (${detail})`;
}
