import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";
import { generateRut } from "../src/lib/chile/rut";
import { connect } from "../tests/db/helpers";
import { expect, randomTestIp, test } from "./fixtures";
import { TEST_PASSWORD, createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-048a: el Dueño crea, edita y elimina «Textos listos» en Configuración (un texto de cada tipo), inserta variables
// en el texto del correo y ve su vista previa, marca el texto inicial (solo uno), ve avisos claros ante nombre
// repetido, otra pestaña, falta de conexión y 375 px; un Comercial no entra ni puede ejecutar las acciones.
// Todo es ficticio (correos @ejemplo.test).

// Una sola organización para todo el archivo y varias pruebas en orden: crear cuentas es lo más lento.
test.describe.configure({ mode: "serial" });

const MOBILE = { width: 375, height: 812 };
const MIN_TOUCH_PX = 44;
const CANARY = `CANARIO-TEXTO-${Date.now().toString(36)}`;
const NO_PERMISSION = "No tienes permiso para esto.";
const NAME_TAKEN = "Ya tienes un texto con ese nombre en este tipo. Elige otro nombre.";

async function withDb<T>(fn: (db: import("pg").Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

let tenantId = "";
let ownerContext: BrowserContext;
let salesContext: BrowserContext;
let ownerPage: Page;
let salesPage: Page;
/** La misma petición de «guardar» que hizo el Dueño, para repetirla con la sesión del Comercial. */
let replay: { url: string; headers: Record<string, string>; body: Buffer | null } | null = null;
let conditionsId = "";

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

const listUrl = () => `/o/${tenantId}/configuracion/textos`;
const rowOf = (page: Page, name: string) =>
  page
    .getByTestId("snippet-row")
    .filter({ has: page.getByTestId("snippet-row-name").getByText(name, { exact: true }) });

type NewSnippet = { kind: string; name: string; body: string; isDefault?: boolean };

/** Llena el formulario de «Nuevo texto» y lo guarda. */
async function fillAndSave(page: Page, snippet: NewSnippet) {
  await page.getByTestId("snippet-kind").selectOption(snippet.kind);
  await page.getByTestId("snippet-name").fill(snippet.name);
  await page.getByTestId("snippet-body").fill(snippet.body);
  if (snippet.isDefault) await page.getByTestId("snippet-default").check();
  await page.getByTestId("snippet-save").click();
}

async function createSnippet(page: Page, snippet: NewSnippet) {
  await page.goto(`${listUrl()}/nuevo`);
  await fillAndSave(page, snippet);
  await expect(page).toHaveURL(new RegExp(`${listUrl()}$`));
  await expect(rowOf(page, snippet.name)).toHaveCount(1);
}

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

test.beforeAll(async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const ownerEmail = uniqueEmail("textos-dueno");
  const salesEmail = uniqueEmail("textos-comercial");

  ownerContext = await newContext(browser, baseURL);
  ownerPage = await ownerContext.newPage();
  await signUpAndVerify(ownerPage, ownerEmail, "Dueña Textos");
  tenantId = await createTenant(ownerPage, "Textos Listos Ltda", generateRut());

  // Un Comercial de la misma organización (no administra los textos).
  const setup = await newContext(browser, baseURL);
  try {
    await signUpAndVerify(await setup.newPage(), salesEmail, "Comercial Textos");
  } finally {
    await setup.close();
  }
  await withDb((db) =>
    db.query(
      `insert into public.members (tenant_id, user_id, role)
       select $1, id, 'sales' from auth.users where email = $2`,
      [tenantId, salesEmail],
    ),
  );
  salesContext = await newContext(browser, baseURL);
  salesPage = await salesContext.newPage();
  await login(salesPage, salesEmail);
});

test.afterAll(async () => {
  await ownerContext?.close();
  await salesContext?.close();
});

test("el Dueño llega desde Configuración, ve la lista vacía y crea un texto de cada tipo", async () => {
  test.setTimeout(240_000);
  const page = ownerPage;
  await page.goto(`/o/${tenantId}/configuracion`);
  await expect(page.getByRole("link", { name: /Textos listos/ })).toBeVisible();
  await expect(
    page.getByText(
      "Escribe una vez el correo base, las condiciones, las exclusiones y las notas al pie.",
    ),
  ).toBeVisible();
  await page.getByRole("link", { name: /Textos listos/ }).click();
  await expect(page).toHaveURL(new RegExp(`${listUrl()}$`));
  await expect(page.getByRole("heading", { name: "Textos listos", level: 1 })).toBeVisible();

  // --- estado vacío: no promete nada que hoy no pase (usarlos al cotizar llega después) ---
  await expect(page.getByText("Aún no tienes textos guardados")).toBeVisible();
  await expect(page.getByText("Pronto podrás usarlos al cotizar.")).toHaveCount(2);
  await expect(page.getByText(/con un clic|úsalos en tus cotizaciones/)).toHaveCount(0);
  await expect(page.getByTestId("snippet-count")).toHaveText("0 de 50 textos guardados");
  await page.getByTestId("snippet-new-empty").click();
  await expect(page).toHaveURL(new RegExp(`${listUrl()}/nuevo$`));

  // --- validación local: nada se envía vacío ---
  await page.getByTestId("snippet-save").click();
  await expect(page.getByText("Elige el tipo de texto.")).toBeVisible();
  await expect(page.getByText("Escribe un nombre para el texto.")).toBeVisible();
  await expect(page.getByText("Escribe el texto.", { exact: true })).toBeVisible();

  // --- las variables, la vista previa y la casilla solo existen en el texto del correo ---
  await page.getByTestId("snippet-kind").selectOption("conditions");
  await expect(page.getByTestId("snippet-variables")).toHaveCount(0);
  await expect(page.getByTestId("snippet-default")).toHaveCount(0);
  await expect(page.getByTestId("snippet-preview")).toHaveCount(0);
  await page.getByTestId("snippet-kind").selectOption("email_body");
  await expect(page.getByTestId("snippet-variables")).toBeVisible();
  await expect(page.getByTestId("snippet-default")).toBeVisible();
  // Los textos explican que usarlos al cotizar llega pronto, sin prometer lo que hoy no pasa.
  await expect(page.getByTestId("snippet-variables")).toContainText(
    "Pronto, cuando uses este texto",
  );
  await expect(page.getByText("el correo podrá partir con este texto")).toBeVisible();
  await expect(
    page.getByText(/el correo parte con este texto|se reemplaza por el dato real/),
  ).toHaveCount(0);

  // --- contador, variables en la posición del cursor (lo que se escribe después va tras la variable)  y vista previa con datos de ejemplo ---
  await expect(page.getByTestId("snippet-counter")).toHaveText("0 / 4.000");
  await page.getByTestId("snippet-name").fill("Saludo estándar");
  await page.getByTestId("snippet-body").fill("Hola , gracias");
  await expect(page.getByTestId("snippet-counter")).toHaveText("14 / 4.000");
  await page.getByTestId("snippet-body").evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(5, 5);
  });
  await page.getByTestId("snippet-variable-cliente").click();
  await expect(page.getByTestId("snippet-body")).toHaveValue("Hola {{cliente}}, gracias");
  await page.getByTestId("snippet-body").pressSequentially(" Cotización ");
  await page.getByTestId("snippet-variable-numero").click();
  await page.getByTestId("snippet-body").pressSequentially(". Saludos, ");
  await page.getByTestId("snippet-variable-remitente").click();
  await page.getByTestId("snippet-body").pressSequentially(" de ");
  await page.getByTestId("snippet-variable-organizacion").click();
  await expect(page.getByTestId("snippet-body")).toHaveValue(
    "Hola {{cliente}} Cotización {{numero}}. Saludos, {{remitente}} de {{organizacion}}, gracias",
  );
  await expect(page.getByTestId("snippet-preview-text")).toHaveText(
    "Hola Ana Pérez Cotización COT-2026-0001. Saludos, Juan Soto de Tu Empresa SpA, gracias",
  );
  await page.getByTestId("snippet-default").check();
  await page.getByTestId("snippet-save").click();
  await expect(page).toHaveURL(new RegExp(`${listUrl()}$`));
  await expect(page.getByText("Guardamos el texto.")).toBeVisible();
  await expect(rowOf(page, "Saludo estándar")).toHaveCount(1);
  await expect(rowOf(page, "Saludo estándar").getByTestId("snippet-row-default")).toHaveText(
    "Texto inicial",
  );

  // --- los otros tres tipos ---
  await createSnippet(page, {
    kind: "conditions",
    name: "Pago a 30 días",
    body: `Pago a 30 días. ${CANARY}`,
  });
  await createSnippet(page, {
    kind: "exclusions",
    name: "No incluye embalaje",
    body: "No incluye embalaje ni descarga.",
  });
  await createSnippet(page, {
    kind: "footer_note",
    name: "Vigencia",
    body: "Válida por 15 días.",
  });
  conditionsId = (await rowOf(page, "Pago a 30 días").getAttribute("href"))!.split("/").pop()!;

  // La lista agrupa por tipo, en el orden de la pantalla, y la vista breve muestra el texto.
  const groups = await page
    .locator('[data-testid^="snippet-group-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
  expect(groups).toEqual([
    "snippet-group-email_body",
    "snippet-group-conditions",
    "snippet-group-exclusions",
    "snippet-group-footer_note",
  ]);
  await expect(rowOf(page, "Pago a 30 días")).toContainText("Pago a 30 días.");
  await expect(page.getByTestId("snippet-count")).toHaveText("4 de 50 textos guardados");

  // --- la auditoría guarda quién y qué, pero nunca el texto ---
  const audit = await withDb(async (db) => {
    const { rows } = await db.query<{ action: string; details: unknown }>(
      `select action, details from public.audit_log
        where tenant_id = $1 and action like 'text_snippet.%' order by occurred_at`,
      [tenantId],
    );
    return rows;
  });
  expect(audit.filter((row) => row.action === "text_snippet.created")).toHaveLength(4);
  expect(JSON.stringify(audit)).not.toContain(CANARY);
  expect(JSON.stringify(audit)).not.toContain("Válida por 15 días");
});

test("un nombre repetido se avisa bajo el campo y no se pierde lo escrito", async () => {
  const page = ownerPage;
  await page.goto(`${listUrl()}/nuevo`);
  await page.getByTestId("snippet-kind").selectOption("conditions");
  await page.getByTestId("snippet-name").fill("pago A 30 DÍAS");
  await page.getByTestId("snippet-body").fill("Otro texto distinto.");
  await page.getByTestId("snippet-save").click();
  await expect(page.getByText(NAME_TAKEN)).toBeVisible();
  await expect(page.getByTestId("snippet-name")).toHaveAttribute("aria-invalid", "true");
  await expect(page).toHaveURL(new RegExp(`${listUrl()}/nuevo$`));
  await expect(page.getByTestId("snippet-body")).toHaveValue("Otro texto distinto.");
  // El mismo nombre en OTRO tipo sí vale.
  await page.getByTestId("snippet-kind").selectOption("exclusions");
  await page.getByTestId("snippet-name").fill("pago A 30 DÍAS");
  await page.getByTestId("snippet-save").click();
  await expect(page).toHaveURL(new RegExp(`${listUrl()}$`));
  await expect(rowOf(page, "pago A 30 DÍAS")).toHaveCount(1);
  // y se elimina para dejar el orden de las pruebas siguientes
  await rowOf(page, "pago A 30 DÍAS").click();
  await page.getByTestId("snippet-delete-button").click();
  await page.getByTestId("snippet-delete-confirm").click();
  await expect(page).toHaveURL(new RegExp(`${listUrl()}$`));
  await expect(rowOf(page, "pago A 30 DÍAS")).toHaveCount(0);
});

test("un correo que no se podría enviar (enlace engañoso) no se guarda y dice qué corregir", async () => {
  const page = ownerPage;
  const misleadingName = "Correo con enlace engañoso";
  await page.goto(`${listUrl()}/nuevo`);
  await page.getByTestId("snippet-kind").selectOption("email_body");
  await page.getByTestId("snippet-name").fill(misleadingName);
  await page
    .getByTestId("snippet-body")
    .fill("Mira [https://banco.cl](https://estafa.example/entrar) por favor.");
  // La vista previa ya avisa; al guardar, no se guarda y el mensaje queda bajo el texto.
  await expect(page.getByTestId("snippet-preview-problem")).toBeVisible();
  await page.getByTestId("snippet-save").click();
  const problem = page.getByText(
    "Un enlace muestra una dirección distinta a la que realmente abre.",
  );
  await expect(problem).toHaveCount(2); // bajo el campo y en la vista previa
  await expect(page.getByTestId("snippet-body")).toHaveAttribute("aria-invalid", "true");
  await expect(page).toHaveURL(new RegExp(`${listUrl()}/nuevo$`));
  const saved = await withDb(async (db) => {
    const { rows } = await db.query(
      "select 1 from public.text_snippets where tenant_id = $1 and name = $2",
      [tenantId, misleadingName],
    );
    return rows.length;
  });
  expect(saved).toBe(0);
  // Corregido el enlace, ya se puede guardar lo mismo (no se deja guardado: queda el orden de las pruebas siguientes).
  await page
    .getByTestId("snippet-body")
    .fill("Mira [nuestra página](https://ejemplo.cl/entrar) por favor.");
  await expect(page.getByTestId("snippet-preview-problem")).toHaveCount(0);
  await expect(page.getByTestId("snippet-preview-text")).toBeVisible();
});

test("marcar otro texto del correo como inicial desmarca el anterior; editar y eliminar piden confirmación", async () => {
  test.setTimeout(180_000);
  const page = ownerPage;
  await createSnippet(page, {
    kind: "email_body",
    name: "Seguimiento",
    body: "Hola {{cliente}}, ¿pudiste revisar la cotización?",
    isDefault: true,
  });
  await expect(page.getByTestId("snippet-row-default")).toHaveCount(1);
  await expect(rowOf(page, "Seguimiento").getByTestId("snippet-row-default")).toBeVisible();
  await expect(rowOf(page, "Saludo estándar").getByTestId("snippet-row-default")).toHaveCount(0);

  // Editar «Saludo estándar»: el tipo no se cambia, parte de lo guardado y se vuelve a marcar como inicial.
  await rowOf(page, "Saludo estándar").click();
  await expect(page.getByRole("heading", { name: "Editar texto", level: 1 })).toBeVisible();
  await expect(page.getByTestId("snippet-kind")).toHaveCount(0);
  await expect(page.getByTestId("snippet-kind-fixed")).toHaveText("Texto del correo");
  await expect(page.getByTestId("snippet-default")).not.toBeChecked();
  await page.getByTestId("snippet-body").fill("Estimado {{cliente}}: cambiamos el saludo.");
  await page.getByTestId("snippet-default").check();
  const actionRequest = page.waitForRequest(
    (request) => request.method() === "POST" && !!request.headers()["next-action"],
  );
  await page.getByTestId("snippet-save").click();
  const captured = await actionRequest;
  replay = {
    url: captured.url(),
    headers: Object.fromEntries(
      Object.entries(captured.headers()).filter(
        ([name]) => !["cookie", "content-length", "host"].includes(name.toLowerCase()),
      ),
    ),
    body: captured.postDataBuffer(),
  };
  await expect(page.getByText("Guardamos los cambios.")).toBeVisible();
  await expect(page.getByTestId("snippet-default")).toBeChecked();

  await page.goto(listUrl());
  await expect(page.getByTestId("snippet-row-default")).toHaveCount(1);
  await expect(rowOf(page, "Saludo estándar").getByTestId("snippet-row-default")).toBeVisible();
  await expect(rowOf(page, "Saludo estándar")).toContainText("cambiamos el saludo");
  const defaults = await withDb(async (db) => {
    const { rows } = await db.query<{ name: string }>(
      "select name from public.text_snippets where tenant_id = $1 and is_default",
      [tenantId],
    );
    return rows.map((row) => row.name);
  });
  expect(defaults).toEqual(["Saludo estándar"]);

  // Eliminar pide confirmar y explica que las cotizaciones ya creadas no cambian.
  await rowOf(page, "Vigencia").click();
  await page.getByTestId("snippet-delete-button").click();
  await expect(page.getByTestId("snippet-delete-dialog")).toContainText("¿Eliminar este texto?");
  await expect(page.getByTestId("snippet-delete-dialog")).toContainText(
    "Las cotizaciones ya creadas no cambian.",
  );
  await page.getByTestId("snippet-delete-cancel").click();
  await expect(page).toHaveURL(/\/configuracion\/textos\/[0-9a-f-]{36}$/);
  await page.getByTestId("snippet-delete-button").click();
  await page.getByTestId("snippet-delete-confirm").click();
  await expect(page).toHaveURL(new RegExp(`${listUrl()}$`));
  await expect(page.getByText("Eliminamos el texto.")).toBeVisible();
  await expect(rowOf(page, "Vigencia")).toHaveCount(0);
  await expect(page.getByTestId("snippet-group-footer_note")).toHaveCount(0);
});

test("dos pestañas del mismo texto: la segunda recibe el aviso de que otra persona lo cambió", async () => {
  test.setTimeout(120_000);
  const first = ownerPage;
  const second = await ownerContext.newPage();
  try {
    const url = `${listUrl()}/${conditionsId}`;
    await first.goto(url);
    await second.goto(url);
    await first.getByTestId("snippet-name").fill("Pago a 30 días (v2)");
    await first.getByTestId("snippet-save").click();
    await expect(first.getByText("Guardamos los cambios.")).toBeVisible();

    await second.getByTestId("snippet-body").fill(`Texto de la segunda pestaña ${CANARY}`);
    await second.getByTestId("snippet-save").click();
    await expect(second.getByTestId("snippet-error")).toContainText(
      "Otra persona cambió este texto mientras lo editabas. Recarga para ver la versión actual.",
    );
    // Lo escrito sigue en pantalla y nada se pisó en la base.
    await expect(second.getByTestId("snippet-body")).toHaveValue(
      `Texto de la segunda pestaña ${CANARY}`,
    );
    const stored = await withDb(async (db) => {
      const { rows } = await db.query<{ name: string; body: string }>(
        "select name, body from public.text_snippets where id = $1",
        [conditionsId],
      );
      return rows[0];
    });
    expect(stored.name).toBe("Pago a 30 días (v2)");
    expect(stored.body).toBe(`Pago a 30 días. ${CANARY}`);
    // Recargar trae la versión de la primera pestaña.
    await second.getByTestId("snippet-reload").click();
    await expect(second.getByTestId("snippet-name")).toHaveValue("Pago a 30 días (v2)");
    await expect(second.getByTestId("snippet-error")).toHaveCount(0);
  } finally {
    await second.close();
  }
});

test("sin conexión se avisa en la pantalla y lo escrito no se pierde", async () => {
  test.setTimeout(120_000);
  const page = ownerPage;
  await page.goto(`${listUrl()}/nuevo`);
  await page.getByTestId("snippet-kind").selectOption("footer_note");
  await page.getByTestId("snippet-name").fill("Nota sin conexión");
  await page.getByTestId("snippet-body").fill("Esta nota se escribe sin internet.");
  await ownerContext.setOffline(true);
  try {
    await expect(page.getByTestId("offline-notice")).toBeVisible();
    await page.getByTestId("snippet-save").click();
    await expect(page.getByTestId("snippet-error")).toContainText(
      "No pudimos conectar con el servidor",
    );
    // La pantalla de error de la organización no apareció y lo escrito sigue ahí.
    await expect(page.getByText("Algo salió mal")).toHaveCount(0);
    await expect(page.getByTestId("snippet-name")).toHaveValue("Nota sin conexión");
    await expect(page.getByTestId("snippet-body")).toHaveValue(
      "Esta nota se escribe sin internet.",
    );
  } finally {
    await ownerContext.setOffline(false);
  }
  await expect(page.getByTestId("offline-notice")).toHaveCount(0);
  await page.getByTestId("snippet-save").click();
  await expect(page).toHaveURL(new RegExp(`${listUrl()}$`));
  await expect(rowOf(page, "Nota sin conexión")).toHaveCount(1);
});

test("un identificador al azar o roto da «No encontrado»", async () => {
  const page = ownerPage;
  for (const id of ["00000000-0000-4000-8000-0000000000aa", "no-es-un-uuid"]) {
    // (el código puede ser 200: la pantalla ya empezó a enviarse cuando se sabe que no existe)
    await page.goto(`${listUrl()}/${id}`);
    await expect(page.getByRole("heading", { name: "No encontrado" })).toBeVisible();
  }
});

test("en el teléfono (375 px) no hay desplazamiento horizontal y los botones miden al menos 44 px", async () => {
  test.setTimeout(120_000);
  const page = ownerPage;
  // Un nombre largo sin espacios no debe estirar la lista (se crea antes de achicar la pantalla).
  const longName = "PagoATreintaDiasConTransferenciaBancaria";
  await createSnippet(page, {
    kind: "conditions",
    name: longName,
    body: "Pago con transferencia.",
  });
  await page.setViewportSize(MOBILE);
  try {
    await page.goto(listUrl());
    await expect(page.getByTestId("snippet-list")).toBeVisible();
    await expect(rowOf(page, longName)).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const longRow = await rowOf(page, longName).boundingBox();
    expect(longRow!.x + longRow!.width).toBeLessThanOrEqual(MOBILE.width);
    expect(await heightOf(page, "snippet-new")).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
    expect(await heightOf(page, "snippet-row")).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
    await expect(page.getByTestId("snippet-new")).toBeInViewport();

    await page.goto(`${listUrl()}/nuevo`);
    await page.getByTestId("snippet-kind").selectOption("email_body");
    await page.getByTestId("snippet-body").fill(`${"palabralarga".repeat(40)} {{cliente}}`);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const testId of [
      "snippet-kind",
      "snippet-name",
      "snippet-body",
      "snippet-variable-cliente",
      "snippet-variable-organizacion",
      "snippet-default",
      "snippet-save",
    ]) {
      expect(await heightOf(page, testId), testId).toBeGreaterThanOrEqual(
        testId === "snippet-default" ? 20 : MIN_TOUCH_PX,
      );
    }
    // El texto inicial se toca desde su etiqueta entera, que mide 44 px o más.
    const label = page.locator("label").filter({ has: page.getByTestId("snippet-default") });
    expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(MIN_TOUCH_PX);

    // La pantalla de editar (con eliminar y su confirmación)
    await page.goto(`${listUrl()}/${conditionsId}`);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(await heightOf(page, "snippet-delete-button")).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
    await page.getByTestId("snippet-delete-button").click();
    await expect(page.getByTestId("snippet-delete-dialog")).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(await heightOf(page, "snippet-delete-confirm")).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
    await page.getByTestId("snippet-delete-cancel").click();
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});

test("un Comercial no ve la tarjeta, no entra a las pantallas y no puede ejecutar las acciones", async () => {
  test.setTimeout(120_000);
  const page = salesPage;
  const snapshot = () =>
    withDb(async (db) => {
      const { rows } = await db.query(
        "select id, name, body, is_default, revision from public.text_snippets where tenant_id = $1 order by id",
        [tenantId],
      );
      return rows;
    });
  const before = await snapshot();
  expect(before.length).toBeGreaterThan(0);

  await page.goto(`/o/${tenantId}`);
  await expect(page.getByRole("link", { name: "Configuración", exact: true })).toHaveCount(0);
  await page.goto(`/o/${tenantId}/configuracion`);
  await expect(page.getByText(NO_PERMISSION)).toBeVisible();
  await expect(page.getByRole("link", { name: /Textos listos/ })).toHaveCount(0);

  for (const path of [listUrl(), `${listUrl()}/nuevo`, `${listUrl()}/${conditionsId}`]) {
    await page.goto(path);
    await expect(page.getByText(NO_PERMISSION), path).toBeVisible();
    await expect(page.getByTestId("snippet-list")).toHaveCount(0);
    await expect(page.getByTestId("snippet-form")).toHaveCount(0);
    expect(await page.content(), path).not.toContain(CANARY);
  }

  // La misma petición de guardar que hizo el Dueño, repetida con la sesión del Comercial: rechazada y sin efecto.
  expect(replay, "la prueba de edición debía capturar la petición").not.toBeNull();
  const api: APIRequestContext = salesContext.request;
  const response = await api.post(replay!.url, {
    headers: replay!.headers,
    data: replay!.body ?? undefined,
  });
  expect(await response.text()).toContain(NO_PERMISSION);
  const after = await snapshot();
  expect(after).toEqual(before);
});
