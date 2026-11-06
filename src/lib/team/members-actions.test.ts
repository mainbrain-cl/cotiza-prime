import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_ROLES, NO_PERMISSION_MESSAGE, can } from "@/lib/permissions/matrix";

// Las acciones de la lista del equipo con un falso miembro de cada rol: quien no maneja el equipo recibe el
// mensaje único y la base NI SE CONSULTA; quien sí, llega a las funciones de la base con los argumentos justos.

const TENANT_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0001";
const USER_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0002";
const MEMBER_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0003";

const rpc = vi.fn();
const from = vi.fn();
const revalidatePath = vi.fn();
const logged: string[] = [];
let role: string = MEMBER_ROLES[0];

vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));
vi.mock("@/lib/tenant/active-tenant", () => ({
  requireActiveTenant: vi.fn(async () => ({
    tenantId: TENANT_ID,
    tenantName: "Negocio de Prueba",
    role,
    userId: USER_ID,
    supabase: { rpc, from },
  })),
}));

const { changeMemberRoleAction, removeMemberAction } = await import("./members-actions");

beforeEach(() => {
  role = MEMBER_ROLES[0];
  rpc.mockReset();
  from.mockReset();
  revalidatePath.mockReset();
  logged.length = 0;
  vi.spyOn(console, "error").mockImplementation((line: string) => {
    logged.push(String(line));
  });
});

const changeArgs = [TENANT_ID, MEMBER_ID, MEMBER_ROLES[4], MEMBER_ROLES[3]] as const;
const removeArgs = [TENANT_ID, MEMBER_ID, MEMBER_ROLES[3]] as const;

describe("quién puede cambiar el rol o quitar: la base ni se consulta si el rol no alcanza", () => {
  for (const memberRole of MEMBER_ROLES) {
    const allowed = can(memberRole, "team.manage");
    it(`${memberRole}: ${allowed ? "llega a la base" : "recibe el mensaje y la base no se toca"}`, async () => {
      role = memberRole;
      rpc.mockResolvedValue({ data: { result: "changed", cancelled_invitations: 0 }, error: null });
      const changed = await changeMemberRoleAction(...changeArgs);
      rpc.mockResolvedValue({ data: { result: "removed", cancelled_invitations: 0 }, error: null });
      const removed = await removeMemberAction(...removeArgs);
      if (allowed) {
        expect(changed.status).toBe("ok");
        expect(removed.status).toBe("ok");
        expect(rpc).toHaveBeenCalledTimes(2);
      } else {
        for (const result of [changed, removed]) {
          expect(result).toEqual({
            status: "error",
            kind: "forbidden",
            message: NO_PERMISSION_MESSAGE,
          });
        }
        expect(rpc).not.toHaveBeenCalled();
        expect(from).not.toHaveBeenCalled();
        expect(revalidatePath).not.toHaveBeenCalled();
      }
    });
  }
});

describe("cambiar el rol", () => {
  it("manda a la base el miembro, el rol nuevo y el rol que la persona vio, y refresca la pantalla", async () => {
    rpc.mockResolvedValue({ data: { result: "changed", cancelled_invitations: 0 }, error: null });
    const result = await changeMemberRoleAction(...changeArgs);
    expect(rpc).toHaveBeenCalledWith("change_member_role", {
      p_member_id: MEMBER_ID,
      p_new_role: MEMBER_ROLES[4],
      p_expected_role: MEMBER_ROLES[3],
    });
    expect(result).toEqual({
      status: "ok",
      message: "El rol ahora es Observador. Se aplica en su siguiente clic.",
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/o/${TENANT_ID}/equipo`, "layout");
  });

  it("si la base cancela invitaciones, lo dice", async () => {
    rpc.mockResolvedValue({ data: { result: "changed", cancelled_invitations: 1 }, error: null });
    const one = await changeMemberRoleAction(...changeArgs);
    rpc.mockResolvedValue({ data: { result: "changed", cancelled_invitations: 3 }, error: null });
    const three = await changeMemberRoleAction(...changeArgs);
    expect(one.message).toContain("Se canceló 1 invitación que esa persona había enviado.");
    expect(three.message).toContain("Se cancelaron 3 invitaciones que esa persona había enviado.");
  });

  it("si ya tenía ese rol, avisa que no hubo cambios", async () => {
    rpc.mockResolvedValue({ data: { result: "unchanged" }, error: null });
    expect(await changeMemberRoleAction(...changeArgs)).toEqual({
      status: "ok",
      message: "Esa persona ya tenía ese rol. No hubo cambios.",
    });
  });

  it("«el rol cambió»: el mensaje claro y la pantalla NO se rehace (no se le tapa el aviso)", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "CP409", message: "role_changed" } });
    const result = await changeMemberRoleAction(...changeArgs);
    expect(result).toMatchObject({ status: "error", kind: "role_changed" });
    expect(result.message).toContain("El rol cambió mientras lo editabas");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("el Dueño y uno mismo: los mensajes de la base", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "CP423", message: "cannot_target_owner" } });
    expect(await changeMemberRoleAction(...changeArgs)).toMatchObject({ kind: "target_owner" });
    rpc.mockResolvedValue({ data: null, error: { code: "CP423", message: "cannot_target_self" } });
    expect(await changeMemberRoleAction(...changeArgs)).toMatchObject({ kind: "target_self" });
  });

  it("un Administrador que intenta nombrar o bajar a un Administrador: «solo el Dueño», sin rehacer la pantalla", async () => {
    role = MEMBER_ROLES[1];
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "owner_only" } });
    const result = await changeMemberRoleAction(
      TENANT_ID,
      MEMBER_ID,
      MEMBER_ROLES[1],
      MEMBER_ROLES[3],
    );
    expect(result).toEqual({
      status: "error",
      kind: "owner_only",
      message:
        "Solo el Dueño puede nombrar Administradores, cambiarles el rol o quitarlos del equipo.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
    // Lo esperado no se escribe en el log.
    expect(logged.join("\n")).not.toContain("member_role_change_failed");
  });

  it("el tope de cambios en el equipo por hora tiene su mensaje", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "CP429", message: "limit_member_changes" },
    });
    const result = await changeMemberRoleAction(...changeArgs);
    expect(result).toMatchObject({ status: "error", kind: "rate_limited" });
    expect(result.message).toContain("muchos cambios en tu equipo en la última hora");
    // Quitar suma al mismo tope: mismo mensaje.
    const removed = await removeMemberAction(...removeArgs);
    expect(removed).toMatchObject({ status: "error", kind: "rate_limited" });
    expect(removed.message).toContain("muchos cambios en tu equipo en la última hora");
  });

  it("un error desconocido no filtra detalle técnico y deja solo el código en el log", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "XX000", message: 'relation "members" does not exist' },
    });
    const result = await changeMemberRoleAction(...changeArgs);
    expect(result.status).toBe("error");
    expect(result.message).not.toContain("members");
    expect(logged.join("\n")).toContain("member_role_change_failed");
    expect(logged.join("\n")).not.toContain("does not exist");
  });

  it("una respuesta con forma rara se trata como error, no como éxito", async () => {
    rpc.mockResolvedValue({ data: { result: "algo-raro" }, error: null });
    expect(await changeMemberRoleAction(...changeArgs)).toMatchObject({ kind: "other" });
  });

  it("no consulta la base con ids o roles inválidos (el Dueño nunca es el rol nuevo)", async () => {
    const bad: [string, string, string, string][] = [
      [TENANT_ID, "no-es-un-id", MEMBER_ROLES[4], MEMBER_ROLES[3]],
      [TENANT_ID, MEMBER_ID, MEMBER_ROLES[0], MEMBER_ROLES[3]],
      [TENANT_ID, MEMBER_ID, "superjefe", MEMBER_ROLES[3]],
      [TENANT_ID, MEMBER_ID, MEMBER_ROLES[4], "superjefe"],
      [TENANT_ID, randomUUID(), "", ""],
    ];
    for (const args of bad) {
      const result = await changeMemberRoleAction(...args);
      expect(result.status).toBe("error");
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("quitar del equipo", () => {
  it("manda a la base el miembro y el rol que la persona vio, y NO rehace la pantalla (lo hace el navegador)", async () => {
    rpc.mockResolvedValue({ data: { result: "removed", cancelled_invitations: 2 }, error: null });
    const result = await removeMemberAction(...removeArgs);
    expect(rpc).toHaveBeenCalledWith("remove_member", {
      p_member_id: MEMBER_ID,
      p_expected_role: MEMBER_ROLES[3],
    });
    expect(result.status).toBe("ok");
    expect(result.message).toContain("Pierde el acceso en su siguiente clic.");
    expect(result.message).toContain("Se cancelaron 2 invitaciones");
    expect(result.message).not.toContain("solicitud");
    // Rehacer la ficha de alguien que ya no está daría «No encontrado» antes de navegar a la lista.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("dice cuántas solicitudes quedaron asignadas a esa persona, esperando que se reasignen", async () => {
    rpc.mockResolvedValue({
      data: { result: "removed", cancelled_invitations: 0, assigned_requests: 1 },
      error: null,
    });
    expect((await removeMemberAction(...removeArgs)).message).toContain(
      "Tenía 1 solicitud asignada: queda esperando que la reasignes.",
    );
    rpc.mockResolvedValue({
      data: { result: "removed", cancelled_invitations: 0, assigned_requests: 3 },
      error: null,
    });
    expect((await removeMemberAction(...removeArgs)).message).toContain(
      "Tenía 3 solicitudes asignadas: quedan esperando que las reasignes.",
    );
  });

  it("quitar a alguien que ya no estaba es un «listo» tranquilo", async () => {
    rpc.mockResolvedValue({ data: { result: "already_removed" }, error: null });
    expect(await removeMemberAction(...removeArgs)).toEqual({
      status: "ok",
      message: "Esa persona ya no estaba en tu equipo.",
    });
  });

  it("errores de la base: no existe, rol cambiado, Dueño", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "CP404", message: "member_not_found" } });
    expect(await removeMemberAction(...removeArgs)).toMatchObject({ kind: "not_found" });
    rpc.mockResolvedValue({ data: null, error: { code: "CP409", message: "role_changed" } });
    expect(await removeMemberAction(...removeArgs)).toMatchObject({ kind: "role_changed" });
    rpc.mockResolvedValue({ data: null, error: { code: "CP423", message: "cannot_target_owner" } });
    expect(await removeMemberAction(...removeArgs)).toMatchObject({ kind: "target_owner" });
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "owner_only" } });
    expect(await removeMemberAction(...removeArgs)).toMatchObject({ kind: "owner_only" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("ids inválidos no llegan a la base", async () => {
    expect((await removeMemberAction(TENANT_ID, "no-es-un-id", MEMBER_ROLES[3])).status).toBe(
      "error",
    );
    expect((await removeMemberAction(TENANT_ID, MEMBER_ID, "")).status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
  });
});
