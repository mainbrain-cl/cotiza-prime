import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INVITATION_COOKIE_NAME } from "@/lib/team/accept-model";
import { newInvitationToken } from "@/lib/team/invitation-code";

// El enlace del correo de una invitación (H-009): guarda el código en una cookie y redirige a /invitacion, sin que
// el código quede en la dirección. No consulta la base de datos.

const consume = vi.fn();
vi.mock("@/lib/security/login-rate-limit", () => ({
  consumeInvitationLinkQuota: (ip: string | null) => consume(ip),
}));
vi.mock("@/lib/http/request-context", () => ({
  getAppOrigin: () => "https://app.ejemplo.test",
  getRequestContext: async () => ({ requestId: "r", clientIp: "203.0.113.9", userAgent: null }),
}));
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn(async () => undefined) }));

const { GET } = await import("./route");

const call = async (token: string) =>
  GET(
    new Request(`https://app.ejemplo.test/invitacion/${token}`) as never,
    {
      params: Promise.resolve({ token }),
    } as never,
  );

beforeEach(() => {
  consume.mockReset();
  consume.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("/invitacion/[código]", () => {
  it("guarda el código en una cookie y redirige a /invitacion sin el código en la dirección", async () => {
    const token = newInvitationToken();
    const response = await call(token);
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toBe("https://app.ejemplo.test/invitacion");
    expect(location).not.toContain(token);
    const cookie = response.cookies.get(INVITATION_COOKIE_NAME);
    expect(cookie?.value).toBe(token);
  });

  it("la cookie es HttpOnly, SameSite=Lax, de una hora y vale para toda la aplicación", async () => {
    const response = await call(newInvitationToken());
    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=lax/i);
    expect(header).toMatch(/Max-Age=3600/i);
    expect(header).toMatch(/Path=\//i);
  });

  it("en producción la cookie es Secure", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await call(newInvitationToken());
    expect(response.headers.get("set-cookie") ?? "").toMatch(/Secure/i);
  });

  it("nada se guarda en cachés ni se manda la dirección a otros sitios", async () => {
    const response = await call(newInvitationToken());
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toMatch(/noindex/);
  });

  it.each(["corto", "a".repeat(44), `${"a".repeat(42)}/`, "..%2F..%2Fetc", "<script>"])(
    "un código mal formado («%s») no se guarda, borra el anterior y no gasta el límite",
    async (token) => {
      const response = await call(token);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        "https://app.ejemplo.test/invitacion?aviso=enlace-no-valido",
      );
      const header = response.headers.get("set-cookie") ?? "";
      expect(header).toContain(`${INVITATION_COOKIE_NAME}=;`);
      expect(consume).not.toHaveBeenCalled();
    },
  );

  it("pasado el límite por IP no guarda nada", async () => {
    consume.mockResolvedValue(false);
    const response = await call(newInvitationToken());
    expect(response.headers.get("location")).toBe(
      "https://app.ejemplo.test/invitacion?aviso=muchos-intentos",
    );
    // No guarda el código de este enlace y borra el de un enlace anterior (como con uno mal formado).
    expect(response.cookies.get(INVITATION_COOKIE_NAME)?.value ?? "").toBe("");
    expect(response.headers.get("set-cookie") ?? "").toContain(`${INVITATION_COOKIE_NAME}=;`);
    expect(consume).toHaveBeenCalledWith("203.0.113.9");
  });
});
