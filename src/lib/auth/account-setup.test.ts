import { describe, expect, it } from "vitest";
import {
  OTHER_SESSIONS_MESSAGE,
  SETUP_FAILED_MESSAGE,
  SETUP_REJECTIONS,
  SETUP_RESULTS,
  rejectionFor,
  rejectionState,
  setupResponseSchema,
} from "./account-setup";

describe("terminar la cuenta: lo que responde la base y lo que se le dice a la persona (H-116)", () => {
  it("reconoce los resultados de la base y descarta cualquier otra forma", () => {
    for (const result of SETUP_RESULTS) {
      expect(setupResponseSchema.safeParse({ result }).success, result).toBe(true);
    }
    expect(setupResponseSchema.safeParse({ result: "inventado" }).success).toBe(false);
    expect(setupResponseSchema.safeParse({}).success).toBe(false);
    expect(setupResponseSchema.safeParse(null).success).toBe(false);
    expect(
      setupResponseSchema.safeParse({ result: "completed", already_ready: true }).success,
    ).toBe(true);
  });

  it("cada rechazo tiene su mensaje, en español, sin jerga ni nombres técnicos", () => {
    const rejected = SETUP_RESULTS.filter(
      (result) => !["ok", "completed", "other_sessions"].includes(result),
    );
    expect(rejected.sort()).toEqual(Object.keys(SETUP_REJECTIONS).sort());
    for (const result of rejected) {
      const { message } = rejectionFor(result);
      expect(message.length, result).toBeGreaterThan(20);
      expect(message, result).not.toMatch(/_|undefined|Supabase|JWT|42501|amr/i);
    }
    expect(rejectionFor("other_sessions").message).toBe(OTHER_SESSIONS_MESSAGE);
  });

  it("un resultado que no es un rechazo nunca se presenta como éxito", () => {
    expect(rejectionFor("ok").message).toBe(SETUP_FAILED_MESSAGE);
    expect(rejectionFor("completed").message).toBe(SETUP_FAILED_MESSAGE);
  });

  it("solo los rechazos del enlace piden uno nuevo; el del nombre va en su campo", () => {
    expect(rejectionFor("not_email_link").expired).toBe(true);
    expect(rejectionFor("unverified").expired).toBe(true);
    for (const result of ["email_changed", "factor_present", "legal_changed"] as const) {
      expect(rejectionFor(result).expired, result).toBeUndefined();
    }
    const name = rejectionState(rejectionFor("invalid_name"), { fullName: "x" });
    expect(name.fieldErrors?.fullName).toMatch(/nombre/);
    expect(name.message).toBeUndefined();
    const general = rejectionState(rejectionFor("legal_changed"), { fullName: "x" });
    expect(general.message).toMatch(/términos/);
    expect(general.fieldErrors).toBeUndefined();
    expect(general.values).toEqual({ fullName: "x" });
  });
});
