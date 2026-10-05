import { randomUUID } from "node:crypto";
import { generateRut } from "../src/lib/chile/rut";
import { connect } from "../tests/db/helpers";
import { expect, randomTestIp, test, type Page } from "./fixtures";
import { addDaysIso, isoToDisplay, todayInChile } from "../src/lib/quotes/validity";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-025 y H-026: crear una cotización y ajustar cantidades, precios y descuentos, de punta a punta.

async function withDb<T>(fn: (db: import("pg").Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** Crea una organización con un cliente y tres servicios (uno exento), todo ficticio. */
async function setup(page: Page, label: string) {
  await signUpAndVerify(page, uniqueEmail(label), "Cotiza Ficticia");
  const tenantId = await createTenant(page, `Cotizaciones ${label} Ltda`, generateRut());
  const ids = await withDb(async (db) => {
    const customer = await db.query<{ id: string }>(
      `insert into public.customers (id, tenant_id, kind, display_name)
       values ($1, $2, 'company', 'Cliente Existente Ltda') returning id`,
      [randomUUID(), tenantId],
    );
    const item = async (name: string, price: number, tax: string) =>
      (
        await db.query<{ id: string }>(
          `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp, tax_treatment)
           values ($1, $2, 'service', $3, $4) returning id`,
          [tenantId, name, price, tax],
        )
      ).rows[0].id;
    return {
      customerId: customer.rows[0].id,
      a: await item("Servicio Alfa", 10_000, "taxable"),
      b: await item("Servicio Beta", 20_000, "taxable"),
      c: await item("Capacitación Exenta", 5_000, "exempt"),
    };
  });
  return { tenantId, ...ids };
}

const lines = (page: Page) => page.getByTestId("quote-line");
const total = (page: Page, id: string) => page.getByTestId(id);

async function addFromCatalog(page: Page, name: string) {
  await page.getByRole("button", { name: `Agregar ${name}`, exact: true }).click();
}

test("crear una cotización con un cliente existente, armarla, guardarla y recuperarla", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const { tenantId, a } = await setup(page, "armar");

  // Lista vacía -> nueva cotización -> elegir cliente
  await page.goto(`/o/${tenantId}/cotizaciones`);
  await expect(page.getByRole("heading", { name: "Aún no tienes cotizaciones" })).toBeVisible();
  await page.getByRole("link", { name: "Crear una cotización" }).click();
  await expect(page).toHaveURL(/\/cotizaciones\/nueva$/);
  await page.getByRole("button", { name: /Cliente Existente Ltda/ }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/cotizaciones/[0-9a-f-]{36}$`));
  const quoteUrl = page.url();
  await expect(page.getByTestId("quote-number")).toHaveText(/^COT-\d{4}-0001$/);
  await expect(page.getByText("Borrador", { exact: true })).toBeVisible();
  await expect(page.getByTestId("no-lines")).toBeVisible();
  await expect(total(page, "total-total")).toHaveText("$0");

  // Tres servicios del catálogo (el precio y el IVA se cargan solos) y una línea libre
  await addFromCatalog(page, "Servicio Alfa");
  await addFromCatalog(page, "Servicio Beta");
  await addFromCatalog(page, "Capacitación Exenta");
  await page.getByRole("button", { name: "Agregar línea libre" }).click();
  await expect(lines(page)).toHaveCount(4);
  await expect(lines(page).nth(0).getByLabel("Precio unitario (neto)")).toHaveValue("10000");
  await expect(lines(page).nth(2).getByText("Exento de IVA")).toBeVisible();

  // Cantidad con coma, 10% en una línea, $500 en otra, y la línea libre
  await lines(page).nth(0).getByLabel("Cantidad").fill("2,5");
  await lines(page).nth(1).getByLabel("Descuento", { exact: true }).selectOption("percent");
  await lines(page).nth(1).getByLabel("Porcentaje").fill("10");
  await lines(page).nth(2).getByLabel("Descuento", { exact: true }).selectOption("amount");
  await lines(page).nth(2).getByLabel("Monto del descuento").fill("500");
  await lines(page)
    .nth(3)
    .getByLabel(/Nombre de la línea/)
    .fill("Traslado especial");
  await lines(page).nth(3).getByLabel("Precio unitario (neto)").fill("3.001");

  // Totales al instante: 25.000 + 18.000 + 4.500 (exenta) + 3.001 = 50.501; IVA 19% de 46.001 = 8.740
  await expect(lines(page).nth(0).getByTestId("line-total")).toHaveText("$25.000");
  await expect(lines(page).nth(1).getByTestId("line-total")).toHaveText("$18.000");
  await expect(lines(page).nth(2).getByTestId("line-total")).toHaveText("$4.500");
  await expect(total(page, "total-subtotal")).toHaveText("$50.501");
  await expect(total(page, "total-net-taxable")).toHaveText("$46.001");
  await expect(total(page, "total-exempt")).toHaveText("$4.500");
  await expect(total(page, "total-tax")).toHaveText("$8.740");
  await expect(total(page, "total-total")).toHaveText("$59.241");
  await expect(page.getByTestId("save-status")).toHaveText("Hay cambios sin guardar.");

  // Un dato malo se marca y no deja guardar
  await lines(page).nth(0).getByLabel("Cantidad").fill("2.5");
  await expect(page.getByText("Usa coma para decimales: 2,5")).toBeVisible();
  await expect(page.getByTestId("save-quote")).toBeDisabled();
  await expect(total(page, "total-total")).toHaveText("—");
  await lines(page).nth(0).getByLabel("Cantidad").fill("2,5");
  await expect(total(page, "total-total")).toHaveText("$59.241");

  // Guardar y recargar: todo igual
  await page.getByTestId("save-quote").click();
  await expect(page.getByTestId("save-status")).toHaveText("Guardado.");
  await page.reload();
  await expect(lines(page)).toHaveCount(4);
  await expect(lines(page).nth(0).getByLabel("Cantidad")).toHaveValue("2,5");
  await expect(lines(page).nth(1).getByLabel("Porcentaje")).toHaveValue("10");
  await expect(total(page, "total-total")).toHaveText("$59.241");
  await expect(total(page, "total-subtotal")).toHaveText("$50.501");

  // Una línea libre ya guardada puede cambiar de unidad y pasar a exenta: el IVA se recalcula
  await lines(page).nth(3).getByLabel("Unidad").selectOption("hour");
  await lines(page).nth(3).getByLabel("IVA").selectOption("exempt");
  // Neto afecto 43.000 (IVA 8.170) + exento 4.500 + 3.001 = 58.671
  await expect(total(page, "total-tax")).toHaveText("$8.170");
  await expect(total(page, "total-total")).toHaveText("$58.671");
  await page.getByTestId("save-quote").click();
  await expect(page.getByTestId("save-status")).toHaveText("Guardado.");
  await page.reload();
  await expect(lines(page).nth(3).getByLabel("Unidad")).toHaveValue("hour");
  await expect(lines(page).nth(3).getByLabel("IVA")).toHaveValue("exempt");
  await expect(total(page, "total-total")).toHaveText("$58.671");

  // Reordenar con el teclado y quitar una línea; todo queda guardado
  await lines(page).nth(0).getByRole("button", { name: "Bajar la línea 1" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    lines(page)
      .nth(1)
      .getByLabel(/Nombre de la línea/),
  ).toHaveValue("Servicio Alfa");
  // Al llegar al último lugar, el foco pasa a la otra flecha de la misma línea (no se pierde)
  await lines(page).nth(2).getByRole("button", { name: "Bajar la línea 3" }).focus();
  await page.keyboard.press("Enter");
  await expect(lines(page).nth(3).getByRole("button", { name: "Subir la línea 4" })).toBeFocused();
  await page.keyboard.press("Enter");
  await lines(page).nth(3).getByRole("button", { name: "Quitar la línea 4" }).click();
  await expect(lines(page)).toHaveCount(3);
  await page.getByTestId("save-quote").click();
  await expect(page.getByTestId("save-status")).toHaveText("Guardado.");
  await page.reload();
  await expect(lines(page)).toHaveCount(3);
  await expect(
    lines(page)
      .nth(0)
      .getByLabel(/Nombre de la línea/),
  ).toHaveValue("Servicio Beta");
  await expect(
    lines(page)
      .nth(1)
      .getByLabel(/Nombre de la línea/),
  ).toHaveValue("Servicio Alfa");
  await expect(
    lines(page)
      .nth(2)
      .getByLabel(/Nombre de la línea/),
  ).toHaveValue("Capacitación Exenta");
  // 25.000 + 18.000 + 4.500 = 47.500; IVA de 43.000 = 8.170; total 55.670
  await expect(total(page, "total-total")).toHaveText("$55.670");

  // El precio de una línea no cambia aunque el catálogo cambie
  await withDb((db) =>
    db.query("update public.catalog_items set unit_price_clp = 99999 where id = $1", [a]),
  );
  await page.goto(quoteUrl);
  await expect(lines(page).nth(1).getByLabel("Precio unitario (neto)")).toHaveValue("10000");
  await expect(total(page, "total-total")).toHaveText("$55.670");
  // Una línea nueva sí trae el precio nuevo
  await addFromCatalog(page, "Servicio Alfa");
  await expect(lines(page).nth(3).getByLabel("Precio unitario (neto)")).toHaveValue("99999");

  // Un servicio desactivado deja de ofrecerse, pero la línea que ya existe sigue
  await withDb((db) =>
    db.query("update public.catalog_items set is_active = false where id = $1", [a]),
  );
  await page.goto(quoteUrl);
  await expect(page.getByRole("button", { name: "Agregar Servicio Alfa" })).toHaveCount(0);
  await expect(lines(page)).toHaveCount(3);
  await expect(lines(page).nth(1).getByText("Ya no está en el catálogo.")).toBeVisible();

  // La lista muestra la cotización
  await page.goto(`/o/${tenantId}/cotizaciones`);
  await expect(page.getByTestId("quote-row")).toHaveCount(1);
  await expect(page.getByTestId("quote-row")).toContainText("Cliente Existente Ltda");
  await expect(page.getByTestId("quote-row")).toContainText("$55.670");

  expect(consoleErrors).toEqual([]);
});

test("crear el cliente sin salir de la cotización, y un descuento global que se rechaza", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { tenantId } = await setup(page, "dialogo");

  await page.goto(`/o/${tenantId}/cotizaciones/nueva`);
  await page.getByRole("button", { name: "Crear un cliente nuevo" }).click();
  await page
    .getByRole("dialog")
    .getByLabel(/^(Nombre|Razón social)/)
    .fill("Cliente Recién Creado SpA");
  await page.getByRole("button", { name: "Guardar y cotizar" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/cotizaciones/[0-9a-f-]{36}$`));
  await expect(page.getByText("Cliente Recién Creado SpA")).toBeVisible();
  await expect(page.getByTestId("quote-number")).toBeVisible();

  // Descuento global: 10% sobre una línea libre; mayor que el subtotal se rechaza
  await page.getByRole("button", { name: "Agregar línea libre" }).click();
  await lines(page)
    .nth(0)
    .getByLabel(/Nombre de la línea/)
    .fill("Mudanza");
  await lines(page).nth(0).getByLabel("Precio unitario (neto)").fill("150.000");
  await page.getByLabel("Descuento global").selectOption("percent");
  await page.getByLabel("Porcentaje", { exact: true }).last().fill("10");
  await expect(total(page, "total-global-discount")).toHaveText("−$15.000");
  await expect(total(page, "total-total")).toHaveText("$160.650");
  await page.getByLabel("Descuento global").selectOption("amount");
  await page.getByLabel("Monto", { exact: true }).fill("150.001");
  await expect(page.getByText("El descuento global es mayor que el subtotal.")).toBeVisible();
  await expect(page.getByTestId("save-quote")).toBeDisabled();
  await page.getByLabel("Monto", { exact: true }).fill("10.000");
  await page.getByTestId("save-quote").click();
  await expect(page.getByTestId("save-status")).toHaveText("Guardado.");
  await page.reload();
  await expect(total(page, "total-global-discount")).toHaveText("−$10.000");
  // 150.000 − 10.000 = 140.000; IVA 26.600; total 166.600
  await expect(total(page, "total-total")).toHaveText("$166.600");
});

test("dos pestañas: la segunda recibe el aviso y no sobrescribe; un Observador solo mira; teléfono sin desborde", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const { tenantId, customerId } = await setup(page, "pestanas");
  await page.goto(`/o/${tenantId}/cotizaciones/nueva`);
  await page.getByRole("button", { name: /Cliente Existente Ltda/ }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/cotizaciones/[0-9a-f-]{36}$`));
  const quoteUrl = page.url();
  await page.getByRole("button", { name: "Agregar línea libre" }).click();
  await lines(page)
    .nth(0)
    .getByLabel(/Nombre de la línea/)
    .fill("Línea de la pestaña uno");
  await lines(page).nth(0).getByLabel("Precio unitario (neto)").fill("1000");
  await page.getByTestId("save-quote").click();
  await expect(page.getByTestId("save-status")).toHaveText("Guardado.");

  // Segunda pestaña de la misma sesión
  const second = await page.context().newPage();
  await second.goto(quoteUrl);
  await expect(lines(second)).toHaveCount(1);

  // La primera guarda un cambio...
  await lines(page).nth(0).getByLabel("Precio unitario (neto)").fill("2000");
  await page.getByTestId("save-quote").click();
  await expect(page.getByTestId("save-status")).toHaveText("Guardado.");

  // ...y la segunda, con la versión vieja, recibe el aviso y no pisa nada
  await lines(second).nth(0).getByLabel("Precio unitario (neto)").fill("3000");
  await second.getByTestId("save-quote").click();
  await expect(
    second.getByText("Esta cotización cambió en otra pestaña. Recarga para ver la última versión."),
  ).toBeVisible();
  await second.getByRole("button", { name: "Recargar ahora" }).click();
  await expect(lines(second).nth(0).getByLabel("Precio unitario (neto)")).toHaveValue("2000");
  await second.close();

  // Un Observador de la organización ve la cotización pero no puede editarla
  const viewerEmail = uniqueEmail("obs-cot");
  const viewerContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  const viewerPage = await viewerContext.newPage();
  try {
    await signUpAndVerify(viewerPage, viewerEmail, "Observa Cotiza");
    await withDb((db) =>
      db.query(
        `insert into public.members (tenant_id, user_id, role)
         select $1, id, 'viewer' from auth.users where email = $2`,
        [tenantId, viewerEmail],
      ),
    );
    await viewerPage.goto(`/o/${tenantId}/cotizaciones`);
    await expect(viewerPage.getByTestId("quote-row")).toHaveCount(1);
    await expect(viewerPage.getByRole("link", { name: "Nueva cotización" })).toHaveCount(0);
    await viewerPage.goto(quoteUrl);
    await expect(viewerPage.getByTestId("quote-read-only")).toBeVisible();
    await expect(viewerPage.getByText("Tu rol solo permite ver las cotizaciones.")).toBeVisible();
    await expect(viewerPage.getByTestId("save-quote")).toHaveCount(0);
    await expect(viewerPage.getByTestId("total-total")).toHaveText("$2.380");
    await viewerPage.goto(`/o/${tenantId}/cotizaciones/nueva`);
    await expect(viewerPage.getByRole("heading", { name: "No encontrado" })).toBeVisible();
  } finally {
    await viewerContext.close();
  }

  // Teléfono: líneas como tarjetas y sin desplazamiento horizontal (editor y lista)
  await page.setViewportSize({ width: 375, height: 812 });
  for (const url of [
    quoteUrl,
    `/o/${tenantId}/cotizaciones`,
    `/o/${tenantId}/cotizaciones/nueva`,
  ]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, url).toBeLessThanOrEqual(0);
  }
  expect(customerId).toBeTruthy();
});

test("H-027: vigencia en días o con fecha, por defecto la de la organización; observaciones y condiciones", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { tenantId } = await setup(page, "vigencia");
  const today = todayInChile();

  // La vigencia por defecto de la organización se cambia en Configuración -> Empresa
  await page.goto(`/o/${tenantId}/configuracion/empresa`);
  const defaultDays = page.getByLabel(/Vigencia por defecto de tus cotizaciones/);
  await expect(defaultDays).toHaveValue("15");
  await defaultDays.fill("0");
  await page.getByRole("button", { name: "Guardar datos" }).click();
  await expect(page.getByText("La vigencia debe estar entre 1 y 365 días.")).toBeVisible();
  await defaultDays.fill("30");
  await page.getByRole("button", { name: "Guardar datos" }).click();
  await expect(page.getByText("Guardamos los datos de tu empresa.")).toBeVisible();

  // La cotización nueva parte con los 30 días y muestra la fecha exacta si se envía hoy
  await page.goto(`/o/${tenantId}/cotizaciones/nueva`);
  await page.getByRole("button", { name: /Cliente Existente Ltda/ }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/cotizaciones/[0-9a-f-]{36}$`));
  const quoteUrl = page.url();
  const days = page.getByLabel("Días de vigencia");
  const summary = page.getByTestId("validity-summary");
  await expect(days).toHaveValue("30");
  await expect(summary).toHaveText(
    `Vence 30 días después de enviarla. Si la envías hoy, vence el ${isoToDisplay(addDaysIso(today, 30))}.`,
  );

  // Días inválidos: se marca y no deja guardar
  for (const bad of ["0", "366", "1,5", ""]) {
    await days.fill(bad);
    await expect(page.locator("#validity-error")).toBeVisible();
    await expect(page.getByTestId("save-quote")).toBeDisabled();
  }
  await days.fill("20");
  await expect(summary).toContainText(isoToDisplay(addDaysIso(today, 20)));
  await expect(page.locator("#validity-error")).toHaveCount(0);

  // Con fecha: una fecha pasada se rechaza; una futura se muestra tal cual
  await page.getByLabel("Vigencia", { exact: true }).selectOption("date");
  const date = page.getByLabel("Vale hasta");
  await date.fill("2020-01-01");
  await expect(page.getByText("La fecha de vigencia no puede estar en el pasado.")).toBeVisible();
  await expect(page.getByTestId("save-quote")).toBeDisabled();
  await date.fill("2099-12-31");
  await expect(summary).toHaveText("Vence el 31-12-2099.");

  // Observaciones y condiciones: contador y tope de 4.000 caracteres
  const observations = page.getByLabel("Observaciones (opcional)");
  const conditions = page.getByLabel("Condiciones comerciales (opcional)");
  await expect(page.getByTestId("observations-count")).toHaveText("0 / 4.000");
  await observations.fill("x".repeat(4001));
  await expect(page.getByTestId("observations-count")).toHaveText("4.001 / 4.000");
  await expect(page.getByText(/Las observaciones son demasiado largas/)).toBeVisible();
  await expect(page.getByTestId("save-quote")).toBeDisabled();
  const html = "<b>Entrega</b> en bodega <script>window.__xss = 1</script>";
  await observations.fill(html);
  await conditions.fill("50% al aceptar y 50% contra entrega.");
  await expect(page.getByTestId("observations-count")).toHaveText(`${html.length} / 4.000`);

  // Guardar y recargar: todo vuelve igual
  await page.getByTestId("save-quote").click();
  await expect(page.getByTestId("save-status")).toHaveText("Guardado.");
  await page.reload();
  await expect(page.getByLabel("Vigencia", { exact: true })).toHaveValue("date");
  await expect(page.getByLabel("Vale hasta")).toHaveValue("2099-12-31");
  await expect(page.getByLabel("Observaciones (opcional)")).toHaveValue(html);
  await expect(page.getByLabel("Condiciones comerciales (opcional)")).toHaveValue(
    "50% al aceptar y 50% contra entrega.",
  );
  expect(
    await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
  ).toBeUndefined();

  // Volver a días y guardar
  await page.getByLabel("Vigencia", { exact: true }).selectOption("days");
  await page.getByLabel("Días de vigencia").fill("45");
  await page.getByTestId("save-quote").click();
  await expect(page.getByTestId("save-status")).toHaveText("Guardado.");

  // Ya no editable: la vista de solo lectura muestra el texto como texto, sin interpretarlo
  await withDb((db) =>
    db.query("update public.quotes set status = 'sent' where tenant_id = $1", [tenantId]),
  );
  await page.goto(quoteUrl);
  await expect(page.getByTestId("quote-read-only")).toBeVisible();
  await expect(page.getByTestId("validity-summary")).toContainText(
    "Vence 45 días después del envío",
  );
  await expect(page.getByText(html)).toBeVisible();
  await expect(page.getByText("50% al aceptar y 50% contra entrega.")).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
  ).toBeUndefined();
});
