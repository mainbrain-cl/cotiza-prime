import jsQR from "jsqr";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  QR_MARGIN_MODULES,
  QR_PNG_SIZE_PX,
  QrError,
  buildQrMatrix,
  buildQrPng,
  buildQrSvg,
} from "./qr";

const URL_1 = "https://app.cotizaprime.test/f/Xk3aBcDeFgHiJkLmNoPqRs";
const URL_2 = "https://cotizaprime.example/f/AbCdEfGhIjKlMnOpQrStUv";

/** Decodifica una matriz de módulos pintándola con 8 px por módulo y dejando que jsQR la lea. */
function decodeMatrix(content: string): string | null {
  const matrix = buildQrMatrix(content);
  const scale = 8;
  const total = (matrix.size + QR_MARGIN_MODULES * 2) * scale;
  const data = new Uint8ClampedArray(total * total * 4).fill(255);
  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (!matrix.isDark(row, col)) continue;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const px = (col + QR_MARGIN_MODULES) * scale + x;
          const py = (row + QR_MARGIN_MODULES) * scale + y;
          const offset = (py * total + px) * 4;
          data[offset] = data[offset + 1] = data[offset + 2] = 0;
        }
      }
    }
  }
  return jsQR(data, total, total)?.data ?? null;
}

describe("buildQrSvg", () => {
  const svg = buildQrSvg(URL_1);

  it("solo contiene los elementos permitidos", () => {
    const tags = [...svg.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]);
    expect(new Set(tags)).toEqual(new Set(["svg", "rect", "path"]));
  });

  it("no lleva scripts, estilos, enlaces, manejadores ni la dirección en claro", () => {
    expect(svg).not.toMatch(/script|style|href|onload|onerror|foreignObject|<image|<text|<title/i);
    expect(svg).not.toContain("cotizaprime");
    expect(svg).not.toContain(URL_1);
  });

  it("los atributos son solo los esperados", () => {
    const attrs = new Set([...svg.matchAll(/\s([a-zA-Z:-]+)="/g)].map((m) => m[1]));
    expect(attrs).toEqual(
      new Set(["xmlns", "viewBox", "width", "height", "shape-rendering", "fill", "d"]),
    );
  });

  it("el dibujo del trazado solo usa comandos de dibujo y números", () => {
    const d = /<path d="([^"]*)"/.exec(svg)?.[1] ?? "";
    expect(d).toMatch(/^[Mhvz0-9 -]+$/);
  });

  it("tiene margen de 4 módulos: nada oscuro en las orillas", () => {
    const total = Number(/viewBox="0 0 (\d+) /.exec(svg)?.[1]);
    const matrix = buildQrMatrix(URL_1);
    expect(total).toBe(matrix.size + QR_MARGIN_MODULES * 2);
    const d = /<path d="([^"]*)"/.exec(svg)?.[1] ?? "";
    for (const [, x, y, run] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      expect(Number(x)).toBeGreaterThanOrEqual(QR_MARGIN_MODULES);
      expect(Number(y)).toBeGreaterThanOrEqual(QR_MARGIN_MODULES);
      expect(Number(x) + Number(run)).toBeLessThanOrEqual(total - QR_MARGIN_MODULES);
      expect(Number(y) + 1).toBeLessThanOrEqual(total - QR_MARGIN_MODULES);
    }
  });

  it("es determinista", () => {
    expect(buildQrSvg(URL_1)).toBe(svg);
    expect(buildQrSvg(URL_2)).not.toBe(svg);
  });
});

describe("contenido codificado", () => {
  it.each([URL_1, URL_2, "http://localhost:3000/f/Xk3aBcDeFgHiJkLmNoPqRs"])(
    "la matriz decodifica exactamente %s",
    (content) => {
      expect(decodeMatrix(content)).toBe(content);
    },
  );

  it("usa corrección M: el mismo texto da la versión de QR esperada para M (no L)", () => {
    // Para esta dirección, M exige al menos la versión 4 (33 módulos); L cabría en la 3 (29).
    expect(buildQrMatrix(URL_1).size).toBeGreaterThanOrEqual(33);
  });
});

describe("entrada inválida", () => {
  it.each([
    "",
    "no es url",
    "javascript:alert(1)",
    "data:text/html,hola",
    "ftp://x.cl",
    "https://x.cl/\nSet-Cookie: a",
    "https://x.cl/ñ",
    "https://x.cl/ a",
    `https://x.cl/${"a".repeat(600)}`,
  ])("rechaza %j", (content) => {
    expect(() => buildQrSvg(content)).toThrow(QrError);
  });
});

describe("buildQrPng", () => {
  it("es un PNG cuadrado de 2.048 px que se decodifica con la URL exacta", async () => {
    const png = await buildQrPng(URL_1);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const { data, info } = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(QR_PNG_SIZE_PX);
    expect(info.height).toBe(QR_PNG_SIZE_PX);
    const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
    expect(decoded?.data).toBe(URL_1);
  }, 30_000);

  it("solo tiene blanco y negro", async () => {
    const png = await buildQrPng(URL_2);
    const { data } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
    const histogram = new Set<number>();
    for (const value of data) histogram.add(value);
    expect([...histogram].every((v) => v === 0 || v === 255)).toBe(true);
  }, 30_000);
});
