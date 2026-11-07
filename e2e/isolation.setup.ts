// H-012 · Montaje de la prueba de aislamiento de punta a punta: arma la fixture (organizaciones,
// personas y datos ficticios) y deja una sesión de navegador iniciada por pantalla para cada persona.
import "../tests/support/stub-server-only"; // debe ir primero
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  createIsolationFixture,
  removeExMember,
  type PersonaKey,
} from "../tests/isolation/fixture";
import { TEST_PASSWORD } from "../tests/support/local-supabase";
import { expect, test } from "./fixtures";
import { AUTH_DIR, FIXTURE_FILE, loadFixture, stateFile } from "./isolation-support";

/**
 * Personas que navegan en las pruebas de pantalla. Ana (Dueña), Mixta (Administradora), Darío (Aprobador), Sofía
 * (Comercial) y Dante (Observador) son los cinco roles de la organización A (H-011b, e2e/roles.spec.ts); Carla
 * (organización archivada) y Ex (ya quitada) atacan.
 */
const BROWSER_PERSONAS: PersonaKey[] = ["ana", "mixta", "dario", "sofia", "dante", "carla", "ex"];

test.describe.configure({ mode: "serial" });

test("monta la fixture de aislamiento", async () => {
  test.setTimeout(120_000);
  mkdirSync(AUTH_DIR, { recursive: true });
  const fixture = await createIsolationFixture(randomUUID().slice(0, 8));
  writeFileSync(FIXTURE_FILE, JSON.stringify(fixture));
});

for (const key of BROWSER_PERSONAS) {
  test(`inicia sesión por pantalla como ${key}`, async ({ page }) => {
    await page.goto("/ingresar");
    await page.getByLabel("Correo").fill(loadFixture().personas[key].email);
    await page.getByLabel("Contraseña").fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Ingresar" }).click();
    await expect(page).not.toHaveURL(/\/ingresar/);
    await page.context().storageState({ path: stateFile(key) });
  });
}

test("quita a 'ex' de la organización A (con su sesión ya iniciada)", async () => {
  await removeExMember(loadFixture());
});
