import { describe, expect, it, vi } from "vitest";
import { logoForPdf } from "./logo-image";

vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn(async () => undefined) }));

// PNG de 1 × 1 píxel, válido.
const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50" viewBox="0 0 200 50"><rect width="200" height="50" fill="#0e4c7a"/></svg>',
);

describe("logoForPdf", () => {
  it("un PNG válido pasa tal cual", async () => {
    const logo = await logoForPdf(PNG_1X1);
    expect(logo?.format).toBe("png");
  });

  it("un SVG limpio se convierte a PNG", async () => {
    const logo = await logoForPdf(SVG);
    expect(logo?.format).toBe("png");
    expect(logo?.data.subarray(1, 4).toString()).toBe("PNG");
  });

  it.each([
    ["4000", "1000"],
    ["20000", "20000"],
    ["8000", "400"],
    ["20", "5"],
  ])(
    "un SVG que declara %s × %s se convierte a un PNG de tamaño acotado",
    async (width, height) => {
      const svg = new TextEncoder().encode(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 200 50"><rect width="200" height="50" fill="#0e4c7a"/></svg>`,
      );
      const logo = await logoForPdf(svg);
      expect(logo?.format).toBe("png");
      // IHDR: ancho y alto del PNG resultante, dentro de lo razonable para un logo de 39 pt.
      const pngWidth = logo!.data.readUInt32BE(16);
      const pngHeight = logo!.data.readUInt32BE(20);
      expect(pngWidth).toBeLessThanOrEqual(1200);
      expect(pngHeight).toBeLessThanOrEqual(240);
    },
  );

  it("un archivo que no pasa la revisión (subido a mano a Storage) deja el documento sin logo", async () => {
    const script = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(await logoForPdf(script)).toBeNull();
    expect(await logoForPdf(new TextEncoder().encode("no soy una imagen"))).toBeNull();
    expect(await logoForPdf(new Uint8Array())).toBeNull();
  });
});
