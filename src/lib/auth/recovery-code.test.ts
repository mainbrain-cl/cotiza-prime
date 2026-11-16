import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `node:crypto` se envuelve solo para comprobar que los códigos salen de `randomBytes`; por defecto el espía llama al real.
const crypto = vi.hoisted(() => ({
  real: undefined as unknown as (size: number) => Buffer,
  spy: vi.fn(),
}));
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  crypto.real = original.randomBytes as unknown as (size: number) => Buffer;
  crypto.spy.mockImplementation((size: number) => crypto.real(size));
  return { ...original, randomBytes: crypto.spy };
});
const randomBytesSpy = crypto.spy;
const realRandomBytes = (size: number): Buffer => crypto.real(size);
const useRealRandomBytes = () => randomBytesSpy.mockImplementation(realRandomBytes);

import {
  RECOVERY_CODES_PER_SET,
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_LENGTH,
  formatRecoveryCode,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  recoveryCodeHash,
  recoveryCodeHashes,
} from "./recovery-code";

const KEY_VAR = "CP_SEARCH_KEY_V1";
let savedKey: string | undefined;
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  savedKey = process.env[KEY_VAR];
  process.env[KEY_VAR] = realRandomBytes(32).toString("base64");
});
afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY_VAR];
  else process.env[KEY_VAR] = savedKey;
  randomBytesSpy.mockClear();
});

describe("alfabeto", () => {
  it("son 32 símbolos, todos distintos, sin I, L, O ni U", () => {
    expect(RECOVERY_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(RECOVERY_CODE_ALPHABET).size).toBe(32);
    for (const forbidden of ["I", "L", "O", "U"]) {
      expect(RECOVERY_CODE_ALPHABET).not.toContain(forbidden);
    }
  });
});

describe("generar un juego", () => {
  it("son 10 códigos de 12 símbolos del alfabeto, todos distintos, sacados de node:crypto", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODES_PER_SET);
    expect(RECOVERY_CODES_PER_SET).toBe(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toHaveLength(RECOVERY_CODE_LENGTH);
      expect(RECOVERY_CODE_LENGTH).toBe(12);
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
      // Lo que se genera ya está normalizado: normalizarlo no lo cambia.
      expect(normalizeRecoveryCode(code)).toBe(code);
    }
    expect(randomBytesSpy).toHaveBeenCalled();
  });

  it("cada byte aporta un símbolo con sus 5 bits bajos (256 es múltiplo de 32: ningún símbolo pesa más que otro)", () => {
    const expected = "0123456789AB";
    // Los mismos 5 bits bajos con distintos bits altos dan el mismo código.
    for (const offset of [0, 32, 64, 224]) {
      randomBytesSpy.mockImplementationOnce((() =>
        Buffer.from(Array.from({ length: 12 }, (_, index) => offset + index))) as never);
      expect(generateRecoveryCodes(), `desfase ${offset}`).toContain(expected);
    }
    // Con todos los bytes posibles, aparecen los 32 símbolos y cada uno exactamente 8 veces.
    const counts = new Map<string, number>();
    for (let value = 0; value < 256; value += 1) {
      const symbol = RECOVERY_CODE_ALPHABET[value & 31];
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
    expect(counts.size).toBe(32);
    expect([...counts.values()].every((count) => count === 8)).toBe(true);
  });

  it("si dos códigos salieran iguales, se vuelve a sortear: el juego siempre trae 10 distintos", () => {
    const fixed = Buffer.alloc(RECOVERY_CODE_LENGTH, 7);
    let calls = 0;
    randomBytesSpy.mockImplementation(((size: number) => {
      calls += 1;
      // Las tres primeras veces, el mismo código; después, azar real.
      return calls <= 3 ? Buffer.from(fixed) : realRandomBytes(size);
    }) as never);
    try {
      const codes = generateRecoveryCodes();
      expect(new Set(codes).size).toBe(10);
      expect(calls).toBeGreaterThan(10);
    } finally {
      useRealRandomBytes();
    }
  });

  it("dos juegos seguidos no se parecen", () => {
    const first = generateRecoveryCodes();
    const second = generateRecoveryCodes();
    expect(first.filter((code) => second.includes(code))).toEqual([]);
  });
});

describe("formato", () => {
  it("grupos de 4 con guion", () => {
    expect(formatRecoveryCode("7KQM3XHPW2RT")).toBe("7KQM-3XHP-W2RT");
  });
});

describe("normalizar lo que escribe la persona", () => {
  it("con y sin guiones, en minúsculas, con espacios: da la misma forma", () => {
    for (const typed of [
      "7KQM-3XHP-W2RT",
      "7kqm-3xhp-w2rt",
      "7KQM3XHPW2RT",
      " 7kqm 3xhp w2rt ",
      "7KQM–3XHP–W2RT",
      "7KQM−3XHP−W2RT",
      "\t7KQM-3XHP-W2RT\n",
    ]) {
      expect(normalizeRecoveryCode(typed), typed).toBe("7KQM3XHPW2RT");
    }
  });

  it("O es 0 e I o L son 1, como en el alfabeto Crockford", () => {
    expect(normalizeRecoveryCode("OOOO-IIII-LLLL")).toBe("000011111111");
    expect(normalizeRecoveryCode("oi1l-0o11-ABCD")).toBe("01110011ABCD");
  });

  it("rechaza lo que no queda en 12 símbolos válidos", () => {
    for (const bad of [
      "",
      "   ",
      "7KQM-3XHP-W2R",
      "7KQM-3XHP-W2RT7",
      "123456",
      "7KQM-3XHP-W2RU",
      "7KQM-3XHP-W2R!",
      "7KQM-3XHP-W2RÑ",
      "7KQM_3XHP_W2RT",
      `${"7KQM-3XHP-W2RT".repeat(10)}`,
    ]) {
      expect(normalizeRecoveryCode(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(normalizeRecoveryCode(undefined as unknown as string)).toBeNull();
    expect(normalizeRecoveryCode(123456789012 as unknown as string)).toBeNull();
  });
});

describe("huella", () => {
  it("es hexadecimal de 64 caracteres y siempre la misma para la misma cuenta y el mismo código", () => {
    const hash = recoveryCodeHash(USER_A, "7KQM3XHPW2RT");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(recoveryCodeHash(USER_A, "7KQM3XHPW2RT")).toBe(hash);
  });

  it("el mismo código en dos cuentas da huellas distintas; y dos códigos de una cuenta, también", () => {
    expect(recoveryCodeHash(USER_A, "7KQM3XHPW2RT")).not.toBe(
      recoveryCodeHash(USER_B, "7KQM3XHPW2RT"),
    );
    expect(recoveryCodeHash(USER_A, "7KQM3XHPW2RT")).not.toBe(
      recoveryCodeHash(USER_A, "7KQM3XHPW2RS"),
    );
  });

  it("cambia con la llave: sin ella no se pueden calcular ni comparar", () => {
    const hash = recoveryCodeHash(USER_A, "7KQM3XHPW2RT");
    process.env[KEY_VAR] = realRandomBytes(32).toString("base64");
    expect(recoveryCodeHash(USER_A, "7KQM3XHPW2RT")).not.toBe(hash);
  });

  it("la huella de un juego completo trae 10 distintas, en el mismo orden", () => {
    const codes = generateRecoveryCodes();
    const hashes = recoveryCodeHashes(USER_A, codes);
    expect(hashes).toHaveLength(10);
    expect(new Set(hashes).size).toBe(10);
    expect(hashes[3]).toBe(recoveryCodeHash(USER_A, codes[3]));
  });

  it("la huella no contiene el código ni lo deja ver", () => {
    const hash = recoveryCodeHash(USER_A, "7KQM3XHPW2RT");
    expect(hash.toUpperCase()).not.toContain("7KQM3XHPW2RT");
  });
});
