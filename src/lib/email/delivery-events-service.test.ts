import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin-client", () => ({ createAdminClient: () => ({ rpc }) }));

import type { DeliveryEvent } from "./delivery-events";
import { DeliveryEventError, recordDeliveryEvent } from "./delivery-events-service";

const OCCURRED_AT = new Date("2026-10-06T12:00:00.000Z");
const bounce = (bounceType: DeliveryEvent["bounceType"]): DeliveryEvent => ({
  providerMessageId: "msg-1",
  event: "bounced",
  occurredAt: OCCURRED_AT,
  bounceType,
});

beforeEach(() => rpc.mockReset());

describe("recordDeliveryEvent (H-033)", () => {
  it("llama solo a record_email_event con los datos del aviso", async () => {
    rpc.mockResolvedValue({ data: { result: "applied", status: "bounced" }, error: null });
    await expect(recordDeliveryEvent("resend", bounce("hard"))).resolves.toBe("applied");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_email_event", {
      p_provider: "resend",
      p_provider_message_id: "msg-1",
      p_event: "bounced",
      p_occurred_at: OCCURRED_AT.toISOString(),
      p_bounce_type: "hard",
    });
  });

  it("un rebote indeterminado se anota como blando (la base solo conoce duro y blando)", async () => {
    rpc.mockResolvedValue({ data: { result: "applied" }, error: null });
    await recordDeliveryEvent("resend", bounce("unknown"));
    expect(rpc.mock.calls[0][1].p_bounce_type).toBe("soft");
  });

  it("una entrega no lleva tipo de rebote", async () => {
    rpc.mockResolvedValue({ data: { result: "applied" }, error: null });
    await recordDeliveryEvent("resend", { ...bounce(null), event: "delivered" });
    expect(rpc.mock.calls[0][1].p_bounce_type).toBeNull();
  });

  it("traduce los resultados de la base", async () => {
    for (const [result, expected] of [
      ["ignored", "ignored"],
      ["ignored_older", "ignored"],
      ["unknown", "unknown"],
    ] as const) {
      rpc.mockResolvedValueOnce({ data: { result }, error: null });
      await expect(recordDeliveryEvent("resend", bounce("hard"))).resolves.toBe(expected);
    }
  });

  it("si la base falla o responde algo raro, lanza un error que solo lleva el código", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "CP422" } });
    await expect(recordDeliveryEvent("resend", bounce("hard"))).rejects.toThrow(
      new DeliveryEventError("CP422"),
    );
    rpc.mockResolvedValueOnce({ data: { result: "???" }, error: null });
    await expect(recordDeliveryEvent("resend", bounce("hard"))).rejects.toThrow("shape");
  });
});
