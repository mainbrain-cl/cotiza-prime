import { describe, expect, it } from "vitest";
import {
  MEMBER_ROLES,
  NO_PERMISSION_MESSAGE,
  ROLE_DESCRIPTIONS,
  can,
} from "@/lib/permissions/matrix";
import {
  ROLE_OPTIONS,
  canResendInvitation,
  managesTeam,
  roleOptionsFor,
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

const OWNER = MEMBER_ROLES[0];
const ADMIN = MEMBER_ROLES[1];

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
  it("al Dueño se le ofrecen sobre cualquiera que no sea él mismo, también sobre un Administrador", () => {
    for (const role of MEMBER_ROLES.slice(1)) {
      expect(memberControls({ role, isSelf: false }, OWNER)).toEqual({
        canChangeRole: true,
        canRemove: true,
        lockedReason: null,
      });
    }
  });

  it("al Administrador, solo sobre quien no maneja el equipo; un Administrador es «solo el Dueño»", () => {
    for (const role of MEMBER_ROLES.slice(1)) {
      const controls = memberControls({ role, isSelf: false }, ADMIN);
      if (managesTeam(role)) {
        expect(controls).toEqual({
          canChangeRole: false,
          canRemove: false,
          lockedReason: "owner_only",
        });
      } else {
        expect(controls).toEqual({ canChangeRole: true, canRemove: true, lockedReason: null });
      }
    }
    // Hoy, el único rol así es el de Administrador.
    expect(memberControls({ role: ADMIN, isSelf: false }, ADMIN).lockedReason).toBe("owner_only");
  });

  it("el Dueño no tiene acciones, aunque no sea uno mismo", () => {
    for (const viewer of [OWNER, ADMIN]) {
      expect(memberControls({ role: OWNER, isSelf: false }, viewer)).toEqual({
        canChangeRole: false,
        canRemove: false,
        lockedReason: "organization_owner",
      });
    }
  });

  it("uno mismo tampoco, sea el rol que sea", () => {
    for (const role of MEMBER_ROLES.slice(1)) {
      expect(memberControls({ role, isSelf: true }, role)).toEqual({
        canChangeRole: false,
        canRemove: false,
        lockedReason: "yourself",
      });
    }
  });
});

describe("qué roles se ofrecen al cambiar el rol y al invitar", () => {
  it("el Dueño ve los cuatro; el Administrador, solo los que no manejan el equipo (sin Administrador)", () => {
    expect(roleOptionsFor(OWNER)).toEqual([...ROLE_OPTIONS]);
    const forAdmin = roleOptionsFor(ADMIN);
    expect(forAdmin.map((option) => option.value)).toEqual(
      ROLE_OPTIONS.filter((option) => !can(option.value, "team.manage")).map((o) => o.value),
    );
    expect(forAdmin.map((option) => option.value)).not.toContain(ADMIN);
    expect(forAdmin).toHaveLength(3);
  });

  it("cada opción sabe si maneja el equipo (para avisar que se cancelan sus invitaciones)", () => {
    for (const option of ROLE_OPTIONS) expect(option.managesTeam).toBe(managesTeam(option.value));
    expect(ROLE_OPTIONS.filter((option) => option.managesTeam).map((o) => o.value)).toEqual([
      ADMIN,
    ]);
  });
});

describe("quién reenvía una invitación (H-010)", () => {
  it("la de un rol que maneja el equipo, solo el Dueño; las demás, también el Administrador", () => {
    for (const option of ROLE_OPTIONS) {
      expect(canResendInvitation(option.value, OWNER), option.value).toBe(true);
      expect(canResendInvitation(option.value, ADMIN), option.value).toBe(!option.managesTeam);
    }
    expect(canResendInvitation(ADMIN, ADMIN)).toBe(false);
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
    const item = toMemberItem(record(), TENANT, OWNER);
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
    expect(toMemberItem(record({ name: null }), TENANT, OWNER).displayName).toBe(
      "juan@ejemplo.test",
    );
    expect(toMemberItem(record({ name: null, email: null }), TENANT, OWNER).displayName).toBe(
      "esta persona",
    );
  });

  it("el Dueño queda marcado y sin acciones", () => {
    const item = toMemberItem(record({ role: MEMBER_ROLES[0] }), TENANT, OWNER);
    expect(item).toMatchObject({
      roleLabel: "Dueño",
      isOwner: true,
      canChangeRole: false,
      canRemove: false,
      lockedReason: "organization_owner",
    });
  });

  it("un Administrador visto por otro Administrador: sin acciones y con su motivo", () => {
    expect(toMemberItem(record({ role: ADMIN }), TENANT, ADMIN)).toMatchObject({
      isOwner: false,
      canChangeRole: false,
      canRemove: false,
      lockedReason: "owner_only",
    });
    expect(toMemberItem(record({ role: ADMIN }), TENANT, OWNER)).toMatchObject({
      canChangeRole: true,
      canRemove: true,
      lockedReason: null,
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
    expect(mapMemberError({ code: "42501", message: "owner_only" })).toEqual({
      kind: "owner_only",
      message:
        "Solo el Dueño puede nombrar Administradores, cambiarles el rol o quitarlos del equipo.",
    });
    expect(mapMemberError({ code: "42501", message: "forbidden" }).kind).toBe("forbidden");
    expect(mapMemberError({ code: "CP429", message: "limit_member_changes" })).toEqual({
      kind: "rate_limited",
      message:
        "Hiciste muchos cambios en tu equipo en la última hora (cambios de rol y personas quitadas). Espera un rato y vuelve a intentar.",
    });
  });

  it("un código desconocido da un mensaje genérico sin detalle técnico", () => {
    const mapped = mapMemberError({ code: "XX000", message: 'relation "members" does not exist' });
    expect(mapped.kind).toBe("other");
    expect(mapped.message).not.toContain("members");
    expect(mapMemberError({}).kind).toBe("other");
  });
});
