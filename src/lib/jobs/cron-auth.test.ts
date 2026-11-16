import { describe, expect, it } from "vitest";
import { MIN_CRON_SECRET_LENGTH, verifyCronRequest } from "./cron-auth";

const SECRET = "s".repeat(MIN_CRON_SECRET_LENGTH) + "-secreto-de-prueba";

describe("verifyCronRequest (decisión #17)", () => {
  it("sin secreto configurado (o vacío) la ruta queda desactivada", () => {
    expect(verifyCronRequest(`Bearer ${SECRET}`, undefined)).toBe("disabled");
    expect(verifyCronRequest(`Bearer ${SECRET}`, "")).toBe("disabled");
  });

  it("un secreto corto (menos de 32 caracteres) también la desactiva, aunque coincida", () => {
    const short = "x".repeat(MIN_CRON_SECRET_LENGTH - 1);
    expect(verifyCronRequest(`Bearer ${short}`, short)).toBe("disabled");
    expect(verifyCronRequest("Bearer undefined", "undefined")).toBe("disabled");
  });

  it("acepta un secreto de exactamente 32 caracteres", () => {
    const exact = "y".repeat(MIN_CRON_SECRET_LENGTH);
    expect(verifyCronRequest(`Bearer ${exact}`, exact)).toBe("ok");
  });

  it("sin encabezado, vacío o sin el esquema Bearer: no autorizado", () => {
    expect(verifyCronRequest(null, SECRET)).toBe("unauthorized");
    expect(verifyCronRequest("", SECRET)).toBe("unauthorized");
    expect(verifyCronRequest("Bearer", SECRET)).toBe("unauthorized");
    expect(verifyCronRequest("Bearer ", SECRET)).toBe("unauthorized");
    expect(verifyCronRequest(SECRET, SECRET)).toBe("unauthorized");
    expect(verifyCronRequest(`Basic ${SECRET}`, SECRET)).toBe("unauthorized");
  });

  it("un secreto distinto (más corto, más largo o con un carácter cambiado): no autorizado", () => {
    expect(verifyCronRequest("Bearer x", SECRET)).toBe("unauthorized");
    expect(verifyCronRequest(`Bearer ${SECRET}x`, SECRET)).toBe("unauthorized");
    expect(verifyCronRequest(`Bearer ${SECRET.slice(0, -1)}X`, SECRET)).toBe("unauthorized");
    expect(verifyCronRequest(`Bearer ${SECRET.toUpperCase()}`, SECRET)).toBe("unauthorized");
  });

  it("el secreto correcto pasa (el esquema no distingue mayúsculas)", () => {
    expect(verifyCronRequest(`Bearer ${SECRET}`, SECRET)).toBe("ok");
    expect(verifyCronRequest(`bearer ${SECRET}`, SECRET)).toBe("ok");
  });

  it("lee CRON_SECRET del entorno si no se le pasa uno", () => {
    const previous = process.env.CRON_SECRET;
    try {
      process.env.CRON_SECRET = SECRET;
      expect(verifyCronRequest(`Bearer ${SECRET}`)).toBe("ok");
      delete process.env.CRON_SECRET;
      expect(verifyCronRequest(`Bearer ${SECRET}`)).toBe("disabled");
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previous;
    }
  });
});
