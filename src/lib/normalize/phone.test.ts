import { describe, expect, it } from "vitest";
import { createTenantSchema } from "@/lib/tenant/schemas";
import { customerSchema } from "@/lib/customers/schemas";
import { isPlausiblePhone } from "./phone";

describe("isPlausiblePhone", () => {
  it.each(["+56 9 1111 2222", "223456789", "(2) 2345-6789", "123456"])("acepta %s", (value) => {
    expect(isPlausiblePhone(value)).toBe(true);
  });

  it.each(["", "12345", "- - - - - -", "()()()()()", "+ ( ) -", "abc123456", "12 34 5"])(
    "rechaza %j",
    (value) => {
      expect(isPlausiblePhone(value)).toBe(false);
    },
  );
});

describe("el teléfono exige al menos 6 dígitos en los formularios", () => {
  const customer = { kind: "person", displayName: "Ana", rut: "", email: "", address: "" };
  const tenant = {
    name: "Negocio",
    rut: "76.086.428-5",
    industry: "services",
    contactEmail: "",
  };

  it("cliente", () => {
    expect(customerSchema.safeParse({ ...customer, phone: "- - - - - -" }).success).toBe(false);
    expect(customerSchema.safeParse({ ...customer, phone: "12345" }).success).toBe(false);
    expect(customerSchema.safeParse({ ...customer, phone: "+56 9 1111 2222" }).success).toBe(true);
    expect(customerSchema.safeParse({ ...customer, phone: "" }).success).toBe(true);
  });

  it("organización", () => {
    expect(createTenantSchema.safeParse({ ...tenant, contactPhone: "12345" }).success).toBe(false);
    expect(
      createTenantSchema.safeParse({ ...tenant, contactPhone: "+56 2 2345 6789" }).success,
    ).toBe(true);
    expect(createTenantSchema.safeParse({ ...tenant, contactPhone: "" }).success).toBe(true);
  });
});
