import { describe, expect, it } from "vitest";
import {
  QUOTE_STATUSES,
  STATUS_DEFINITIONS,
  getStatusDefinition,
  type StatusTone,
} from "./status-badge";

const EXPECTED_TONES: Record<StatusTone, string[]> = {
  neutral: ["draft", "expired", "replaced"],
  accent: ["sent", "viewed"],
  warning: [
    "pending_approval",
    "changes_requested",
    "pending_payment",
    "pending_deposit",
    "pending_balance",
  ],
  success: ["accepted", "deposit_paid"],
  "success-solid": ["paid"],
  danger: ["rejected_internal", "rejected_by_client"],
};

describe("estados de la cotización", () => {
  it("define los 15 estados, cada uno con su etiqueta", () => {
    expect(QUOTE_STATUSES).toHaveLength(15);
    for (const status of QUOTE_STATUSES) {
      expect(STATUS_DEFINITIONS[status].label.length).toBeGreaterThan(0);
    }
    const labels = QUOTE_STATUSES.map((status) => STATUS_DEFINITIONS[status].label);
    expect(new Set(labels).size).toBe(15);
  });

  it.each(Object.entries(EXPECTED_TONES))(
    "el color %s agrupa los estados de DISENO.md",
    (tone, statuses) => {
      const actual = QUOTE_STATUSES.filter((status) => getStatusDefinition(status).tone === tone);
      expect([...actual].sort()).toEqual([...statuses].sort());
    },
  );

  it("solo Reemplazada va tachada", () => {
    const struck = QUOTE_STATUSES.filter((status) => getStatusDefinition(status).strikethrough);
    expect(struck).toEqual(["replaced"]);
  });
});
