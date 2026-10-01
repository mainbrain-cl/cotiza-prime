import { describe, expect, it } from "vitest";
import { isTestEnv, resolveAppEnv } from "./app-env";

describe("resolveAppEnv", () => {
  it("reconoce producción solo con el valor exacto", () => {
    expect(resolveAppEnv("production")).toBe("production");
  });

  it("reconoce pruebas", () => {
    expect(resolveAppEnv("test")).toBe("test");
  });

  it.each([undefined, "", "Production", "prod", " production", "staging", "x"])(
    "falla seguro a pruebas con %j",
    (value) => {
      expect(resolveAppEnv(value)).toBe("test");
    },
  );
});

describe("isTestEnv", () => {
  it("es verdadero en pruebas y falso en producción", () => {
    expect(isTestEnv("test")).toBe(true);
    expect(isTestEnv("production")).toBe(false);
  });
});
