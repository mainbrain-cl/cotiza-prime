import { describe, expect, it } from "vitest";
import { canRevokeLinks, REVOCABLE_STATUSES } from "./link-rules";

describe("canRevokeLinks (H-035)", () => {
  it("solo se revoca mientras el cliente no ha respondido", () => {
    expect(REVOCABLE_STATUSES).toEqual(["sent", "viewed"]);
    for (const status of ["sent", "viewed"]) {
      expect(canRevokeLinks({ role: "owner", isAuthor: false, status })).toBe(true);
    }
    for (const status of [
      "draft",
      "accepted",
      "rejected_by_customer",
      "expired",
      "pending_payment",
      "pending_deposit",
      "paid",
      "superseded",
    ]) {
      expect(canRevokeLinks({ role: "owner", isAuthor: true, status }), status).toBe(false);
    }
  });

  it("el autor, el Dueño y el Administrador pueden; el resto no", () => {
    expect(canRevokeLinks({ role: "sales", isAuthor: true, status: "sent" })).toBe(true);
    expect(canRevokeLinks({ role: "sales", isAuthor: false, status: "sent" })).toBe(false);
    expect(canRevokeLinks({ role: "admin", isAuthor: false, status: "viewed" })).toBe(true);
    expect(canRevokeLinks({ role: "owner", isAuthor: false, status: "viewed" })).toBe(true);
    for (const role of ["approver", "viewer", "observer"]) {
      expect(canRevokeLinks({ role, isAuthor: true, status: "sent" }), role).toBe(false);
    }
  });
});
