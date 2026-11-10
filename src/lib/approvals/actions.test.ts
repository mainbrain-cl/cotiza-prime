import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_ROLES, NO_PERMISSION_MESSAGE, can } from "@/lib/permissions/matrix";

// La acción de guardar la regla con un falso miembro de cada rol: quien no configura la organización recibe el mensaje único y
// la base NI SE CONSULTA; quien sí, llega a `set_approval_rule` con los datos ya leídos.

const TENANT_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0001";
const rpc = vi.fn();
const revalidatePath = vi.fn();
let role = "owner";

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));
vi.mock("@/lib/tenant/active-tenant", () => ({
  requireActiveTenant: vi.fn(async () => ({
    tenantId: TENANT_ID,
    tenantName: "Negocio de Prueba",
    role,
    userId: "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0002",
    supabase: { rpc },
  })),
}));

const {
  saveApprovalRuleAction,
  APPROVAL_CONFLICT_MESSAGE,
  APPROVAL_GENERIC_FAILURE,
  APPROVAL_SAVED_MESSAGE,
  APPROVAL_UNCHANGED_MESSAGE,
} = await import("./actions");
const { INITIAL_APPROVAL_STATE } = await import("./form-state");

const logged: string[] = [];
beforeEach(() => {
  role = "owner";
  rpc.mockReset();
  revalidatePath.mockReset();
  logged.length = 0;
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}
const conditionalForm = (over: Record<string, string> = {}) =>
  form({ mode: "conditional", amount: "2.000.000", discount: "10", expectedVersion: "4", ...over });
const save = (data: FormData) => saveApprovalRuleAction(TENANT_ID, INITIAL_APPROVAL_STATE, data);
const dbError = (code: string, message: string) => ({ data: null, error: { code, message } });

describe("quien no configura la organización no llega a la base", () => {
  const without = MEMBER_ROLES.filter((r) => !can(r, "settings.manage"));

  it("son exactamente Aprobador, Comercial y Observador", () => {
    expect(without).toHaveLength(3);
  });

  it.each(without)("%s: da «sin permiso» y no se consulta nada", async (r) => {
    role = r;
    const result = await save(conditionalForm());
    expect(result.status).toBe("error");
    expect(result.message).toBe(NO_PERMISSION_MESSAGE);
    expect(rpc).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("quien configura la organización guarda la regla", () => {
  it.each(MEMBER_ROLES.filter((r) => can(r, "settings.manage")))(
    "%s llega a set_approval_rule con los datos leídos",
    async (r) => {
      role = r;
      rpc.mockResolvedValue({ data: { changed: true, id: "x", version: 5 }, error: null });
      const result = await save(conditionalForm());
      expect(rpc).toHaveBeenCalledWith("set_approval_rule", {
        p_expected_version: 4,
        p_mode: "conditional",
        p_amount_threshold_clp: 2_000_000,
        p_discount_threshold_bp: 1_000,
      });
      expect(result).toMatchObject({
        status: "saved",
        message: APPROVAL_SAVED_MESSAGE,
        version: 5,
      });
      expect(revalidatePath).toHaveBeenCalledWith(`/o/${TENANT_ID}/configuracion/aprobaciones`);
    },
  );

  it("«Siempre» manda los umbrales vacíos aunque el formulario traiga basura", async () => {
    rpc.mockResolvedValue({ data: { changed: true, id: "x", version: 2 }, error: null });
    await save(form({ mode: "always", amount: "99", discount: "99", expectedVersion: "1" }));
    expect(rpc).toHaveBeenCalledWith("set_approval_rule", {
      p_expected_version: 1,
      p_mode: "always",
      p_amount_threshold_clp: null,
      p_discount_threshold_bp: null,
    });
  });

  it("guardar lo mismo no es un error: se dice que no hubo cambios", async () => {
    rpc.mockResolvedValue({ data: { changed: false, id: "x", version: 4 }, error: null });
    expect(await save(conditionalForm())).toMatchObject({
      status: "saved",
      message: APPROVAL_UNCHANGED_MESSAGE,
      version: 4,
    });
  });

  it("un dato ilegible se rechaza antes de llamar a la base", async () => {
    const result = await save(conditionalForm({ amount: "2.000,5" }));
    expect(result.status).toBe("error");
    expect(result.fieldErrors).toHaveProperty("amount");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("los errores de la base se cuentan en español, sin detalle técnico", () => {
  it("CP409: otra persona cambió la regla", async () => {
    rpc.mockResolvedValue(dbError("CP409", "rule_changed"));
    expect(await save(conditionalForm())).toMatchObject({
      status: "error",
      message: APPROVAL_CONFLICT_MESSAGE,
      conflict: true,
    });
  });
  it("42501: sin permiso", async () => {
    rpc.mockResolvedValue(dbError("42501", "forbidden"));
    expect(await save(conditionalForm())).toMatchObject({
      status: "error",
      message: NO_PERMISSION_MESSAGE,
    });
  });
  it.each([
    ["amount_out_of_range", "amount"],
    ["discount_out_of_range", "discount"],
    ["missing_condition", "condition"],
  ])("CP422 %s cae en el campo %s", async (reason, field) => {
    rpc.mockResolvedValue(dbError("CP422", reason));
    const result = await save(conditionalForm());
    expect(result.status).toBe("error");
    expect(result.fieldErrors).toHaveProperty(field);
  });
  it("cualquier otro error: mensaje general, y solo el código va al registro", async () => {
    rpc.mockResolvedValue(dbError("XX000", "detalle interno con 2.000.000"));
    const result = await save(conditionalForm());
    expect(result).toMatchObject({ status: "error", message: APPROVAL_GENERIC_FAILURE });
    expect(logged.join("\n")).toContain("XX000");
    expect(logged.join("\n")).not.toContain("detalle interno");
    expect(logged.join("\n")).not.toContain("2.000.000");
  });
  it("una respuesta con otra forma también falla con el mensaje general", async () => {
    rpc.mockResolvedValue({ data: { hola: 1 }, error: null });
    expect(await save(conditionalForm())).toMatchObject({
      status: "error",
      message: APPROVAL_GENERIC_FAILURE,
    });
  });
});
