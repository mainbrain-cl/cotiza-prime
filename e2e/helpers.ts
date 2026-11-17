import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { freshTotp } from "../src/test/totp";

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
export async function waitForVerificationLink(email: string, subject?: string): Promise<string> {
  let link: string | null = null;
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(
            subject ? `to:${email} subject:${subject}` : `to:${email}`,
          )}`,
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
export async function openVerificationLink(
  page: Page,
  link: string,
  callbackPath = "/auth/callback",
): Promise<void> {
  // El navegador de la prueba no debe seguir la redirección a otro puerto: se toma el código y se
  // entrega directo a la ruta de la aplicación que corre en esta prueba.
  const response = await page.request.get(link, { maxRedirects: 0 });
  const location = response.headers()["location"];
  expect(location, "el enlace de verificación debe redirigir con un código").toBeTruthy();
  const code = new URL(location).searchParams.get("code");
  expect(code, "la redirección debe traer ?code=").toBeTruthy();
  await page.goto(`${callbackPath}?code=${code}`);
}

/** Cuántos correos con ese asunto hay para esa dirección en el buzón local. */
export async function countMails(email: string, subject: string): Promise<number> {
  const search = await fetch(
    `${MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${email} subject:${subject}`)}`,
  );
  const { messages } = (await search.json()) as MailpitSearch;
  return messages?.length ?? 0;
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

/** Cuánto se espera la pantalla de códigos de respaldo tras confirmar la activación. */
const RECOVERY_SCREEN_TIMEOUT_MS = 20_000;
/** Etiquetas de «Seguridad de tu cuenta» al activar la verificación en dos pasos (H-004b: el último paso pide también la contraseña). */
const ENABLE_TWO_STEP_BUTTON = "Activar la verificación en dos pasos";
const TOTP_CODE_LABEL = "Código de 6 números";
const ENROLL_PASSWORD_LABEL = "Tu contraseña";

/**
 * El último paso de activar: escribe el código de la aplicación y la contraseña, y confirma. La contraseña se vuelve a
 * pedir desde H-004b; por defecto es la de las cuentas de prueba.
 */
export async function submitEnrollmentConfirmation(
  page: Page,
  code: string,
  password: string = TEST_PASSWORD,
): Promise<void> {
  await page.getByLabel(TOTP_CODE_LABEL).fill(code);
  await page.getByLabel(ENROLL_PASSWORD_LABEL).fill(password);
  await page.getByRole("button", { name: "Confirmar y activar" }).click();
}

/**
 * La pantalla «Tus códigos de respaldo» que aparece al activar (H-004b): lee los 10 códigos, marca «Guardé estos códigos en un
 * lugar seguro», aprieta «Listo» y espera volver a la pantalla de seguridad con el aviso `aviso` (por defecto, «activada»).
 * Devuelve los códigos tal como se mostraron (con guiones).
 */
export async function finishRecoveryCodes(
  page: Page,
  notice: "activada" | "codigos" = "activada",
): Promise<string[]> {
  // Activar hace bastante en el servidor (contraseña, código, aviso por correo y los códigos): damos más margen que los 5 s de siempre.
  await expect(page.getByTestId("recovery-codes-screen")).toBeVisible({
    timeout: RECOVERY_SCREEN_TIMEOUT_MS,
  });
  const codes = await page.getByTestId("recovery-code").allInnerTexts();
  expect(codes).toHaveLength(10);
  await page.getByRole("checkbox", { name: "Guardé estos códigos en un lugar seguro" }).check();
  await page.getByRole("button", { name: "Listo", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/cuenta/seguridad\\?aviso=${notice}$`));
  return codes;
}

/**
 * Activa la verificación en dos pasos desde «Seguridad de tu cuenta», de punta a punta: abre la pantalla, lee la clave,
 * escribe el código de la aplicación y la contraseña, y espera el aviso de «activada». Devuelve la clave, el período
 * (de 30 s) del código usado, para seguir con códigos nuevos, y los códigos de respaldo.
 */
export async function activateTwoStep(
  page: Page,
  password: string = TEST_PASSWORD,
): Promise<{ secret: string; step: number; recoveryCodes: string[] }> {
  await page.goto("/cuenta/seguridad");
  await page.getByRole("button", { name: ENABLE_TWO_STEP_BUTTON }).click();
  const secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s/g, "");
  await page.getByRole("button", { name: "Ya la escaneé" }).click();
  const { code, step } = await freshTotp(secret);
  await submitEnrollmentConfirmation(page, code, password);
  // Desde H-004b la activación pasa por la pantalla de códigos de respaldo y «Listo».
  const recoveryCodes = await finishRecoveryCodes(page);
  return { secret, step, recoveryCodes };
}

/**
 * Ningún botón, enlace, campo, casilla ni código de la pantalla se sale de su tarjeta (`AuthCard`, que tiene `overflow-hidden`:
 * lo que se sale queda cortado y el `scrollWidth` del documento NO lo ve). Compara el rectángulo de cada control con el de la
 * tarjeta. Si no hay controles o no hay tarjeta, falla (la prueba no puede pasar en vacío).
 */
export async function expectControlsInsideCard(page: Page, where: string): Promise<void> {
  const measure = () =>
    page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('section[aria-labelledby="auth-title"]');
      if (!card) return { missingCard: true, controls: 0, outside: [] as string[] };
      const box = card.getBoundingClientRect();
      const controls = [
        ...card.querySelectorAll<HTMLElement>(
          'button, a[href], input:not([type="hidden"]), label, code, select, textarea',
        ),
      ].filter(
        (el) => el.getAttribute("aria-hidden") !== "true" && !el.classList.contains("sr-only"),
      );
      const visible = controls.filter((el) => el.getClientRects().length > 0);
      const bad = visible
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left < box.left - 1 || rect.right > box.right + 1;
        })
        .map((el) => el.textContent?.trim().slice(0, 40) || el.getAttribute("name") || el.tagName);
      return { missingCard: false, controls: visible.length, outside: bad };
    });
  // Tras navegar puede verse un instante la pantalla de carga (misma tarjeta, sin controles): se espera a que haya controles.
  await expect
    .poll(async () => (await measure()).controls, {
      message: `${where}: la tarjeta no mostró controles`,
    })
    .toBeGreaterThan(0);
  const outside = await measure();
  expect(outside.missingCard, `${where}: no se encontró la tarjeta de la pantalla`).toBe(false);
  expect(outside.controls, `${where}: no encontró controles dentro de la tarjeta`).toBeGreaterThan(
    0,
  );
  expect(outside.outside, `${where}: controles que se salen de la tarjeta`).toEqual([]);
}
