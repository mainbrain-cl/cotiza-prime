import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTION_LABELS,
  actionLabel,
  describeAuditDetails,
  isKnownAuditAction,
  resourceLabel,
} from "./labels";

describe("nombres del registro de actividad", () => {
  it("cada acción conocida tiene nombre en español; las nuevas se muestran con su código", () => {
    expect(actionLabel("session.login")).toBe("Ingresó a la plataforma");
    expect(actionLabel("member.updated")).toBe("Cambió un miembro");
    expect(actionLabel("payment.confirmed")).toBe("payment.confirmed");
    for (const label of Object.values(AUDIT_ACTION_LABELS)) expect(label.length).toBeGreaterThan(0);
  });

  it("solo las acciones de la lista se aceptan como filtro", () => {
    expect(isKnownAuditAction("member.updated")).toBe(true);
    expect(isKnownAuditAction("toString")).toBe(false);
    expect(isKnownAuditAction("__proto__")).toBe(false);
    expect(isKnownAuditAction("x.y")).toBe(false);
  });

  it("nombra el recurso o deja una raya", () => {
    expect(resourceLabel("customer")).toBe("Cliente");
    expect(resourceLabel(null)).toBe("—");
    expect(resourceLabel("algo_nuevo")).toBe("algo_nuevo");
  });

  it("describe un cambio de rol con los dos roles", () => {
    expect(describeAuditDetails({ old: { role: "sales" }, new: { role: "admin" } })).toBe(
      "Rol: Comercial → Administrador",
    );
  });

  it("de un cambio de datos nombra los campos sin mostrar valores", () => {
    expect(
      describeAuditDetails({ old: { name: "A" }, new: { name: "B", contact_email: "x@y.cl" } }),
    ).toBe("Cambió: nombre, correo de contacto");
    expect(describeAuditDetails({ changed: ["email_enc", "phone_enc"] })).toBe(
      "Cambió: correo, teléfono",
    );
    expect(describeAuditDetails({ changed: ["campo_raro"] })).toBe("Cambió: otros datos");
  });

  it("sin cambios que contar no agrega nada", () => {
    expect(describeAuditDetails({})).toBeNull();
    expect(describeAuditDetails(null)).toBeNull();
    expect(describeAuditDetails("texto")).toBeNull();
  });
});

describe("las acciones de aceptar una invitación (H-009)", () => {
  it("tienen nombre y se pueden elegir en el filtro del registro de actividad", () => {
    expect(actionLabel("invitation.accepted")).toBe("Una persona aceptó la invitación al equipo");
    expect(actionLabel("invitation.accept_denied")).toBe(
      "Alguien intentó usar una invitación con otro correo",
    );
    expect(isKnownAuditAction("invitation.accepted")).toBe(true);
    expect(isKnownAuditAction("invitation.accept_denied")).toBe(true);
  });
});
