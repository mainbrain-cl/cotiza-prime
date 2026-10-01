// Ayudas compartidas por la preparación y las pruebas de aislamiento de pantalla (H-012).
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import type { IsolationFixture, PersonaKey } from "../tests/isolation/fixture";

export const AUTH_DIR = path.resolve(__dirname, ".auth");
export const FIXTURE_FILE = path.join(AUTH_DIR, "fixture.json");
export const stateFile = (key: PersonaKey) => path.join(AUTH_DIR, `${key}.json`);

/** La fixture que dejó `isolation.setup.ts`. Se lee dentro de cada prueba, no al cargar el archivo. */
export function loadFixture(): IsolationFixture {
  return JSON.parse(readFileSync(FIXTURE_FILE, "utf8")) as IsolationFixture;
}

export async function countRows(db: Client, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*)::text as n from (${sql}) q`,
    params,
  );
  return Number(rows[0].n);
}
