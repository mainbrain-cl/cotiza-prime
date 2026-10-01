import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "./fixtures";
import { generateRut } from "../src/lib/chile/rut";
import { connect } from "../tests/db/helpers";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-022: registrar un cliente, avisar de duplicados y comprobar que en la base no hay datos en claro.
// Todo ficticio, con correos @ejemplo.test.

const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1440, height: 900 };
const RUT_COMPANY = "76.086.428-5";
const RUT_PERSON_RAW = "123456785";
const EMAIL_PERSON = "ana.cliente@ejemplo.test";

async function fillCustomer(
  page: Page,
  data: { name: string; rut?: string; email?: string; phone?: string; address?: string },
) {
  await page.getByLabel(/^(Nombre|Razón social)/).fill(data.name);
  if (data.rut) await page.getByLabel("RUT (opcional)").fill(data.rut);
  if (data.email) await page.getByLabel("Correo (opcional)").fill(data.email);
  if (data.phone) await page.getByLabel("Teléfono (opcional)").fill(data.phone);
  if (data.address) await page.getByLabel("Dirección (opcional)").fill(data.address);
}

test("registrar clientes, duplicados, detalle, aislamiento y cifrado en la base", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    // Las pantallas "No encontrado" responden 404 a propósito: no cuentan como error.
    if (message.type() === "error" && !message.text().includes("404")) {
      consoleErrors.push(message.text());
    }
  });

  await signUpAndVerify(page, uniqueEmail("clientes"), "Clara Ficticia");
  const tenantId = await createTenant(page, "Negocio de Clientes", "76.123.456-0");

  // Lista vacía
  await page.goto(`/o/${tenantId}/clientes`);
  await expect(page.getByRole("heading", { name: "Aún no tienes clientes" })).toBeVisible();

  // Formulario: validación en el navegador y en el servidor
  await page.getByRole("link", { name: "Registrar un cliente" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/clientes/nuevo$`));
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  await expect(page.getByText("Ingresa el nombre o la razón social.")).toBeVisible();
  await page.getByLabel("Razón social").or(page.getByLabel("Nombre")).first().fill("Cliente Malo");
  await page.getByLabel("RUT (opcional)").fill("76.086.428-4");
  await page.getByLabel("Teléfono (opcional)").click(); // al salir del campo se valida
  await expect(page.getByText("El RUT no es válido.")).toBeVisible();
  await page.getByLabel("Correo (opcional)").fill("sin-arroba");
  await page.getByLabel("Teléfono (opcional)").fill("12345"); // menos de 6 dígitos
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  await expect(page.getByText("Revisa el correo.")).toBeVisible();
  await expect(page.getByText("Revisa el teléfono.")).toBeVisible();

  // Cliente 1: empresa
  await page.goto(`/o/${tenantId}/clientes/nuevo`);
  await page.getByText("Empresa", { exact: true }).click();
  await fillCustomer(page, {
    name: "Transportes Ficticios SpA",
    rut: RUT_COMPANY,
    phone: "+56 9 1234 5678",
    address: "Calle Ficticia 123, Santiago",
  });
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/clientes/[0-9a-f-]{36}\\?creado=1$`));
  await expect(page.getByText("Cliente guardado.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Transportes Ficticios SpA" })).toBeVisible();
  await expect(page.getByText(RUT_COMPANY)).toBeVisible(); // con formato
  await expect(page.getByText("Calle Ficticia 123, Santiago")).toBeVisible();
  const companyId = page.url().split("/clientes/")[1].split("?")[0];

  // Cliente 2: persona, con RUT sin formato y correo
  await page.goto(`/o/${tenantId}/clientes/nuevo`);
  await fillCustomer(page, {
    name: "Ana Cliente",
    rut: RUT_PERSON_RAW,
    email: EMAIL_PERSON,
  });
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  await expect(page.getByText("Cliente guardado.")).toBeVisible();
  await expect(page.getByText("12.345.678-5")).toBeVisible();
  await expect(page.getByText(EMAIL_PERSON)).toBeVisible();

  // Duplicado por RUT: avisa, ofrece abrir el existente, y deja guardar igual
  await page.goto(`/o/${tenantId}/clientes/nuevo`);
  await fillCustomer(page, { name: "Otra Ficticia", rut: "76086428-5" });
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  const warning = page.getByTestId("duplicate-warning");
  await expect(warning).toContainText("Transportes Ficticios SpA");
  await expect(warning).toContainText("el mismo RUT");
  await expect(
    warning.getByRole("link", { name: /Abrir Transportes Ficticios SpA/ }),
  ).toHaveAttribute("href", `/o/${tenantId}/clientes/${companyId}`);
  // Se conserva lo escrito
  await expect(page.getByLabel(/^(Nombre|Razón social)/)).toHaveValue("Otra Ficticia");
  await warning.getByRole("link", { name: /Abrir Transportes Ficticios SpA/ }).click();
  await expect(page.getByRole("heading", { name: "Transportes Ficticios SpA" })).toBeVisible();

  // Duplicado por correo (en otra mayúscula) y guardar de todos modos
  await page.goto(`/o/${tenantId}/clientes/nuevo`);
  await fillCustomer(page, { name: "Ana Repetida", email: "ANA.CLIENTE@ejemplo.test" });
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  await expect(page.getByTestId("duplicate-warning")).toContainText("el mismo correo");
  // Si se edita el correo, el aviso ya no vale: se esconde y "Guardar de todos modos" desaparece
  await page.getByLabel("Correo (opcional)").fill("otra.persona@ejemplo.test");
  await expect(page.getByTestId("duplicate-warning")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Guardar de todos modos" })).toHaveCount(0);
  // Al volver a escribir el correo repetido y guardar, se revisa de nuevo y el aviso vuelve
  await page.getByLabel("Correo (opcional)").fill("ANA.CLIENTE@ejemplo.test");
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  await expect(page.getByTestId("duplicate-warning")).toContainText("el mismo correo");
  await page.getByRole("button", { name: "Guardar de todos modos" }).click();
  await expect(page.getByText("Cliente guardado.")).toBeVisible();

  // Lista: enmascarada, sin datos completos
  await page.goto(`/o/${tenantId}/clientes`);
  const table = page.getByRole("table");
  await expect(table.getByRole("link", { name: "Ana Cliente" })).toBeVisible();
  await expect(table.getByRole("link", { name: "Transportes Ficticios SpA" })).toBeVisible();
  await expect(table).toContainText("••.•••.428-5");
  await expect(page.getByText(EMAIL_PERSON)).toHaveCount(0);
  await expect(page.getByText("12.345.678-5")).toHaveCount(0);

  // 404 para un cliente que no existe y para uno de otra organización
  await page.goto(`/o/${tenantId}/clientes/${randomUUID()}`);
  await expect(page.getByRole("heading", { name: "No encontrado" })).toBeVisible();
  await page.goto("/organizaciones/nueva");
  const otherTenantId = await createTenant(page, "Otro Negocio", generateRut());
  await page.goto(`/o/${otherTenantId}/clientes/${companyId}`);
  await expect(page.getByRole("heading", { name: "No encontrado" })).toBeVisible();
  await page.goto(`/o/${otherTenantId}/clientes`);
  await expect(page.getByRole("heading", { name: "Aún no tienes clientes" })).toBeVisible();

  // El mismo RUT en otra organización no es un duplicado: cada una tiene sus clientes
  await page.goto(`/o/${otherTenantId}/clientes/nuevo`);
  await fillCustomer(page, { name: "Mismo RUT, otro negocio", rut: RUT_COMPANY });
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  await expect(page.getByTestId("duplicate-warning")).toHaveCount(0);
  await expect(page).toHaveURL(
    new RegExp(`/o/${otherTenantId}/clientes/[0-9a-f-]{36}\\?creado=1$`),
  );

  // Teléfono: tarjetas y sin desplazamiento horizontal
  await page.setViewportSize(MOBILE);
  await page.goto(`/o/${tenantId}/clientes`);
  await expect(page.getByTestId("customer-cards")).toBeVisible();
  await expect(page.getByRole("table")).toBeHidden();
  await page.goto(`/o/${tenantId}/clientes/nuevo`);
  for (const path of ["clientes", `clientes/${companyId}`, "clientes/nuevo"]) {
    await page.goto(`/o/${tenantId}/${path}`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize(DESKTOP);

  // En la base: nada de correo, RUT, teléfono ni dirección en texto plano
  const db = await connect();
  try {
    const { rows } = await db.query(
      `select display_name, email_enc, email_hash, phone_enc, rut_enc, rut_hash, address_enc
         from public.customers where tenant_id = $1`,
      [tenantId],
    );
    expect(rows).toHaveLength(3);
    const dump = JSON.stringify(rows).toLowerCase();
    for (const secret of [
      EMAIL_PERSON,
      "76086428",
      "76.086.428",
      "12345678",
      "12.345.678",
      "1234 5678",
      "calle ficticia 123",
    ]) {
      expect(dump, `no debe aparecer ${secret} en claro`).not.toContain(secret);
    }
    const ana = rows.find((r) => r.display_name === "Ana Cliente");
    expect(ana.email_enc).toMatch(/^v1\./);
    expect(ana.rut_enc).toMatch(/^v1\./);
    expect(ana.email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ana.rut_hash).toMatch(/^[0-9a-f]{64}$/);
    // La auditoría de la base no guarda los valores, solo qué campos cambiaron
    const audit = await db.query(
      `select details::text as d from public.audit_log where tenant_id = $1 and resource_type = 'customer'`,
      [tenantId],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(
      audit.rows
        .map((r) => r.d)
        .join(" ")
        .toLowerCase(),
    ).not.toContain("ejemplo.test");
  } finally {
    await db.end();
  }

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
