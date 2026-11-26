import "../tests/support/stub-server-only"; // debe ir primero
import { generateRut } from "../src/lib/chile/rut";
import { connect } from "../tests/db/helpers";
import { expect, randomTestIp, test, type Page } from "./fixtures";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// Humo del cobro por transferencia (H-050 a H-057), de punta a punta: la Dueña registra los datos de transferencia, envía una
// cotización 50/50, el cliente la acepta y recibe los datos para pagar, la Dueña marca el anticipo, pide el saldo (correo 3) y marca
// el saldo hasta «Pagada». Correos en Mailpit local; todo ficticio (@ejemplo.test).

const MAILBOX_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:56324";
const ACCOUNT_NUMBER = "000987654321";

type MailDetail = { ID: string; Subject: string; HTML: string; Text: string };

async function mailsTo(address: string): Promise<MailDetail[]> {
  const search = await fetch(
    `${MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
  );
  const { messages } = (await search.json()) as { messages?: { ID: string }[] };
  const details: MailDetail[] = [];
  for (const { ID } of [...(messages ?? [])].reverse()) {
    details.push((await (await fetch(`${MAILBOX_URL}/api/v1/message/${ID}`)).json()) as MailDetail);
  }
  return details;
}

async function waitForMailWithSubject(address: string, subject: RegExp): Promise<MailDetail> {
  let found: MailDetail | undefined;
  await expect
    .poll(
      async () => {
        found = (await mailsTo(address)).find((mail) => subject.test(mail.Subject));
        return found !== undefined;
      },
      { message: `Esperaba un correo «${subject}» a ${address}`, timeout: 60_000 },
    )
    .toBe(true);
  return found!;
}

/** La insignia de estado de la cotización (la primera de la pantalla, junto al número). */
function statusOf(page: Page) {
  return page.locator('[data-slot="status-badge"]').first();
}

test("cobro 50/50 de punta a punta: datos de transferencia, aceptar, anticipo, saldo y pagada", async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const ownerEmail = uniqueEmail("cobro");
  await signUpAndVerify(page, ownerEmail, "Dueña Cobro Ficticia");
  const tenantId = await createTenant(page, "Cobro Ficticio Ltda", generateRut());
  const db = await connect();
  try {
    await db.query(
      `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp, tax_treatment)
       values ($1, 'Flete Alfa', 'service', 10001, 'taxable')`,
      [tenantId],
    );
  } finally {
    await db.end();
  }

  // H-050: los datos de transferencia, en Configuración.
  await page.goto(`/o/${tenantId}/configuracion`);
  await page.getByRole("link", { name: /Datos de transferencia/ }).click();
  await page.getByLabel("Banco").selectOption("BancoEstado");
  await page.getByLabel("Tipo de cuenta").selectOption("checking");
  await page.getByLabel("Número de cuenta").fill(ACCOUNT_NUMBER);
  await page.getByLabel("Titular de la cuenta").fill("Cobro Ficticio Ltda");
  await page.getByLabel("RUT del titular").fill(generateRut());
  await page.getByLabel("Correo para avisar la transferencia").fill("pagos@ejemplo.test");
  await page.getByTestId("bank-save").click();
  await expect(page.getByTestId("bank-last-change")).toContainText("Último cambio");

  // Cliente y cotización.
  const customerEmail = uniqueEmail("cliente-cobro");
  await page.goto(`/o/${tenantId}/clientes/nuevo`);
  await page.getByLabel(/^(Nombre|Razón social)/).fill("Cliente Cobro Ficticio");
  await page.getByLabel("Correo (opcional)").fill(customerEmail);
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/clientes/[0-9a-f-]{36}`));
  await page.goto(`/o/${tenantId}/cotizaciones/nueva`);
  await page.getByRole("button", { name: /Cliente Cobro Ficticio/ }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/cotizaciones/[0-9a-f-]{36}$`));
  const quotePath = new URL(page.url()).pathname;
  await page.getByRole("button", { name: "Agregar Flete Alfa", exact: true }).click();
  await page.getByTestId("save-quote").click();
  await expect(page.getByTestId("save-status")).toHaveText("Guardado.");

  // H-052: 50 % y 50 % (total 11.901: anticipo 5.950 y saldo 5.951, el peso sobrante al saldo).
  await page.getByTestId("go-send").click();
  const split = page.getByTestId("payment-terms-split_50_50");
  await expect(split).toBeVisible();
  await expect(page.getByText("Saldo (50 %): $5.951")).toBeVisible();
  await expect(page.getByText("Guardando la condición…")).toHaveCount(0, { timeout: 20_000 });
  await split.check();
  await expect(page.getByText("Guardando la condición…")).toHaveCount(0, { timeout: 20_000 });
  await page.getByTestId("send-submit").click();
  await expect(page).toHaveURL(new RegExp(`${quotePath}$`), { timeout: 120_000 });

  const quoteMail = await waitForMailWithSubject(customerEmail, /^Cotización /);
  // Los datos bancarios NUNCA van en el correo de la cotización.
  expect(quoteMail.Text).not.toContain(ACCOUNT_NUMBER);
  const match = /href="https?:\/\/[^"]*(\/c\/[A-Za-z0-9_-]{43})"/.exec(quoteMail.HTML);
  if (!match) throw new Error("El correo no trae el enlace de la cotización");

  // H-053: el cliente acepta desde su enlace (sin cuenta) y recibe los datos para pagar.
  const clientContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL!,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  try {
    const client = await clientContext.newPage();
    await client.goto(match[1]);
    await expect(client.getByTestId("response-accept-open")).toBeVisible();
    // Antes de aceptar no hay datos para pagar.
    await expect(client.getByTestId("share-payment")).toHaveCount(0);
    await expect(client.getByText(ACCOUNT_NUMBER)).toHaveCount(0);
    await client.getByTestId("response-accept-open").click();
    await client.getByTestId("accept-name").fill("Carolina Cliente Ficticia");
    await client.getByTestId("accept-confirm").check();
    await client.getByTestId("accept-submit").click();
    await expect(client.getByTestId("response-confirmation")).toContainText(
      "Aceptaste esta cotización",
    );
    await expect(client.getByTestId("share-payment-due")).toHaveText("$5.950", {
      timeout: 20_000,
    });
    await expect(client.getByTestId("share-payment")).toContainText(ACCOUNT_NUMBER);
  } finally {
    await clientContext.close();
  }
  const paymentMail = await waitForMailWithSubject(customerEmail, /^Datos para pagar/);
  expect(paymentMail.Text).toContain("$5.950");
  expect(paymentMail.Text).toContain(ACCOUNT_NUMBER);

  // H-054: la Dueña marca el anticipo.
  await page.goto(quotePath);
  await expect(statusOf(page)).toHaveText("Pendiente de anticipo");
  await expect(page.getByTestId("payments-outstanding")).toContainText("$11.901");
  await page.getByTestId("payment-record-deposit").click();
  await page.getByTestId("payment-record-confirm").click();
  await expect(page.getByTestId("payment-status-deposit")).toHaveText("Recibido");
  await expect(statusOf(page)).toHaveText("Anticipo pagado");

  // H-056: pide el saldo (correo 3) y H-054: lo marca. Queda «Pagada».
  await page.getByTestId("payment-request-balance").click();
  await page.getByTestId("payment-request-confirm").click();
  await expect(statusOf(page)).toHaveText("Pendiente de saldo");
  const balanceMail = await waitForMailWithSubject(customerEmail, /^Saldo de la cotización/);
  expect(balanceMail.Text).toContain("$5.951");
  expect(balanceMail.Text).toContain(ACCOUNT_NUMBER);
  await page.getByTestId("payment-record-balance").click();
  await page.getByTestId("payment-record-confirm").click();
  await expect(statusOf(page)).toHaveText("Pagada");
  await expect(page.getByTestId("payments-outstanding")).toHaveText("Todo pagado");
  await expect(page.getByText(/Pago recibido: saldo \(50 %\) por \$5\.951/)).toBeVisible();

  // H-057: en el inicio ya no queda nada por cobrar.
  await page.goto(`/o/${tenantId}`);
  await expect(page.getByTestId("home-outstanding")).toHaveCount(0);
});
