import { describe, expect, it } from "vitest";
import { summarizeQuotes } from "./summary";

describe("summarizeQuotes", () => {
  it("sin cotizaciones: todo en cero", () => {
    const summary = summarizeQuotes([]);
    expect(summary.total).toBe(0);
    expect(summary.entries.map((entry) => entry.count)).toEqual([0, 0, 0, 0]);
  });

  it("agrupa los estados y suma los montos de cada grupo", () => {
    const summary = summarizeQuotes([
      { status: "draft", total_clp: 1000 },
      { status: "changes_requested", total_clp: 500 },
      { status: "sent", total_clp: 2000 },
      { status: "viewed", total_clp: 3000 },
      { status: "accepted", total_clp: 4000 },
      { status: "pending_deposit", total_clp: 5000 },
      { status: "paid", total_clp: 9000 },
      { status: "superseded", total_clp: 700 },
    ]);
    expect(summary.total).toBe(8);
    const byId = Object.fromEntries(summary.entries.map((entry) => [entry.id, entry]));
    expect(byId.drafts).toMatchObject({ count: 2, amountClp: 1500 });
    expect(byId.sent).toMatchObject({ count: 2, amountClp: 5000 });
    expect(byId.accepted).toMatchObject({ count: 1, amountClp: 4000 });
    expect(byId.to_collect).toMatchObject({ count: 1, amountClp: 5000 });
  });

  it("entiende los nombres de la base de datos que difieren de la insignia", () => {
    const summary = summarizeQuotes([{ status: "rejected_by_customer", total_clp: 100 }]);
    expect(summary.entries.every((entry) => entry.count === 0)).toBe(true);
  });
});
