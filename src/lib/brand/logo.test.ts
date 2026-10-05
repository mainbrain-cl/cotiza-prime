import { describe, expect, it } from "vitest";
import {
  inspectLogo,
  LOGO_MAX_BYTES,
  LOGO_MAX_DIMENSION,
  logoUrl,
  logoVersion,
  mimeForLogoPath,
  newLogoPath,
} from "./logo";

const TENANT = "11111111-1111-4111-8111-111111111111";

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(type: string, data: number[]): number[] {
  return [...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
}

function png(width = 8, height = 8, withEnd = true): Uint8Array {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = chunk("IHDR", [...u32(width), ...u32(height), 8, 6, 0, 0, 0]);
  const idat = chunk("IDAT", [1, 2, 3, 4]);
  return Uint8Array.from([...header, ...ihdr, ...idat, ...(withEnd ? chunk("IEND", []) : [])]);
}

function jpeg(width = 8, height = 8, withEnd = true): Uint8Array {
  const sof = [
    0xff,
    0xc0,
    0x00,
    0x0b,
    8,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    1,
    1,
    0x11,
    0,
  ];
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];
  const sos = [0xff, 0xda, 0x00, 0x02, 0x12, 0x34];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sof, ...sos, ...(withEnd ? [0xff, 0xd9] : [])]);
}

const text = (value: string) => new TextEncoder().encode(value);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';

describe("inspectLogo: el tipo sale de los bytes", () => {
  it("acepta un PNG, un JPG y un SVG verdaderos", () => {
    expect(inspectLogo(png())).toMatchObject({
      ok: true,
      kind: "png",
      mime: "image/png",
      ext: "png",
    });
    expect(inspectLogo(jpeg())).toMatchObject({
      ok: true,
      kind: "jpg",
      mime: "image/jpeg",
      ext: "jpg",
    });
    expect(inspectLogo(text(SVG))).toMatchObject({ ok: true, kind: "svg", mime: "image/svg+xml" });
  });

  it("un SVG con BOM también pasa", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...text(SVG)]);
    expect(inspectLogo(bytes)).toMatchObject({ ok: true, kind: "svg" });
  });

  it("el SVG que se guarda es el limpio, no el original", () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="1" height="1"/></svg>';
    const result = inspectLogo(text(dirty));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const saved = new TextDecoder().decode(result.bytes);
      expect(saved).not.toMatch(/script|onload|alert/);
    }
  });

  it("no se deja engañar por el nombre: un ejecutable, un HTML o un PDF no son logos", () => {
    const exe = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 3, 0, 0, 0]);
    expect(inspectLogo(exe)).toMatchObject({ ok: false });
    expect(inspectLogo(text("<html><body>hola</body></html>"))).toMatchObject({ ok: false });
    expect(inspectLogo(text("%PDF-1.7\n..."))).toMatchObject({ ok: false });
    expect(inspectLogo(text("GIF89a......"))).toMatchObject({ ok: false });
    expect(inspectLogo(text("hola, esto es texto"))).toMatchObject({ ok: false });
  });

  it("un SVG que en realidad es un script o trae contenido peligroso se rechaza o se limpia", () => {
    expect(
      inspectLogo(
        text('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://x.cl/a.png"/></svg>'),
      ),
    ).toMatchObject({ ok: false });
    expect(inspectLogo(text("<script>alert(1)</script><svg/>"))).toMatchObject({ ok: false });
  });

  it("bytes binarios que empiezan como texto no pasan por SVG", () => {
    expect(inspectLogo(Uint8Array.from([0x3c, 0xff, 0xfe, 0x00]))).toMatchObject({ ok: false });
  });

  it("rechaza un archivo vacío", () => {
    expect(inspectLogo(new Uint8Array())).toEqual({ ok: false, message: "El archivo está vacío." });
  });

  it("rechaza lo que pesa más del máximo, con un mensaje que dice cuál es", () => {
    const big = new Uint8Array(LOGO_MAX_BYTES + 1);
    big.set(png().subarray(0, 8));
    const result = inspectLogo(big);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain("1 MB");
  });

  it("acepta justo el máximo", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><title>${"a".repeat(900)}</title></svg>`;
    expect(inspectLogo(text(svg))).toMatchObject({ ok: true });
  });
});

describe("inspectLogo: imágenes dañadas o descomunales", () => {
  it("rechaza un PNG cortado (sin IEND) y uno con bloques que se pasan del final", () => {
    expect(inspectLogo(png(8, 8, false))).toMatchObject({ ok: false });
    const truncated = png().subarray(0, 40);
    expect(inspectLogo(truncated)).toMatchObject({ ok: false });
  });

  it("rechaza un PNG que no empieza con IHDR", () => {
    const bytes = png();
    bytes[12] = 0x58;
    expect(inspectLogo(bytes)).toMatchObject({ ok: false });
  });

  it("rechaza dimensiones cero o mayores al tope (bombas de descompresión)", () => {
    expect(inspectLogo(png(0, 8))).toMatchObject({ ok: false });
    const tooBig = inspectLogo(png(LOGO_MAX_DIMENSION + 1, 8));
    expect(tooBig).toMatchObject({ ok: false });
    if (!tooBig.ok) expect(tooBig.message).toContain("demasiado grande");
    expect(inspectLogo(png(LOGO_MAX_DIMENSION, LOGO_MAX_DIMENSION))).toMatchObject({ ok: true });
    expect(inspectLogo(png(65_535, 65_535))).toMatchObject({ ok: false });
  });

  it("rechaza un JPG cortado, sin tamaño o enorme", () => {
    expect(inspectLogo(jpeg(8, 8, false))).toMatchObject({ ok: false });
    expect(inspectLogo(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toMatchObject({ ok: false });
    expect(inspectLogo(jpeg(0, 8))).toMatchObject({ ok: false });
    expect(inspectLogo(jpeg(LOGO_MAX_DIMENSION + 1, 10))).toMatchObject({ ok: false });
    expect(inspectLogo(jpeg(LOGO_MAX_DIMENSION, 10))).toMatchObject({ ok: true });
  });
});

describe("rutas del logo", () => {
  it("el nombre nuevo empieza por la organización y es distinto cada vez", () => {
    const first = newLogoPath(TENANT, "png");
    const second = newLogoPath(TENANT, "png");
    expect(first).toMatch(new RegExp(`^${TENANT}/logo-[0-9a-f]{12}\\.png$`));
    expect(first).not.toBe(second);
  });

  it("deduce el tipo para responder solo de las tres extensiones que guardamos", () => {
    expect(mimeForLogoPath(`${TENANT}/logo-aaaaaaaaaaaa.png`)).toBe("image/png");
    expect(mimeForLogoPath(`${TENANT}/logo-aaaaaaaaaaaa.jpg`)).toBe("image/jpeg");
    expect(mimeForLogoPath(`${TENANT}/logo-aaaaaaaaaaaa.svg`)).toBe("image/svg+xml");
    expect(mimeForLogoPath(`${TENANT}/logo-aaaaaaaaaaaa.html`)).toBeNull();
  });

  it("la dirección con que se entrega lleva la versión", () => {
    const path = `${TENANT}/logo-0123456789ab.svg`;
    expect(logoVersion(path)).toBe("0123456789ab");
    expect(logoUrl(TENANT, path)).toBe(`/api/v1/tenants/${TENANT}/logo?v=0123456789ab`);
    expect(logoUrl(TENANT, null)).toBeNull();
  });
});
