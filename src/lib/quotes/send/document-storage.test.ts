import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const upload = vi.fn();
const download = vi.fn();
vi.mock("@/lib/supabase/admin-client", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ upload, download }) } }),
}));

import {
  readPackagePdf,
  uploadPackageLogo,
  uploadPackagePdf,
  packageLogoPath,
  packagePdfPath,
} from "./document-storage";
import { PackagePathError } from "./package-paths";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const QUOTE = "33333333-3333-4333-8333-333333333333";
const PACKAGE = "44444444-4444-4444-8444-444444444444";
const BYTES = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  upload.mockReset().mockResolvedValue({ error: null });
  download.mockReset().mockResolvedValue({ data: new Blob([BYTES]), error: null });
});

describe("almacenamiento de los archivos congelados (I3)", () => {
  it("sube y lee rutas de la propia organización", async () => {
    expect(await uploadPackagePdf(TENANT, packagePdfPath(TENANT, QUOTE, PACKAGE), BYTES)).toBe(
      true,
    );
    expect(
      await uploadPackageLogo(TENANT, packageLogoPath(TENANT, QUOTE, PACKAGE, "png"), BYTES, "png"),
    ).toBe(true);
    expect(await readPackagePdf(TENANT, packagePdfPath(TENANT, QUOTE, PACKAGE))).not.toBeNull();
  });

  it("no toca el almacenamiento con rutas de otra organización, con `..`, en mayúsculas o vacías", async () => {
    const bad = [
      packagePdfPath(OTHER, QUOTE, PACKAGE),
      `${TENANT}/../${OTHER}/${QUOTE}/${PACKAGE}.pdf`,
      packagePdfPath(TENANT, QUOTE, PACKAGE).toUpperCase(),
      "",
    ];
    for (const path of bad) {
      await expect(uploadPackagePdf(TENANT, path, BYTES), path).rejects.toBeInstanceOf(
        PackagePathError,
      );
      await expect(readPackagePdf(TENANT, path), path).rejects.toBeInstanceOf(PackagePathError);
    }
    await expect(
      uploadPackageLogo(TENANT, packageLogoPath(OTHER, QUOTE, PACKAGE, "jpg"), BYTES, "jpg"),
    ).rejects.toBeInstanceOf(PackagePathError);
    // un PDF no se sube como logo ni al revés
    await expect(
      uploadPackageLogo(TENANT, packagePdfPath(TENANT, QUOTE, PACKAGE), BYTES, "png"),
    ).rejects.toBeInstanceOf(PackagePathError);
    expect(upload).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
});
