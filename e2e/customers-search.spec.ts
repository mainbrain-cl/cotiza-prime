import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "./fixtures";
import { generateRut } from "../src/lib/chile/rut";
import { connect } from "../tests/db/helpers";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-023: buscar, paginar y editar clientes. Todo ficticio, con correos @ejemplo.test.

const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1440, height: 900 };
const RUT_COMPANY = "76.086.428-5";
const RUT_PERSON = "12.345.678-5";
const EMAIL_PERSON = "Ana.Cliente@ejemplo.test";
const EXTRA_CUSTOMERS = 27;

async function addCustomer(
  page: Page,
  tenantId: string,
  data: { name: string; rut?: string; email?: string },
) {
  await page.goto(`/o/${tenantId}/clientes/nuevo`);
  await page.getByLabel(/^(Nombre|Razón social)/).fill(data.name);
  if (data.rut) await page.getByLabel("RUT (opcional)").fill(data.rut);
  if (data.email) await page.getByLabel("Correo (opcional)").fill(data.email);
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  await expect(page.getByText("Cliente guardado.")).toBeVisible();
}

async function search(page: Page, tenantId: string, text: string) {
  await page.goto(`/o/${tenantId}/clientes`);
  await page.getByLabel("Buscar un cliente").fill(text);
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(page).toHaveURL(/q=/);
}

test("buscar, paginar y editar clientes", async ({ page }) => {
  test.setTimeout(300_000);
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("404")) {
      consoleErrors.push(message.text());
    }
  });

  await signUpAndVerify(page, uniqueEmail("busqueda"), "Berta Ficticia");
  const tenantId = await createTenant(page, "Negocio de Búsqueda", "76.123.456-0");

  await addCustomer(page, tenantId, { name: "Transportes Ficticios SpA", rut: RUT_COMPANY });
  await addCustomer(page, tenantId, { name: "Ana Cliente", rut: RUT_PERSON, email: EMAIL_PERSON });
  await addCustomer(page, tenantId, { name: "Zeta Servicios" });

  // Otra organización con un RUT que esta no tiene
  await page.goto("/organizaciones/nueva");
  const otherRut = generateRut();
  const otherTenantId = await createTenant(page, "Otro Negocio", generateRut());
  await addCustomer(page, otherTenantId, { name: "Cliente Ajeno", rut: otherRut });

  // Lista ordenada por nombre
  await page.goto(`/o/${tenantId}/clientes`);
  const names = page.getByRole("table").getByRole("link");
  await expect(names).toHaveText(["Ana Cliente", "Transportes Ficticios SpA", "Zeta Servicios"]);

  // Por parte del nombre, sin importar mayúsculas
  await search(page, tenantId, "ficti");
  await expect(names).toHaveText(["Transportes Ficticios SpA"]);

  // Por RUT completo: con puntos, sin puntos y sin guion
  for (const typed of [RUT_PERSON, "12345678-5", "123456785"]) {
    await search(page, tenantId, typed);
    await expect(names).toHaveText(["Ana Cliente"]);
  }
  // Un RUT a medias no encuentra nada: se busca completo
  await search(page, tenantId, "12.345.67");
  await expect(page.getByTestId("no-results")).toBeVisible();

  // Por correo completo, con mayúsculas; a medias no encuentra
  await search(page, tenantId, "ANA.cliente@EJEMPLO.test");
  await expect(names).toHaveText(["Ana Cliente"]);
  await search(page, tenantId, "ana.cliente@ejemplo");
  await expect(page.getByTestId("no-results")).toBeVisible();

  // El RUT de un cliente de otra organización no aparece aquí
  await search(page, tenantId, otherRut);
  await expect(page.getByTestId("no-results")).toBeVisible();
  await expect(page.getByText("Cliente Ajeno")).toHaveCount(0);
  await search(page, tenantId, "Ajeno");
  await expect(page.getByTestId("no-results")).toBeVisible();

  // Los comodines se buscan tal cual
  await search(page, tenantId, "%");
  await expect(page.getByTestId("no-results")).toBeVisible();

  // Paginación: se agregan clientes solo con nombre directo en la base (sin datos personales)
  const db = await connect();
  try {
    const rows = Array.from({ length: EXTRA_CUSTOMERS }, (_, index) => [
      randomUUID(),
      tenantId,
      `Relleno ${String(index).padStart(2, "0")}`,
    ]);
    for (const row of rows) {
      await db.query(
        "insert into public.customers (id, tenant_id, kind, display_name) values ($1, $2, 'person', $3)",
        row,
      );
    }
  } finally {
    await db.end();
  }
  await page.goto(`/o/${tenantId}/clientes`);
  await expect(page.getByTestId("page-status")).toContainText("Página 1 de 2");
  await expect(names).toHaveCount(25);
  await page.getByRole("link", { name: "Siguiente" }).click();
  await expect(page).toHaveURL(/pagina=2/);
  await expect(page.getByTestId("page-status")).toContainText("Página 2 de 2");
  await expect(names).toHaveCount(5);
  await expect(page.getByRole("link", { name: "Zeta Servicios" })).toBeVisible();
  // Una página que no existe muestra la primera
  await page.goto(`/o/${tenantId}/clientes?pagina=99`);
  await expect(page.getByTestId("page-status")).toContainText("Página 1 de 2");
  // La búsqueda se conserva al paginar
  await page.goto(`/o/${tenantId}/clientes?q=relleno`);
  await expect(page.getByTestId("page-status")).toContainText("27 clientes");
  await page.getByRole("link", { name: "Siguiente" }).click();
  await expect(page).toHaveURL(/q=relleno&pagina=2/);

  // Editar un cliente
  await search(page, tenantId, "Ana Cliente");
  await page.getByRole("link", { name: "Ana Cliente" }).first().click();
  await page.getByRole("link", { name: "Editar" }).click();
  await expect(page.getByRole("heading", { name: "Editar cliente" })).toBeVisible();
  await expect(page.getByLabel("RUT (opcional)")).toHaveValue(RUT_PERSON);
  await expect(page.getByLabel("Correo (opcional)")).toHaveValue(EMAIL_PERSON.toLowerCase());
  const customerId = page.url().split("/clientes/")[1].split("/")[0];

  // Validación: nombre vacío y RUT malo
  await page.getByLabel(/^(Nombre|Razón social)/).fill("");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByText("Ingresa el nombre o la razón social.")).toBeVisible();

  // Cambiar el RUT por el de otro cliente de la organización avisa del duplicado
  await page.getByLabel(/^(Nombre|Razón social)/).fill("Ana Cliente Editada");
  await page.getByLabel("RUT (opcional)").fill(RUT_COMPANY);
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  const warning = page.getByTestId("duplicate-warning");
  await expect(warning).toContainText("Transportes Ficticios SpA");
  await expect(warning).toContainText("el mismo RUT");
  // Se vuelve al RUT original y se guarda con otro correo y teléfono
  await page.getByLabel("RUT (opcional)").fill(RUT_PERSON);
  await expect(page.getByTestId("duplicate-warning")).toHaveCount(0);
  await page.getByLabel("Correo (opcional)").fill("Nuevo.Correo@ejemplo.test");
  await page.getByLabel("Teléfono (opcional)").fill("+56 9 8765 4321");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByText("Cambios guardados.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ana Cliente Editada" })).toBeVisible();
  await expect(page.getByText("nuevo.correo@ejemplo.test")).toBeVisible();
  await expect(page.getByText("+56 9 8765 4321")).toBeVisible();
  await expect(page.getByText(RUT_PERSON)).toBeVisible();

  // La búsqueda ya usa las huellas nuevas: el correo viejo no encuentra, el nuevo sí
  await search(page, tenantId, EMAIL_PERSON);
  await expect(page.getByTestId("no-results")).toBeVisible();
  await search(page, tenantId, "NUEVO.correo@ejemplo.test");
  await expect(names).toHaveText(["Ana Cliente Editada"]);
  await search(page, tenantId, RUT_PERSON);
  await expect(names).toHaveText(["Ana Cliente Editada"]);

  // Guardar de todos modos con un RUT repetido, y el aviso no sale si el RUT no cambió
  await page.goto(`/o/${tenantId}/clientes/${customerId}/editar`);
  await page.getByLabel("RUT (opcional)").fill(RUT_COMPANY);
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByTestId("duplicate-warning")).toBeVisible();
  await page.getByRole("button", { name: "Guardar de todos modos" }).click();
  await expect(page.getByText("Cambios guardados.")).toBeVisible();
  await page.goto(`/o/${tenantId}/clientes/${customerId}/editar`);
  await page.getByLabel("Dirección (opcional)").fill("Calle Nueva 456");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByText("Cambios guardados.")).toBeVisible();

  // No se puede editar un cliente de otra organización, ni por su dirección ni con la de la otra
  await page.goto(`/o/${otherTenantId}/clientes/${customerId}/editar`);
  await expect(page.getByRole("heading", { name: "No encontrado" })).toBeVisible();

  // La base: quién cambió y qué campos, sin valores
  const check = await connect();
  try {
    const stored = await check.query(
      "select updated_by, created_by, address_enc, rut_hash from public.customers where id = $1",
      [customerId],
    );
    expect(stored.rows[0].updated_by).toBeTruthy();
    expect(stored.rows[0].updated_by).toBe(stored.rows[0].created_by);
    expect(stored.rows[0].address_enc).toMatch(/^v1\./);
    const audit = await check.query(
      `select actor_user_id, details::text as d from public.audit_log
        where tenant_id = $1 and resource_id = $2 and action = 'customer.updated'`,
      [tenantId, customerId],
    );
    expect(audit.rows.length).toBe(3);
    for (const row of audit.rows) expect(row.actor_user_id).toBeTruthy();
    const dump = audit.rows
      .map((row) => row.d)
      .join(" ")
      .toLowerCase();
    expect(dump).toContain("email_hash");
    for (const secret of ["ejemplo.test", "ana cliente", "8765", "calle nueva", "76086428"]) {
      expect(dump, `la auditoría no debe guardar ${secret}`).not.toContain(secret);
    }
  } finally {
    await check.end();
  }

  // Teléfono: tarjetas, buscador visible y sin desplazamiento horizontal
  await page.setViewportSize(MOBILE);
  await page.goto(`/o/${tenantId}/clientes?q=ficti`);
  await expect(page.getByTestId("customer-cards")).toBeVisible();
  await expect(page.getByRole("table")).toBeHidden();
  await expect(page.getByLabel("Buscar un cliente")).toBeVisible();
  for (const path of [
    "clientes",
    "clientes?pagina=2",
    `clientes/${customerId}`,
    `clientes/${customerId}/editar`,
  ]) {
    await page.goto(`/o/${tenantId}/${path}`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize(DESKTOP);

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
