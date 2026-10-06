import { describe, expect, it } from "vitest";
import {
  PackagePathError,
  assertPackagePath,
  isPackagePath,
  packageLogoPath,
  packagePdfPath,
} from "./package-paths";

const TENANT = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const QUOTE = "33333333-3333-4333-8333-333333333333";
const PACKAGE = "44444444-4444-4444-8444-444444444444";

describe("rutas de los archivos congelados (I3)", () => {
  it("acepta las rutas que arma el propio módulo", () => {
    expect(() => assertPackagePath(TENANT, packagePdfPath(TENANT, QUOTE, PACKAGE))).not.toThrow();
    for (const format of ["png", "jpg"] as const) {
      const path = packageLogoPath(TENANT, QUOTE, PACKAGE, format);
      expect(() => assertPackagePath(TENANT, path)).not.toThrow();
      expect(isPackagePath(TENANT, path, "logo")).toBe(true);
      expect(isPackagePath(TENANT, path, "pdf")).toBe(false);
    }
    expect(isPackagePath(TENANT, packagePdfPath(TENANT, QUOTE, PACKAGE), "pdf")).toBe(true);
    expect(isPackagePath(TENANT, packagePdfPath(TENANT, QUOTE, PACKAGE), "logo")).toBe(false);
  });

  it("rechaza una ruta de otra organización", () => {
    const path = packagePdfPath(OTHER_TENANT, QUOTE, PACKAGE);
    expect(() => assertPackagePath(TENANT, path)).toThrow(PackagePathError);
    expect(isPackagePath(TENANT, packageLogoPath(OTHER_TENANT, QUOTE, PACKAGE, "png"))).toBe(false);
  });

  it("rechaza `..`, barras extra y rutas que no son del patrón", () => {
    const bad = [
      `${TENANT}/../${OTHER_TENANT}/${QUOTE}/${PACKAGE}.pdf`,
      `${TENANT}/${QUOTE}/../${PACKAGE}.pdf`,
      `${TENANT}/${QUOTE}/${PACKAGE}.pdf/../x.pdf`,
      `${TENANT}/${QUOTE}/${PACKAGE}.pdf/`,
      `/${TENANT}/${QUOTE}/${PACKAGE}.pdf`,
      `${TENANT}//${QUOTE}/${PACKAGE}.pdf`,
      `${TENANT}/${QUOTE}/${PACKAGE}.exe`,
      `${TENANT}/${QUOTE}/${PACKAGE}-logo.gif`,
      `${TENANT}/${QUOTE}/${PACKAGE}.pdf\n`,
      `${TENANT}\\${QUOTE}\\${PACKAGE}.pdf`,
      `${TENANT}/${QUOTE}/algo.pdf`,
      `${TENANT}/${PACKAGE}.pdf`,
    ];
    for (const path of bad) expect(isPackagePath(TENANT, path), path).toBe(false);
  });

  it("rechaza mayúsculas", () => {
    expect(isPackagePath(TENANT, packagePdfPath(TENANT, QUOTE, PACKAGE).toUpperCase())).toBe(false);
    expect(isPackagePath(TENANT.toUpperCase(), packagePdfPath(TENANT, QUOTE, PACKAGE))).toBe(false);
  });

  it("rechaza rutas vacías y organizaciones que no son UUID", () => {
    expect(isPackagePath(TENANT, "")).toBe(false);
    expect(isPackagePath("", packagePdfPath("", QUOTE, PACKAGE))).toBe(false);
    expect(isPackagePath("x", `x/${QUOTE}/${PACKAGE}.pdf`)).toBe(false);
  });
});
