/**
 * Generador de cotizaciones al azar con semilla fija, compartido por la prueba de propiedades
 * (`calc.test.ts`) y la de paridad con la base de datos (`tests/db/quote-calc-parity.test.ts`).
 */

import { calculateQuote, type CalcInput, type Discount, type LineInput } from "./calc";

/** Generador con semilla fija (mulberry32): mismos números en cada corrida, sin librerías. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PROPERTY_SEED = 20_261_001;

export function generateInputs(count: number, seed: number): CalcInput[] {
  const random = createRandom(seed);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const pick = <T>(items: T[]): T => items[int(0, items.length - 1)];

  const inputs: CalcInput[] = [];
  for (let i = 0; i < count; i += 1) {
    const lineCount = int(0, 12);
    const lines: LineInput[] = [];
    for (let l = 0; l < lineCount; l += 1) {
      const quantityMilli = pick([int(1, 20), int(1, 5000), int(1000, 100_000), int(1, 5_000_000)]);
      const unitPriceClp = pick([0, int(1, 100), int(1, 5000), int(1, 2_000_000)]);
      // Cota segura del bruto (el real es ese valor redondeado hacia abajo o arriba por $1 como mucho).
      const grossFloor = Math.floor((quantityMilli * unitPriceClp) / 1000);
      const kind = pick(["none", "percent", "amount"] as const);
      let discount: Discount = { kind: "none" };
      if (kind === "percent")
        discount = { kind: "percent", bp: pick([0, int(0, 10_000), 1250, 10_000]) };
      if (kind === "amount") discount = { kind: "amount", clp: int(0, grossFloor) };
      lines.push({
        quantityMilli,
        unitPriceClp,
        taxTreatment: random() < 0.3 ? "exempt" : "taxable",
        discount,
      });
    }
    const taxRateBp = pick([1900, 1900, 1900, 0, 1000, int(0, 10_000)]);
    const base: CalcInput = { lines, globalDiscount: { kind: "none" }, taxRateBp };
    const without = calculateQuote(base);
    let globalDiscount: Discount = { kind: "none" };
    const globalKind = pick(["none", "percent", "amount"] as const);
    if (globalKind === "percent")
      globalDiscount = { kind: "percent", bp: pick([int(0, 10_000), 500, 10_000]) };
    if (globalKind === "amount" && without.ok) {
      globalDiscount = { kind: "amount", clp: int(0, without.totals.subtotalClp) };
    }
    inputs.push({ lines, globalDiscount, taxRateBp });
  }
  return inputs;
}
