import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import {
  EMBED_PROXY_CASE_MATCHER,
  EMBED_PROXY_MATCHER,
  EMBED_ROUTE_EXCLUSION,
  buildEmbedLookalikeHeaders,
  buildEmbedResponseHeaders,
  isEmbedPathLookalike,
  parseEmbedPath,
  safeFrameAncestors,
} from "./embed-headers";

const ID = "Xk3aBcDeFgHiJkLmNoPqRs";
const ENV = { isDev: false, supabaseUrl: "https://supabase.test" };

describe("parseEmbedPath", () => {
  it("reconoce solo /f/<id>/incrustar", () => {
    expect(parseEmbedPath(`/f/${ID}/incrustar`)).toEqual({ publicId: ID });
    for (const path of [
      "/",
      `/f/${ID}`,
      `/f/${ID}/`,
      `/f/${ID}/incrustar/`,
      `/f/${ID}/incrustar/x`,
      `/f/${ID}/otra`,
      `/f/incrustar`,
      `/o/${ID}/incrustar`,
      `/c/${ID}/incrustar`,
      `/api/v1/public/forms/${ID}/incrustar`,
    ]) {
      expect(parseEmbedPath(path), path).toBeNull();
    }
  });
});

const LOOKALIKES = [
  `/F/${ID}/incrustar`,
  `/F/${ID}/INCRUSTAR`,
  `/f/${ID}/INCRUSTAR`,
  `/f/${ID}/Incrustar`,
];

describe("isEmbedPathLookalike y sus cabeceras", () => {
  it("detecta solo las variantes con otras mayúsculas, no la ruta exacta ni otras", () => {
    expect(isEmbedPathLookalike(`/f/${ID}/incrustar`)).toBe(false);
    for (const path of [`/f/${ID}`, `/f/${ID}/incrustar/`, `/f/${ID}/otra`, "/ingresar", "/F/x"]) {
      expect(isEmbedPathLookalike(path), path).toBe(false);
    }
  });

  it("responden con DENY y frame-ancestors 'none', sin dejar enmarcar a nadie", () => {
    const headers = buildEmbedLookalikeHeaders(ENV);
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["Content-Security-Policy"]).toContain("default-src 'self'");
  });
});

describe("safeFrameAncestors", () => {
  it("lista vacía o dudosa deja 'none'; una válida, solo esos sitios", () => {
    expect(safeFrameAncestors([])).toBe("'none'");
    expect(safeFrameAncestors(["https://a.cl", "https://b.cl"])).toBe("https://a.cl https://b.cl");
    expect(safeFrameAncestors(["https://a.cl; script-src *"])).toBe("'none'");
    expect(safeFrameAncestors(["*"])).toBe("'none'");
    expect(safeFrameAncestors(Array.from({ length: 11 }, (_, i) => `https://s${i}.cl`))).toBe(
      "'none'",
    );
  });
});

describe("buildEmbedResponseHeaders", () => {
  it("lleva la política completa con SOLO los sitios autorizados y sin X-Frame-Options ni CORS", () => {
    const headers = buildEmbedResponseHeaders(["https://sitio-permitido.test"], ENV);
    const csp = headers["Content-Security-Policy"];
    expect(csp).toContain("frame-ancestors https://sitio-permitido.test;");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("challenges.cloudflare.com");
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("x-frame-options");
    expect(Object.keys(headers).join(" ").toLowerCase()).not.toContain("access-control");
    expect(headers["Cache-Control"]).toBe("private, no-store, max-age=0");
    expect(headers["X-Robots-Tag"]).toContain("noindex");
    expect(headers["Strict-Transport-Security"]).toContain("max-age=");
  });

  it("sin sitios o con una lista dudosa: frame-ancestors 'none'", () => {
    expect(buildEmbedResponseHeaders([], ENV)["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(buildEmbedResponseHeaders(["http://x.cl"], ENV)["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("con Turnstile abre solo Cloudflare", () => {
    const csp = buildEmbedResponseHeaders([], { ...ENV, antibotProvider: "turnstile" })[
      "Content-Security-Policy"
    ];
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
  });
});

/** Convierte el `source` de Next (`/:path(regex)`) en una expresión regular para probar rutas. */
function sourceToRegExp(source: string): RegExp {
  const match = /^\/:path\((.*)\)$/.exec(source);
  expect(match, source).not.toBeNull();
  // Next compara las rutas sin distinguir mayúsculas: la prueba también.
  return new RegExp(`^/${match![1]}$`, "i");
}

describe("next.config: solo /f/:publicId/incrustar queda fuera de la regla DENY", () => {
  it("la regla global es la que excluye esa ruta, y es la ÚNICA con X-Frame-Options DENY", async () => {
    const all = await nextConfig.headers!();
    const deny = all.filter((rule) =>
      rule.headers.some((h) => h.key === "X-Frame-Options" && h.value === "DENY"),
    );
    expect(deny).toHaveLength(1);
    expect(deny[0].source).toBe(EMBED_ROUTE_EXCLUSION);
    // la única otra variante es el PDF (SAMEORIGIN)
    const others = all.flatMap((rule) =>
      rule.headers
        .filter((h) => h.key === "X-Frame-Options" && h.value !== "DENY")
        .map(() => rule.source),
    );
    expect(others).toEqual(["/api/v1/tenants/:tenantId/quotes/:quoteId/pdf"]);
  });

  it("la expresión deja fuera esa única ruta y protege todo lo demás", () => {
    const regexp = sourceToRegExp(EMBED_ROUTE_EXCLUSION);
    expect(regexp.test(`/f/${ID}/incrustar`)).toBe(false);
    // Next no distingue mayúsculas: estas variantes también quedan fuera de DENY y las cubre el proxy
    // (`isEmbedPathLookalike`). Si esta prueba cambia, cambia la protección.
    for (const path of LOOKALIKES) {
      expect(regexp.test(path), path).toBe(false);
      expect(isEmbedPathLookalike(path), path).toBe(true);
    }
    for (const path of [
      "/",
      "/ingresar",
      "/o/abc/formularios",
      "/o/abc/cotizaciones/x/enviar",
      "/c/token123",
      `/f/${ID}`,
      `/f/${ID}/incrustar/`,
      `/f/${ID}/incrustar/otra`,
      `/f/${ID}/otra`,
      `/x/f/${ID}/incrustar`,
      "/api/v1/tenants/a/quotes/b/pdf",
      "/api/v1/public/forms/abc/requests",
      "/api/v1/tenants/a/intake-forms/b/qr",
    ]) {
      expect(regexp.test(path), path).toBe(true);
    }
  });
});

describe("el matcher del proxy", () => {
  it("el literal de proxy.ts es el mismo que EMBED_PROXY_MATCHER", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const text = fs.readFileSync(path.join(process.cwd(), "src", "proxy.ts"), "utf8");
    expect(text).toContain(`"${EMBED_PROXY_MATCHER}"`);
    expect(EMBED_PROXY_MATCHER).toBe("/f/:publicId/incrustar");
    // y el de las variantes con otras mayúsculas, que también tiene que pasar por el proxy
    expect(text).toContain(`"${EMBED_PROXY_CASE_MATCHER}"`);
    const segment = /:segment\((.*)\)$/.exec(EMBED_PROXY_CASE_MATCHER)![1];
    const casing = new RegExp(`^${segment}$`);
    for (const variant of ["incrustar", "INCRUSTAR", "Incrustar", "iNcRuStAr"]) {
      expect(casing.test(variant), variant).toBe(true);
    }
    expect(casing.test("incrustar2")).toBe(false);
    expect(casing.test("otra")).toBe(false);
  });
});
