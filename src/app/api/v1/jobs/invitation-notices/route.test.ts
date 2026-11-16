import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runScheduledInvitationNotices, serverLog } = vi.hoisted(() => ({
  runScheduledInvitationNotices: vi.fn(),
  serverLog: vi.fn(),
}));
vi.mock("@/server/jobs/send-invitation-notices", () => ({ runScheduledInvitationNotices }));
vi.mock("@/lib/log/server-log", () => ({ serverLog }));

import * as route from "./route";

const { GET, dynamic, maxDuration } = route;

const SECRET = "secreto-cron-de-prueba-0123456789-abcdef";
const URL_ = "http://localhost/api/v1/jobs/invitation-notices";

const get = (authorization?: string) =>
  GET(new Request(URL_, authorization ? { headers: { authorization } } : undefined));

const previousSecret = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  runScheduledInvitationNotices.mockReset().mockResolvedValue({
    attended: 2,
    exhausted: 1,
    failed: false,
  });
  serverLog.mockReset();
});

afterEach(() => {
  if (previousSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousSecret;
});

describe("GET /api/v1/jobs/invitation-notices (decisión #17)", () => {
  it("sin CRON_SECRET: 404 y no corre la tarea (ni con un encabezado cualquiera)", async () => {
    delete process.env.CRON_SECRET;
    for (const header of [undefined, "Bearer undefined", "Bearer ", `Bearer ${SECRET}`]) {
      const response = await get(header);
      expect(response.status).toBe(404);
    }
    expect(runScheduledInvitationNotices).not.toHaveBeenCalled();
  });

  it("CRON_SECRET corto: 404 aunque el encabezado coincida", async () => {
    process.env.CRON_SECRET = "corto-123";
    const response = await get("Bearer corto-123");
    expect(response.status).toBe(404);
    expect(runScheduledInvitationNotices).not.toHaveBeenCalled();
  });

  it("sin encabezado: 401 genérico, sin caché y sin correr la tarea", async () => {
    const response = await get();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toBe("No autorizado.");
    expect(runScheduledInvitationNotices).not.toHaveBeenCalled();
  });

  it("secreto incorrecto: 401 y no corre la tarea", async () => {
    const response = await get(`Bearer ${SECRET}x`);
    expect(response.status).toBe(401);
    expect(runScheduledInvitationNotices).not.toHaveBeenCalled();
  });

  it("secreto correcto: 200 con los conteos y corre la tarea una vez", async () => {
    const response = await get(`Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      job: "invitation-notices",
      attended: 2,
      exhausted: 1,
      failed: false,
    });
    expect(runScheduledInvitationNotices).toHaveBeenCalledTimes(1);
  });

  it("la tarea falla: 500 genérico para que el programador lo marque como error", async () => {
    runScheduledInvitationNotices.mockResolvedValue({ attended: 0, exhausted: 0, failed: true });
    const response = await get(`Bearer ${SECRET}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ job: "invitation-notices", failed: true });
  });

  it("ni el cuerpo ni los registros contienen el secreto ni el encabezado", async () => {
    const bodies: string[] = [];
    for (const header of [undefined, `Bearer ${SECRET}x`, `Bearer ${SECRET}`]) {
      bodies.push(await (await get(header)).text());
    }
    runScheduledInvitationNotices.mockResolvedValue({ attended: 0, exhausted: 0, failed: true });
    bodies.push(await (await get(`Bearer ${SECRET}`)).text());
    expect(serverLog).toHaveBeenCalled();
    const everything = JSON.stringify([bodies, serverLog.mock.calls]);
    expect(everything).not.toContain(SECRET);
    expect(everything.toLowerCase()).not.toContain("bearer");
  });

  it("exporta solo GET y las constantes de configuración de la ruta", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "maxDuration", "runtime"]);
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBe(60);
  });
});
