import { randomUUID } from "node:crypto";
import { generateRut } from "../src/lib/chile/rut";
import { rpc } from "../tests/support/local-supabase";
import { expect, test, type Page } from "./fixtures";
import { createTenant } from "./helpers";
import {
  addMember,
  expectNoHorizontalScroll,
  header,
  newPerson,
  withDb,
  type Org,
  type Person,
} from "./intake-support";

// H-041: bloquear el precio de un servicio y poner un descuento máximo a los Comerciales, de punta a punta. Todo ficticio.
// Una organización nueva por corrida: Ana (Dueña) y Carla (Comercial). Ninguna prueba toca la semilla.

const MOBILE = { width: 375, height: 812 };
const TOUCH_MIN_PX = 44;
const LOCKED_NAME = `Flete con candado ${randomUUID().slice(0, 6)}`;
const FREE_NAME = `Servicio sin candado ${randomUUID().slice(0, 6)}`;
const LOCKED_PRICE_ERROR =
  "El precio de este servicio está bloqueado. Usa el precio con que se agregó a la cotización.";
const CAP_ERROR = "El descuento pasa del máximo que permite tu organización (10 %).";
// Un precio bloqueado y un descuento sobre el máximo a la vez: el aviso general es neutro (no afirma que las reglas cambiaron).
const RULES_CHANGED = "Revisa los precios y descuentos marcados en la cotización.";

const ctx = {} as {
  tenantId: string;
  org: Pick<Org, "tenantId">;
  ana: Person;
  carla: Person;
  customerName: string;
  lockedId: string;
  freeId: string;
  carlaQuoteUrl: string;
};

const lines = (page: Page) => page.getByTestId("quote-line");
const savedToast = (page: Page, text: string) => expect(page.getByText(text)).toBeVisible();
const dbMaxDiscount = () =>
  withDb(async (db) => {
    const { rows } = await db.query<{ max_discount_bp: number | null }>(
      "select max_discount_bp from public.tenants where tenant_id = $1",
      [ctx.tenantId],
    );
    return rows[0].max_discount_bp;
  });
const dbLocked = (id: string) =>
  withDb(async (db) => {
    const { rows } = await db.query<{ price_locked: boolean }>(
      "select price_locked from public.catalog_items where id = $1",
      [id],
    );
    return rows[0].price_locked;
  });
const setCap = async (bp: number | null) => {
  const result = await rpc(
    ctx.ana.token,
    "set_quote_max_discount",
    { p_max_bp: bp },
    header(ctx.org as Org),
  );
  expect(result.status, result.text).toBeLessThan(300);
};

async function dismissToasts(page: Page) {
  for (const button of await page.locator("[data-sonner-toast] [data-close-button]").all()) {
    await button.click({ force: true, timeout: 1_000 }).catch(() => undefined);
  }
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
}

/** Crea una cotización para el cliente de la prueba y deja el editor abierto. */
async function newQuote(page: Page): Promise<string> {
  await page.goto(`/o/${ctx.tenantId}/cotizaciones/nueva`);
  await page.getByRole("button", { name: new RegExp(ctx.customerName) }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${ctx.tenantId}/cotizaciones/[0-9a-f-]{36}$`));
  return page.url();
}
const addFromCatalog = (page: Page, name: string) =>
  page.getByRole("button", { name: `Agregar ${name}`, exact: true }).click();
async function save(page: Page) {
  await page.getByTestId("save-quote").click();
  await expect(page.getByTestId("save-status")).toHaveText("Guardado.");
}
const heightOf = async (locator: ReturnType<Page["locator"]>) => {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box, "el control debe estar a la vista para medirlo").not.toBeNull();
  return box!.height;
};

test.describe.configure({ mode: "serial" });

test.describe("H-041 · precios bloqueados y descuento máximo", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    ctx.ana = await newPerson(browser, "ana", "Ana Ficticia");
    ctx.tenantId = await createTenant(
      ctx.ana.page,
      `Candados ${randomUUID().slice(0, 6)} Ltda`,
      generateRut(),
    );
    ctx.org = { tenantId: ctx.tenantId };
    ctx.carla = await newPerson(browser, "carla", "Carla Ficticia");
    await addMember(ctx.org, ctx.carla, "sales");
    ctx.customerName = `Cliente Candados ${randomUUID().slice(0, 6)}`;
    // Un cliente con correo (sin él `/enviar` bloquea por otra cosa) y un servicio sin candado.
    await ctx.ana.page.goto(`/o/${ctx.tenantId}/clientes/nuevo`);
    await ctx.ana.page.getByLabel(/^(Nombre|Razón social)/).fill(ctx.customerName);
    await ctx.ana.page
      .getByLabel("Correo (opcional)")
      .fill(`cliente-${randomUUID().slice(0, 8)}@ejemplo.test`);
    await ctx.ana.page.getByRole("button", { name: "Guardar cliente" }).click();
    await expect(ctx.ana.page).toHaveURL(new RegExp(`/o/${ctx.tenantId}/clientes/[0-9a-f-]{36}`));
    ctx.freeId = await withDb(
      async (db) =>
        (
          await db.query<{ id: string }>(
            `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp, tax_treatment)
             values ($1, $2, 'service', 20000, 'taxable') returning id`,
            [ctx.tenantId, FREE_NAME],
          )
        ).rows[0].id,
    );
  });

  test.afterAll(async () => {
    for (const person of [ctx.ana, ctx.carla]) await person?.context.close();
  });

  test("Ana bloquea el precio de un servicio nuevo (con el teclado) y fija el descuento máximo en 10 %", async () => {
    test.setTimeout(240_000);
    const { page } = ctx.ana;
    await page.goto(`/o/${ctx.tenantId}/catalogo`);

    // La tarjeta parte sin tope y la frase lo dice.
    await expect(
      page.getByRole("heading", { name: "Descuento máximo de los Comerciales" }),
    ).toBeVisible();
    await expect(page.getByTestId("discount-cap-preview")).toHaveText(
      "Sin tope: los Comerciales pueden dar el descuento que quieran.",
    );
    await expect(page.getByTestId("discount-cap-save")).toBeDisabled();

    // El servicio nuevo: la casilla se marca con el teclado (foco y Espacio).
    await page.getByLabel(/^Nombre/).fill(LOCKED_NAME);
    await page.getByLabel("Precio neto (en pesos)").fill("10000");
    const lock = page.getByRole("checkbox", { name: /Bloquear el precio/ });
    await expect(lock).not.toBeChecked();
    await lock.focus();
    await page.keyboard.press("Space");
    await expect(lock).toBeChecked();
    await page.getByRole("button", { name: "Agregar al catálogo" }).click();
    await savedToast(page, `Agregaste "${LOCKED_NAME}" al catálogo.`);
    await dismissToasts(page);

    // En la lista: el candado junto al precio, con el texto para lectores de pantalla; el otro servicio, sin candado.
    const row = page.getByTestId("catalog-item").filter({ hasText: LOCKED_NAME });
    await expect(row.getByTestId("price-lock-icon")).toBeVisible();
    await expect(row.getByText("Precio bloqueado")).toBeAttached();
    await expect(
      page
        .getByTestId("catalog-item")
        .filter({ hasText: FREE_NAME })
        .getByTestId("price-lock-icon"),
    ).toHaveCount(0);
    ctx.lockedId = await withDb(
      async (db) =>
        (
          await db.query<{ id: string }>(
            "select id from public.catalog_items where tenant_id = $1 and name = $2",
            [ctx.tenantId, LOCKED_NAME],
          )
        ).rows[0].id,
    );
    expect(await dbLocked(ctx.lockedId)).toBe(true);

    // El descuento máximo: la frase cambia mientras se escribe, un valor malo se marca y 10 se guarda.
    await page.getByTestId("discount-cap-input").fill("100");
    await page.getByTestId("discount-cap-save").click();
    await expect(page.getByText("El máximo debe ser menor que 100 %.")).toBeVisible();
    expect(await dbMaxDiscount()).toBeNull();
    await page.getByTestId("discount-cap-input").fill("10");
    await expect(page.getByTestId("discount-cap-preview")).toContainText("hasta 10 % de descuento");
    await page.getByTestId("discount-cap-save").click();
    await savedToast(page, "Guardamos el descuento máximo de los Comerciales.");
    await expect(page.getByTestId("discount-cap-save")).toBeDisabled();
    expect(await dbMaxDiscount()).toBe(1_000);
    await page.reload();
    await expect(page.getByTestId("discount-cap-input")).toHaveValue("10");

    // La ficha del servicio muestra la casilla marcada.
    await page.goto(`/o/${ctx.tenantId}/catalogo/${ctx.lockedId}`);
    await expect(page.getByRole("checkbox", { name: /Bloquear el precio/ })).toBeChecked();
  });

  test("Carla (Comercial) ve el candado y el tope en solo lectura; en la cotización, «Máximo 10 %»; 15 % da error y 10 % guarda", async () => {
    test.setTimeout(300_000);
    const { page } = ctx.carla;

    // Catálogo: lectura sola. Ni formulario para agregar ni botón para guardar el tope.
    await page.goto(`/o/${ctx.tenantId}/catalogo`);
    await expect(page.getByTestId("discount-cap-input")).toHaveValue("10");
    await expect(page.getByTestId("discount-cap-input")).toBeDisabled();
    await expect(page.getByTestId("discount-cap-save")).toHaveCount(0);
    await expect(page.getByTestId("discount-cap-readonly")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Agregar un servicio" })).toHaveCount(0);
    await expect(
      page
        .getByTestId("catalog-item")
        .filter({ hasText: LOCKED_NAME })
        .getByTestId("price-lock-icon"),
    ).toBeVisible();

    // La cotización: precio fijo con candado, «Máximo 10 %» junto a cada descuento.
    ctx.carlaQuoteUrl = await newQuote(page);
    await addFromCatalog(page, LOCKED_NAME);
    await addFromCatalog(page, FREE_NAME);
    await expect(lines(page)).toHaveCount(2);
    const locked = lines(page).nth(0);
    const free = lines(page).nth(1);
    await expect(locked.getByLabel("Precio unitario (neto)")).toHaveValue("10000");
    await expect(locked.getByLabel("Precio unitario (neto)")).toHaveAttribute("readonly", "");
    await expect(locked.getByTestId("price-lock-icon")).toBeVisible();
    await expect(locked.getByText("Precio bloqueado por tu organización")).toBeVisible();
    await expect(locked.getByTestId("use-catalog-price")).toHaveCount(0);
    await expect(free.getByLabel("Precio unitario (neto)")).not.toHaveAttribute("readonly", "");
    await expect(page.getByTestId("discount-cap-hint")).toHaveCount(2);
    await expect(page.getByTestId("discount-cap-hint").first()).toHaveText("Máximo 10 %");
    await expect(page.getByTestId("global-discount-cap-hint")).toHaveText("Máximo 10 %");

    // El precio bloqueado se puede dejar con descuento hasta el tope; sobre el tope, el error sale junto a la línea.
    await locked.getByLabel("Descuento", { exact: true }).selectOption("percent");
    await locked.getByLabel("Porcentaje").fill("15");
    await expect(locked.getByText(CAP_ERROR)).toBeVisible();
    await expect(page.getByTestId("save-quote")).toBeDisabled();
    await expect(page.getByTestId("save-status")).toHaveText(
      "Corrige los datos marcados para poder guardar.",
    );
    await locked.getByLabel("Porcentaje").fill("10");
    await expect(locked.getByText(CAP_ERROR)).toHaveCount(0);

    // El descuento general también tiene tope.
    await page.locator("#global-discount-kind").selectOption("percent");
    await page.locator("#global-discount").fill("11");
    await expect(page.locator("#global-discount-error")).toContainText(
      "máximo que permite tu organización",
    );
    await expect(page.getByTestId("save-quote")).toBeDisabled();
    await page.locator("#global-discount-kind").selectOption("none");

    // Un servicio sin candado se puede cotizar a otro precio.
    await free.getByLabel("Precio unitario (neto)").fill("15000");
    await save(page);

    // Recargar: el candado sigue.
    await page.reload();
    await expect(lines(page).nth(0).getByLabel("Precio unitario (neto)")).toHaveAttribute(
      "readonly",
      "",
    );
    await expect(lines(page).nth(0).getByLabel("Porcentaje")).toHaveValue("10");
    await expect(lines(page).nth(1).getByLabel("Precio unitario (neto)")).toHaveValue("15000");
  });

  test("un precio forzado por fuera de la pantalla: la base lo rechaza, el mensaje sale en la línea y no se guarda nada", async () => {
    test.setTimeout(240_000);
    const { page } = ctx.carla;
    await page.goto(ctx.carlaQuoteUrl);
    const before = await withDb(async (db) => {
      const { rows } = await db.query<{ revision: number; observations: string | null }>(
        "select revision, observations from public.quotes where id = $1",
        [ctx.carlaQuoteUrl.split("/").pop()],
      );
      return rows[0];
    });

    // Se altera el pedido de guardar: el precio de la línea bloqueada baja a $8.000 y el descuento general sube a 15 %.
    let forged = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData();
      if (
        request.method() === "POST" &&
        request.headers()["next-action"] &&
        body?.includes('"unitPriceClp":10000')
      ) {
        forged += 1;
        await route.continue({
          postData: body
            .replace('"unitPriceClp":10000', '"unitPriceClp":8000')
            .replace(
              '"globalDiscount":{"kind":"none"}',
              '"globalDiscount":{"kind":"percent","bp":1500}',
            ),
        });
        return;
      }
      await route.continue();
    });
    await page.getByLabel("Observaciones (opcional)").fill("Pedido alterado");
    await page.getByTestId("save-quote").click();

    await expect(page.getByText(RULES_CHANGED)).toBeVisible();
    expect(forged).toBe(1);
    await expect(lines(page).nth(0).getByText(LOCKED_PRICE_ERROR)).toBeVisible();
    await expect(page.locator("#global-discount-error")).toContainText(
      "máximo que permite tu organización",
    );
    await expect(page.getByTestId("save-status")).toHaveText(
      "Corrige los datos marcados para poder guardar.",
    );
    // Nada se guardó.
    const after = await withDb(async (db) => {
      const { rows } = await db.query<{ revision: number; observations: string | null }>(
        "select revision, observations from public.quotes where id = $1",
        [ctx.carlaQuoteUrl.split("/").pop()],
      );
      return rows[0];
    });
    expect(after).toEqual(before);

    // Al cambiar algo, el error de la línea se va (ya no corresponde a lo que hay en pantalla).
    await page.unroute("**/*");
    await page.getByLabel("Observaciones (opcional)").fill("");
    await expect(lines(page).nth(0).getByText(LOCKED_PRICE_ERROR)).toHaveCount(0);
    await expect(page.getByTestId("save-status")).toHaveText("Guardado.");
  });

  test("Ana (Dueña) cambia un precio bloqueado: queda en la línea de tiempo y en el registro de actividad", async () => {
    test.setTimeout(300_000);
    const { page } = ctx.ana;
    await newQuote(page);
    const quoteUrl = page.url();
    await addFromCatalog(page, LOCKED_NAME);
    const line = lines(page).first();
    // La Dueña no tiene «Máximo» ni el precio fijo: lo edita, con la ayuda de que queda registrado.
    await expect(page.getByTestId("discount-cap-hint")).toHaveCount(0);
    await expect(line.getByLabel("Precio unitario (neto)")).not.toHaveAttribute("readonly", "");
    await expect(line.getByTestId("price-locked-override-note")).toHaveText(
      "Precio bloqueado en el catálogo. Puedes cambiarlo; quedará registrado.",
    );
    // Primero se guarda al precio del catálogo: no hay nada que anotar.
    await save(page);
    await expect(page.getByTestId("quote-timeline")).not.toContainText(
      "Se cambió un precio bloqueado",
    );

    // Ahora sí: de $10.000 a $8.000, y con un descuento sobre el tope de los Comerciales (ella no lo tiene).
    await line.getByLabel("Precio unitario (neto)").fill("8000");
    await line.getByLabel("Descuento", { exact: true }).selectOption("percent");
    await line.getByLabel("Porcentaje").fill("50");
    await save(page);
    await page.reload();
    const timeline = page.getByTestId("quote-timeline");
    await expect(
      timeline.getByText("Se cambió un precio bloqueado (línea 1: $10.000 → $8.000)"),
    ).toBeVisible();
    await expect(timeline.getByText("Se cambió un precio bloqueado")).toHaveCount(1);

    // Guardar otra vez sin tocar el precio no repite el aviso.
    await page.getByLabel("Observaciones (opcional)").fill("Otra vez");
    await save(page);
    await page.reload();
    await expect(
      page.getByTestId("quote-timeline").getByText(/Se cambió un precio bloqueado/),
    ).toHaveCount(1);

    // El Dueño no queda bloqueado al enviar.
    await page.goto(`${quoteUrl}/enviar`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Enviar");
    await expect(page.getByTestId("send-blocker")).toHaveCount(0);

    // El registro de actividad lo cuenta, sin nombres de línea; y el cambio del descuento máximo, con su nombre.
    await page.goto(`/o/${ctx.tenantId}/configuracion/actividad`);
    const override = page
      .getByTestId("audit-row")
      .filter({ hasText: "Se cambió un precio bloqueado en una cotización" });
    await expect(override).toHaveCount(1);
    await expect(override).toContainText("Cambió: línea 1: $10.000 → $8.000");
    await expect(
      page
        .getByTestId("audit-row")
        .filter({ hasText: "Descuento máximo: Sin tope → 10 %" })
        .first(),
    ).toBeVisible();
  });

  test("/enviar bloquea el borrador de Carla cuando sube el candado o baja el tope, y se arregla desde la cotización", async () => {
    test.setTimeout(300_000);
    const { page } = ctx.carla;
    const sendUrl = `${ctx.carlaQuoteUrl}/enviar`;
    const blocker = page.getByTestId("send-blocker");

    // Sin cambios, el borrador de Carla sale (solo se mira el bloqueo, no se envía nada).
    await page.goto(sendUrl);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Enviar");
    await expect(blocker).toHaveCount(0);

    // Ana bloquea el servicio libre que Carla cotizó a $15.000 (el catálogo dice $20.000).
    await ctx.ana.page.goto(`/o/${ctx.tenantId}/catalogo/${ctx.freeId}`);
    await ctx.ana.page.getByRole("checkbox", { name: /Bloquear el precio/ }).check();
    await ctx.ana.page.getByRole("button", { name: "Guardar cambios" }).click();
    await savedToast(ctx.ana.page, "Guardamos los cambios del servicio.");
    expect(await dbLocked(ctx.freeId)).toBe(true);
    // El registro de actividad lo cuenta con la frase de H-040: «Bloqueó el precio».
    await ctx.ana.page.goto(`/o/${ctx.tenantId}/configuracion/actividad`);
    await expect(
      ctx.ana.page.getByTestId("audit-row").filter({ hasText: "Bloqueó el precio" }).first(),
    ).toBeVisible();

    await page.goto(sendUrl);
    await expect(blocker).toContainText(
      "La línea 2 tiene un precio bloqueado distinto al precio con que se agregó. Vuelve a la cotización y usa ese precio.",
    );

    // Y baja el tope a 5 %: el descuento de 10 % de la línea 1 tampoco sale.
    await setCap(500);
    await page.goto(sendUrl);
    await expect(blocker).toContainText(
      "El descuento de la línea 1 pasa del máximo que permite tu organización. Máximo 5 %.",
    );
    await expect(blocker).toContainText("La línea 2 tiene un precio bloqueado");

    // Carla lo arregla en la cotización: «Usar el precio con que se agregó» y el descuento en 5 %.
    await page.goto(ctx.carlaQuoteUrl);
    const second = lines(page).nth(1);
    await expect(second.getByLabel("Precio unitario (neto)")).toHaveAttribute("readonly", "");
    await expect(second.getByLabel("Precio unitario (neto)")).toHaveValue("15000");
    await expect(page.getByTestId("discount-cap-hint").first()).toHaveText("Máximo 5 %");
    await expect(lines(page).nth(0).getByText("El descuento pasa del máximo")).toBeVisible();
    await expect(page.getByTestId("save-quote")).toBeDisabled();
    await second.getByTestId("use-catalog-price").click();
    await expect(second.getByLabel("Precio unitario (neto)")).toHaveValue("20000");
    await expect(second.getByTestId("use-catalog-price")).toHaveCount(0);
    await lines(page).nth(0).getByLabel("Porcentaje").fill("5");
    await save(page);

    await page.goto(sendUrl);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Enviar");
    await expect(blocker).toHaveCount(0);
    await setCap(1_000);
  });

  test("en el teléfono (375 px): sin desborde y con áreas táctiles de 44 px", async () => {
    test.setTimeout(240_000);
    const { page } = ctx.carla;
    await page.setViewportSize(MOBILE);
    await page.goto(ctx.carlaQuoteUrl);
    const price = lines(page).nth(1).getByLabel("Precio unitario (neto)");
    await expect(price).toHaveAttribute("readonly", "");
    await expectNoHorizontalScroll(page);
    expect(await heightOf(price)).toBeGreaterThanOrEqual(TOUCH_MIN_PX);
    expect(await heightOf(lines(page).nth(0).getByLabel("Porcentaje"))).toBeGreaterThanOrEqual(
      TOUCH_MIN_PX,
    );

    // Con el botón «Usar el precio con que se agregó» a la vista: un borrador viejo cuya línea bloqueada quedó a otro precio (se
    // deja así por la base, como si la línea viniera de antes del candado). El botón va a todo el ancho, debajo de la grilla.
    const quoteId = ctx.carlaQuoteUrl.split("/").pop();
    const setLinePrice = (clp: number) =>
      withDb((db) =>
        db.query(
          "update public.quote_items set unit_price_clp = $2 where quote_id = $1 and position = 2",
          [quoteId, clp],
        ),
      );
    await setLinePrice(15_000);
    try {
      await page.goto(ctx.carlaQuoteUrl);
      const button = lines(page).nth(1).getByTestId("use-catalog-price");
      await expect(button).toBeVisible();
      await expect(button).toContainText("Usar el precio con que se agregó ($20.000)");
      await expectNoHorizontalScroll(page);
      expect(await heightOf(button)).toBeGreaterThanOrEqual(TOUCH_MIN_PX);
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(MOBILE.width);
    } finally {
      await setLinePrice(20_000);
    }

    // El catálogo en el teléfono, con la tarjeta del tope y la casilla (Ana).
    await ctx.ana.page.setViewportSize(MOBILE);
    await ctx.ana.page.goto(`/o/${ctx.tenantId}/catalogo`);
    await expectNoHorizontalScroll(ctx.ana.page);
    expect(await heightOf(ctx.ana.page.getByTestId("discount-cap-input"))).toBeGreaterThanOrEqual(
      TOUCH_MIN_PX,
    );
    await ctx.ana.page.getByTestId("discount-cap-input").fill("12");
    expect(await heightOf(ctx.ana.page.getByTestId("discount-cap-save"))).toBeGreaterThanOrEqual(
      TOUCH_MIN_PX,
    );
    expect(
      await heightOf(
        ctx.ana.page
          .locator("label")
          .filter({ has: ctx.ana.page.locator('input[name="priceLocked"]') }),
      ),
    ).toBeGreaterThanOrEqual(TOUCH_MIN_PX);
    await ctx.ana.page.goto(`/o/${ctx.tenantId}/catalogo/${ctx.lockedId}`);
    await expectNoHorizontalScroll(ctx.ana.page);
  });

  test("sin conexión: el descuento máximo avisa, conserva lo escrito y guarda al volver", async () => {
    test.setTimeout(240_000);
    const { page, context } = ctx.ana;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/o/${ctx.tenantId}/catalogo`);
    await context.setOffline(true);
    await expect(page.getByTestId("offline-notice").first()).toBeVisible();
    await page.getByTestId("discount-cap-input").fill("7,5");
    await page.getByTestId("discount-cap-save").click();
    await expect(page.getByTestId("discount-cap-banner")).toContainText("Revisa tu conexión");
    await expect(page.getByTestId("discount-cap-input")).toHaveValue("7,5");
    expect(await dbMaxDiscount()).toBe(1_000);
    await context.setOffline(false);
    await page.getByTestId("discount-cap-save").click();
    await savedToast(page, "Guardamos el descuento máximo de los Comerciales.");
    expect(await dbMaxDiscount()).toBe(750);

    // Vaciarlo vuelve a «Sin tope».
    await page.getByTestId("discount-cap-input").fill("");
    await expect(page.getByTestId("discount-cap-preview")).toHaveText(
      "Sin tope: los Comerciales pueden dar el descuento que quieran.",
    );
    await page.getByTestId("discount-cap-save").click();
    await expect.poll(dbMaxDiscount).toBeNull();
  });
});
