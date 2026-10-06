import { randomUUID } from "node:crypto";
import { generateRut } from "../src/lib/chile/rut";
import { connect } from "../tests/db/helpers";
import { expect, randomTestIp, test } from "./fixtures";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-032: la lista de cotizaciones con su estado, "mías" y "todas", y el diseño de teléfono.

async function withDb<T>(fn: (db: import("pg").Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

type QuoteSeed = { display: string; seq: number; status: string; authorEmail: string };

test("la lista muestra número, cliente, total, fecha, autor y estado; filtra mías y todas; en teléfono son tarjetas", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const ownerEmail = uniqueEmail("lista-dueno");
  const salesEmail = uniqueEmail("lista-comercial");
  await signUpAndVerify(page, ownerEmail, "Dueña Lista");
  const tenantId = await createTenant(page, "Lista Cotizaciones Ltda", generateRut());

  // Una persona con rol Comercial en la misma organización
  const salesContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  const salesPage = await salesContext.newPage();
  try {
    await signUpAndVerify(salesPage, salesEmail, "Comercial Lista");
    await withDb(async (db) => {
      await db.query(
        `insert into public.members (tenant_id, user_id, role)
         select $1, id, 'sales' from auth.users where email = $2`,
        [tenantId, salesEmail],
      );
      const customer = await db.query<{ id: string }>(
        `insert into public.customers (id, tenant_id, kind, display_name)
         values ($1, $2, 'company', 'Cliente de la Lista Ltda') returning id`,
        [randomUUID(), tenantId],
      );
      const seeds: QuoteSeed[] = [
        { display: "COT-2026-9001", seq: 9001, status: "draft", authorEmail: ownerEmail },
        { display: "COT-2026-9002", seq: 9002, status: "accepted", authorEmail: ownerEmail },
        { display: "COT-2026-9003", seq: 9003, status: "sent", authorEmail: salesEmail },
        { display: "COT-2026-9004", seq: 9004, status: "superseded", authorEmail: salesEmail },
      ];
      for (const seed of seeds) {
        const id = randomUUID();
        await db.query(
          `insert into public.quotes
             (id, tenant_id, number_seq, number_scope, number_display, root_quote_id, customer_id,
              creation_key, tax_rate_bp, status, created_by,
              subtotal_taxable_clp, subtotal_clp, net_taxable_clp, tax_clp, total_clp)
           select $1, $2, $3, 'continuous', $4, $1, $5, gen_random_uuid(), 1900, $6, u.id,
                  100000, 100000, 100000, 19000, 119000
           from auth.users u where u.email = $7`,
          [
            id,
            tenantId,
            seed.seq,
            seed.display,
            customer.rows[0].id,
            seed.status,
            seed.authorEmail,
          ],
        );
      }
    });

    // Escritorio: todas las columnas y el estado con nombre
    await page.goto(`/o/${tenantId}/cotizaciones`);
    const rows = page.getByTestId("quote-row");
    await expect(rows).toHaveCount(4);
    const draftRow = rows.filter({ hasText: "COT-2026-9001" });
    await expect(draftRow).toContainText("Cliente de la Lista Ltda");
    await expect(draftRow).toContainText("$119.000");
    await expect(draftRow).toContainText("Dueña Lista");
    await expect(draftRow).toContainText(/\d{2}-\d{2}-\d{4}/);
    await expect(draftRow.locator('[data-slot="status-badge"]')).toHaveText("Borrador");
    await expect(
      rows.filter({ hasText: "COT-2026-9002" }).locator('[data-slot="status-badge"]'),
    ).toHaveText("Aceptada");
    await expect(
      rows.filter({ hasText: "COT-2026-9003" }).locator('[data-slot="status-badge"]'),
    ).toHaveText("Enviada");
    await expect(
      rows.filter({ hasText: "COT-2026-9004" }).locator('[data-slot="status-badge"]'),
    ).toHaveText("Reemplazada");

    // Mías y todas
    await expect(page.getByTestId("scope-all")).toHaveAttribute("aria-current", "page");
    await page.getByTestId("scope-mine").click();
    await expect(page).toHaveURL(/\?ver=mias$/);
    await expect(page.getByTestId("scope-mine")).toHaveAttribute("aria-current", "page");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Comercial Lista" })).toHaveCount(0);
    await page.getByTestId("scope-all").click();
    await expect(rows).toHaveCount(4);

    // La Comercial, con "Mías", ve solo las dos suyas
    await salesPage.goto(`/o/${tenantId}/cotizaciones?ver=mias`);
    await expect(salesPage.getByTestId("quote-row")).toHaveCount(2);
    await expect(salesPage.getByTestId("quote-row").filter({ hasText: "Dueña Lista" })).toHaveCount(
      0,
    );

    // Al tocar una cotización, se abre
    await page.getByRole("link", { name: "COT-2026-9001", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/cotizaciones/[0-9a-f-]{36}$`));
    await expect(page.getByTestId("quote-number")).toHaveText("COT-2026-9001");

    // Teléfono: tarjetas con el estado en texto, sin desplazamiento horizontal
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/o/${tenantId}/cotizaciones`);
    const cards = page.getByTestId("quote-cards").locator("li");
    await expect(cards).toHaveCount(4);
    await expect(page.getByTestId("quote-table")).toBeHidden();
    await expect(cards.filter({ hasText: "COT-2026-9002" })).toContainText("Aceptada");
    await expect(cards.filter({ hasText: "COT-2026-9002" })).toContainText(
      "Cliente de la Lista Ltda",
    );
    await expect(cards.filter({ hasText: "COT-2026-9002" })).toContainText("$119.000");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await cards.filter({ hasText: "COT-2026-9003" }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/cotizaciones/[0-9a-f-]{36}$`));

    // Un Observador no armó ninguna: "Mías" lo dice con claridad y "Todas" sigue mostrando todo
    const viewerEmail = uniqueEmail("lista-observador");
    const viewerContext = await browser.newContext({
      baseURL,
      extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
    });
    try {
      const viewerPage = await viewerContext.newPage();
      await signUpAndVerify(viewerPage, viewerEmail, "Observa Lista");
      await withDb((db) =>
        db.query(
          `insert into public.members (tenant_id, user_id, role)
           select $1, id, 'viewer' from auth.users where email = $2`,
          [tenantId, viewerEmail],
        ),
      );
      await viewerPage.goto(`/o/${tenantId}/cotizaciones?ver=mias`);
      await expect(viewerPage.getByTestId("no-mine")).toBeVisible();
      await viewerPage.getByTestId("scope-all").click();
      await expect(viewerPage.getByTestId("quote-row")).toHaveCount(4);
    } finally {
      await viewerContext.close();
    }
  } finally {
    await salesContext.close();
  }
});
