import { randomUUID } from "node:crypto";
import { readPdf } from "../src/test/read-pdf";
import { rpc } from "../tests/support/local-supabase";
import { expect, test } from "./fixtures";
import {
  addMember,
  expectNoHorizontalScroll,
  header,
  newOrg,
  newPerson,
  requestIdsOf,
  visitorsSubmit,
  withDb,
  type FormItemSpec,
  type Org,
  type Person,
} from "./intake-support";

// H-090: convertir una solicitud en cotización con un clic. Todo ficticio. Una organización nueva por
// corrida (A, con Dueña, Administradora y Comercial; y B, con su propia Dueña). Los visitantes envían por
// la API como el navegador; el equipo convierte desde la pantalla.

const MOBILE = { width: 375, height: 812 };
const NOT_FOUND_HEADING = "No encontrado";
const ALFA = "Flete Alfa";
const BETA = "Flete Beta";
const FREE = "Visita técnica a medida";
const XSS_NAME = "Visitante <b>Uno</b>";
const PRIVATE_MARK = "MARCA-SOLO-EQUIPO";
const XSS_MESSAGE = `Hola\n<script>alert(1)</script>\n& "comillas" ${PRIVATE_MARK}`;
const ADDRESS = "Av. Siempre Viva 742";

const ctx = {} as {
  a: Org;
  b: Org;
  owner: Person;
  admin: Person;
  sales: Person;
  ownerB: Person;
  alfaId: string;
  betaId: string;
  requests: string[];
  emailOne: string;
  requestB: string;
  quoteOne: string;
  customerOne: string;
};

const email = (label: string) => `${label}-${randomUUID().slice(0, 8)}@ejemplo.test`;
const detailPath = (org: Org, id: string) => `/o/${org.tenantId}/solicitudes/${id}`;
const convertPath = (org: Org, id: string) => `${detailPath(org, id)}/convertir`;
const QUOTE_URL = /\/cotizaciones\/[0-9a-f-]{36}$/;

const quoteOfRequest = (requestId: string) =>
  withDb(async (db) => {
    const { rows } = await db.query<{
      id: string;
      customer_id: string;
      created_by: string;
      observations: string | null;
      status: string;
    }>(
      "select id, customer_id, created_by, observations, status from public.quotes where source_request_id = $1",
      [requestId],
    );
    return rows;
  });

const linesOf = (quoteId: string) =>
  withDb(async (db) => {
    const { rows } = await db.query<{
      name: string;
      quantity_milli: number;
      unit_price_clp: number;
    }>(
      "select name, quantity_milli::int as quantity_milli, unit_price_clp::int as unit_price_clp from public.quote_items where quote_id = $1 order by position",
      [quoteId],
    );
    return rows;
  });

const requestRow = (requestId: string) =>
  withDb(async (db) => {
    const { rows } = await db.query<{
      status: string;
      assigned_to: string | null;
      quote_id: string | null;
    }>("select status, assigned_to, quote_id from public.intake_requests where id = $1", [
      requestId,
    ]);
    return rows[0];
  });

const customerCount = (org: Org) =>
  withDb(async (db) => {
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from public.customers where tenant_id = $1",
      [org.tenantId],
    );
    return rows[0].n;
  });

const quoteCount = (org: Org) =>
  withDb(async (db) => {
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from public.quotes where tenant_id = $1",
      [org.tenantId],
    );
    return rows[0].n;
  });

const codeOf = (res: { json: unknown }) => (res.json as { code?: string } | null)?.code;

test.describe.configure({ mode: "serial" });

test.describe("H-090 · convertir una solicitud en cotización", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(420_000);
    ctx.owner = await newPerson(browser, "duena", "Dueña Convertir");
    ctx.ownerB = await newPerson(browser, "duenob", "Dueña Otra Empresa");
    ctx.admin = await newPerson(browser, "adela", "Adela Administradora");
    ctx.sales = await newPerson(browser, "carla", "Carla Comercial");

    // Organización A: dos servicios del catálogo (con precio, solo del equipo) y uno libre en el formulario.
    ctx.a = await newOrg(
      ctx.owner,
      `Negocio Convertir ${randomUUID().slice(0, 6)}`,
      async (tenantId): Promise<FormItemSpec[]> => {
        const item = async (name: string, price: number) =>
          withDb(
            async (db) =>
              (
                await db.query<{ id: string }>(
                  `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp, tax_treatment)
                   values ($1, $2, 'km', $3, 'taxable') returning id`,
                  [tenantId, name, price],
                )
              ).rows[0].id,
          );
        ctx.alfaId = await item(ALFA, 25_000);
        ctx.betaId = await item(BETA, 40_000);
        return [
          { name: ALFA, unit: "km", catalogItemId: ctx.alfaId, quantityMode: "required" },
          { name: BETA, unit: "km", catalogItemId: ctx.betaId, quantityMode: "optional" },
          { name: FREE, unit: "service", catalogItemId: null, quantityMode: "none" },
        ];
      },
      { serviceAddress: "optional" },
    );

    ctx.b = await newOrg(ctx.ownerB, `Otra Empresa ${randomUUID().slice(0, 6)}`, [
      { name: FREE, unit: "service", catalogItemId: null, quantityMode: "none" },
    ]);
    await addMember(ctx.a, ctx.admin, "admin");
    await addMember(ctx.a, ctx.sales, "sales");
  });

  test.afterAll(async () => {
    for (const person of [ctx.owner, ctx.ownerB, ctx.admin, ctx.sales]) {
      await person?.context.close();
    }
    // La prueba no deja formularios publicados: se archivan al terminar (las solicitudes quedan).
    for (const [org, person] of [
      [ctx.a, ctx.owner],
      [ctx.b, ctx.ownerB],
    ] as const) {
      if (!org || !person) continue;
      await rpc(
        person.token,
        "set_intake_form_status",
        { p_form_id: org.formId, p_status: "archived" },
        header(org),
      );
    }
  });

  test("llegan las solicitudes de los visitantes (sin precios, como texto)", async ({ page }) => {
    test.setTimeout(240_000);
    ctx.emailOne = email("visitante");
    await visitorsSubmit(page, ctx.a, [
      {
        name: XSS_NAME,
        email: ctx.emailOne,
        phone: "+56 9 1234 5678",
        serviceAddress: ADDRESS,
        message: XSS_MESSAGE,
        items: { [ALFA]: "12,5", [BETA]: "2", [FREE]: null },
      },
      { name: "Visitante Dos", email: email("dos"), items: { [ALFA]: "1" } },
      { name: "Visitante Tres", email: ctx.emailOne, items: { [ALFA]: "4" } },
      { name: "Visitante Cuatro", email: email("cuatro"), items: { [ALFA]: "5", [FREE]: null } },
      { name: "Visitante Cinco", email: email("cinco"), items: { [ALFA]: "2" } },
      { name: "Visitante Seis", email: email("seis"), items: { [ALFA]: "2" } },
      { name: "Visitante Siete", email: email("siete"), items: { [ALFA]: "2" } },
      { name: "Visitante Ocho", email: email("ocho"), items: { [ALFA]: "1", [BETA]: "4" } },
      { name: "Visitante Nueve", email: email("nueve"), items: { [ALFA]: "3" } },
    ]);
    ctx.requests = await requestIdsOf(ctx.a);
    expect(ctx.requests).toHaveLength(9);
    await visitorsSubmit(page, ctx.b, [
      { name: "Visitante B", email: email("b"), items: { [FREE]: null } },
    ]);
    ctx.requestB = (await requestIdsOf(ctx.b))[0];
  });

  test("el Administrador convierte con cliente nuevo: borrador con las líneas del catálogo, cliente cargado y el mensaje solo en «Solicitud original»", async () => {
    test.setTimeout(180_000);
    const { page } = ctx.admin;
    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    const requestId = ctx.requests[0];
    await page.goto(detailPath(ctx.a, requestId));
    await page.getByTestId("convert-open").click();
    await expect(page).toHaveURL(new RegExp(`/solicitudes/${requestId}/convertir$`));

    // El formulario de cliente viene cargado con lo que escribió la persona
    await expect(page.locator('input[name="displayName"]')).toHaveValue(XSS_NAME);
    await expect(page.locator('input[name="email"]')).toHaveValue(ctx.emailOne);
    await expect(page.locator('input[name="phone"]')).toHaveValue(/912345678|9 1234 5678/);
    await expect(page.locator('input[name="address"]')).toHaveValue(ADDRESS);
    await expect(page.getByTestId("duplicate-warning")).toHaveCount(0);
    // el mensaje del visitante no se muestra aquí
    await expect(page.locator("body")).not.toContainText(PRIVATE_MARK);

    const customersBefore = await customerCount(ctx.a);
    await page.getByTestId("convert-submit").click();
    await page.waitForURL(QUOTE_URL, { timeout: 60_000 });
    ctx.quoteOne = page.url().split("/").pop()!;
    await expect(page.getByTestId("quote-editor")).toBeVisible();

    // La cotización: borrador, de quien convirtió, con el cliente y SIN el mensaje en las observaciones
    const quotes = await quoteOfRequest(requestId);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      id: ctx.quoteOne,
      created_by: ctx.admin.userId,
      observations: null,
      status: "draft",
    });
    ctx.customerOne = quotes[0].customer_id;
    expect(await customerCount(ctx.a)).toBe(customersBefore + 1);
    await expect(page.getByLabel("Observaciones (opcional)")).toHaveValue("");

    // Las líneas: los dos del catálogo, con la cantidad pedida y el precio de hoy; el libre no es línea
    expect(await linesOf(ctx.quoteOne)).toEqual([
      { name: ALFA, quantity_milli: 12_500, unit_price_clp: 25_000 },
      { name: BETA, quantity_milli: 2_000, unit_price_clp: 40_000 },
    ]);
    await expect(page.getByTestId("quote-line")).toHaveCount(2);
    await expect(page.getByTestId("load-request-services")).toHaveCount(0);

    // La solicitud: convertida, a cargo de quien convirtió, y el mensaje solo en «Solicitud original»
    expect(await requestRow(requestId)).toEqual({
      status: "converted",
      assigned_to: ctx.admin.userId,
      quote_id: ctx.quoteOne,
    });
    const panel = page.getByTestId("source-request");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("source-request-items")).toContainText(ALFA);
    await expect(panel.getByTestId("source-request-items")).toContainText("12,5 km");
    await expect(panel.getByTestId("source-request-items")).toContainText(FREE);
    const message = panel.getByTestId("source-request-message");
    await expect(message).toContainText("<script>alert(1)</script>");
    await expect(message).toContainText('& "comillas"');
    await expect(message).toContainText(PRIVATE_MARK);
    expect(await panel.locator("script, b, img").count()).toBe(0);
    await expect(panel).toContainText(ADDRESS);
    await expect(page.getByTestId("request-not-loaded")).toHaveCount(0);
    // línea de tiempo
    await expect(page.getByTestId("quote-timeline")).toContainText("Creada desde una solicitud");
    expect(dialogs).toEqual([]);

    // El PDF no lleva el mensaje del visitante
    const pdf = await page.request.get(
      `/api/v1/tenants/${ctx.a.tenantId}/quotes/${ctx.quoteOne}/pdf?size=letter`,
    );
    expect(pdf.status()).toBe(200);
    const text = (await readPdf(await pdf.body())).text;
    expect(text).toContain(ALFA);
    expect(text).not.toContain(PRIVATE_MARK);
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("comillas");

    // La lista de cotizaciones la muestra, y la solicitud queda «Convertida» con enlace a su cotización
    await page.goto(`/o/${ctx.a.tenantId}/cotizaciones`);
    await expect(page.locator(`a[href$="/cotizaciones/${ctx.quoteOne}"]`)).not.toHaveCount(0);
    await page.goto(detailPath(ctx.a, requestId));
    await expect(page.locator('[data-slot="request-status-badge"]')).toContainText("Convertida");
    await expect(page.getByRole("link", { name: "Ver la cotización" })).toHaveAttribute(
      "href",
      `/o/${ctx.a.tenantId}/cotizaciones/${ctx.quoteOne}`,
    );
    await expect(page.getByTestId("convert-open")).toHaveCount(0);
    await page.goto(`/o/${ctx.a.tenantId}/solicitudes?estado=convertidas`);
    await expect(page.getByTestId("request-row")).toHaveCount(1);
    await expect(page.getByTestId("request-row")).toContainText("Convertida");
    // Volver a abrir «convertir» lleva a la misma cotización
    await page.goto(convertPath(ctx.a, requestId));
    await expect(page).toHaveURL(new RegExp(`/cotizaciones/${ctx.quoteOne}$`));
  });

  test("doble clic y dos pestañas a la vez: una cotización y un cliente", async () => {
    test.setTimeout(180_000);
    const requestId = ctx.requests[1];
    const first = ctx.admin.page;
    const second = await ctx.admin.context.newPage();
    try {
      await first.goto(convertPath(ctx.a, requestId));
      await second.goto(convertPath(ctx.a, requestId));
      await expect(first.getByTestId("convert-submit")).toBeEnabled();
      await expect(second.getByTestId("convert-submit")).toBeEnabled();
      const quotesBefore = await quoteCount(ctx.a);
      const customersBefore = await customerCount(ctx.a);
      await Promise.all([
        first.getByTestId("convert-submit").dblclick(),
        second.getByTestId("convert-submit").click(),
      ]);
      await first.waitForURL(QUOTE_URL, { timeout: 60_000 });
      await second.waitForURL(QUOTE_URL, { timeout: 60_000 });
      // las dos pestañas terminan en LA MISMA cotización
      expect(first.url()).toBe(second.url());
      const quotes = await quoteOfRequest(requestId);
      expect(quotes).toHaveLength(1);
      expect(await quoteCount(ctx.a)).toBe(quotesBefore + 1);
      expect(await customerCount(ctx.a)).toBe(customersBefore + 1);
      expect((await requestRow(requestId)).status).toBe("converted");
      // solo hay un conjunto de líneas, no dos
      expect(await linesOf(quotes[0].id)).toEqual([
        { name: ALFA, quantity_milli: 1_000, unit_price_clp: 25_000 },
      ]);
    } finally {
      await second.close();
    }
  });

  test("con el mismo correo que un cliente existente se ofrece reutilizarlo: no se crea otro", async () => {
    test.setTimeout(120_000);
    const { page } = ctx.admin;
    const requestId = ctx.requests[2];
    await page.goto(convertPath(ctx.a, requestId));
    const warning = page.getByTestId("duplicate-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(XSS_NAME);
    await expect(warning).toContainText("el mismo correo");
    const customersBefore = await customerCount(ctx.a);
    await page.getByTestId("use-existing-customer").click();
    await page.waitForURL(QUOTE_URL, { timeout: 60_000 });
    const quotes = await quoteOfRequest(requestId);
    expect(quotes).toHaveLength(1);
    expect(quotes[0].customer_id).toBe(ctx.customerOne);
    expect(await customerCount(ctx.a)).toBe(customersBefore);
    expect(await linesOf(quotes[0].id)).toEqual([
      { name: ALFA, quantity_milli: 4_000, unit_price_clp: 25_000 },
    ]);
  });

  test("Carla convierte una suya (sin asignar) y queda a su cargo; la asignada a otra persona no la puede convertir (servidor 42501)", async () => {
    test.setTimeout(180_000);
    const { page } = ctx.sales;
    await page.setViewportSize({ width: 1280, height: 800 });
    const mine = ctx.requests[3];
    await page.goto(detailPath(ctx.a, mine));
    await expect(page.getByTestId("convert-open")).toBeVisible();
    await page.getByTestId("convert-open").click();
    await page.getByTestId("convert-submit").click();
    await page.waitForURL(QUOTE_URL, { timeout: 60_000 });
    const quotes = await quoteOfRequest(mine);
    expect(quotes).toHaveLength(1);
    expect(quotes[0].created_by).toBe(ctx.sales.userId);
    expect(await requestRow(mine)).toMatchObject({
      status: "converted",
      assigned_to: ctx.sales.userId,
    });
    // Carla es la autora: el borrador es editable y trae «Solicitud original»
    await expect(page.getByTestId("quote-editor")).toBeVisible();
    await expect(page.getByTestId("source-request")).toBeVisible();

    // La asignada a Adela: sin botón, la pantalla de convertir lo explica y el servidor la rechaza
    const theirs = ctx.requests[4];
    await ok(
      rpc(
        ctx.owner.token,
        "assign_intake_request",
        { p_request_id: theirs, p_assignee_user_id: ctx.admin.userId },
        header(ctx.a),
      ),
    );
    await page.goto(detailPath(ctx.a, theirs));
    await expect(page.getByTestId("request-title")).toBeVisible();
    await expect(page.getByTestId("convert-open")).toHaveCount(0);
    await page.goto(convertPath(ctx.a, theirs));
    await expect(page.getByTestId("convert-blocked")).toContainText("a cargo de otra persona");
    const quotesBefore = await quoteCount(ctx.a);
    const denied = await rpc(
      ctx.sales.token,
      "convert_intake_request",
      { p_request_id: theirs, p_customer_id: ctx.customerOne, p_creation_key: randomUUID() },
      header(ctx.a),
    );
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(codeOf(denied), denied.text).toBe("42501");
    expect(await quoteCount(ctx.a)).toBe(quotesBefore);
    expect(await requestRow(theirs)).toMatchObject({ status: "assigned", quote_id: null });
  });

  test("una solicitud descartada o con los datos eliminados no se puede convertir", async () => {
    test.setTimeout(180_000);
    const { page } = ctx.admin;
    const discarded = ctx.requests[5];
    const anonymized = ctx.requests[6];
    await ok(
      rpc(
        ctx.owner.token,
        "discard_intake_request",
        { p_request_id: discarded, p_reason: "spam", p_note: null },
        header(ctx.a),
      ),
    );
    await ok(
      rpc(
        ctx.owner.token,
        "anonymize_intake_request",
        { p_request_id: anonymized, p_reason: "data_subject_request" },
        header(ctx.a),
      ),
    );
    const quotesBefore = await quoteCount(ctx.a);
    const customersBefore = await customerCount(ctx.a);

    await page.goto(detailPath(ctx.a, discarded));
    await expect(page.getByTestId("convert-open")).toHaveCount(0);
    await page.goto(convertPath(ctx.a, discarded));
    await expect(page.getByTestId("convert-blocked")).toContainText("descartada");
    await expect(page.getByTestId("convert-form")).toHaveCount(0);
    const viaServer = await rpc(
      ctx.admin.token,
      "convert_intake_request",
      { p_request_id: discarded, p_customer_id: ctx.customerOne, p_creation_key: randomUUID() },
      header(ctx.a),
    );
    expect(codeOf(viaServer), viaServer.text).toBe("CP423");

    await page.goto(detailPath(ctx.a, anonymized));
    await expect(page.getByTestId("convert-open")).toHaveCount(0);
    await page.goto(convertPath(ctx.a, anonymized));
    await expect(page.getByTestId("convert-blocked")).toContainText("eliminados");
    await expect(page.getByTestId("convert-form")).toHaveCount(0);

    expect(await quoteCount(ctx.a)).toBe(quotesBefore);
    expect(await customerCount(ctx.a)).toBe(customersBefore);
    expect(await quoteOfRequest(discarded)).toEqual([]);
    expect(await quoteOfRequest(anonymized)).toEqual([]);
  });

  test("una solicitud de otra organización no se convierte desde esta (404)", async () => {
    const { page } = ctx.admin;
    const quotesBefore = await quoteCount(ctx.a);
    const customersBefore = await customerCount(ctx.a);
    await page.goto(convertPath(ctx.a, ctx.requestB));
    await expect(page.getByRole("heading", { name: NOT_FOUND_HEADING })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Visitante B");
    const viaServer = await rpc(
      ctx.admin.token,
      "convert_intake_request",
      { p_request_id: ctx.requestB, p_customer_id: ctx.customerOne, p_creation_key: randomUUID() },
      header(ctx.a),
    );
    expect(viaServer.status).toBeGreaterThanOrEqual(400);
    expect(codeOf(viaServer), viaServer.text).toBe("CP404");
    expect(await quoteCount(ctx.a)).toBe(quotesBefore);
    expect(await customerCount(ctx.a)).toBe(customersBefore);
    expect(await requestRow(ctx.requestB)).toMatchObject({ status: "new", quote_id: null });
    // y con la sesión de A, la dirección de otra organización tampoco abre nada
    await page.goto(convertPath(ctx.b, ctx.requestB));
    await expect(page.getByRole("heading", { name: NOT_FOUND_HEADING })).toBeVisible();
  });

  test("el editor ofrece «Cargar los servicios de la solicitud» solo cuando la cotización no tiene líneas", async () => {
    test.setTimeout(180_000);
    const { page } = ctx.admin;
    await page.goto(`/o/${ctx.a.tenantId}/cotizaciones/${ctx.quoteOne}`);
    await expect(page.getByTestId("quote-line")).toHaveCount(2);
    await expect(page.getByTestId("load-request-services")).toHaveCount(0);

    // Se quitan las líneas y se guarda: ahora no tiene líneas, así que se ofrece cargarlas
    await page.getByRole("button", { name: "Quitar la línea 1" }).click();
    await page.getByRole("button", { name: "Quitar la línea 1" }).click();
    await expect(page.getByTestId("no-lines")).toBeVisible();
    await expect(page.getByTestId("load-request-services")).toBeVisible();
    await page.getByTestId("save-quote").click();
    await expect(page.getByTestId("save-status")).toHaveText("Guardado.");
    expect(await linesOf(ctx.quoteOne)).toEqual([]);
    await page.reload();
    await expect(page.getByTestId("no-lines")).toBeVisible();
    await page.getByTestId("load-request-services").click();
    await expect(page.getByTestId("quote-line")).toHaveCount(2);
    await expect(page.getByTestId("load-request-services")).toHaveCount(0);
    await page.getByTestId("save-quote").click();
    await expect(page.getByTestId("save-status")).toHaveText("Guardado.");
    expect(await linesOf(ctx.quoteOne)).toEqual([
      { name: ALFA, quantity_milli: 12_500, unit_price_clp: 25_000 },
      { name: BETA, quantity_milli: 2_000, unit_price_clp: 40_000 },
    ]);
    await page.reload();
    await expect(page.getByTestId("load-request-services")).toHaveCount(0);
  });

  test("si un servicio del catálogo se desactivó antes de convertir, queda el aviso y la cotización sin esa línea", async () => {
    test.setTimeout(180_000);
    const { page } = ctx.admin;
    const requestId = ctx.requests[7];
    await withDb((db) =>
      db.query("update public.catalog_items set is_active = false where id = $1", [ctx.betaId]),
    );
    await page.goto(convertPath(ctx.a, requestId));
    await page.getByTestId("convert-submit").click();
    await page.waitForURL(QUOTE_URL, { timeout: 60_000 });
    const quoteId = page.url().split("/").pop()!;
    expect(await linesOf(quoteId)).toEqual([
      { name: ALFA, quantity_milli: 1_000, unit_price_clp: 25_000 },
    ]);
    await expect(page.getByTestId("quote-line")).toHaveCount(1);
    const notice = page.getByTestId("request-not-loaded");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(BETA);
    // el servicio sigue visible en lo que pidió, para poder cotizarlo a mano
    await expect(page.getByTestId("source-request-items")).toContainText(BETA);
  });

  test("a 375 px, convertir y la cotización con «Solicitud original» no se desbordan", async () => {
    test.setTimeout(120_000);
    const { page } = ctx.admin;
    await page.setViewportSize(MOBILE);
    const requestId = ctx.requests[8];
    await page.goto(convertPath(ctx.a, requestId));
    await expect(page.getByTestId("convert-form")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expect(page.getByTestId("convert-submit")).toBeVisible();
    await page.goto(`/o/${ctx.a.tenantId}/cotizaciones/${ctx.quoteOne}`);
    await expect(page.getByTestId("source-request")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.goto(detailPath(ctx.a, requestId));
    await expect(page.getByTestId("convert-open")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

async function ok(promise: Promise<{ status: number; text: string }>) {
  const res = await promise;
  expect(res.status, res.text).toBeLessThan(300);
}
