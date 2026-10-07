import { describe, expect, it } from "vitest";
import { latestDeliveryByQuote, needsAttention } from "./delivery-model";

const row = (quote_id: string, status: string, created_at: string) => ({
  quote_id,
  status,
  status_at: created_at,
  created_at,
});

describe("latestDeliveryByQuote (H-033)", () => {
  it("gana el correo más reciente, sin importar el orden de las filas", () => {
    const rows = [
      row("a", "bounced", "2026-10-06T10:00:00Z"),
      row("a", "sent", "2026-10-06T11:00:00Z"),
      row("b", "delivered", "2026-10-06T09:00:00Z"),
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      const result = latestDeliveryByQuote(ordered);
      expect(result.get("a")?.status).toBe("sent");
      expect(result.get("b")?.status).toBe("delivered");
    }
  });

  it("un rebote sin reenvío posterior sigue pidiendo atención; reenviado, deja de pedirla", () => {
    const bounced = latestDeliveryByQuote([row("a", "bounced", "2026-10-06T10:00:00Z")]);
    expect(needsAttention(bounced.get("a"))).toBe(true);
    const resent = latestDeliveryByQuote([
      row("a", "bounced", "2026-10-06T10:00:00Z"),
      row("a", "delivered", "2026-10-06T12:00:00Z"),
    ]);
    expect(needsAttention(resent.get("a"))).toBe(false);
  });

  it("ignora estados que nunca salieron y no inventa entregas", () => {
    const result = latestDeliveryByQuote([
      row("a", "pending", "2026-10-06T10:00:00Z"),
      row("a", "failed", "2026-10-06T11:00:00Z"),
    ]);
    expect(result.size).toBe(0);
    expect(needsAttention(undefined)).toBe(false);
    expect(needsAttention(null)).toBe(false);
  });

  it("un reclamo de spam también pide atención; enviado y entregado no", () => {
    for (const [status, expected] of [
      ["complained", true],
      ["bounced", true],
      ["sent", false],
      ["delivered", false],
    ] as const) {
      expect(needsAttention({ status, statusAt: "x" })).toBe(expected);
    }
  });
});
