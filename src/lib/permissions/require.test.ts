import { describe, expect, it } from "vitest";
import { MEMBER_ROLES, NO_PERMISSION_MESSAGE } from "./matrix";
import { pagePermission, requirePermission } from "./require";

const TENANT_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0001";

describe("requirePermission", () => {
  it("devuelve null a quien puede y el mensaje único a quien no", () => {
    expect(requirePermission({ role: "owner" }, "catalog.manage")).toBeNull();
    expect(requirePermission({ role: "sales" }, "catalog.manage")).toBe(NO_PERMISSION_MESSAGE);
    expect(requirePermission({ role: "viewer" }, "customer.write")).toBe(NO_PERMISSION_MESSAGE);
  });

  it("sin isOwn la revisión es gruesa: el Comercial pasa en lo que solo puede sobre lo suyo", () => {
    expect(requirePermission({ role: "sales" }, "quote.edit")).toBeNull();
    expect(requirePermission({ role: "viewer" }, "quote.edit")).toBe(NO_PERMISSION_MESSAGE);
    expect(requirePermission({ role: "approver" }, "quote.edit")).toBe(NO_PERMISSION_MESSAGE);
  });

  it("con isOwn explícito la revisión es exacta", () => {
    expect(requirePermission({ role: "sales" }, "quote.edit", { isOwn: true })).toBeNull();
    expect(requirePermission({ role: "sales" }, "quote.edit", { isOwn: false })).toBe(
      NO_PERMISSION_MESSAGE,
    );
    expect(requirePermission({ role: "owner" }, "quote.edit", { isOwn: false })).toBe(
      NO_PERMISSION_MESSAGE,
    );
  });

  it("con ctx sin isOwn definido se trata como isOwn false (nunca cae a la revisión gruesa)", () => {
    expect(requirePermission({ role: "sales" }, "quote.edit", {})).toBe(NO_PERMISSION_MESSAGE);
    expect(requirePermission({ role: "sales" }, "quote.edit", { isOwn: undefined })).toBe(
      NO_PERMISSION_MESSAGE,
    );
    expect(requirePermission({ role: "sales" }, "quote.resend", { isOwn: undefined })).toBe(
      NO_PERMISSION_MESSAGE,
    );
    expect(requirePermission({ role: "owner" }, "quote.resend", { isOwn: undefined })).toBeNull();
  });

  it("un rol desconocido nunca pasa", () => {
    expect(requirePermission({ role: "superadmin" }, "org.view")).toBe(NO_PERMISSION_MESSAGE);
  });
});

describe("pagePermission", () => {
  it("sin ctx es gruesa; con ctx es exacta y un isOwn ausente cuenta como false", () => {
    const tenant = { tenantId: TENANT_ID };
    expect(pagePermission({ role: "sales", ...tenant }, "quote.edit")).toBeNull();
    expect(pagePermission({ role: "sales", ...tenant }, "quote.edit", { isOwn: true })).toBeNull();
    expect(
      pagePermission({ role: "sales", ...tenant }, "quote.edit", { isOwn: false }),
    ).not.toBeNull();
    expect(
      pagePermission({ role: "sales", ...tenant }, "quote.edit", { isOwn: undefined }),
    ).not.toBeNull();
  });

  it("devuelve null a quien puede", () => {
    for (const role of MEMBER_ROLES) {
      expect(pagePermission({ role, tenantId: TENANT_ID }, "org.view")).toBeNull();
    }
  });

  it("a quien no puede le devuelve la pantalla «No tienes permiso» de su organización", () => {
    const screen = pagePermission({ role: "viewer", tenantId: TENANT_ID }, "settings.manage");
    expect(screen).not.toBeNull();
    expect(screen?.props).toEqual({ tenantId: TENANT_ID });
  });
});
