import { describe, expect, it } from "vitest";
import { parseQrFormat, qrFileName } from "./qr-download";

describe("parseQrFormat", () => {
  it("acepta svg y png", () => {
    expect(parseQrFormat("svg")).toBe("svg");
    expect(parseQrFormat("png")).toBe("png");
  });
  it("rechaza todo lo demás", () => {
    for (const value of [null, "", "exe", "PNG", "svg ", "png,svg", "../png"]) {
      expect(parseQrFormat(value)).toBeNull();
    }
  });
});

describe("qrFileName", () => {
  it("quita tildes, espacios y símbolos", () => {
    expect(qrFileName("Fletes Región Metropolitana", "png")).toBe(
      "qr-fletes-region-metropolitana.png",
    );
    expect(qrFileName("Mudanzas web 2026!", "svg")).toBe("qr-mudanzas-web-2026.svg");
  });
  it("no deja caracteres peligrosos", () => {
    const name = qrFileName('../../etc/passwd"\r\nSet-Cookie: x=1;.exe', "svg");
    expect(name).toMatch(/^qr-[a-z0-9-]+\.svg$/);
    expect(name).not.toMatch(/[\\/"\r\n;]/);
  });
  it("usa un nombre de respaldo si no queda nada y acota el largo", () => {
    expect(qrFileName("***", "png")).toBe("qr-formulario.png");
    expect(qrFileName("a".repeat(500), "png").length).toBeLessThanOrEqual(70);
  });
});
