import type { Browser, BrowserContext, Page } from "@playwright/test";
import { generateRut } from "../src/lib/chile/rut";
import { TENANT_HEADER } from "../src/lib/tenant/constants";
import { connect } from "../tests/db/helpers";
import { rpc } from "../tests/support/local-supabase";
import { expect, randomTestIp, test } from "./fixtures";
import { passwordToken } from "./intake-support";
import { TEST_PASSWORD, createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-040: el Dueño configura cuándo se exige aprobación (Configuración → Aprobaciones), ve la frase en vivo, guarda y recarga;
// un Comercial no entra a la pantalla; una cotización que cumple la regla no se puede enviar (bloqueo en /enviar y rechazo de
// la base aunque se fuerce por la API); dos pestañas del Dueño (conflicto); sin conexión, teléfono y teclado; y el registro de
// actividad cuenta el cambio. Todo es ficticio (correos @ejemplo.test).

// Una sola organización para todo el archivo y varias pruebas en orden: crear cuentas es lo más lento.
test.describe.configure({ mode: "serial" });

const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1440, height: 900 };
const MIN_TOUCH_PX = 44;
const NO_PERMISSION = "No tienes permiso para esto.";
const NEVER_PHRASE = "No se pide aprobación: las cotizaciones se envían directo.";
const NOT_YET = "La solicitud de aprobación todavía no está disponible";

async function withDb<T>(fn: (db: import("pg").Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

let tenantId = "";
let salesEmail = "";
let ownerContext: BrowserContext;
let salesContext: BrowserContext;
let ownerPage: Page;
let salesPage: Page;
let quoteId = "";

async function newContext(browser: Browser, baseURL: string | undefined) {
  return browser.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": randomTestIp() } });
}

async function login(page: Page, email: string) {
  await page.goto("/ingresar");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}$`));
}

const ruleUrl = () => `/o/${tenantId}/configuracion/aprobaciones`;
const sendUrl = () => `/o/${tenantId}/cotizaciones/${quoteId}/enviar`;

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function heightOf(page: Page, testId: string): Promise<number> {
  const target = page.getByTestId(testId).first();
  await expect(target, `${testId} debe verse`).toBeVisible();
  const box = await target.boundingBox();
  expect(box, `${testId} debe tener tamaño`).not.toBeNull();
  return box!.height;
}

/** Elige una opción y guarda; espera el aviso de que quedó guardada. */
async function chooseAndSave(
  page: Page,
  mode: "never" | "always" | "conditional",
  fields: { amount?: string; discount?: string } = {},
) {
  await page.goto(ruleUrl());
  await page.getByTestId(`approval-mode-${mode}`).check();
  if (mode === "conditional") {
    await page.getByTestId("approval-amount").fill(fields.amount ?? "");
    await page.getByTestId("approval-discount").fill(fields.discount ?? "");
  }
  await page.getByTestId("approval-save").click();
  await expect(page.getByTestId("approval-saved")).toBeVisible();
}

test.beforeAll(async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  const ownerEmail = uniqueEmail("aprob-dueno");
  salesEmail = uniqueEmail("aprob-comercial");

  ownerContext = await newContext(browser, baseURL);
  ownerPage = await ownerContext.newPage();
  await signUpAndVerify(ownerPage, ownerEmail, "Dueña Aprobaciones");
  tenantId = await createTenant(ownerPage, "Aprobaciones Ltda", generateRut());

  // Un Comercial de la misma organización (no configura nada).
  const setup = await newContext(browser, baseURL);
  try {
    await signUpAndVerify(await setup.newPage(), salesEmail, "Comercial Aprobaciones");
  } finally {
    await setup.close();
  }
  await withDb(async (db) => {
    await db.query(
      `insert into public.members (tenant_id, user_id, role)
       select $1, id, 'sales' from auth.users where email = $2`,
      [tenantId, salesEmail],
    );
    await db.query(
      `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp, tax_treatment)
       values ($1, 'Servicio Alfa', 'service', 10000, 'taxable')`,
      [tenantId],
    );
  });
  salesContext = await newContext(browser, baseURL);
  salesPage = await salesContext.newPage();
  await login(salesPage, salesEmail);
});

test.afterAll(async () => {
  await ownerContext?.close();
  await salesContext?.close();
});

test("el Dueño llega desde Configuración, ve «Nunca» de partida y la frase se actualiza al escribir", async () => {
  test.setTimeout(240_000);
  const page = ownerPage;
  await page.setViewportSize(DESKTOP);
  await page.goto(`/o/${tenantId}/configuracion`);
  // «Disponible pronto» ya no incluye las reglas de aprobación: ahora es una entrada real
  await expect(page.getByText("Tus reglas de aprobación")).toHaveCount(0);
  await expect(
    page.getByText("Elige cuándo una cotización necesita visto bueno antes de salir."),
  ).toBeVisible();
  await page.getByRole("link", { name: /Aprobaciones/ }).click();
  await expect(page).toHaveURL(new RegExp(`${ruleUrl()}$`));
  await expect(page.getByRole("heading", { name: "Aprobaciones", level: 1 })).toBeVisible();

  // De partida: «Nunca», sin cambios, y sin avisos de bloqueo
  await expect(page.getByTestId("approval-mode-never")).toBeChecked();
  await expect(page.getByTestId("approval-preview")).toHaveText(NEVER_PHRASE);
  await expect(page.getByTestId("approval-last-change")).toHaveText(
    "Todavía nadie ha cambiado esta regla.",
  );
  await expect(page.getByTestId("approval-heads-up")).toHaveCount(0);
  await expect(page.getByTestId("approval-amount")).toHaveCount(0);

  await page.getByTestId("approval-mode-always").check();
  await expect(page.getByTestId("approval-preview")).toHaveText(
    "Se pide aprobación para todas las cotizaciones.",
  );
  await expect(page.getByTestId("approval-heads-up")).toContainText(
    "una cotización que cumpla la regla no se puede enviar",
  );

  // Según el monto o el descuento: los dos campos aparecen y la frase sigue lo que se escribe
  await page.getByTestId("approval-mode-conditional").check();
  await expect(page.getByTestId("approval-preview")).toContainText("Completa los datos");
  await page.getByTestId("approval-amount").fill("5.000");
  await expect(page.getByTestId("approval-preview")).toHaveText(
    "Se pide aprobación si el total supera $5.000.",
  );
  await page.getByTestId("approval-discount").fill("10");
  await expect(page.getByTestId("approval-preview")).toHaveText(
    "Se pide aprobación si el total supera $5.000 o el descuento supera 10%.",
  );
  await page.getByTestId("approval-amount").fill("");
  await page.getByTestId("approval-discount").fill("12,5");
  await expect(page.getByTestId("approval-preview")).toHaveText(
    "Se pide aprobación si el descuento supera 12,5%.",
  );
  await page.getByTestId("approval-discount").fill("0");
  await expect(page.getByTestId("approval-preview")).toHaveText(
    "Se pide aprobación si la cotización tiene cualquier descuento.",
  );
  await expect(page.getByText("El total incluye IVA.")).toBeVisible();
  await expect(page.getByText(/aplica a las cotizaciones que se envíen desde ahora/)).toBeVisible();

  // Aviso de «nadie más puede aprobar»: el Dueño es la única persona que puede aprobar
  await expect(page.getByTestId("approval-only-you")).toContainText("Hoy solo tú puedes aprobar");
});

test("datos inválidos se rechazan con mensajes claros y no se guarda nada", async () => {
  const page = ownerPage;
  await page.goto(ruleUrl());
  await page.getByTestId("approval-mode-conditional").check();

  // Sin condiciones
  await page.getByTestId("approval-save").click();
  await expect(
    page.getByText("Escribe un monto, un porcentaje de descuento o los dos."),
  ).toBeVisible();

  // Montos y porcentajes ilegibles
  await page.getByTestId("approval-amount").fill("2.000,5");
  await page.getByTestId("approval-save").click();
  await expect(page.getByText("Usa pesos enteros, sin decimales.")).toBeVisible();
  await page.getByTestId("approval-amount").fill("0");
  await page.getByTestId("approval-save").click();
  await expect(page.getByText("El monto debe ser mayor que $0.")).toBeVisible();
  await page.getByTestId("approval-amount").fill("");
  await page.getByTestId("approval-discount").fill("100");
  await page.getByTestId("approval-save").click();
  await expect(page.getByText("El descuento debe ser menor que 100%.")).toBeVisible();
  await page.getByTestId("approval-discount").fill("10,005");
  await page.getByTestId("approval-save").click();
  await expect(page.getByText("Máximo 2 decimales.")).toBeVisible();
  await expect(page.getByTestId("approval-saved")).toHaveCount(0);

  // Nada se guardó
  await page.goto(ruleUrl());
  await expect(page.getByTestId("approval-mode-never")).toBeChecked();
  await expect(page.getByTestId("approval-last-change")).toHaveText(
    "Todavía nadie ha cambiado esta regla.",
  );
});

test("guardar la regla: queda guardada, sobrevive a recargar y se ve quién y cuándo", async () => {
  const page = ownerPage;
  await chooseAndSave(page, "conditional", { amount: "5.000", discount: "10" });
  await expect(page.getByTestId("approval-saved")).toContainText(
    "Guardamos la regla de aprobación.",
  );
  await expect(page.getByTestId("approval-last-change")).toContainText("por Dueña Aprobaciones");
  await expect(page.getByTestId("approval-last-change")).toHaveText(
    /^Último cambio: \d{2}-\d{2}-\d{4} \d{2}:\d{2} por Dueña Aprobaciones\.$/,
  );

  await page.reload();
  await expect(page.getByTestId("approval-mode-conditional")).toBeChecked();
  await expect(page.getByTestId("approval-amount")).toHaveValue("5000");
  await expect(page.getByTestId("approval-discount")).toHaveValue("10");
  await expect(page.getByTestId("approval-preview")).toHaveText(
    "Se pide aprobación si el total supera $5.000 o el descuento supera 10%.",
  );

  // Guardar lo mismo no es un error ni crea una versión nueva
  await page.getByTestId("approval-save").click();
  await expect(page.getByTestId("approval-saved")).toContainText("no hay cambios que guardar");
  const versions = await withDb(async (db) =>
    Number(
      (
        await db.query<{ n: string }>(
          "select count(*) as n from public.approval_rules where tenant_id = $1",
          [tenantId],
        )
      ).rows[0].n,
    ),
  );
  expect(versions).toBe(2);
});

test("un Comercial no entra a la pantalla (por la dirección), no ve la entrada y no puede guardar", async () => {
  const page = salesPage;
  await page.goto(ruleUrl());
  await expect(page.getByText(NO_PERMISSION)).toBeVisible();
  await expect(page.getByTestId("approval-save")).toHaveCount(0);
  await expect(page.getByTestId("approval-preview")).toHaveCount(0);
  await page.goto(`/o/${tenantId}/configuracion`);
  await expect(page.getByText(NO_PERMISSION)).toBeVisible();

  // Aunque forzara la función de la base con su propio pase, la base le responde «sin permiso» y la regla no cambia
  const token = await passwordToken(salesEmail);
  const res = await rpc(
    token,
    "set_approval_rule",
    {
      p_expected_version: 2,
      p_mode: "never",
      p_amount_threshold_clp: null,
      p_discount_threshold_bp: null,
    },
    { [TENANT_HEADER]: tenantId },
  );
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect((res.json as { code?: string }).code).toBe("42501");
  const mode = await withDb(
    async (db) =>
      (
        await db.query<{ mode: string }>(
          "select mode from public.approval_rules where tenant_id = $1 order by version desc limit 1",
          [tenantId],
        )
      ).rows[0].mode,
  );
  expect(mode).toBe("conditional");
});

test("una cotización que cumple la regla no se puede enviar: bloqueo claro en /enviar y rechazo de la base si se fuerza", async () => {
  test.setTimeout(240_000);
  const page = salesPage;
  // La Comercial arma una cotización de $11.900 (con IVA): pasa los $5.000 de la regla
  await page.goto(`/o/${tenantId}/clientes/nuevo`);
  await page.getByLabel(/^(Nombre|Razón social)/).fill("Cliente De Aprobaciones");
  await page.getByLabel("Correo (opcional)").fill(uniqueEmail("cliente"));
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/clientes/[0-9a-f-]{36}(\\?creado=1)?$`));
  await page.goto(`/o/${tenantId}/cotizaciones/nueva`);
  await page.getByRole("button", { name: /Cliente De Aprobaciones/ }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/cotizaciones/[0-9a-f-]{36}$`));
  quoteId = page.url().split("/").pop()!;
  await page.getByRole("button", { name: "Agregar Servicio Alfa", exact: true }).click();
  await page.getByTestId("save-quote").click();
  await expect(page.getByTestId("save-status")).toHaveText("Guardado.");

  await page.goto(sendUrl());
  const blocker = page.getByTestId("send-blocker");
  await expect(blocker).toBeVisible();
  await expect(blocker).toContainText(
    "Esta cotización necesita aprobación: el total ($11.900) supera $5.000.",
  );
  await expect(blocker).toContainText(NOT_YET);
  await expect(page.getByTestId("send-quote")).toHaveCount(0);
  await expect(page.getByTestId("send-submit")).toHaveCount(0);

  // Forzando la base con su propio pase (sin pasar por la pantalla): rechazada, sin dejar nada a medias
  const token = await passwordToken(salesEmail);
  const detail = await withDb(async (db) => {
    const { rows } = await db.query<{ revision: number }>(
      "select revision from public.quotes where id = $1",
      [quoteId],
    );
    return rows[0];
  });
  const forced = await rpc(
    token,
    "prepare_quote_send",
    {
      p_quote_id: quoteId,
      p_expected_revision: detail.revision,
      p_send_key: crypto.randomUUID(),
      p_package_id: crypto.randomUUID(),
      p_email_message_id: crypto.randomUUID(),
      p_share_link_id: crypto.randomUUID(),
      p_token_sha256: "a".repeat(64),
      p_email_subject: "Su cotización",
      p_email_body_md: "Hola",
      p_to_email_enc: "v1.to.to",
      p_to_email_hash: "b".repeat(64),
      p_customer_snapshot_enc: "v1.snap.snap",
    },
    { [TENANT_HEADER]: tenantId },
  );
  expect(forced.status).toBeGreaterThanOrEqual(400);
  expect(forced.json).toMatchObject({ code: "CP423", message: "approval_required" });
  const left = await withDb(async (db) => {
    const count = async (table: string) =>
      Number(
        (
          await db.query<{ n: string }>(
            `select count(*) as n from public.${table} where quote_id = $1`,
            [quoteId],
          )
        ).rows[0].n,
      );
    const { rows } = await db.query<{ status: string; locked: boolean }>(
      "select status, send_lock_key is not null as locked from public.quotes where id = $1",
      [quoteId],
    );
    return {
      packages: await count("quote_packages"),
      links: await count("share_links"),
      emails: await count("email_messages"),
      ...rows[0],
    };
  });
  expect(left).toEqual({ packages: 0, links: 0, emails: 0, status: "draft", locked: false });

  // En teléfono: el bloqueo se lee sin desplazamiento horizontal
  await page.setViewportSize(MOBILE);
  await page.reload();
  await expect(page.getByTestId("send-blocker")).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await page.setViewportSize(DESKTOP);
});

test("al cambiar la regla, el envío lo nota enseguida: «Siempre» bloquea y «Nunca» deja enviar", async () => {
  test.setTimeout(240_000);
  await chooseAndSave(ownerPage, "always");

  await salesPage.goto(sendUrl());
  await expect(salesPage.getByTestId("send-blocker")).toContainText(
    "la organización pide aprobación para todas las cotizaciones",
  );

  // Un monto más alto que el total: ya no se pide (y el descuento no se mira porque no hay)
  await chooseAndSave(ownerPage, "conditional", { amount: "20.000" });
  await salesPage.goto(sendUrl());
  await expect(salesPage.getByTestId("send-quote")).toBeVisible();
  await expect(salesPage.getByTestId("send-blocker")).toHaveCount(0);

  await chooseAndSave(ownerPage, "never");
  await salesPage.goto(sendUrl());
  await expect(salesPage.getByTestId("send-quote")).toBeVisible();
  await expect(salesPage.getByTestId("send-blocker")).toHaveCount(0);
});

test("dos pestañas del Dueño: la segunda en guardar recibe el aviso de que otra persona cambió la regla", async () => {
  test.setTimeout(240_000);
  const first = ownerPage;
  const second = await ownerContext.newPage();
  try {
    await first.goto(ruleUrl());
    await second.goto(ruleUrl());
    await expect(first.getByTestId("approval-mode-never")).toBeChecked();
    await expect(second.getByTestId("approval-mode-never")).toBeChecked();

    await first.getByTestId("approval-mode-always").check();
    await first.getByTestId("approval-save").click();
    await expect(first.getByTestId("approval-saved")).toBeVisible();

    await second.getByTestId("approval-mode-conditional").check();
    await second.getByTestId("approval-amount").fill("7.000");
    await second.getByTestId("approval-save").click();
    await expect(
      second.getByText(
        "Otra persona cambió la regla mientras la editabas. Recarga para ver la vigente.",
      ),
    ).toBeVisible();
    await expect(second.getByTestId("approval-saved")).toHaveCount(0);
    // lo escrito sigue ahí hasta que decida recargar
    await expect(second.getByTestId("approval-amount")).toHaveValue("7.000");

    await second.getByTestId("approval-reload").click();
    await expect(second.getByTestId("approval-mode-always")).toBeChecked();
    await expect(second.getByTestId("approval-preview")).toHaveText(
      "Se pide aprobación para todas las cotizaciones.",
    );
  } finally {
    await second.close();
  }
});

test("sin conexión: aviso claro, lo escrito se conserva y al volver se guarda", async () => {
  test.setTimeout(240_000);
  const page = ownerPage;
  await page.goto(ruleUrl());
  await page.getByTestId("approval-mode-conditional").check();
  await page.getByTestId("approval-amount").fill("9.000");
  await ownerContext.setOffline(true);
  try {
    await expect(page.getByTestId("offline-notice")).toBeVisible();
    await page.getByTestId("approval-save").click();
    await expect(page.getByText(/No pudimos conectar con el servidor/)).toBeVisible();
    // La pantalla de error de la organización no apareció y lo escrito sigue ahí.
    await expect(page.getByText("Algo salió mal")).toHaveCount(0);
    await expect(page.getByTestId("approval-amount")).toHaveValue("9.000");
  } finally {
    await ownerContext.setOffline(false);
  }
  await expect(page.getByTestId("offline-notice")).toHaveCount(0);
  await page.getByTestId("approval-save").click();
  await expect(page.getByTestId("approval-saved")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("approval-amount")).toHaveValue("9000");
});

test("teléfono y teclado: sin desplazamiento horizontal, áreas táctiles de 44 px y se maneja con flechas", async () => {
  const page = ownerPage;
  await page.setViewportSize(MOBILE);
  await page.goto(ruleUrl());
  await expect(page.getByTestId("approval-mode-conditional")).toBeChecked();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await heightOf(page, "approval-save")).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
  expect(await heightOf(page, "approval-amount")).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
  expect(await heightOf(page, "approval-discount")).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
  for (const mode of ["never", "always", "conditional"]) {
    const box = await page.getByTestId(`approval-mode-${mode}`).boundingBox();
    expect(box!.height, `opción ${mode}`).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
  }
  // Los campos, a 16 px: el iPhone no hace zoom
  const fontSize = await page
    .getByTestId("approval-amount")
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);

  // Teclado: las flechas cambian la opción y Enter guarda
  await page.getByTestId("approval-mode-never").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("approval-mode-always")).toBeChecked();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("approval-mode-never")).toBeChecked();
  await expect(page.getByTestId("approval-preview")).toHaveText(NEVER_PHRASE);
  await page.setViewportSize(DESKTOP);
});

test("el registro de actividad cuenta cada cambio con la regla de antes y la de ahora", async () => {
  const page = ownerPage;
  await chooseAndSave(page, "never");
  await page.goto(`/o/${tenantId}/configuracion/actividad`);
  await expect(page.getByText("Cambió la regla de aprobación").first()).toBeVisible();
  await expect(page.getByText(/^Antes: .* Ahora: No se pide aprobación/).first()).toBeVisible();
  await expect(page.getByText("Regla de aprobación").first()).toBeVisible();
  const text = await page.locator("body").innerText();
  expect(text).toContain("Se pide aprobación si el total supera $5.000 o el descuento supera 10%.");
});
