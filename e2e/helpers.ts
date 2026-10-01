import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";

/** Buzón de prueba de Supabase local (Mailpit). Puerto de `[local_smtp]` en supabase/config.toml. */
const MAILBOX_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:56324";

export const TEST_PASSWORD = "clave-de-prueba-123";

/** Correo único por ejecución, con el dominio reservado `.test`: no choca con otras corridas ni usa datos reales. */
export function uniqueEmail(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}@ejemplo.test`;
}

type MailpitSearch = { messages?: { ID: string }[] };
type MailpitMessage = { Text: string; HTML: string };

/** Espera el correo de verificación en el buzón local y devuelve el enlace que trae. */
export async function waitForVerificationLink(email: string): Promise<string> {
  let link: string | null = null;
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
        );
        const { messages } = (await search.json()) as MailpitSearch;
        if (!messages?.length) return null;
        const detail = await fetch(`${MAILBOX_URL}/api/v1/message/${messages[0].ID}`);
        const body = (await detail.json()) as MailpitMessage;
        link = body.Text.match(/https?:\/\/\S+\/auth\/v1\/verify\?\S+/)?.[0] ?? null;
        return link;
      },
      { message: `No llegó el correo de verificación a ${email}`, timeout: 30_000 },
    )
    .not.toBeNull();
  return link!.replace(/[)>\]]+$/, "");
}

/** Sigue el enlace del correo: Supabase verifica y devuelve un código que la aplicación cambia por sesión. */
export async function openVerificationLink(page: Page, link: string): Promise<void> {
  // El navegador de la prueba no debe seguir la redirección a otro puerto: se toma el código y se
  // entrega directo a la ruta de la aplicación que corre en esta prueba.
  const response = await page.request.get(link, { maxRedirects: 0 });
  const location = response.headers()["location"];
  expect(location, "el enlace de verificación debe redirigir con un código").toBeTruthy();
  const code = new URL(location).searchParams.get("code");
  expect(code, "la redirección debe traer ?code=").toBeTruthy();
  await page.goto(`/auth/callback?code=${code}`);
}

/** Registra una cuenta nueva, verifica el correo y deja la sesión iniciada en la pantalla de crear organización. */
export async function signUpAndVerify(page: Page, email: string, fullName: string): Promise<void> {
  await page.goto("/registro");
  await page.getByLabel("Tu nombre").fill(fullName);
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(TEST_PASSWORD);
  await page.getByRole("checkbox", { name: /Acepto los/ }).check();
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  await expect(page.getByTestId("signup-sent")).toBeVisible();

  await openVerificationLink(page, await waitForVerificationLink(email));
  await expect(page).toHaveURL(/\/organizaciones\/nueva$/);
}

/** Completa el formulario de organización y espera llegar a su inicio. Devuelve el id de la organización. */
export async function createTenant(page: Page, name: string, rut: string): Promise<string> {
  await page.getByLabel("Nombre de la empresa").fill(name);
  await page.getByLabel("RUT de la empresa").fill(rut);
  await page.getByLabel("Rubro").selectOption("services");
  await page.getByRole("button", { name: "Crear organización" }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  return page.url().split("/o/")[1];
}
