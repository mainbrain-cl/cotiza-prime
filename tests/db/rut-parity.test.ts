import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isValidRut, normalizeRut } from "../../src/lib/chile/rut";
import { connect } from "./helpers";

// La implementación de TypeScript y la de SQL (app.normalize_rut / app.is_valid_rut) deben
// responder igual a los mismos casos.

const CASES: (string | null)[] = [
  "76086428-5",
  "76.086.428-5",
  "760864285",
  " 76 086 428-5 ",
  "0076086428-5",
  "012345678-5",
  "12345678-5",
  "12345678-K",
  "11111111-1",
  "1-9",
  "6-K",
  "6-k",
  "6-k ",
  "76086428-4",
  "76086428-k",
  "123456789-0",
  "000000-0",
  "0-0",
  "-5",
  "1",
  "",
  "abc",
  "abc-1",
  "12a45678-5",
  "12..345.678-5",
  "12 345 678 - 5",
  "K-K",
  "9999999-9",
  "99999999-9",
  null,
];

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

describe("RUT: TypeScript y SQL coinciden", () => {
  it.each(CASES.map((c) => [c]))("normalize_rut(%j)", async (input) => {
    const { rows } = await db.query<{ r: string | null }>("select app.normalize_rut($1) as r", [
      input,
    ]);
    expect(normalizeRut(input)).toBe(rows[0].r);
  });

  it.each(CASES.map((c) => [c]))("is_valid_rut(%j) sobre la forma canónica", async (input) => {
    const { rows } = await db.query<{ v: boolean }>("select app.is_valid_rut($1) as v", [input]);
    expect(isValidRut(input)).toBe(rows[0].v);
  });

  it.each(CASES.map((c) => [c]))("is_valid_rut(normalize_rut(%j))", async (input) => {
    const { rows } = await db.query<{ v: boolean }>(
      "select app.is_valid_rut(app.normalize_rut($1)) as v",
      [input],
    );
    expect(isValidRut(normalizeRut(input))).toBe(rows[0].v);
  });
});
