import { describe, expect, it, vi } from "vitest";
import { documentFingerprint, PdfCache, pdfCacheKey } from "./cache";
import { sampleDocument, sampleInput } from "./sample-data";

const buf = (size: number, fill = 1) => Buffer.alloc(size, fill);

describe("PdfCache", () => {
  it("entrega lo guardado y descarta lo menos usado al pasar el tope de bytes", () => {
    const cache = new PdfCache(100, 10);
    cache.set("a", buf(40));
    cache.set("b", buf(40));
    expect(cache.get("a")).toBeDefined(); // "a" pasa a ser el más reciente
    cache.set("c", buf(40)); // pasa de 100: sale "b", el menos usado
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.totalBytes).toBe(80);
  });

  it("respeta el tope de cantidad y no guarda un archivo más grande que toda la caché", () => {
    const cache = new PdfCache(1000, 2);
    cache.set("a", buf(1));
    cache.set("b", buf(1));
    cache.set("c", buf(1));
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    cache.set("enorme", buf(2000));
    expect(cache.get("enorme")).toBeUndefined();
  });

  it("no rehace el PDF si ya está, y no cuenta contra el tope de pedidos", async () => {
    const cache = new PdfCache();
    const render = vi.fn(async () => buf(10));
    const admit = vi.fn(async () => true);
    const first = await cache.getOrRender("k", admit, render);
    const second = await cache.getOrRender("k", admit, render);
    expect(first).toMatchObject({ ok: true, cached: false });
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(render).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("dos pedidos simultáneos arman una sola vez", async () => {
    const cache = new PdfCache();
    const render = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return buf(10);
    });
    const admit = vi.fn(async () => true);
    const [a, b] = await Promise.all([
      cache.getOrRender("k", admit, render),
      cache.getOrRender("k", admit, render),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("si el tope de pedidos no deja, no arma nada ni guarda nada", async () => {
    const cache = new PdfCache();
    const render = vi.fn(async () => buf(10));
    const result = await cache.getOrRender("k", async () => false, render);
    expect(result).toEqual({ ok: false, reason: "rate_limited" });
    expect(render).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
  });

  it("si armar falla, no queda nada guardado y se puede reintentar", async () => {
    const cache = new PdfCache();
    await expect(
      cache.getOrRender(
        "k",
        async () => true,
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    const retry = await cache.getOrRender(
      "k",
      async () => true,
      async () => buf(5),
    );
    expect(retry).toMatchObject({ ok: true, cached: false });
  });
});

describe("pdfCacheKey", () => {
  const base = {
    tenantId: "t1",
    quoteId: "q1",
    revision: 1,
    paper: "letter" as const,
    data: sampleDocument(),
  };

  it("lleva la organización: la misma cotización y datos en otra organización no comparte clave", () => {
    expect(pdfCacheKey(base)).not.toBe(pdfCacheKey({ ...base, tenantId: "t2" }));
    expect(pdfCacheKey(base).startsWith("t1:")).toBe(true);
  });

  it("cambia con la revisión, la cotización y el tamaño de hoja", () => {
    const key = pdfCacheKey(base);
    expect(pdfCacheKey({ ...base, revision: 2 })).not.toBe(key);
    expect(pdfCacheKey({ ...base, quoteId: "q2" })).not.toBe(key);
    expect(pdfCacheKey({ ...base, paper: "a4" })).not.toBe(key);
  });

  it("cambia si cambia algo del contenido sin tocar la revisión (cliente, marca, logo)", () => {
    const key = pdfCacheKey(base);
    const renamed = sampleDocument({
      customer: { ...sampleInput().customer, displayName: "Otro Cliente SpA" },
    });
    expect(pdfCacheKey({ ...base, data: renamed })).not.toBe(key);
    const recolored = sampleDocument({
      organization: { ...sampleInput().organization, primaryColor: "#aa0000" },
    });
    expect(pdfCacheKey({ ...base, data: recolored })).not.toBe(key);
    const png = Buffer.from("logo-uno");
    const withLogo = (data: Buffer) =>
      sampleDocument({
        organization: { ...sampleInput().organization, logo: { format: "png", data } },
      });
    expect(documentFingerprint(withLogo(png))).not.toBe(
      documentFingerprint(withLogo(Buffer.from("logo-dos"))),
    );
    expect(documentFingerprint(withLogo(png))).not.toBe(documentFingerprint(sampleDocument()));
  });
});
