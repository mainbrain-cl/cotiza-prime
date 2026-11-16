import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { serverLog } = vi.hoisted(() => ({ serverLog: vi.fn() }));
vi.mock("@/lib/log/server-log", () => ({ serverLog }));

import { MIN_CRON_SECRET_LENGTH, cronJobRoute, verifyCronRequest } from "./cron-auth";

const SECRET = "s".repeat(MIN_CRON_SECRET_LENGTH) + "-secreto-de-prueba";
const URL_ = "http://localhost/api/v1/jobs/prueba";

const previousSecret = process.env.CRON_SECRET;

function setSecret(value: string | undefined) {
  if (value === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = value;
}

beforeEach(() => {
  setSecret(SECRET);
  serverLog.mockReset();
});

afterEach(() => {
  setSecret(previousSecret);
  vi.unstubAllEnvs();
});

describe("verifyCronRequest (decisión #17)", () => {
  it("sin secreto configurado (o vacío) la ruta queda desactivada", () => {
    setSecret(undefined);
    expect(verifyCronRequest(`Bearer ${SECRET}`)).toBe("disabled");
    setSecret("");
    expect(verifyCronRequest(`Bearer ${SECRET}`)).toBe("disabled");
    setSecret("   \n");
    expect(verifyCronRequest("Bearer ")).toBe("disabled");
  });

  it("un secreto corto (menos de 32 caracteres) también la desactiva, aunque coincida", () => {
    const short = "x".repeat(MIN_CRON_SECRET_LENGTH - 1);
    setSecret(short);
    expect(verifyCronRequest(`Bearer ${short}`)).toBe("disabled");
    setSecret("undefined");
    expect(verifyCronRequest("Bearer undefined")).toBe("disabled");
  });

  it("acepta un secreto de exactamente 32 caracteres", () => {
    const exact = "y".repeat(MIN_CRON_SECRET_LENGTH);
    setSecret(exact);
    expect(verifyCronRequest(`Bearer ${exact}`)).toBe("ok");
  });

  it("un secreto con salto de línea o espacios al final (pegado en el panel) igual funciona", () => {
    setSecret(`${SECRET}\n`);
    expect(verifyCronRequest(`Bearer ${SECRET}`)).toBe("ok");
    setSecret(`  ${SECRET} `);
    expect(verifyCronRequest(`Bearer ${SECRET}`)).toBe("ok");
    // y espacios que lo dejan corto no cuentan para el largo mínimo
    setSecret(`${"z".repeat(MIN_CRON_SECRET_LENGTH - 1)}   \n`);
    expect(verifyCronRequest(`Bearer ${"z".repeat(MIN_CRON_SECRET_LENGTH - 1)}`)).toBe("disabled");
  });

  it("sin encabezado, vacío o sin el esquema Bearer: no autorizado", () => {
    expect(verifyCronRequest(null)).toBe("unauthorized");
    expect(verifyCronRequest("")).toBe("unauthorized");
    expect(verifyCronRequest("Bearer")).toBe("unauthorized");
    expect(verifyCronRequest("Bearer ")).toBe("unauthorized");
    expect(verifyCronRequest(SECRET)).toBe("unauthorized");
    expect(verifyCronRequest(`Basic ${SECRET}`)).toBe("unauthorized");
  });

  it("un secreto distinto (más corto, más largo o con un carácter cambiado): no autorizado", () => {
    expect(verifyCronRequest("Bearer x")).toBe("unauthorized");
    expect(verifyCronRequest(`Bearer ${SECRET}x`)).toBe("unauthorized");
    expect(verifyCronRequest(`Bearer ${SECRET.slice(0, -1)}X`)).toBe("unauthorized");
    expect(verifyCronRequest(`Bearer ${SECRET.toUpperCase()}`)).toBe("unauthorized");
  });

  it("el secreto correcto pasa (el esquema no distingue mayúsculas)", () => {
    expect(verifyCronRequest(`Bearer ${SECRET}`)).toBe("ok");
    expect(verifyCronRequest(`bearer ${SECRET}`)).toBe("ok");
  });
});

describe("cronJobRoute", () => {
  const request = (authorization?: string) =>
    new Request(URL_, authorization ? { headers: { authorization } } : undefined);

  it("desactivada: 404 y no corre la tarea; fuera de producción no registra nada", async () => {
    setSecret(undefined);
    const run = vi.fn();
    const response = await cronJobRoute("prueba", run)(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
    expect(serverLog).not.toHaveBeenCalled();
  });

  it("desactivada en producción: 404 y deja un error en el log, sin el valor del secreto", async () => {
    vi.stubEnv("NODE_ENV", "production");
    setSecret("corto");
    const run = vi.fn();
    const response = await cronJobRoute("prueba", run)(request("Bearer corto"));
    expect(response.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
    expect(serverLog).toHaveBeenCalledWith("error", "cron_job_disabled", { job: "prueba" });
    expect(JSON.stringify(serverLog.mock.calls)).not.toContain("corto");
  });

  it("secreto ausente o incorrecto: 401 genérico y sin correr la tarea", async () => {
    const run = vi.fn();
    const handler = cronJobRoute("prueba", run);
    for (const header of [undefined, "Bearer otro"]) {
      const response = await handler(request(header));
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("No autorizado.");
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("secreto correcto: corre la tarea una vez y responde 200 con los conteos, sin caché", async () => {
    const run = vi.fn().mockResolvedValue({ attended: 1, failed: false });
    const response = await cronJobRoute("prueba", run)(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ job: "prueba", attended: 1, failed: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("la tarea falla: 500 genérico, sin conteos", async () => {
    const run = vi.fn().mockResolvedValue({ attended: 0, failed: true });
    const response = await cronJobRoute("prueba", run)(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ job: "prueba", failed: true });
  });
});
