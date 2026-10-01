import { randomInt } from "node:crypto";
import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";
export type { Page } from "@playwright/test";

/**
 * IP ficticia (rango de documentación 2001:db8::/32). Como la aplicación limita intentos por IP
 * (src/lib/security/login-rate-limit.ts), cada prueba entra con la suya y no se pisan entre sí
 * ni con corridas anteriores.
 */
export function randomTestIp(): string {
  const group = () => randomInt(0x1000, 0xffff).toString(16);
  return `2001:db8:${group()}:${group()}::${group()}`;
}

/** Igual que `test` de Playwright, pero cada prueba navega desde una IP propia. */
export const test = base.extend({
  extraHTTPHeaders: async ({}, provide) => {
    await provide({ "x-forwarded-for": randomTestIp() });
  },
});
