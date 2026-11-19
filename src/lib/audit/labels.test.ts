import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTION_LABELS,
  actionLabel,
  auditActorText,
  describeAuditDetails,
  describeAuditEntry,
  describeAuditSubject,
  isKnownAuditAction,
  OUTSIDE_ACTOR_TEXT,
  resourceLabel,
} from "./labels";

describe("nombres del registro de actividad · precios bloqueados y descuento máximo (H-041)", () => {
  it("nombra la acción nueva y la puede elegir el filtro", () => {
    expect(actionLabel("quote.locked_price_overridden")).toBe(
      "Se cambió un precio bloqueado en una cotización",
    );
    expect(isKnownAuditAction("quote.locked_price_overridden")).toBe(true);
  });

  it("el detalle cuenta las líneas y los precios, sin nombres de línea", () => {
    const text = describeAuditEntry({
      action: "quote.locked_price_overridden",
      details: {
        count: 1,
        lines: [{ position: 2, catalog_item_id: "x", old_price_clp: 10_000, new_price_clp: 8_000 }],
      },
    });
    expect(text).toBe("Cambió: línea 2: $10.000 → $8.000");
  });

  it("un detalle ilegible no rompe el registro", () => {
    expect(
      describeAuditEntry({ action: "quote.locked_price_overridden", details: { count: 1 } }),
    ).toBeNull();
  });

  it("el descuento máximo se dice «Sin tope → 10 %», como la regla de aprobación", () => {
    const entry = (oldBp: number | null, newBp: number | null) =>
      describeAuditEntry({
        action: "tenant.updated",
        details: { old: { max_discount_bp: oldBp }, new: { max_discount_bp: newBp } },
      });
    expect(entry(null, 1_000)).toBe("Descuento máximo: Sin tope → 10 %");
    expect(entry(1_000, null)).toBe("Descuento máximo: 10 % → Sin tope");
    expect(entry(1_250, 0)).toBe("Descuento máximo: 12,5 % → 0 %");
  });

  it("el candado del precio dice «Bloqueó el precio» o «Quitó el bloqueo del precio»", () => {
    const entry = (locked: boolean) =>
      describeAuditEntry({
        action: "catalog_item.updated",
        details: { old: { price_locked: !locked }, new: { price_locked: locked } },
      });
    expect(entry(true)).toBe("Bloqueó el precio");
    expect(entry(false)).toBe("Quitó el bloqueo del precio");
  });

  it("si el mismo registro cambia también el precio, lo cuenta además", () => {
    expect(
      describeAuditEntry({
        action: "catalog_item.price_changed",
        details: {
          old: { price_locked: false, unit_price_clp: 1_000 },
          new: { price_locked: true, unit_price_clp: 2_000 },
        },
      }),
    ).toBe("Bloqueó el precio · Cambió: precio");
  });

  it("un valor ilegible cae en la frase general en vez de romper el registro", () => {
    expect(
      describeAuditEntry({
        action: "tenant.updated",
        details: { old: { max_discount_bp: "x" }, new: { max_discount_bp: 1_000 } },
      }),
    ).toBe("Cambió: descuento máximo");
  });

  it("los campos nuevos tienen nombre en español", () => {
    expect(describeAuditDetails({ changed: ["price_locked"] })).toBe("Cambió: precio bloqueado");
    expect(describeAuditDetails({ changed: ["max_discount_bp"] })).toBe("Cambió: descuento máximo");
  });
});

describe("nombres del registro de actividad", () => {
  it("cada acción conocida tiene nombre en español; las nuevas se muestran con su código", () => {
    expect(actionLabel("session.login")).toBe("Ingresó a la plataforma");
    expect(actionLabel("member.updated")).toBe("Cambió un miembro");
    expect(actionLabel("payment.confirmed")).toBe("payment.confirmed");
    for (const label of Object.values(AUDIT_ACTION_LABELS)) expect(label.length).toBeGreaterThan(0);
  });

  it("nombra la activación de la verificación en dos pasos (H-004a)", () => {
    expect(actionLabel("session.mfa_enrolled")).toBe("Activó la verificación en dos pasos");
    expect(isKnownAuditAction("session.mfa_enrolled")).toBe(true);
  });

  it("nombra el aviso de la activación y su reversión (H-118a)", () => {
    expect(actionLabel("session.mfa_notice_sent")).toBe(
      "Se envió el aviso de la activación de la verificación en dos pasos",
    );
    expect(actionLabel("session.mfa_enroll_reverted")).toMatch(/Se revirtió la activación/);
    expect(isKnownAuditAction("session.mfa_enroll_reverted")).toBe(true);
  });

  it("nombra la anulación de la activación y su fallo (H-118b)", () => {
    expect(actionLabel("session.mfa_annulled")).toMatch(/Se anuló la activación/);
    expect(actionLabel("session.mfa_annul_failed")).toMatch(/No se pudo terminar de anular/);
    expect(isKnownAuditAction("session.mfa_annulled")).toBe(true);
  });

  it("nombra los códigos de respaldo y la desactivación del segundo paso, sin mostrar nunca un código (H-004b)", () => {
    expect(actionLabel("session.mfa_recovery_codes_created")).toBe(
      "Creó códigos de respaldo de la verificación en dos pasos",
    );
    expect(actionLabel("session.mfa_recovery_used")).toMatch(/Entró con un código de respaldo/);
    expect(actionLabel("session.mfa_disabled")).toBe("Desactivó la verificación en dos pasos");
    expect(actionLabel("session.reauth_failed")).toMatch(/No se confirmó la contraseña/);
    for (const action of [
      "session.mfa_recovery_codes_created",
      "session.mfa_recovery_used",
      "session.mfa_disabled",
    ]) {
      expect(isKnownAuditAction(action), action).toBe(true);
      expect(actionLabel(action)).not.toBe(action);
    }
  });

  it("nombra los textos guardados y no muestra nunca su contenido (H-048a)", () => {
    expect(actionLabel("text_snippet.created")).toBe("Se creó un texto guardado");
    expect(actionLabel("text_snippet.updated")).toBe("Se cambió un texto guardado");
    expect(actionLabel("text_snippet.deleted")).toBe("Se eliminó un texto guardado");
    expect(isKnownAuditAction("text_snippet.deleted")).toBe(true);
    expect(resourceLabel("text_snippet")).toBe("Texto guardado");
    // lo que guarda la base: tipo, nombre y campos cambiados; la frase solo nombra los campos
    expect(
      describeAuditDetails({
        kind: "email_body",
        name: "Saludo con CANARIO",
        changed: ["name", "body", "is_default"],
      }),
    ).toBe("Cambió: nombre, texto, predeterminado");
    expect(
      describeAuditDetails({ kind: "conditions", name: "Pago con CANARIO", is_default: false }),
    ).toBeNull();
    expect(describeAuditDetails({ kind: "exclusions", name: "X", was_default: false })).toBeNull();
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
      "Se intentó aceptar una invitación dirigida a otra persona",
    );
    expect(isKnownAuditAction("invitation.accepted")).toBe(true);
    expect(isKnownAuditAction("invitation.accept_denied")).toBe(true);
  });
});

describe("cambiar el rol de un miembro o quitarlo (H-010)", () => {
  it("tienen nombre y se pueden elegir en el filtro del registro de actividad", () => {
    expect(actionLabel("member.role_changed")).toBe("Se cambió el rol de un miembro");
    expect(actionLabel("member.removed")).toBe("Se quitó a un miembro del equipo");
    expect(isKnownAuditAction("member.role_changed")).toBe(true);
    expect(isKnownAuditAction("member.removed")).toBe(true);
  });

  it("describen los roles y las invitaciones canceladas, sin mostrar correos ni nombres", () => {
    expect(
      describeAuditDetails({ old_role: "sales", new_role: "viewer", cancelled_invitations: 0 }),
    ).toBe("Rol: Comercial → Observador");
    expect(
      describeAuditDetails({ old_role: "admin", new_role: "sales", cancelled_invitations: 2 }),
    ).toBe(
      "Rol: Administrador → Comercial · se cancelaron 2 invitaciones que había enviado o reenviado",
    );
    expect(describeAuditDetails({ role: "sales", cancelled_invitations: 0 })).toBe(
      "Rol: Comercial",
    );
    expect(describeAuditDetails({ role: "admin", cancelled_invitations: 1 })).toBe(
      "Rol: Administrador · se canceló 1 invitación que había enviado o reenviado",
    );
    // Las acciones de invitaciones, que también llevan un rol, no cambian.
    expect(describeAuditDetails({ role: "sales" })).toBeNull();
  });

  it("la salida del equipo que deja el disparador general se lee en español", () => {
    expect(
      describeAuditDetails({
        old: { status: "active", removed_at: null, removed_by: null },
        new: { status: "removed", removed_at: "2026-11-05T10:00:00Z", removed_by: "x" },
      }),
    ).toBe("Cambió: estado, salida del equipo");
  });
});

describe("a quién afectó la acción (H-010: sin correos, el registro es lo que se lo cuenta al Dueño)", () => {
  const changed = { old_role: "sales", new_role: "viewer", cancelled_invitations: 0 };

  it("cambiar el rol dice a quién, de qué rol a cuál", () => {
    expect(
      describeAuditEntry({
        action: "member.role_changed",
        details: changed,
        subjectName: "María Pérez",
      }),
    ).toBe("Cambió el rol de María Pérez de Comercial a Observador");
  });

  it("quitar a alguien dice a quién, y cuántas invitaciones se cancelaron", () => {
    expect(
      describeAuditEntry({
        action: "member.removed",
        details: { role: "admin", cancelled_invitations: 0 },
        subjectName: "María Pérez",
      }),
    ).toBe("Quitó a María Pérez del equipo");
    expect(
      describeAuditEntry({
        action: "member.removed",
        details: { role: "admin", cancelled_invitations: 2 },
        subjectName: "María Pérez",
      }),
    ).toBe(
      "Quitó a María Pérez del equipo · se cancelaron 2 invitaciones que había enviado o reenviado",
    );
    expect(
      describeAuditEntry({
        action: "member.role_changed",
        details: { ...changed, old_role: "admin", cancelled_invitations: 1 },
        subjectName: "María Pérez",
      }),
    ).toBe(
      "Cambió el rol de María Pérez de Administrador a Observador · se canceló 1 invitación que había enviado o reenviado",
    );
  });

  it("si el nombre no se puede leer dice «una persona del equipo»", () => {
    for (const subjectName of [null, undefined, "", "   "]) {
      expect(describeAuditEntry({ action: "member.removed", details: {}, subjectName })).toBe(
        "Quitó a una persona del equipo",
      );
      expect(
        describeAuditEntry({ action: "member.role_changed", details: changed, subjectName }),
      ).toBe("Cambió el rol de una persona del equipo de Comercial a Observador");
    }
  });

  it("nunca muestra un correo, aunque el nombre del perfil o los detalles lo traigan escondido", () => {
    const text = describeAuditEntry({
      action: "member.role_changed",
      details: { ...changed, email: "x@ejemplo.test" },
      subjectName: "Ana",
    });
    expect(text).not.toContain("@");
  });

  it("las demás acciones siguen como antes", () => {
    expect(
      describeAuditEntry({
        action: "member.updated",
        details: { old: { role: "sales" }, new: { role: "admin" } },
      }),
    ).toBe("Rol: Comercial → Administrador");
    expect(describeAuditEntry({ action: "tenant.updated", details: null })).toBeNull();
  });

  it("«sobre qué» agrega la persona solo cuando el recurso es un miembro", () => {
    expect(describeAuditSubject({ resourceType: "member", subjectName: "María Pérez" })).toBe(
      "Miembro: María Pérez",
    );
    expect(describeAuditSubject({ resourceType: "member", subjectName: null })).toBe(
      "Miembro: una persona del equipo",
    );
    expect(describeAuditSubject({ resourceType: "customer", subjectName: "María Pérez" })).toBe(
      "Cliente",
    );
    expect(describeAuditSubject({ resourceType: null })).toBe("—");
  });
});

describe("quién hizo cada acción (auditActorText)", () => {
  const base = { actorName: null, actorOutside: false, actorType: "user" as const };

  it("con nombre, el nombre (también de quien ya no está)", () => {
    expect(auditActorText({ ...base, actorName: "María Pérez" })).toBe("María Pérez");
  });

  it("una persona de fuera de la organización (fila de «user» sin id) se dice como tal", () => {
    expect(OUTSIDE_ACTOR_TEXT).toBe("Una persona de fuera de tu organización");
    expect(auditActorText({ ...base, actorOutside: true })).toBe(OUTSIDE_ACTOR_TEXT);
  });

  it("el sistema, una visita sin cuenta y un servicio tienen su propio texto", () => {
    expect(auditActorText({ ...base, actorType: "system" })).toBe("El sistema");
    expect(auditActorText({ ...base, actorType: "public" })).toBe("Una visita sin cuenta");
    expect(auditActorText({ ...base, actorType: "service" })).toBe("Un servicio automático");
  });

  it("una persona con id pero sin nombre legible sigue siendo «alguien que ya no está en el equipo»", () => {
    expect(auditActorText(base)).toBe("Alguien que ya no está en el equipo");
  });
});

describe("la regla de aprobación en el registro de actividad (H-040)", () => {
  it("nombra la acción y el recurso", () => {
    expect(actionLabel("approval_rule.updated")).toBe("Cambió la regla de aprobación");
    expect(isKnownAuditAction("approval_rule.updated")).toBe(true);
    expect(resourceLabel("approval_rule")).toBe("Regla de aprobación");
  });

  it("cuenta la regla de antes y la de ahora con la misma frase de la pantalla", () => {
    expect(
      describeAuditEntry({
        action: "approval_rule.updated",
        details: {
          version: 3,
          old: { mode: "never", amount_threshold_clp: null, discount_threshold_bp: null },
          new: { mode: "conditional", amount_threshold_clp: 2000000, discount_threshold_bp: 1000 },
        },
      }),
    ).toBe(
      "Antes: No se pide aprobación: las cotizaciones se envían directo. Ahora: Se pide aprobación si el total supera $2.000.000 o el descuento supera 10%.",
    );
  });

  it("si el detalle no tiene la forma esperada, no inventa nada", () => {
    expect(
      describeAuditEntry({ action: "approval_rule.updated", details: { old: 1, new: "x" } }),
    ).toBeNull();
    expect(describeAuditEntry({ action: "approval_rule.updated", details: {} })).toBeNull();
  });
});
