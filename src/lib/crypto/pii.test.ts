import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptPii, encryptPii, PiiCryptoError, type PiiContext } from "./pii";
import { searchHash } from "./search-hash";

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

function context(overrides: Partial<PiiContext> = {}): PiiContext {
  return {
    table: "customers",
    field: "email",
    tenantId: randomUUID(),
    rowId: randomUUID(),
    ...overrides,
  };
}

describe("encryptPii / decryptPii", () => {
  it("ida y vuelta", () => {
    const ctx = context();
    const token = encryptPii("ana@ejemplo.test", ctx);
    expect(token).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(token).not.toContain("ana@ejemplo.test");
    expect(decryptPii(token, ctx)).toBe("ana@ejemplo.test");
  });

  it("soporta texto con acentos y vacío", () => {
    const ctx = context();
    expect(decryptPii(encryptPii("Peñalolén 123, Ñuñoa", ctx), ctx)).toBe("Peñalolén 123, Ñuñoa");
    expect(decryptPii(encryptPii("", ctx), ctx)).toBe("");
  });

  it("usa un IV distinto en cada cifrado", () => {
    const ctx = context();
    const a = encryptPii("igual", ctx);
    const b = encryptPii("igual", ctx);
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
  });

  it("falla con otro tenant_id", () => {
    const ctx = context();
    const token = encryptPii("dato", ctx);
    expect(() => decryptPii(token, { ...ctx, tenantId: randomUUID() })).toThrow(PiiCryptoError);
  });

  it("falla con otro row_id", () => {
    const ctx = context();
    const token = encryptPii("dato", ctx);
    expect(() => decryptPii(token, { ...ctx, rowId: randomUUID() })).toThrow(PiiCryptoError);
  });

  it("falla con otro campo o tabla", () => {
    const ctx = context();
    const token = encryptPii("dato", ctx);
    expect(() => decryptPii(token, { ...ctx, field: "phone" })).toThrow(PiiCryptoError);
    expect(() => decryptPii(token, { ...ctx, table: "members" })).toThrow(PiiCryptoError);
  });

  it("falla si el texto cifrado fue alterado", () => {
    const ctx = context();
    const [version, iv, body] = encryptPii("dato", ctx).split(".");
    const bytes = Buffer.from(body, "base64url");
    bytes[0] ^= 1;
    const tampered = `${version}.${iv}.${bytes.toString("base64url")}`;
    expect(() => decryptPii(tampered, ctx)).toThrow(PiiCryptoError);
  });

  it("falla con formato inválido", () => {
    expect(() => decryptPii("basura", context())).toThrow(PiiCryptoError);
    expect(() => decryptPii("v1.aa.bb", context())).toThrow(PiiCryptoError);
  });

  it("los errores no incluyen datos personales", () => {
    const ctx = context();
    const token = encryptPii("secreto@ejemplo.test", ctx);
    try {
      decryptPii(token, { ...ctx, rowId: randomUUID() });
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("secreto");
      expect(message).not.toContain(ctx.tenantId);
    }
  });

  it("lanza error claro si falta la clave", () => {
    delete process.env.CP_PII_KEY_V1;
    expect(() => encryptPii("x", context())).toThrow(/CP_PII_KEY_V1/);
  });

  it("lanza error claro si la clave no mide 32 bytes", () => {
    process.env.CP_PII_KEY_V1 = randomBytes(16).toString("base64");
    expect(() => encryptPii("x", context())).toThrow(/32 bytes/);
  });

  it("lanza error claro si la versión actual es inválida", () => {
    process.env.CP_PII_KEY_CURRENT = "uno";
    expect(() => encryptPii("x", context())).toThrow(/CP_PII_KEY_CURRENT/);
  });

  it("descifra lo antiguo tras rotar la versión actual", () => {
    const ctx = context();
    const old = encryptPii("dato", ctx);
    process.env.CP_PII_KEY_V2 = randomBytes(32).toString("base64");
    process.env.CP_PII_KEY_CURRENT = "v2";
    try {
      expect(encryptPii("nuevo", ctx).startsWith("v2.")).toBe(true);
      expect(decryptPii(old, ctx)).toBe("dato");
    } finally {
      delete process.env.CP_PII_KEY_V2;
    }
  });
});

describe("searchHash", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  it("es estable y tiene 64 caracteres hex", () => {
    const h = searchHash("rut", tenantA, "76086428-5");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(searchHash("rut", tenantA, "76086428-5")).toBe(h);
  });

  it("cambia entre organizaciones", () => {
    expect(searchHash("rut", tenantA, "76086428-5")).not.toBe(
      searchHash("rut", tenantB, "76086428-5"),
    );
  });

  it("cambia entre campos", () => {
    expect(searchHash("rut", tenantA, "valor")).not.toBe(searchHash("email", tenantA, "valor"));
  });

  it("cambia con otra clave", () => {
    const before = searchHash("email", tenantA, "a@ejemplo.test");
    process.env.CP_SEARCH_KEY_V1 = randomBytes(32).toString("base64");
    expect(searchHash("email", tenantA, "a@ejemplo.test")).not.toBe(before);
  });

  it("lanza error claro si falta la clave", () => {
    delete process.env.CP_SEARCH_KEY_V1;
    expect(() => searchHash("rut", tenantA, "x")).toThrow(/CP_SEARCH_KEY_V1/);
  });
});
