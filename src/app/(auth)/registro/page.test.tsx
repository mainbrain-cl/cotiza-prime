// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// /registro (H-116): con el registro público de Supabase abierto en producción (`signup-open-guard`), nuestro formulario se cierra.
const mocks = vi.hoisted(() => ({
  getOptionalUser: vi.fn(),
  hasPendingInvitation: vi.fn(),
  isBlocked: vi.fn(),
}));
class Redirected extends Error {
  constructor(readonly to: string) {
    super(to);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));
vi.mock("@/lib/auth/session", () => ({ getOptionalUser: mocks.getOptionalUser }));
vi.mock("@/lib/team/invitation-cookie", () => ({
  hasPendingInvitation: mocks.hasPendingInvitation,
}));
vi.mock("@/lib/auth/signup-open-guard", () => ({ isSignupBlockedByOpenSupabase: mocks.isBlocked }));
vi.mock("@/lib/antibot", () => ({ loadAntibotConfig: () => ({ provider: "memory" }) }));
vi.mock("./signup-form", () => ({
  SignUpForm: () => createElement("form", { "data-testid": "signup-form" }),
}));
vi.mock("@/components/auth/auth-card", () => ({
  AuthCard: ({ title, children }: { title: string; children: unknown }) =>
    createElement("section", null, createElement("h1", null, title), children as never),
}));

import SignUpPage from "./page";

async function html() {
  return renderToStaticMarkup(await SignUpPage());
}

beforeEach(() => {
  mocks.getOptionalUser.mockResolvedValue(null);
  mocks.hasPendingInvitation.mockResolvedValue(false);
  mocks.isBlocked.mockResolvedValue(false);
});

describe("/registro", () => {
  it("con el registro de Supabase cerrado muestra el formulario del correo", async () => {
    const page = await html();
    expect(page).toContain("Crea tu cuenta");
    expect(page).toContain('data-testid="signup-form"');
    expect(page).not.toContain("signup-unavailable");
  });

  it("con el registro de Supabase abierto en producción cierra el formulario: «El registro no está disponible por ahora» y una salida a ingresar", async () => {
    mocks.isBlocked.mockResolvedValue(true);
    const page = await html();
    expect(page).toContain("El registro no está disponible por ahora");
    expect(page).toContain('data-testid="signup-unavailable"');
    expect(page).toContain('href="/ingresar"');
    expect(page).not.toContain('data-testid="signup-form"');
  });

  it("quien ya tiene sesión va al inicio, sin consultar nada más", async () => {
    mocks.getOptionalUser.mockResolvedValue({ id: "u1" });
    await expect(SignUpPage()).rejects.toMatchObject({ to: "/" });
    expect(mocks.isBlocked).not.toHaveBeenCalled();
  });
});
