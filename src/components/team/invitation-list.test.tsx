// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/team/actions", () => ({
  resendInvitationAction: vi.fn(),
  revokeInvitationAction: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { InvitationList, type InvitationItem } from "./invitation-list";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

const baseItem: InvitationItem = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "persona@ejemplo.test",
  roleLabel: "Comercial",
  statusLabel: "Enviada",
  tone: "accent",
  needsAttention: false,
  expired: false,
  createdLabel: "Invitada el 03-11-2026",
  expiresLabel: "Vence el 10-11-2026",
  sentLabel: "Último envío: 03-11-2026 14:56",
  invitedBy: null,
  resendsLeft: 2,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount(item: InvitationItem) {
  await act(async () => {
    root.render(createElement(InvitationList, { tenantId: TENANT_ID, items: [item] }));
  });
}

const resendButton = () =>
  host.querySelector<HTMLButtonElement>('[data-testid="invitation-resend"]')!;
const noResendsNote = () => host.querySelector('[data-testid="invitation-no-resends"]');

describe("InvitationList — reenvíos agotados", () => {
  it("explica con texto visible por qué «Reenviar» está desactivado, no solo con el cursor", async () => {
    await mount({ ...baseItem, resendsLeft: 0 });
    expect(resendButton().disabled).toBe(true);
    expect(noResendsNote()?.textContent).toContain("Ya usaste los reenvíos de esta invitación.");
    // Una pista que solo aparece al pasar el cursor no se ve en el teléfono ni recibe foco.
    expect(resendButton().hasAttribute("title")).toBe(false);
  });

  it("no muestra ese texto mientras quedan reenvíos", async () => {
    await mount({ ...baseItem, resendsLeft: 2 });
    expect(resendButton().disabled).toBe(false);
    expect(noResendsNote()).toBeNull();
  });
});
