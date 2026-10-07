import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  LOGO_THUMBNAIL_MAX_SIDE_PX,
  LOGO_THUMBNAIL_MIME,
  shrinkLogo,
  shrinkLogoToDataUrl,
} from "./logo-thumbnail";

async function png(width: number, height: number, transparent = false): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 43, g: 84, b: 224, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

describe("logo reducido para la página pública", () => {
  it("achica un PNG grande a 256 px de lado como máximo y lo entrega como WebP", async () => {
    const result = await shrinkLogo(await png(1600, 900), "png");
    expect(result?.mime).toBe(LOGO_THUMBNAIL_MIME);
    const meta = await sharp(result!.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(LOGO_THUMBNAIL_MAX_SIDE_PX);
    expect(meta.height).toBe(144);
  });

  it("no agranda un logo que ya es chico y conserva la transparencia", async () => {
    const result = await shrinkLogo(await png(64, 32, true), "png");
    const meta = await sharp(result!.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([64, 32]);
    expect(meta.hasAlpha).toBe(true);
  });

  it("rasteriza un SVG: la salida es una imagen, nunca código", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="500"><rect width="1000" height="500" fill="#2b54e0"/></svg>',
    );
    const url = await shrinkLogoToDataUrl(svg, "svg");
    expect(url).toMatch(/^data:image\/webp;base64,/);
    const bytes = Buffer.from(url!.split(",")[1], "base64");
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(
      LOGO_THUMBNAIL_MAX_SIDE_PX,
    );
  });

  it("un archivo dañado o que no es una imagen da null (la cabecera queda sin logo)", async () => {
    expect(await shrinkLogo(Buffer.from("esto no es una imagen"), "png")).toBeNull();
    expect(await shrinkLogo(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), "png")).toBeNull();
    expect(await shrinkLogoToDataUrl(Buffer.alloc(0), "jpg")).toBeNull();
  });
});
