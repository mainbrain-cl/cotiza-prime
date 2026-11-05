import { describe, expect, it } from "vitest";
import { MEMBER_ROLES, NO_PERMISSION_MESSAGE, ROLE_DESCRIPTIONS } from "@/lib/permissions/matrix";
import {
  ROLE_OPTIONS,
  changeRoleSchema,
  isOwnerRole,
  mapMemberError,
  memberControls,
  memberListSchema,
  removeMemberSchema,
  toMemberItem,
  type MemberRecord,
} from "./members-model";

const TENANT = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0001";
const MEMBER_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0010";
const USER_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0011";

const record = (over: Partial<MemberRecord> = {}): MemberRecord => ({
  memberId: MEMBER_ID,
  userId: USER_ID,
  name: "Juan Pérez",
  email: "juan@ejemplo.test",
  role: MEMBER_ROLES[3],
  joinedAt: "2026-11-03T15:00:00.000Z",
  isSelf: false,
  ...over,
});

describe("quién es el Dueño", () => {
  it("solo el rol que puede transferir la organización (se decide con la matriz)", () => {
    expect(MEMBER_ROLES.filter(isOwnerRole)).toEqual([MEMBER_ROLES[0]]);
    expect(isOwnerRole("no-existe")).toBe(false);
  });
});

describe("qué acciones se ofrecen sobre un miembro", () => {
  it("cualquiera que no sea el Dueño ni uno mismo: cambiar el rol y quitar", () => {
    for (const role of MEMBER_ROLES.slice(1)) {
      expect(memberControls({ role, isSelf: false })).toEqual({
        canChangeRole: true,
        canRemove: true,
        lockedReason: null,
      });
    }
  });

  it("el Dueño no tiene acciones, aunque no sea uno mismo", () => {
    expect(memberControls({ role: MEMBER_ROLES[0], isSelf: false })).toEqual({
      canChangeRole: false,
      canRemove: false,
      lockedReason: "organization_owner",
    });
  });

  it("uno mismo tampoco, sea el rol que sea", () => {
    for (const role of MEMBER_ROLES.slice(1)) {
      expect(memberControls({ role, isSelf: true })).toEqual({
        canChangeRole: false,
        canRemove: false,
        lockedReason: "yourself",
      });
    }
  });
});

describe("lo que entrega list_members", () => {
  const row = {
    member_id: MEMBER_ID,
    user_id: USER_ID,
    full_name: "Juan Pérez",
    email: "juan@ejemplo.test",
    role: MEMBER_ROLES[3],
    joined_at: "2026-11-03T15:00:00+00:00",
    is_self: false,
  };

  it("se lee con nombres propios", () => {
    expect(memberListSchema.parse([row])).toEqual([
      {
        memberId: MEMBER_ID,
        userId: USER_ID,
        name: "Juan Pérez",
        email: "juan@ejemplo.test",
        role: MEMBER_ROLES[3],
        joinedAt: "2026-11-03T15:00:00+00:00",
        isSelf: false,
      },
    ]);
    expect(memberListSchema.parse([])).toEqual([]);
  });

  it("un rol desconocido o una forma rara hace fallar la lectura (nunca se inventa un rol)", () => {
    expect(memberListSchema.safeParse([{ ...row, role: "superjefe" }]).success).toBe(false);
    expect(memberListSchema.safeParse([{ ...row, member_id: "no-es-un-uuid" }]).success).toBe(
      false,
    );
    expect(memberListSchema.safeParse({}).success).toBe(false);
  });

  it("acepta un nombre o un correo vacíos", () => {
    const parsed = memberListSchema.parse([{ ...row, full_name: null, email: null }]);
    expect(parsed[0].name).toBeNull();
    expect(parsed[0].email).toBeNull();
  });
});

describe("cómo se muestra un miembro", () => {
  it("nombre, rol con su frase, fecha dd-mm-aaaa y la ficha", () => {
    const item = toMemberItem(record(), TENANT);
    expect(item.displayName).toBe("Juan Pérez");
    expect(item.roleLabel).toBe("Comercial");
    expect(item.roleDescription).toBe(ROLE_DESCRIPTIONS.sales);
    expect(item.joinedLabel).toBe("Ingresó el 03-11-2026");
    expect(item.href).toBe(`/o/${TENANT}/equipo/${MEMBER_ID}`);
    expect(item).toMatchObject({
      isSelf: false,
      isOwner: false,
      canChangeRole: true,
      canRemove: true,
    });
  });

  it("sin nombre usa el correo; sin ninguno, «esta persona»", () => {
    expect(toMemberItem(record({ name: null }), TENANT).displayName).toBe("juan@ejemplo.test");
    expect(toMemberItem(record({ name: null, email: null }), TENANT).displayName).toBe(
      "esta persona",
    );
  });

  it("el Dueño queda marcado y sin acciones", () => {
    const item = toMemberItem(record({ role: MEMBER_ROLES[0] }), TENANT);
    expect(item).toMatchObject({
      roleLabel: "Dueño",
      isOwner: true,
      canChangeRole: false,
      canRemove: false,
    });
  });

  it("los roles que se pueden dar son cuatro y ninguno es el Dueño", () => {
    expect(ROLE_OPTIONS).toHaveLength(4);
    expect(ROLE_OPTIONS.map((option) => option.label)).not.toContain("Dueño");
    for (const option of ROLE_OPTIONS) expect(option.description.length).toBeGreaterThan(10);
  });
});

describe("lo que se acepta al cambiar el rol o quitar", () => {
  const valid = { memberId: MEMBER_ID, newRole: MEMBER_ROLES[4], expectedRole: MEMBER_ROLES[3] };

  it("un id, un rol que se pueda dar y el rol que la persona vio", () => {
    expect(changeRoleSchema.safeParse(valid).success).toBe(true);
    expect(
      removeMemberSchema.safeParse({ memberId: MEMBER_ID, expectedRole: "sales" }).success,
    ).toBe(true);
  });

  it("el Dueño nunca es el rol nuevo", () => {
    const result = changeRoleSchema.safeParse({ ...valid, newRole: MEMBER_ROLES[0] });
    expect(result.success).toBe(false);
  });

  it("rechaza ids que no son UUID y roles inventados", () => {
    expect(changeRoleSchema.safeParse({ ...valid, memberId: "1; drop table" }).success).toBe(false);
    expect(changeRoleSchema.safeParse({ ...valid, newRole: "superjefe" }).success).toBe(false);
    expect(changeRoleSchema.safeParse({ ...valid, expectedRole: "superjefe" }).success).toBe(false);
    expect(removeMemberSchema.safeParse({ memberId: MEMBER_ID, expectedRole: "" }).success).toBe(
      false,
    );
  });

  it("el rol esperado puede ser el del Dueño (la base es quien lo rechaza)", () => {
    expect(changeRoleSchema.safeParse({ ...valid, expectedRole: MEMBER_ROLES[0] }).success).toBe(
      true,
    );
  });
});

describe("mensajes de error", () => {
  it("cada código de la base tiene su mensaje claro", () => {
    expect(mapMemberError({ code: "42501" })).toEqual({
      kind: "forbidden",
      message: NO_PERMISSION_MESSAGE,
    });
    expect(mapMemberError({ code: "CP404", message: "member_not_found" }).kind).toBe("not_found");
    expect(mapMemberError({ code: "CP404", message: "not_found" }).kind).toBe("not_found");
    expect(mapMemberError({ code: "CP409", message: "role_changed" })).toEqual({
      kind: "role_changed",
      message: "El rol cambió mientras lo editabas. Recarga la página para ver cómo quedó.",
    });
    expect(mapMemberError({ code: "CP423", message: "cannot_target_owner" }).kind).toBe(
      "target_owner",
    );
    expect(mapMemberError({ code: "CP423", message: "cannot_target_self" }).kind).toBe(
      "target_self",
    );
    expect(mapMemberError({ code: "CP422", message: "invalid_role" }).kind).toBe("invalid");
    expect(mapMemberError({ code: "CP422", message: "invalid_arguments" }).kind).toBe("invalid");
  });

  it("un código desconocido da un mensaje genérico sin detalle técnico", () => {
    const mapped = mapMemberError({ code: "XX000", message: 'relation "members" does not exist' });
    expect(mapped.kind).toBe("other");
    expect(mapped.message).not.toContain("members");
    expect(mapMemberError({}).kind).toBe("other");
  });
});
