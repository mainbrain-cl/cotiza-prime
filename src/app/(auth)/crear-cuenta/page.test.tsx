// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// /crear-cuenta es la única pantalla que acepta una cuenta sin terminar, y solo con la sesión del enlace del correo.
const mocks = vi.hoisted(() => ({
  getSessionState: vi.fn(),
  hasEmailLinkSession: vi.fn(),
  isAccountReady: vi.fn(),
  hasPendingInvitation: vi.fn(),
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
vi.mock("@/lib/auth/session", () => ({
  getSessionState: mocks.getSessionState,
  hasEmailLinkSession: mocks.hasEmailLinkSession,
  isAccountReady: mocks.isAccountReady,
}));
vi.mock("@/lib/team/invitation-cookie", () => ({
  hasPendingInvitation: mocks.hasPendingInvitation,
}));
vi.mock("@/lib/auth/signup-actions", () => ({ completeAccountSetupAction: vi.fn() }));
vi.mock("@/lib/auth/actions", () => ({ signOutAction: vi.fn() }));
vi.mock("@/lib/legal/documents", () => ({
  legalDocuments: { terms: { version: "v-terminos" }, privacy: { version: "v-privacidad" } },
}));
vi.mock("@/components/auth/auth-card", () => ({
  AuthCard: ({
    title,
    description,
    children,
  }: {
    title: string;
    description?: string;
    children: unknown;
  }) =>
    createElement(
      "section",
      null,
      createElement("h1", null, title),
      description,
      children as never,
    ),
}));

import CreateAccountPage from "./page";

const USER = { id: "u1", email: "nueva@ejemplo.test", emailVerified: true };

async function html() {
  return renderToStaticMarkup(await CreateAccountPage());
}
async function redirectOf(): Promise<string> {
  try {
    await CreateAccountPage();
  } catch (error) {
    if (error instanceof Redirected) return error.to;
    throw error;
  }
  throw new Error("se esperaba una redirección");
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getSessionState.mockResolvedValue({ status: "complete", user: USER });
  mocks.isAccountReady.mockResolvedValue(false);
  mocks.hasEmailLinkSession.mockResolvedValue(true);
  mocks.hasPendingInvitation.mockResolvedValue(false);
});

describe("/crear-cuenta", () => {
  it("con la sesión del enlace y la cuenta sin terminar muestra el formulario con el correo a la vista y los textos del diseño", async () => {
    const markup = await html();
    expect(markup).toContain("Termina de crear tu cuenta");
    expect(markup).toContain("Estás creando la cuenta de");
    expect(markup).toContain("nueva@ejemplo.test");
    expect(markup).toContain("¿No es tu correo? Salir");
    expect(markup).toContain("Crear mi cuenta");
    expect(markup).toContain("Paso 2 de 2");
    expect(markup).toContain('value="v-terminos"');
    expect(markup).toContain('value="v-privacidad"');
  });

  it("sin sesión pide un enlace nuevo (sin nada que cerrar)", async () => {
    mocks.getSessionState.mockResolvedValue({ status: "signed_out" });
    const markup = await html();
    expect(markup).toContain("Tu enlace venció");
    expect(markup).toContain('href="/registro"');
    expect(markup).not.toContain("Crear mi cuenta");
  });

  it("con una sesión que no nació del enlace (contraseña) no deja terminar la cuenta: ofrece salir y pedir otro", async () => {
    mocks.hasEmailLinkSession.mockResolvedValue(false);
    const markup = await html();
    expect(markup).toContain("Tu enlace venció");
    expect(markup).toContain("Cerrar sesión y pedir un enlace nuevo");
    expect(markup).not.toContain('name="password"');
  });

  it("una cuenta ya terminada sigue de largo: a unirse si hay invitación; si no, a crear su organización", async () => {
    mocks.isAccountReady.mockResolvedValue(true);
    expect(await redirectOf()).toBe("/organizaciones/nueva");
    mocks.hasPendingInvitation.mockResolvedValue(true);
    expect(await redirectOf()).toBe("/invitacion");
  });

  it("con el segundo paso pendiente va a escribir el código", async () => {
    mocks.getSessionState.mockResolvedValue({
      status: "second_step_pending",
      user: USER,
      factorId: null,
    });
    expect(await redirectOf()).toBe("/ingresar/codigo");
  });
});
