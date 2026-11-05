// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  changeMemberRoleAction: vi.fn(),
  removeMemberAction: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("@/lib/team/members-actions", () => ({
  changeMemberRoleAction: mocks.changeMemberRoleAction,
  removeMemberAction: mocks.removeMemberAction,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));

import { MEMBER_ROLES } from "@/lib/permissions/matrix";
import { ROLE_OPTIONS, toMemberItem, type MemberItem } from "@/lib/team/members-model";
import { MemberActions } from "./member-actions";
import { MemberList } from "./member-list";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const roles = [...ROLE_OPTIONS];

const item = (over: Partial<Parameters<typeof toMemberItem>[0]> = {}): MemberItem =>
  toMemberItem(
    {
      memberId: MEMBER_ID,
      userId: "33333333-3333-4333-8333-333333333333",
      name: "Juan Pérez",
      email: "juan@ejemplo.test",
      role: MEMBER_ROLES[3],
      joinedAt: "2026-11-03T15:00:00.000Z",
      isSelf: false,
      ...over,
    },
    TENANT_ID,
  );

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const q = <T extends HTMLElement>(id: string) =>
  document.body.querySelector<T>(`[data-testid="${id}"]`);
const all = (id: string) => [...document.body.querySelectorAll(`[data-testid="${id}"]`)];

async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
async function mountList(items: MemberItem[]) {
  await act(async () => {
    root.render(createElement(MemberList, { tenantId: TENANT_ID, items, roles }));
  });
}
async function mountActions(role: string = MEMBER_ROLES[3]) {
  await act(async () => {
    root.render(
      createElement(MemberActions, {
        tenantId: TENANT_ID,
        memberId: MEMBER_ID,
        memberName: "Juan Pérez",
        role,
        roles,
        canChangeRole: true,
        canRemove: true,
        afterRemovePath: `/o/${TENANT_ID}/equipo`,
      }),
    );
  });
}

describe("la lista de miembros", () => {
  it("cada fila muestra nombre, correo, rol con su frase y la fecha de ingreso", async () => {
    await mountList([item()]);
    expect(q("member-name")?.textContent).toContain("Juan Pérez");
    expect(q("member-name")?.getAttribute("href")).toBe(`/o/${TENANT_ID}/equipo/${MEMBER_ID}`);
    expect(q("member-email")?.textContent).toBe("juan@ejemplo.test");
    expect(q("member-role")?.textContent).toBe("Comercial");
    expect(q("member-role-description")?.textContent).toContain(
      "Arma y envía sus propias cotizaciones",
    );
    expect(q("member-joined")?.textContent).toBe("Ingresó el 03-11-2026");
    expect(q("member-change-role")?.textContent).toContain("Cambiar rol");
    expect(q("member-remove")?.textContent).toContain("Quitar del equipo");
  });

  it("el Dueño está marcado como «Dueño» y no tiene botones", async () => {
    await mountList([item({ role: MEMBER_ROLES[0] })]);
    expect(q("member-role")?.textContent).toBe("Dueño");
    expect(q("member-change-role")).toBeNull();
    expect(q("member-remove")).toBeNull();
    expect(q("member-lock-note")?.textContent).toBe(
      "El Dueño no se puede cambiar ni quitar desde aquí.",
    );
  });

  it("la propia fila dice «(tú)» y no tiene botones", async () => {
    await mountList([item({ role: MEMBER_ROLES[1], isSelf: true })]);
    expect(q("member-name")?.textContent).toContain("(tú)");
    expect(q("member-change-role")).toBeNull();
    expect(q("member-remove")).toBeNull();
    expect(q("member-lock-note")?.textContent).toContain("No puedes cambiar tu propio rol");
  });

  it("varias filas, cada una con sus botones", async () => {
    await mountList([
      item({ role: MEMBER_ROLES[0] }),
      item({ memberId: "44444444-4444-4444-8444-444444444444" }),
      item({ memberId: "55555555-5555-4555-8555-555555555555", role: MEMBER_ROLES[4] }),
    ]);
    expect(all("member-row")).toHaveLength(3);
    expect(all("member-change-role")).toHaveLength(2);
  });
});

describe("cambiar el rol", () => {
  it("el diálogo ofrece los cuatro roles con su frase, y el actual viene marcado", async () => {
    await mountActions();
    await click(q("member-change-role"));
    const options = all("member-role-choices")[0].querySelectorAll("label");
    expect(options).toHaveLength(4);
    expect(q("member-role-option-sales")?.textContent).toContain("(rol actual)");
    expect(q(`member-role-option-${MEMBER_ROLES[0]}`)).toBeNull();
    expect(q<HTMLInputElement>("member-role-option-sales")!.querySelector("input")!.checked).toBe(
      true,
    );
  });

  it("elegir el mismo rol no llama a la base y lo explica", async () => {
    await mountActions();
    await click(q("member-change-role"));
    await click(q(`member-role-${MEMBER_ID}-confirm`));
    expect(mocks.changeMemberRoleAction).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Elige un rol distinto del actual.");
  });

  it("al confirmar manda el rol nuevo y el rol que se veía, avisa y cierra el diálogo", async () => {
    mocks.changeMemberRoleAction.mockResolvedValue({
      status: "ok",
      message: "El rol ahora es Observador. Se aplica en su siguiente clic.",
    });
    await mountActions();
    await click(q("member-change-role"));
    await click(q("member-role-option-viewer")!.querySelector("input"));
    await click(q(`member-role-${MEMBER_ID}-confirm`));
    expect(mocks.changeMemberRoleAction).toHaveBeenCalledWith(
      TENANT_ID,
      MEMBER_ID,
      "viewer",
      "sales",
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "El rol ahora es Observador. Se aplica en su siguiente clic.",
      expect.anything(),
    );
    expect(q(`member-role-${MEMBER_ID}-dialog`)).toBeNull();
  });

  it("si la base responde «el rol cambió», el aviso sale en el diálogo y la elección no se pierde", async () => {
    mocks.changeMemberRoleAction.mockResolvedValue({
      status: "error",
      kind: "role_changed",
      message: "El rol cambió mientras lo editabas. Recarga la página para ver cómo quedó.",
    });
    await mountActions();
    await click(q("member-change-role"));
    await click(q("member-role-option-approver")!.querySelector("input"));
    await click(q(`member-role-${MEMBER_ID}-confirm`));
    expect(q(`member-role-${MEMBER_ID}-dialog`)?.textContent).toContain(
      "El rol cambió mientras lo editabas",
    );
    expect(
      q("member-role-option-approver")!.querySelector<HTMLInputElement>("input")!.checked,
    ).toBe(true);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("un fallo de red avisa en el mismo diálogo, sin perder lo elegido, y se puede reintentar", async () => {
    mocks.changeMemberRoleAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mocks.changeMemberRoleAction.mockResolvedValueOnce({ status: "ok", message: "Listo." });
    await mountActions();
    await click(q("member-change-role"));
    await click(q("member-role-option-viewer")!.querySelector("input"));
    await click(q(`member-role-${MEMBER_ID}-confirm`));
    expect(q(`member-role-${MEMBER_ID}-dialog`)?.textContent).toContain("Revisa tu conexión");
    expect(q("member-role-option-viewer")!.querySelector<HTMLInputElement>("input")!.checked).toBe(
      true,
    );
    await click(q(`member-role-${MEMBER_ID}-confirm`));
    expect(mocks.changeMemberRoleAction).toHaveBeenCalledTimes(2);
    expect(q(`member-role-${MEMBER_ID}-dialog`)).toBeNull();
  });
});

describe("cancelar el cambio de rol", () => {
  it("al cerrar sin confirmar, la elección vuelve al rol actual (no recuerda lo cancelado)", async () => {
    await mountActions();
    await click(q("member-change-role"));
    await click(q("member-role-option-viewer")!.querySelector("input"));
    expect(q("member-role-option-viewer")!.querySelector<HTMLInputElement>("input")!.checked).toBe(
      true,
    );
    await click(q(`member-role-${MEMBER_ID}-cancel`));
    expect(q(`member-role-${MEMBER_ID}-dialog`)).toBeNull();
    await click(q("member-change-role"));
    expect(q("member-role-option-viewer")!.querySelector<HTMLInputElement>("input")!.checked).toBe(
      false,
    );
    expect(q("member-role-option-sales")!.querySelector<HTMLInputElement>("input")!.checked).toBe(
      true,
    );
    expect(mocks.changeMemberRoleAction).not.toHaveBeenCalled();
  });
});

describe("quitar del equipo", () => {
  it("explica en simple qué pasa antes de confirmar", async () => {
    await mountActions();
    await click(q("member-remove"));
    const dialog = q(`member-remove-${MEMBER_ID}-dialog`)!;
    expect(dialog.textContent).toContain("¿Quitar a Juan Pérez del equipo?");
    expect(dialog.textContent).toContain("Perderá el acceso en su siguiente clic.");
    const consequences = q("member-remove-consequences")!.textContent!;
    for (const phrase of [
      "Sus cotizaciones siguen existiendo con su nombre.",
      "Sus borradores quedan solo para leer.",
      "Las invitaciones que envió se cancelan.",
      "Sus solicitudes asignadas quedan sin responsable.",
    ]) {
      expect(consequences).toContain(phrase);
    }
    expect(mocks.removeMemberAction).not.toHaveBeenCalled();
  });

  it("en la lista (sin ficha) refresca la lista en vez de navegar", async () => {
    mocks.removeMemberAction.mockResolvedValue({
      status: "ok",
      message: "La persona salió del equipo.",
    });
    await act(async () => {
      root.render(
        createElement(MemberActions, {
          tenantId: TENANT_ID,
          memberId: MEMBER_ID,
          memberName: "Juan Pérez",
          role: MEMBER_ROLES[3],
          roles,
          canChangeRole: true,
          canRemove: true,
        }),
      );
    });
    await click(q("member-remove"));
    await click(q(`member-remove-${MEMBER_ID}-confirm`));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("al confirmar manda el rol que se veía, avisa y lleva a la lista", async () => {
    mocks.removeMemberAction.mockResolvedValue({
      status: "ok",
      message: "La persona salió del equipo.",
    });
    await mountActions();
    await click(q("member-remove"));
    await click(q(`member-remove-${MEMBER_ID}-confirm`));
    expect(mocks.removeMemberAction).toHaveBeenCalledWith(TENANT_ID, MEMBER_ID, "sales");
    expect(mocks.toastSuccess).toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith(`/o/${TENANT_ID}/equipo`);
  });

  it("si falla, el aviso queda en el diálogo y no se navega", async () => {
    mocks.removeMemberAction.mockResolvedValue({
      status: "error",
      kind: "not_found",
      message: "No encontramos a esta persona en tu equipo.",
    });
    await mountActions();
    await click(q("member-remove"));
    await click(q(`member-remove-${MEMBER_ID}-confirm`));
    expect(q(`member-remove-${MEMBER_ID}-dialog`)?.textContent).toContain(
      "No encontramos a esta persona en tu equipo.",
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("un doble clic en «Sí, quitar» llama a la base una sola vez", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.removeMemberAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await mountActions();
    await click(q("member-remove"));
    const confirm = q(`member-remove-${MEMBER_ID}-confirm`);
    await click(confirm);
    await click(confirm);
    expect(mocks.removeMemberAction).toHaveBeenCalledTimes(1);
    await act(async () => finish({ status: "ok", message: "Listo." }));
  });
});

describe("sin botones", () => {
  it("si no se puede cambiar ni quitar, no se dibuja nada", async () => {
    await act(async () => {
      root.render(
        createElement(MemberActions, {
          tenantId: TENANT_ID,
          memberId: MEMBER_ID,
          memberName: "X",
          role: MEMBER_ROLES[3],
          roles,
          canChangeRole: false,
          canRemove: false,
        }),
      );
    });
    expect(q("member-actions")).toBeNull();
  });
});
