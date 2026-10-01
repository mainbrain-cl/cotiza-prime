import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { searchHash } from "@/lib/crypto/search-hash";
import { buildCustomerInsertRow, customerHashes, decodeCustomer } from "./record";
import { customerSchema } from "./schemas";

const ENV_VARS = ["CP_PII_KEY_CURRENT", "CP_PII_KEY_V1", "CP_SEARCH_KEY_V1"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ENV_VARS) saved[name] = process.env[name];
  process.env.CP_PII_KEY_CURRENT = "v1";
  process.env.CP_PII_KEY_V1 = randomBytes(32).toString("base64");
  process.env.CP_SEARCH_KEY_V1 = randomBytes(32).toString("base64");
});
afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const input = customerSchema.parse({
  kind: "person",
  displayName: "Ana Ficticia",
  rut: "12.345.678-5",
  email: "Ana@Ejemplo.test",
  phone: "+56 9 1111 2222",
  address: "Calle Ficticia 1",
});

describe("registro cifrado del cliente", () => {
  it("cifra los datos personales y deja solo el nombre en claro", () => {
    const tenantId = randomUUID();
    const row = buildCustomerInsertRow(input, tenantId, randomUUID());
    expect(row.display_name).toBe("Ana Ficticia");
    for (const token of [row.email_enc, row.phone_enc, row.rut_enc, row.address_enc]) {
      expect(token).toMatch(/^v1\./);
    }
    const everything = JSON.stringify(row);
    for (const secret of ["ana@ejemplo.test", "12345678-5", "1111 2222", "Calle Ficticia"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("las huellas son hexadecimales de 64 caracteres y dependen de la organización", () => {
    const a = customerHashes(randomUUID(), input);
    const b = customerHashes(randomUUID(), input);
    expect(a.rutHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.rutHash).not.toBe(b.rutHash);
  });

  it("la huella del RUT es la del RUT normalizado y la del correo, la del correo en minúsculas", () => {
    const tenantId = randomUUID();
    const { rutHash, emailHash } = customerHashes(tenantId, input);
    expect(rutHash).toBe(searchHash("rut", tenantId, "12345678-5"));
    expect(emailHash).toBe(searchHash("email", tenantId, "ana@ejemplo.test"));
  });

  it("sin RUT ni correo no hay huellas ni texto cifrado de esos campos", () => {
    const empty = customerSchema.parse({ ...input, rut: "", email: "", phone: "", address: "" });
    const row = buildCustomerInsertRow(empty, randomUUID(), randomUUID());
    expect(row).toMatchObject({
      email_enc: null,
      email_hash: null,
      rut_enc: null,
      rut_hash: null,
      phone_enc: null,
      address_enc: null,
    });
  });

  it("se puede descifrar con la misma organización y fila, y no con otra", () => {
    const tenantId = randomUUID();
    const id = randomUUID();
    const row = buildCustomerInsertRow(input, tenantId, id);
    const stored = { ...row, created_at: "2026-10-01T00:00:00Z" };
    expect(decodeCustomer(stored, tenantId)).toMatchObject({
      email: "ana@ejemplo.test",
      rut: "12345678-5",
      phone: "+56 9 1111 2222",
      address: "Calle Ficticia 1",
    });
    expect(() => decodeCustomer(stored, randomUUID())).toThrow();
    expect(() => decodeCustomer({ ...stored, id: randomUUID() }, tenantId)).toThrow();
  });
});
