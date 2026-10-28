// La matriz de permisos escrita A MANO, fila por fila (PROYECTO.md §5.2 y el diseño del sprint 5).
// Cambiar la matriz obliga a cambiar esta tabla a propósito: es lo que impide que un permiso se
// amplíe sin que alguien lo note. La migración `role_matrix` y `tests/db/permissions-parity.test.ts`
// vigilan que la base diga lo mismo.
import { describe, expect, it } from "vitest";
import {
  ASSIGNABLE_ROLES,
  GRANTABLE_ROLES,
  MEMBER_ROLES,
  NO_PERMISSION_MESSAGE,
  PERMISSIONS,
  PERMISSION_ACTIONS,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  can,
  canEver,
  isMemberRole,
  roleLabel,
  rolesThatCanEver,
  type MemberRole,
  type PermissionAction,
} from "./matrix";

/** «A» = puede sobre cualquier recurso · «s» = solo sobre lo suyo · «–» = no puede. Orden: Dueño, Admin, Aprobador, Comercial, Observador. */
const EXPECTED: Record<PermissionAction, string> = {
  "org.view": "AAAAA",
  "quote.create": "AA–A–",
  "quote.edit": "ss–s–",
  "quote.send": "ss–s–",
  "quote.resend": "AA–s–",
  "quote.link.revoke": "AA–s–",
  "quote.link_views.read": "AA–––",
  "quote.approval.request": "ss–s–",
  "quote.approve": "AAA––",
  "bank_account.manage": "AA–––",
  "payment.confirm": "AA–––",
  "payment.second.request": "AA–s–",
  "customer.write": "AA–A–",
  "catalog.manage": "AA–––",
  "catalog.price_lock.override": "AA–––",
  "settings.manage": "AA–––",
  "team.manage": "AA–––",
  "intake.forms.manage": "AA–––",
  "intake.protection.read": "AA–––",
  "intake.requests.assign": "AA–––",
  "intake.requests.anonymize": "AA–––",
  "intake.requests.discard": "AA–s–",
  "intake.requests.restore": "AA–s–",
  "intake.requests.convert": "AA–s–",
  "audit.read": "A––––",
  "tenant.billing.manage": "A––––",
  "tenant.delete": "A––––",
  "tenant.transfer": "A––––",
};

const ROLE_ORDER: readonly MemberRole[] = ["owner", "admin", "approver", "sales", "viewer"];

describe("la matriz de permisos", () => {
  it("la tabla de la prueba cubre exactamente las acciones de la matriz", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...PERMISSION_ACTIONS].sort());
  });

  it("los cinco roles son los de PROYECTO.md §5.1, en ese orden", () => {
    expect([...MEMBER_ROLES]).toEqual([...ROLE_ORDER]);
  });

  describe.each(Object.entries(EXPECTED) as [PermissionAction, string][])("%s", (action, row) => {
    it.each(ROLE_ORDER.map((role, index) => [role, row[index]] as const))(
      "%s → %s",
      (role, mark) => {
        expect(can(role, action)).toBe(mark === "A");
        expect(can(role, action, { isOwn: false })).toBe(mark === "A");
        expect(can(role, action, { isOwn: true })).toBe(mark === "A" || mark === "s");
        expect(canEver(role, action)).toBe(mark !== "–");
      },
    );
  });

  it("una acción desconocida da «no» para todos, también con isOwn", () => {
    for (const role of MEMBER_ROLES) {
      expect(can(role, "no.existe" as PermissionAction, { isOwn: true })).toBe(false);
      expect(canEver(role, "no.existe" as PermissionAction)).toBe(false);
    }
  });

  it("un nombre heredado del objeto (constructor, __proto__) no cuenta como acción", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(can("owner", name as PermissionAction, { isOwn: true })).toBe(false);
    }
  });

  it("un rol desconocido, vacío o nulo da «no»", () => {
    for (const role of ["superadmin", "", "Owner", " owner", null, undefined]) {
      expect(can(role, "org.view", { isOwn: true })).toBe(false);
      expect(canEver(role, "org.view")).toBe(false);
    }
  });

  it("todo rol puede ver todo (decisión 009)", () => {
    for (const role of MEMBER_ROLES) expect(can(role, "org.view")).toBe(true);
  });

  it("el Comercial y el Observador nunca tocan el dinero, ni lo suyo", () => {
    for (const action of [
      "payment.confirm",
      "bank_account.manage",
    ] as const satisfies PermissionAction[]) {
      for (const role of ["approver", "sales", "viewer"] as const) {
        expect(canEver(role, action)).toBe(false);
      }
    }
  });

  it("solo el Dueño maneja el plan, elimina y transfiere la organización", () => {
    for (const action of ["tenant.billing.manage", "tenant.delete", "tenant.transfer"] as const) {
      expect(rolesThatCanEver(action)).toEqual(["owner"]);
    }
  });

  it("nadie edita un borrador ajeno: ni el Dueño", () => {
    for (const role of MEMBER_ROLES) {
      expect(can(role, "quote.edit", { isOwn: false })).toBe(false);
      expect(can(role, "quote.send", { isOwn: false })).toBe(false);
    }
  });

  it("toda regla nombra solo roles que existen", () => {
    for (const action of PERMISSION_ACTIONS) {
      const rule = PERMISSIONS[action] as {
        any?: readonly string[];
        own?: readonly string[];
      };
      for (const role of [...(rule.any ?? []), ...(rule.own ?? [])]) {
        expect(isMemberRole(role), `${action}: ${role}`).toBe(true);
      }
    }
  });
});

describe("roles que se pueden asignar o dar", () => {
  it("una solicitud se asigna al Dueño, a los Administradores y a los Comerciales", () => {
    expect([...ASSIGNABLE_ROLES]).toEqual(["owner", "admin", "sales"]);
  });

  it("a un miembro se le puede dar cualquier rol menos Dueño (que es único)", () => {
    expect([...GRANTABLE_ROLES]).toEqual(["admin", "approver", "sales", "viewer"]);
  });
});

describe("nombres de los roles", () => {
  it("cada rol tiene su nombre y su frase", () => {
    expect(ROLE_LABELS).toEqual({
      owner: "Dueño",
      admin: "Administrador",
      approver: "Aprobador",
      sales: "Comercial",
      viewer: "Observador",
    });
    for (const role of MEMBER_ROLES) {
      expect(ROLE_DESCRIPTIONS[role].length).toBeGreaterThan(20);
      expect(ROLE_DESCRIPTIONS[role].endsWith(".")).toBe(true);
    }
  });

  it("un rol desconocido se muestra tal cual", () => {
    expect(roleLabel("sales")).toBe("Comercial");
    expect(roleLabel("otro")).toBe("otro");
  });

  it("el mensaje de falta de permiso es único", () => {
    expect(NO_PERMISSION_MESSAGE).toBe("No tienes permiso para esto.");
  });
});
