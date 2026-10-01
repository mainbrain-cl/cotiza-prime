import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "./helpers";

/** Implementación de referencia, independiente de la de SQL (módulo 11). */
function referenceCheckDigit(body: string): string {
  let total = 0;
  let weight = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    total += Number(body[i]) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const calc = 11 - (total % 11);
  return calc === 11 ? "0" : calc === 10 ? "K" : String(calc);
}

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

async function isValid(rut: string | null): Promise<boolean> {
  const { rows } = await db.query<{ v: boolean }>("select app.is_valid_rut($1) as v", [rut]);
  return rows[0].v;
}

describe("app.is_valid_rut", () => {
  it.each(["76086428-5", "12345678-5", "11111111-1", "1-9", "6-K"])("acepta %s", async (rut) => {
    expect(await isValid(rut)).toBe(true);
  });

  it.each([
    "76086428-4", // dígito verificador equivocado
    "12345678-K",
    "12.345.678-5", // sin normalizar
    "123456785", // sin guion
    "012345678-5", // ceros a la izquierda
    "76086428-k", // minúscula
    "123456789-0", // largo excesivo
    "-5",
    "abc-1",
    "",
  ])("rechaza %s", async (rut) => {
    expect(await isValid(rut)).toBe(false);
  });

  it("rechaza null", async () => {
    expect(await isValid(null)).toBe(false);
  });

  it("incluye el caso de dígito K y el de dígito 0", async () => {
    const findBody = (digit: string): string => {
      for (let i = 1; ; i++) if (referenceCheckDigit(String(i)) === digit) return String(i);
    };
    const withK = findBody("K");
    const withZero = findBody("0");
    expect(await isValid(`${withK}-K`)).toBe(true);
    expect(await isValid(`${withZero}-0`)).toBe(true);
  });

  it("coincide con la implementación de referencia en 500 RUT aleatorios", async () => {
    for (let n = 0; n < 500; n++) {
      const body = String(1 + Math.floor(Math.random() * 99_999_999));
      const dv = referenceCheckDigit(body);
      expect(await isValid(`${body}-${dv}`)).toBe(true);
      const wrong = dv === "1" ? "2" : "1";
      expect(await isValid(`${body}-${wrong}`)).toBe(false);
    }
  });
});

describe("app.normalize_rut", () => {
  it.each([
    ["76.086.428-5", "76086428-5"],
    ["760864285", "76086428-5"],
    [" 76 086 428-5 ", "76086428-5"],
    ["0076086428-5", "76086428-5"],
    ["6-k", "6-K"],
  ])("normaliza %s", async (input, expected) => {
    const { rows } = await db.query<{ r: string }>("select app.normalize_rut($1) as r", [input]);
    expect(rows[0].r).toBe(expected);
  });

  it.each(["", "abc", "1", "0-0", null])("devuelve null para %s", async (input) => {
    const { rows } = await db.query<{ r: string | null }>("select app.normalize_rut($1) as r", [
      input,
    ]);
    expect(rows[0].r).toBeNull();
  });
});
