import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isCanonicalUuid } from "@/lib/tenant/constants";
import { deriveConvertCustomerId } from "./convert-ids";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REQUEST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_REQUEST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("deriveConvertCustomerId", () => {
  it("es siempre el mismo para la misma organización y solicitud (un doble clic no crea otro cliente)", () => {
    expect(deriveConvertCustomerId(TENANT, REQUEST)).toBe(deriveConvertCustomerId(TENANT, REQUEST));
    expect(deriveConvertCustomerId(TENANT, REQUEST)).toBe(
      deriveConvertCustomerId(TENANT.toUpperCase(), REQUEST.toUpperCase()),
    );
  });

  it("cambia con la organización y con la solicitud", () => {
    const base = deriveConvertCustomerId(TENANT, REQUEST);
    expect(deriveConvertCustomerId(OTHER_TENANT, REQUEST)).not.toBe(base);
    expect(deriveConvertCustomerId(TENANT, OTHER_REQUEST)).not.toBe(base);
  });

  it("es un UUID válido y canónico, de los que acepta la base y zod", () => {
    const id = deriveConvertCustomerId(TENANT, REQUEST);
    expect(isCanonicalUuid(id)).toBe(true);
    expect(z.uuid().safeParse(id).success).toBe(true);
  });
});
