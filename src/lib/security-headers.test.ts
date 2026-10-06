import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("cabeceras de caché de las pantallas privadas", () => {
  it("las pantallas de una organización y de cuenta son privadas y no se guardan", async () => {
    const rules = await nextConfig.headers!();
    for (const source of ["/o/:path*", "/organizaciones/:path*", "/aceptar-terminos"]) {
      const rule = rules.find((r) => r.source === source);
      expect(rule, `falta la regla para ${source}`).toBeDefined();
      const cacheControl = rule!.headers.find((h) => h.key === "Cache-Control")?.value ?? "";
      expect(cacheControl).toMatch(/private/);
      expect(cacheControl).toMatch(/no-store/);
    }
  });
});

describe("cabeceras del enlace del cliente (H-030)", () => {
  it("las pantallas y la API públicas por token no se guardan, no se indexan y no pasan la dirección", async () => {
    const rules = await nextConfig.headers!();
    for (const source of ["/c/:path*", "/api/v1/public/:path*"]) {
      const rule = rules.find((r) => r.source === source);
      expect(rule, `falta la regla para ${source}`).toBeDefined();
      const value = (key: string) => rule!.headers.find((h) => h.key === key)?.value ?? "";
      expect(value("Cache-Control")).toMatch(/private/);
      expect(value("Cache-Control")).toMatch(/no-store/);
      expect(value("Referrer-Policy")).toBe("no-referrer");
      expect(value("X-Robots-Tag")).toBe("noindex, nofollow");
    }
  });
});
