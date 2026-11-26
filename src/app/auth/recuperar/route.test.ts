import { beforeEach, describe, expect, it, vi } from "vitest";

// Llegada desde el correo de recuperar la contraseña: una cuenta sin terminar va a /crear-cuenta (H-116).
const mocks = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  rpc: vi.fn(),
  markRecoverySession: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { exchangeCodeForSession: mocks.exchangeCodeForSession },
    rpc: mocks.rpc,
  }),
}));
vi.mock("@/lib/auth/session", () => ({ markRecoverySession: mocks.markRecoverySession }));
vi.mock("@/lib/http/request-context", () => ({
  getAppOrigin: () => "https://app.cotizaprime.example",
}));

import { GET } from "./route";

const request = (query: string) =>
  ({ url: `https://app.cotizaprime.example/auth/recuperar${query}` }) as never;
const locationOf = (response: Response) => response.headers.get("location");

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.exchangeCodeForSession.mockResolvedValue({ error: null });
  mocks.rpc.mockResolvedValue({ data: true, error: null });
});

describe("/auth/recuperar", () => {
  it("con una cuenta terminada marca la recuperación y lleva a elegir la contraseña nueva", async () => {
    const response = await GET(request("?code=abc"));
    expect(locationOf(response)).toBe("https://app.cotizaprime.example/restablecer-contrasena");
    expect(mocks.markRecoverySession).toHaveBeenCalledTimes(1);
  });

  it("con una cuenta SIN terminar lleva a /crear-cuenta y no marca la recuperación", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    const response = await GET(request("?code=abc"));
    expect(locationOf(response)).toBe("https://app.cotizaprime.example/crear-cuenta");
    expect(mocks.rpc).toHaveBeenCalledWith("my_account_ready");
    expect(mocks.markRecoverySession).not.toHaveBeenCalled();
  });

  it("si la base no responde la pregunta (p. ej. falta el código del segundo paso) sigue el camino de siempre", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "second_step_required" },
    });
    const response = await GET(request("?code=abc"));
    expect(locationOf(response)).toBe("https://app.cotizaprime.example/restablecer-contrasena");
    expect(mocks.markRecoverySession).toHaveBeenCalledTimes(1);
  });

  it("un enlace sin código o que no sirve lleva a ingresar con el aviso, sin preguntar nada", async () => {
    for (const response of [
      await GET(request("")),
      await GET(request("?error=access_denied&code=abc")),
    ]) {
      expect(locationOf(response)).toContain("/ingresar?aviso=enlace-recuperacion-vencido");
    }
    mocks.exchangeCodeForSession.mockResolvedValue({ error: { code: "otp_expired" } });
    expect(locationOf(await GET(request("?code=abc")))).toContain("/ingresar?aviso=");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
