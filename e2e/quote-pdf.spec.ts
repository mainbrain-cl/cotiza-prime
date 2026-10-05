import { randomUUID } from "node:crypto";
import { generateRut } from "../src/lib/chile/rut";
import { readPdf } from "../src/test/read-pdf";
import { connect } from "../tests/db/helpers";
import { expect, test, type Page } from "./fixtures";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-028: el PDF de la cotización, de punta a punta (vista previa, descarga, carta y A4, varias páginas).

const CUSTOMER_NAME = "Cliente Existente Ltda";
const MANY_LINES = 40;
const LINE_PRICE_CLP = 10_000;

async function withDb<T>(fn: (db: import("pg").Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

async function setup(page: Page, label: string) {
  await signUpAndVerify(page, uniqueEmail(label), "Cotiza Ficticia");
  const tenantId = await createTenant(page, `Cotizaciones ${label} Ltda`, generateRut());
  await withDb(async (db) => {
    await db.query(
      `insert into public.customers (id, tenant_id, kind, display_name)
       values ($1, $2, 'company', $3)`,
      [randomUUID(), tenantId, CUSTOMER_NAME],
    );
    const item = (name: string, price: number, tax: string) =>
      db.query(
        `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp, tax_treatment)
         values ($1, $2, 'service', $3, $4)`,
        [tenantId, name, price, tax],
      );
    await item("Servicio Alfa", 10_000, "taxable");
    await item("Servicio Beta", 20_000, "taxable");
    await item("Servicio Gamma", 30_000, "taxable");
    await item("Capacitación Exenta", 5_000, "exempt");
  });
  return tenantId;
}

async function newQuote(page: Page, tenantId: string): Promise<string> {
  await page.goto(`/o/${tenantId}/cotizaciones/nueva`);
  await page.getByRole("button", { name: new RegExp(CUSTOMER_NAME) }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/cotizaciones/[0-9a-f-]{36}$`));
  return page.url().split("/").pop()!;
}

test("el PDF de una cotización con exentos, descuento global y observaciones: vista previa, descarga y tamaños", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const tenantId = await setup(page, "pdf");
  const quoteId = await newQuote(page, tenantId);

  for (const name of ["Servicio Alfa", "Servicio Beta", "Servicio Gamma", "Capacitación Exenta"]) {
    await page.getByRole("button", { name: `Agregar ${name}`, exact: true }).click();
  }
  await page.getByLabel("Descuento global").selectOption("amount");
  await page.getByLabel("Monto", { exact: true }).fill("5.000");
  await page.getByLabel("Observaciones (opcional)").fill("Retiro en bodega del cliente.");

  // Sin guardar, el PDF no se ofrece: se arma con lo guardado.
  await expect(page.getByTestId("pdf-hint")).toContainText("Guarda la cotización");
  await expect(page.getByTestId("pdf-preview")).toHaveAttribute("aria-disabled", "true");

  const expectedTotal = await page.getByTestId("total-total").innerText();
  const quoteNumber = await page.getByTestId("quote-number").innerText();
  await page.getByTestId("save-quote").click();
  await expect(page.getByTestId("save-status")).toHaveText("Guardado.");
  await expect(page.getByTestId("pdf-preview")).toHaveAttribute("aria-disabled", "false");

  // Vista previa: carta por defecto, se abre en el visor (inline) en otra pestaña.
  const preview = page.getByTestId("pdf-preview");
  await expect(preview).toHaveAttribute("target", "_blank");
  const previewUrl = (await preview.getAttribute("href"))!;
  expect(previewUrl).toBe(`/api/v1/tenants/${tenantId}/quotes/${quoteId}/pdf?size=letter`);
  const letterResponse = await page.request.get(previewUrl);
  expect(letterResponse.status()).toBe(200);
  expect(letterResponse.headers()["content-type"]).toBe("application/pdf");
  expect(letterResponse.headers()["cache-control"]).toBe("private, no-store");
  expect(letterResponse.headers()["content-disposition"]).toBe(
    `inline; filename="${quoteNumber}.pdf"`,
  );
  const letter = await readPdf(await letterResponse.body());
  expect(letter.pageCount).toBe(1);
  expect(letter.text).toContain(quoteNumber);
  expect(letter.text).toContain(CUSTOMER_NAME);
  expect(letter.text).toContain(expectedTotal);
  expect(letter.text).toContain("IVA 19%");
  expect(letter.text).toContain("EXENTO");
  expect(letter.text).toContain("Descuento global");
  expect(letter.text).toContain("Retiro en bodega del cliente.");
  expect(letter.text).toContain("Servicio Gamma");
  expect(letter.text).toContain("Esta cotización no es un documento tributario");
  expect(letter.text).not.toContain("Cotiza Prime");
  expect(letter.text).not.toMatch(/transferencia/i);

  // Descarga: A4, con nombre de archivo y como adjunto.
  await page.getByLabel("Tamaño de hoja").selectOption("a4");
  const download = page.getByTestId("pdf-download");
  const downloadUrl = (await download.getAttribute("href"))!;
  expect(downloadUrl).toContain("size=a4");
  const a4Response = await page.request.get(downloadUrl);
  expect(a4Response.headers()["content-disposition"]).toBe(
    `attachment; filename="${quoteNumber}.pdf"`,
  );
  const a4 = await readPdf(await a4Response.body());
  expect(a4.text).toContain(expectedTotal);
  expect(Math.round(letter.pages[0].width)).toBe(612);
  expect(Math.round(a4.pages[0].width)).toBe(595);
  expect(Math.round(a4.pages[0].height)).not.toBe(Math.round(letter.pages[0].height));

  // Tamaño inválido, sin sesión: errores sin detalle técnico.
  expect((await page.request.get(`${previewUrl.split("?")[0]}?size=oficio`)).status()).toBe(400);
});

test("una cotización con 40 líneas pasa a más páginas sin cortar filas, y el PDF sale rápido", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const tenantId = await setup(page, "pdfmuchas");
  const quoteId = await newQuote(page, tenantId);

  const subtotal = MANY_LINES * LINE_PRICE_CLP;
  const tax = Math.round(subtotal * 0.19);
  await withDb(async (db) => {
    for (let index = 1; index <= MANY_LINES; index += 1) {
      await db.query(
        `insert into public.quote_items
           (id, tenant_id, quote_id, position, name, description, unit, tax_treatment,
            quantity_milli, unit_price_clp, discount_kind, discount_value, gross_clp, discount_clp, line_total_clp)
         values ($1, $2, $3, $4, $5, $6, 'service', 'taxable', 1000, $7, 'none', 0, $7, 0, $7)`,
        [
          randomUUID(),
          tenantId,
          quoteId,
          index,
          `Servicio masivo número ${index}`,
          `Detalle del servicio ${index}`,
          LINE_PRICE_CLP,
        ],
      );
    }
    await db.query(
      `update public.quotes
          set subtotal_taxable_clp = $3, subtotal_clp = $3, net_taxable_clp = $3,
              tax_clp = $4, total_clp = $5
        where tenant_id = $1 and id = $2`,
      [tenantId, quoteId, subtotal, tax, subtotal + tax],
    );
  });

  const url = `/api/v1/tenants/${tenantId}/quotes/${quoteId}/pdf?size=letter`;
  const started = Date.now();
  const response = await page.request.get(url);
  const seconds = (Date.now() - started) / 1000;
  console.info(
    `PDF de ${MANY_LINES} líneas por HTTP (incluye compilación de la ruta): ${seconds} s`,
  );
  expect(response.status()).toBe(200);
  const read = await readPdf(await response.body());
  expect(read.pageCount).toBeGreaterThanOrEqual(2);

  for (const [index, pageInfo] of read.pages.entries()) {
    expect(pageInfo.text).toContain(`Página ${index + 1} de ${read.pageCount}`);
    // Ninguna fila se corta: el nombre y su detalle siempre quedan en la misma página.
    const numbers = (pattern: RegExp) =>
      pageInfo.items
        .map((item) => pattern.exec(item.text)?.[1])
        .filter(Boolean)
        .sort();
    expect(numbers(/^Servicio masivo número (\d+)$/)).toEqual(
      numbers(/^Detalle del servicio (\d+)$/),
    );
  }
  for (let index = 1; index <= MANY_LINES; index += 1) {
    expect(read.text).toContain(`Servicio masivo número ${index}`);
  }
  expect(read.pages.at(-1)?.text).toContain("$476.000");
});
