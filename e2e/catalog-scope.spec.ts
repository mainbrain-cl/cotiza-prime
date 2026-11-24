import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { generateRut } from "../src/lib/chile/rut";
import { connect } from "../tests/db/helpers";
import {
  adminCreateUser,
  TEST_PASSWORD as ACCOUNT_PASSWORD,
} from "../tests/support/local-supabase";
import { expect, randomTestIp, test } from "./fixtures";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-042: el Dueño o un Administrador elige qué servicios puede cotizar cada Comercial («todos» o «solo los que elijas»). La Comercial solo
// ve y agrega esos al cotizar; si le cambian la lista con el editor abierto, el servidor lo rechaza con un mensaje claro y la pantalla
// vuelve a pedir su lista; lo que la cotización ya tenía se conserva. Todo es ficticio (@ejemplo.test) y cada prueba crea sus propias
// cuentas y su organización.

// El registro de cuentas bajo carga supera los 5 s de espera: este archivo corre en orden.
test.describe.configure({ mode: "serial" });

const MOBILE = { width: 375, height: 812 };
const NO_PERMISSION = "No tienes permiso para esto.";
const NOT_ALLOWED_LINE =
  "Ya no puedes cotizar este servicio: un Administrador cambió tu lista. Quita la línea para guardar.";

async function withDb<T>(fn: (db: import("pg").Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

async function newContext(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": randomTestIp() } });
}

/** Una cuenta lista para ingresar (correo confirmado y términos aceptados), sin pasar por el registro. */
async function createAccount(label: string, fullName: string): Promise<string> {
  const email = uniqueEmail(label);
  const legal = await withDb((db) =>
    db.query<{ kind: string; version: string }>(
      "select kind, version from public.legal_documents where is_current",
    ),
  );
  await adminCreateUser(email, {
    full_name: fullName,
    accepted_legal: Object.fromEntries(legal.rows.map((row) => [row.kind, row.version])),
  });
  return email;
}

async function login(page: Page, email: string, tenantId: string) {
  await page.goto("/ingresar");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(ACCOUNT_PASSWORD);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}$`));
}

type Person = { email: string; name: string; memberId: string; role: string };

/** Suma a la organización una cuenta nueva con ese rol (como lo haría una invitación aceptada). */
async function addPerson(tenantId: string, role: string, name: string): Promise<Person> {
  const email = await createAccount(`alcance-${role}`, name);
  return withDb(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.members (tenant_id, user_id, role)
       select $1, id, $3 from auth.users where email = $2 returning id`,
      [tenantId, email, role],
    );
    return { email, name, memberId: rows[0].id, role };
  });
}

async function addService(tenantId: string, name: string, price = 10_000): Promise<string> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp, tax_treatment)
       values ($1, $2, 'service', $3, 'taxable') returning id`,
      [tenantId, name, price],
    );
    return rows[0].id;
  });
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const dbScope = (memberId: string) =>
  withDb(async (db) => {
    const scope = await db.query<{ mode: string; revision: number }>(
      "select mode, revision from public.member_catalog_scopes where member_id = $1",
      [memberId],
    );
    const items = await db.query<{ name: string }>(
      `select c.name from public.member_catalog_scope_items i
         join public.catalog_items c on c.id = i.catalog_item_id
        where i.member_id = $1 order by c.name`,
      [memberId],
    );
    return { scope: scope.rows[0] ?? null, names: items.rows.map((r) => r.name) };
  });

const scopeSection = (page: Page) => page.getByTestId("catalog-scope");
const lines = (page: Page) => page.getByTestId("quote-line");
const row = (page: Page, name: string) =>
  page.getByTestId("catalog-scope-list").locator("label", { hasText: name });

test("el Dueño limita a una Comercial; ella solo ve lo permitido, le cambian la lista con el editor abierto y lo que ya tenía se conserva", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(420_000);
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await signUpAndVerify(page, uniqueEmail("alcance-dueno"), "Dueña Alcance");
  const tenantId = await createTenant(page, "Alcance Ltda", generateRut());
  const carla = await addPerson(tenantId, "sales", "Carla Comercial");
  await addService(tenantId, "Flete local", 10_000);
  await addService(tenantId, "Grúa", 25_000);
  await addService(tenantId, "Mudanza", 40_000);
  await withDb((db) =>
    db.query(
      `insert into public.customers (id, tenant_id, kind, display_name)
       values ($1, $2, 'company', 'Cliente Alcance')`,
      [randomUUID(), tenantId],
    ),
  );

  // --- la ficha: sin regla es «todos» ---
  await page.goto(`/o/${tenantId}/equipo/${carla.memberId}`);
  await expect(scopeSection(page)).toBeVisible();
  await expect(
    scopeSection(page).getByRole("heading", { name: "Servicios que puede cotizar" }),
  ).toBeVisible();
  await expect(page.getByTestId("catalog-scope-summary")).toHaveText(
    "Carla Comercial puede cotizar todos los servicios",
  );
  await expect(page.getByTestId("catalog-scope-hand-written")).toHaveText(
    "Las líneas escritas a mano no se limitan.",
  );
  await expect(page.getByTestId("catalog-scope-save")).toBeDisabled();

  // --- elegir solo uno: sin elegir nada avisa; con uno, guarda ---
  await page.getByTestId("catalog-scope-mode-list").check();
  await expect(page.getByTestId("catalog-scope-problem")).toContainText(
    "Elige al menos un servicio",
  );
  await expect(page.getByTestId("catalog-scope-save")).toBeDisabled();
  await expect(page.getByTestId("catalog-scope-count")).toHaveText("0 de 3 elegidos");
  // el buscador filtra; «marcar los que se ven» marca solo lo visible
  await page.getByTestId("catalog-scope-search").fill("flete");
  await expect(page.getByTestId("catalog-scope-item")).toHaveCount(1);
  await page.getByTestId("catalog-scope-select-visible").click();
  await page.getByTestId("catalog-scope-search").fill("");
  await expect(page.getByTestId("catalog-scope-count")).toHaveText("1 de 3 elegidos");
  await page.getByTestId("catalog-scope-save").click();
  await expect(
    page.getByText("Listo: Carla Comercial solo puede cotizar 1 servicio."),
  ).toBeVisible();
  await expect(page.getByTestId("catalog-scope-summary")).toHaveText(
    "Carla Comercial puede cotizar 1 servicio: Flete local",
  );
  await expect(page.getByTestId("catalog-scope-changed")).toContainText("Cambiado por ti el");
  await expect(page.getByTestId("catalog-scope-save")).toBeDisabled();
  expect(await dbScope(carla.memberId)).toEqual({
    scope: { mode: "list", revision: 1 },
    names: ["Flete local"],
  });

  // --- recargar: la regla persiste ---
  await page.reload();
  await expect(page.getByTestId("catalog-scope-mode-list")).toBeChecked();
  await expect(page.getByTestId("catalog-scope-count")).toHaveText("1 de 3 elegidos");
  await expect(page.getByTestId("catalog-scope-changed")).toContainText(
    "Cambiado por Dueña Alcance el",
  );

  // --- la Comercial: solo ve lo permitido ---
  const carlaContext = await newContext(browser, baseURL);
  try {
    const carlaPage = await carlaContext.newPage();
    const carlaErrors: string[] = [];
    carlaPage.on("pageerror", (error) => carlaErrors.push(error.message));
    await login(carlaPage, carla.email, tenantId);

    // no puede abrir la ficha ni cambiar su propia regla
    await carlaPage.goto(`/o/${tenantId}/equipo/${carla.memberId}`);
    await expect(carlaPage.getByText(NO_PERMISSION)).toBeVisible();
    await expect(carlaPage.getByTestId("catalog-scope-form")).toHaveCount(0);

    await carlaPage.goto(`/o/${tenantId}/cotizaciones/nueva`);
    await carlaPage.getByRole("button", { name: /Cliente Alcance/ }).click();
    await expect(carlaPage).toHaveURL(new RegExp(`/o/${tenantId}/cotizaciones/[0-9a-f-]{36}$`));
    const firstQuote = carlaPage.url();
    await expect(carlaPage.getByTestId("catalog-scope-notice")).toContainText(
      "Ves solo los servicios que tu organización te permite cotizar.",
    );
    await expect(carlaPage.getByTestId("catalog-results").locator("li")).toHaveCount(1);
    await expect(
      carlaPage.getByRole("button", { name: "Agregar Flete local", exact: true }),
    ).toBeVisible();
    await expect(carlaPage.getByRole("button", { name: "Agregar Grúa", exact: true })).toHaveCount(
      0,
    );
    // buscar un servicio que existe pero no es suyo: lo dice sin revelarlo
    await carlaPage.getByLabel("Buscar en tu catálogo").fill("Mudanza");
    await expect(carlaPage.getByTestId("catalog-empty")).toHaveText(
      "Ninguno de tus servicios coincide con ese nombre.",
    );
    await carlaPage.getByLabel("Buscar en tu catálogo").fill("");
    await expect(carlaPage.getByTestId("catalog-results").locator("li")).toHaveCount(1);
    // agrega el suyo y guarda
    await carlaPage.getByRole("button", { name: "Agregar Flete local", exact: true }).click();
    await carlaPage.getByTestId("save-quote").click();
    await expect(carlaPage.getByTestId("save-status")).toHaveText("Guardado.");

    // una línea libre escrita a mano no se limita (decisión D2)
    await carlaPage.getByRole("button", { name: "Agregar línea libre" }).click();
    await lines(carlaPage)
      .nth(1)
      .getByLabel(/Nombre de la línea/)
      .fill("Mudanza a mano");
    await lines(carlaPage).nth(1).getByLabel("Precio unitario (neto)").fill("12345");
    await carlaPage.getByTestId("save-quote").click();
    await expect(carlaPage.getByTestId("save-status")).toHaveText("Guardado.");

    // --- le cambian la lista con un editor NUEVO abierto: lo que ve es de antes ---
    await carlaPage.goto(`/o/${tenantId}/cotizaciones/nueva`);
    await carlaPage.getByRole("button", { name: /Cliente Alcance/ }).click();
    await expect(carlaPage).toHaveURL(new RegExp(`/o/${tenantId}/cotizaciones/[0-9a-f-]{36}$`));
    const staleQuote = carlaPage.url();
    await expect(
      carlaPage.getByRole("button", { name: "Agregar Flete local", exact: true }),
    ).toBeVisible();

    // el Dueño la deja solo con «Grúa» (versión 1 → 2)
    await page.reload();
    await row(page, "Flete local").getByRole("checkbox").uncheck();
    await row(page, "Grúa").getByRole("checkbox").check();
    await page.getByTestId("catalog-scope-save").click();
    await expect(
      page.getByText("Listo: Carla Comercial solo puede cotizar 1 servicio."),
    ).toBeVisible();
    expect(await dbScope(carla.memberId)).toEqual({
      scope: { mode: "list", revision: 2 },
      names: ["Grúa"],
    });

    // la Comercial agrega «Flete local» de su lista vieja y guarda: el servidor lo rechaza con el mensaje claro junto a la línea
    await carlaPage.getByRole("button", { name: "Agregar Flete local", exact: true }).click();
    await carlaPage.getByTestId("save-quote").click();
    await expect(carlaPage.getByText(NOT_ALLOWED_LINE)).toBeVisible();
    // y la pantalla vuelve a pedir su lista: ahora le ofrece «Grúa» y ya no «Flete local»
    await expect(
      carlaPage.getByRole("button", { name: "Agregar Grúa", exact: true }),
    ).toBeVisible();
    await expect(
      carlaPage.getByRole("button", { name: "Agregar Flete local", exact: true }),
    ).toHaveCount(0);
    // quitar la línea la deja guardar
    await carlaPage.getByRole("button", { name: /Quitar la línea 1/i }).click();
    await carlaPage.getByTestId("save-quote").click();
    await expect(carlaPage.getByTestId("save-status")).toHaveText("Guardado.");

    // --- el borrador de antes, con «Flete local» (ya fuera de su lista): se conserva, avisa y se sigue guardando ---
    await carlaPage.goto(firstQuote);
    await expect(carlaPage.getByTestId("line-1-not-allowed")).toHaveText(
      "Este servicio ya no está entre los que puedes cotizar. La línea se conserva.",
    );
    await expect(
      lines(carlaPage)
        .nth(0)
        .getByLabel(/Nombre de la línea/),
    ).toHaveValue("Flete local");
    await lines(carlaPage).nth(0).getByLabel("Cantidad").fill("3");
    await carlaPage.getByTestId("save-quote").click();
    await expect(carlaPage.getByTestId("save-status")).toHaveText("Guardado.");
    expect(staleQuote).not.toBe(firstQuote);

    // --- el Dueño vuelve a «todos»: ella ve todo al recargar ---
    await page.getByTestId("catalog-scope-mode-all").check();
    await page.getByTestId("catalog-scope-save").click();
    await expect(
      page.getByText("Listo: Carla Comercial puede cotizar todos los servicios."),
    ).toBeVisible();
    await expect(page.getByTestId("catalog-scope-summary")).toHaveText(
      "Carla Comercial puede cotizar todos los servicios",
    );
    await carlaPage.reload();
    await expect(carlaPage.getByTestId("catalog-scope-notice")).toHaveCount(0);
    await expect(carlaPage.getByTestId("catalog-results").locator("li")).toHaveCount(3);
    await expect(carlaPage.getByTestId("line-1-not-allowed")).toHaveCount(0);
    expect(carlaErrors).toEqual([]);
  } finally {
    await carlaContext.close();
  }
  expect(consoleErrors).toEqual([]);
});

test("la ficha de un Administrador, de un Aprobador o de un Observador no ofrece límite; en teléfono la sección cabe sin desplazamiento horizontal", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signUpAndVerify(page, uniqueEmail("alcance2-dueno"), "Dueña Dos");
  const tenantId = await createTenant(page, "Alcance Dos Ltda", generateRut());
  const admin = await addPerson(tenantId, "admin", "Admin Alcance");
  const approver = await addPerson(tenantId, "approver", "Aprobador Alcance");
  const viewer = await addPerson(tenantId, "viewer", "Observador Alcance");
  const sales = await addPerson(tenantId, "sales", "Comercial Alcance");
  for (let n = 1; n <= 12; n += 1) await addService(tenantId, `Servicio de prueba ${n}`);
  // el Administrador tenía una lista de antes (D4: se conserva y no aplica)
  await withDb(async (db) => {
    await db.query(
      "insert into public.member_catalog_scopes (tenant_id, member_id, mode) values ($1, $2, 'list')",
      [tenantId, admin.memberId],
    );
  });

  for (const [person, text] of [
    [
      admin,
      "Su rol no tiene límite de servicios. Tiene una lista guardada que se aplicará si vuelve a ser Comercial.",
    ],
    [approver, "Su rol no cotiza."],
    [viewer, "Su rol no cotiza."],
  ] as const) {
    await page.goto(`/o/${tenantId}/equipo/${person.memberId}`);
    await expect(page.getByTestId("member-title")).toContainText(person.name);
    await expect(page.getByTestId("catalog-scope-not-limitable")).toHaveText(text);
    await expect(page.getByTestId("catalog-scope-form")).toHaveCount(0);
    await expect(page.getByTestId("catalog-scope-save")).toHaveCount(0);
  }

  // la ficha de la Comercial en teléfono: sin desplazamiento horizontal y con áreas táctiles de 44 px
  await page.setViewportSize(MOBILE);
  await page.goto(`/o/${tenantId}/equipo/${sales.memberId}`);
  await page.getByTestId("catalog-scope-mode-list").check();
  await expect(page.getByTestId("catalog-scope-item")).toHaveCount(12);
  await expectNoHorizontalScroll(page);
  for (const locator of [
    page.getByTestId("catalog-scope-mode-list").locator("xpath=ancestor::label"),
    page.getByTestId("catalog-scope-item").first().locator("xpath=ancestor::label"),
    page.getByTestId("catalog-scope-select-visible"),
    page.getByTestId("catalog-scope-clear"),
    page.getByTestId("catalog-scope-save"),
  ]) {
    expect((await locator.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  // el buscador a 16 px (si no, el iPhone hace zoom)
  const searchFont = await page
    .getByTestId("catalog-scope-search")
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  expect(searchFont).toBeGreaterThanOrEqual(16);
  // la lista larga se desplaza dentro de su caja, no la página
  await page.getByTestId("catalog-scope-select-visible").click();
  await expect(page.getByTestId("catalog-scope-count")).toHaveText("12 de 12 elegidos");
  await expectNoHorizontalScroll(page);
});
