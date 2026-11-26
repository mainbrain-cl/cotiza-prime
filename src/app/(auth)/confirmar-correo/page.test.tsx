// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Abrir /confirmar-correo NO gasta el código del enlace (los antivirus abren los enlaces): la página solo muestra «Continuar».
const mocks = vi.hoisted(() => ({ confirmEmailLinkAction: vi.fn(), verifyOtp: vi.fn() }));
vi.mock("@/lib/auth/signup-actions", () => ({
  confirmEmailLinkAction: mocks.confirmEmailLinkAction,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { verifyOtp: mocks.verifyOtp } }),
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

import ConfirmEmailPage from "./page";

async function html(params: Record<string, string | string[]>) {
  const element = await ConfirmEmailPage({
    searchParams: Promise.resolve(params),
  } as never);
  return renderToStaticMarkup(element);
}

describe("/confirmar-correo", () => {
  it("con un enlace completo muestra «Continuar» con el código en un campo oculto y NO consulta a Supabase", async () => {
    const markup = await html({ token_hash: "abc123_-XYZ.9", type: "invite" });
    expect(markup).toContain("Confirma tu correo");
    expect(markup).toContain("Continuar");
    expect(markup).toContain('name="token_hash"');
    expect(markup).toContain('value="abc123_-XYZ.9"');
    expect(markup).toContain("Paso 1 de 2");
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(mocks.confirmEmailLinkAction).not.toHaveBeenCalled();
  });

  it.each([
    ["sin código", { type: "invite" }],
    ["con otro tipo de enlace", { token_hash: "abc12345", type: "recovery" }],
    ["sin tipo", { token_hash: "abc12345" }],
    ["con un código corto", { token_hash: "abc", type: "invite" }],
    ["con un código con caracteres raros", { token_hash: "abc12345<script>", type: "invite" }],
    ["con el código repetido", { token_hash: ["abc12345", "abc12345"], type: "invite" }],
  ])("%s dice «Este enlace ya se usó o venció» y ofrece pedir uno nuevo", async (_name, params) => {
    const markup = await html(params as Record<string, string | string[]>);
    expect(markup).toContain("Este enlace ya se usó o venció");
    expect(markup).toContain("Pedir un enlace nuevo");
    expect(markup).toContain('href="/registro"');
    expect(markup).not.toContain("Continuar");
    expect(markup).not.toContain("<script>");
  });
});
