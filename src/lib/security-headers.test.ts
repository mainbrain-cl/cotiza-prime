import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { EMBED_ROUTE_EXCLUSION } from "./intake/embed-headers";

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

describe("enmarcado de las páginas (M3)", () => {
  const PDF_SOURCE = "/api/v1/tenants/:tenantId/quotes/:quoteId/pdf";
  type Header = { key: string; value: string };
  const valueOf = (headers: Header[], key: string) => headers.find((h) => h.key === key)?.value;

  it("la ruta del PDF conserva la política base y solo cambia frame-ancestors a 'self'", async () => {
    const rules = await nextConfig.headers!();
    const base = rules.find((r) => r.source === EMBED_ROUTE_EXCLUSION)!;
    const pdf = rules.find((r) => r.source === PDF_SOURCE)!;
    const baseCsp = valueOf(base.headers, "Content-Security-Policy")!;
    const pdfCsp = valueOf(pdf.headers, "Content-Security-Policy")!;
    expect(baseCsp).toContain("frame-ancestors 'none'");
    expect(pdfCsp).toContain("frame-ancestors 'self'");
    expect(pdfCsp).not.toContain("frame-ancestors 'none'");
    expect(pdfCsp.replace("frame-ancestors 'self'", "frame-ancestors 'none'")).toBe(baseCsp);
    expect(pdfCsp).toContain("object-src 'none'");
    expect(pdfCsp).toContain("default-src 'self'");
    expect(valueOf(pdf.headers, "X-Frame-Options")).toBe("SAMEORIGIN");
  });

  it("todas las demás rutas siguen con DENY y frame-ancestors 'none'", async () => {
    const rules = await nextConfig.headers!();
    for (const rule of rules) {
      if (rule.source === PDF_SOURCE) continue;
      const frame = valueOf(rule.headers, "X-Frame-Options");
      if (frame !== undefined) expect(frame, rule.source).toBe("DENY");
      const csp = valueOf(rule.headers, "Content-Security-Policy");
      if (csp?.includes("frame-ancestors")) {
        expect(csp, rule.source).toContain("frame-ancestors 'none'");
      }
    }
    const base = rules.find((r) => r.source === EMBED_ROUTE_EXCLUSION)!;
    expect(valueOf(base.headers, "X-Frame-Options")).toBe("DENY");
    // El logo tiene su propia política, que no permite que lo enmarquen.
    const logo = rules.find((r) => r.source === "/api/v1/tenants/:tenantId/logo")!;
    expect(valueOf(logo.headers, "Content-Security-Policy")).not.toContain(
      "frame-ancestors 'self'",
    );
  });
});

describe("formulario incrustable (H-093)", () => {
  it("la regla base (DENY) es la única que lo deja fuera, y no hay otra regla global que lo cubra", async () => {
    const rules = await nextConfig.headers!();
    const global = rules.filter((r) => r.source === "/:path*");
    expect(global).toEqual([]);
    expect(rules.filter((r) => r.source === EMBED_ROUTE_EXCLUSION)).toHaveLength(1);
  });
});

describe("cabeceras del enlace del cliente (H-030)", () => {
  it("las pantallas y la API públicas por token no se guardan, no se indexan y no pasan la dirección", async () => {
    const rules = await nextConfig.headers!();
    for (const source of ["/c/:path*", "/api/v1/public/:path*"]) {
      const rule = rules.find((r) => r.source === source);
      expect(rule, `falta la regla para ${source}`).toBeDefined();
      const value = (key: string) => rule!.headers.find((h) => h.key === key)?.value ?? "";
      // Valor exacto: es la regla que se publica en producción (el servidor de desarrollo la cambia).
      expect(value("Cache-Control")).toBe("private, no-store, max-age=0");
      expect(value("Referrer-Policy")).toBe("no-referrer");
      expect(value("X-Robots-Tag")).toBe("noindex, nofollow");
    }
  });
});
