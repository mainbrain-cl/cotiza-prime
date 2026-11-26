import { describe, expect, it } from "vitest";
import { nextDueMilestone, outstandingClp, splitPayment } from "./model";

describe("splitPayment: los hitos de pago (PROYECTO.md §13.7)", () => {
  it("100 %: un solo pago por el total", () => {
    expect(splitPayment(1_190_000, "full")).toEqual([
      { seq: 1, kind: "full", amountClp: 1_190_000 },
    ]);
  });

  it("50/50 con total par: dos mitades iguales", () => {
    expect(splitPayment(11_900, "split_50_50")).toEqual([
      { seq: 1, kind: "deposit", amountClp: 5_950 },
      { seq: 2, kind: "balance", amountClp: 5_950 },
    ]);
  });

  it("50/50 con total impar: el peso sobrante va al segundo pago", () => {
    expect(splitPayment(11_901, "split_50_50").map((m) => m.amountClp)).toEqual([5_950, 5_951]);
    expect(splitPayment(1, "split_50_50").map((m) => m.amountClp)).toEqual([0, 1]);
  });

  it("la suma de los hitos es siempre el total, con enteros", () => {
    for (const total of [0, 1, 2, 3, 999, 1_000_001, 999_999_999_999, 1_000_000_000_000]) {
      for (const terms of ["full", "split_50_50"] as const) {
        const parts = splitPayment(total, terms);
        expect(parts.reduce((sum, m) => sum + m.amountClp, 0)).toBe(total);
        for (const m of parts) expect(Number.isSafeInteger(m.amountClp)).toBe(true);
      }
    }
  });

  it("rechaza un total negativo o con decimales", () => {
    expect(() => splitPayment(-1, "full")).toThrow(RangeError);
    expect(() => splitPayment(10.5, "split_50_50")).toThrow(RangeError);
  });
});

describe("lo que falta por cobrar (H-057)", () => {
  const rows = [
    { seq: 1, amountClp: 5_950, status: "paid" as const },
    { seq: 2, amountClp: 5_951, status: "requested" as const },
  ];

  it("suma solo los hitos sin recibir", () => {
    expect(outstandingClp(rows)).toBe(5_951);
    expect(outstandingClp(rows.map((r) => ({ ...r, status: "paid" as const })))).toBe(0);
  });

  it("lo que toca pagar ahora es el primer hito sin pagar", () => {
    expect(nextDueMilestone(rows)?.seq).toBe(2);
    expect(
      nextDueMilestone([...rows].reverse().map((r) => ({ ...r, status: "pending" as const })))?.seq,
    ).toBe(1);
    expect(nextDueMilestone(rows.map((r) => ({ ...r, status: "paid" as const })))).toBeNull();
  });
});
