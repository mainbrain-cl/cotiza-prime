import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ headers: vi.fn() }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));

import { getRequestContext } from "./request-context";

/** Cada petición tiene su propio objeto de cabeceras, igual en toda ella (páginas y rutas de la API). */
const requestHeaders = (init: Record<string, string> = {}) => new Headers(init);

beforeEach(() => mocks.headers.mockReset());

describe("getRequestContext", () => {
  it("devuelve el mismo requestId durante toda una petición (registro y auditoría coinciden)", async () => {
    const mine = requestHeaders({ "x-forwarded-for": "203.0.113.9" });
    mocks.headers.mockResolvedValue(mine);
    const first = await getRequestContext();
    const second = await getRequestContext();
    expect(second).toBe(first);
    expect(second.requestId).toBe(first.requestId);
    expect(first.clientIp).toBe("203.0.113.9");
  });

  it("otra petición tiene otro requestId", async () => {
    mocks.headers.mockResolvedValueOnce(requestHeaders());
    const a = await getRequestContext();
    mocks.headers.mockResolvedValueOnce(requestHeaders());
    const b = await getRequestContext();
    expect(a.requestId).not.toBe(b.requestId);
  });

  it("descarta una IP que no es válida", async () => {
    mocks.headers.mockResolvedValue(requestHeaders({ "x-forwarded-for": "no-es-ip, 1.2.3.4" }));
    expect((await getRequestContext()).clientIp).toBeNull();
  });
});
