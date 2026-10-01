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
