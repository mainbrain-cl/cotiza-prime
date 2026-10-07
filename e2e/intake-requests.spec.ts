import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext } from "@playwright/test";
import type { Client } from "pg";
import { generateRut } from "../src/lib/chile/rut";
import { TENANT_HEADER } from "../src/lib/tenant/constants";
import { connect } from "../tests/db/helpers";
import { localEnv, rest, rpc } from "../tests/support/local-supabase";
import { TEST_PASSWORD, createTenant, signUpAndVerify, uniqueEmail } from "./helpers";
import { expect, randomTestIp, test, type Page } from "./fixtures";

// H-089: recibir y asignar solicitudes. Todo ficticio. Una organización nueva por corrida (A, con Dueño,
// Administrador y Comercial; y B, con su propio Dueño) para no tocar la semilla ni sus topes del día.
// Quien pide la cotización entra por el formulario público; el equipo la ve, la asigna, la descarta, la
// restaura y la anonimiza. Los datos del visitante son texto plano y nunca hay un precio en pantalla.

const MAILBOX_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:56324";
const MOBILE = { width: 375, height: 812 };
const NOT_FOUND_HEADING = "No encontrado";
const RENDER_TOKEN = /v1\.\d{9,12}\.[A-Za-z0-9_-]{43}/;
/** El sello de tiempo del formulario pide al menos 3 segundos entre mostrarlo y enviarlo. */
const AFTER_MIN_FILL_MS = 3_500;
const XSS_NAME = "<img src=x onerror=alert(1)>";
const XSS_MESSAGE = 'Hola\n<script>alert(1)</script>\n& "comillas"';
const SERVICE_NAME = "Traslado por kilómetro";
const NAMES = {
  owner: "Dueña Solicitudes",
  admin: "Adela Administradora",
  sales: "Carla Comercial",
};

type Person = { email: string; userId: string; context: BrowserContext; page: Page; token: string };
type Org = { tenantId: string; name: string; token: string; formId: string; publicId: string };

const ctx = {} as {
  a: Org;
  b: Org;
  owner: Person;
  admin: Person;
  sales: Person;
  ownerB: Person;
  formRevision: Record<"a" | "b", number>;
  visitorEmail: string;
  requestA: string;
  requestB: string;
};

const header = (org: Org) => ({ [TENANT_HEADER]: org.tenantId });

async function passwordToken(email: string): Promise<string> {
  const { apiUrl, publishableKey } = localEnv();
  const res = await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function ok<T>(
  promise: Promise<{ status: number; text: string; json: unknown }>,
  what: string,
) {
  const res = await promise;
  expect(res.status, `${what}: ${res.text}`).toBeLessThan(300);
  return res.json as T;
}

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** Crea una cuenta nueva con sesión abierta en su propio navegador. */
async function newPerson(browser: Browser, label: string, fullName: string): Promise<Person> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  const page = await context.newPage();
  const email = uniqueEmail(label);
  await signUpAndVerify(page, email, fullName);
  const userId = await withDb(async (db) => {
    const { rows } = await db.query<{ id: string }>("select id from auth.users where email = $1", [
      email,
    ]);
    return rows[0].id;
  });
  return { email, userId, context, page, token: await passwordToken(email) };
}

/** Organización nueva con un formulario publicado de un solo servicio libre con cantidad. */
async function newOrg(owner: Person, name: string): Promise<Org> {
  const tenantId = await createTenant(owner.page, name, generateRut());
  const patched = await rest(owner.token, `tenants?tenant_id=eq.${tenantId}`, {
    method: "PATCH",
    headers: { [TENANT_HEADER]: tenantId, prefer: "return=representation" },
    body: { contact_email: `contacto-${randomUUID().slice(0, 6)}@ejemplo.test` },
  });
  expect(patched.status, patched.text).toBe(200);
  const org = { tenantId, name, token: owner.token, formId: randomUUID(), publicId: "" };
  const created = await ok<{ public_id: string; revision: number }>(
    rpc(
      owner.token,
      "create_intake_form",
      { p_form_id: org.formId, p_name: `Fletes ${name.slice(-6)}` },
      header(org),
    ),
    "create_intake_form",
  );
  org.publicId = created.public_id;
  await ok(
    rpc(
      owner.token,
      "save_intake_form",
      {
        p_form_id: org.formId,
        p_expected_revision: created.revision,
        p_form: {
          title: "Pide tu cotización",
          intro: "Cuéntanos qué necesitas.",
          success_message: "Gracias, te escribiremos.",
          fields: {
            phone: "optional",
            company: "off",
            comuna: "off",
            serviceAddress: "off",
            desiredDate: "off",
            message: "optional",
          },
        },
        p_items: [
          {
            id: randomUUID(),
            kind: "free",
            public_name: SERVICE_NAME,
            unit: "km",
            quantity_mode: "required",
            min_qty_milli: 1000,
          },
        ],
      },
      header(org),
    ),
    "save_intake_form",
  );
  await ok(
    rpc(
      owner.token,
      "set_intake_form_status",
      { p_form_id: org.formId, p_status: "published" },
      header(org),
    ),
    "publicar",
  );
  return org;
}

async function addMember(org: Org, person: Person, role: "admin" | "sales" | "viewer") {
  await withDb((db) =>
    db.query("insert into public.members (tenant_id, user_id, role) values ($1, $2, $3)", [
      org.tenantId,
      person.userId,
      role,
    ]),
  );
}

type Mail = { Subject: string; Text: string; HTML: string };

async function mailsTo(to: string, subject?: string): Promise<Mail[]> {
  const query = encodeURIComponent(subject ? `to:${to} subject:"${subject}"` : `to:${to}`);
  const search = await fetch(`${MAILBOX_URL}/api/v1/search?query=${query}`);
  const { messages } = (await search.json()) as { messages?: { ID: string }[] };
  const out: Mail[] = [];
  for (const message of messages ?? []) {
    const detail = await fetch(`${MAILBOX_URL}/api/v1/message/${message.ID}`);
    out.push((await detail.json()) as Mail);
  }
  return out;
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Lo que se ve en pantalla nunca lleva un signo de pesos ni un monto con puntos de miles. */
async function expectNoPrices(page: Page) {
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/\$\s?\d/);
  expect(text).not.toMatch(/\b\d{1,3}(\.\d{3})+\b/);
  expect(text).not.toMatch(/\bCLP\b/);
  const html = await page.content();
  expect(html).not.toMatch(/unit_price|price_clp|estimate/i);
}

/** El visitante envía directo a la API (como lo haría el navegador): sello de tiempo + anti-robot de pruebas. */
async function visitorSubmit(
  page: Page,
  org: Org,
  revision: number,
  overrides: Record<string, unknown> = {},
) {
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const html = await (await page.request.get(`/f/${org.publicId}`)).text();
  const token = RENDER_TOKEN.exec(html)?.[0];
  expect(token, "la página trae el sello de tiempo").toBeTruthy();
  await page.waitForTimeout(AFTER_MIN_FILL_MS);
  const itemId = await withDb(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.intake_form_items where form_id = $1",
      [org.formId],
    );
    return rows[0].id;
  });
  const response = await page.request.post(`/api/v1/public/forms/${org.publicId}/requests`, {
    headers: { origin },
    data: {
      name: "Visitante Ficticio",
      email: `visitante-${randomUUID().slice(0, 8)}@ejemplo.test`,
      items: [{ formItemId: itemId, quantity: "3" }],
      consent: true,
      submitKey: randomUUID(),
      requestId: randomUUID(),
      formRevision: revision,
      website: "",
      renderToken: token,
      antibotToken: "test-pass",
      ...overrides,
    },
  });
  expect(response.status(), await response.text()).toBeLessThan(300);
}

const requestIdOf = (org: Org) =>
  withDb(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.intake_requests where form_id = $1 order by created_at desc limit 1",
      [org.formId],
    );
    return rows[0].id;
  });

const statusOf = (requestId: string) =>
  withDb(async (db) => {
    const { rows } = await db.query<{ status: string; assigned_to: string | null }>(
      "select status, assigned_to from public.intake_requests where id = $1",
      [requestId],
    );
    return rows[0];
  });

const listPath = (org: Org, filter?: string) =>
  `/o/${org.tenantId}/solicitudes${filter ? `?estado=${filter}` : ""}`;
const detailPath = (org: Org, id: string) => `/o/${org.tenantId}/solicitudes/${id}`;

test.describe.configure({ mode: "serial" });

test.describe("H-089 · recibir y asignar solicitudes", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(360_000);
    ctx.owner = await newPerson(browser, "duena", NAMES.owner);
    ctx.a = await newOrg(ctx.owner, `Negocio Solicitudes ${randomUUID().slice(0, 6)}`);
    ctx.ownerB = await newPerson(browser, "duenob", "Dueño Otra Empresa");
    ctx.b = await newOrg(ctx.ownerB, `Otra Empresa ${randomUUID().slice(0, 6)}`);
    ctx.admin = await newPerson(browser, "adela", NAMES.admin);
    ctx.sales = await newPerson(browser, "carla", NAMES.sales);
    await addMember(ctx.a, ctx.admin, "admin");
    await addMember(ctx.a, ctx.sales, "sales");
    // Un lector de A (el Dueño de la otra empresa): no debe aparecer entre quienes reciben solicitudes.
    await addMember(ctx.a, ctx.ownerB, "viewer");
    ctx.formRevision = await withDb(async (db) => {
      const { rows } = await db.query<{ id: string; revision: number }>(
        "select id, revision from public.intake_forms where id = any($1)",
        [[ctx.a.formId, ctx.b.formId]],
      );
      const byId = new Map(rows.map((r) => [r.id, r.revision]));
      return { a: byId.get(ctx.a.formId)!, b: byId.get(ctx.b.formId)! };
    });
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

  test("un visitante envía una solicitud por el formulario público y llega sin asignar, como texto", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    ctx.visitorEmail = `visitante-${randomUUID().slice(0, 8)}@ejemplo.test`;
    await page.setViewportSize(MOBILE);
    await page.goto(`/f/${ctx.a.publicId}`);
    await expect(page.getByTestId("form-view")).toBeVisible();
    await page.locator("#pf-name").fill(XSS_NAME);
    await page.locator("#pf-email").fill(ctx.visitorEmail);
    await page.locator("#pf-phone").fill("+56 9 1234 5678");
    await page.locator("#pf-message").fill(XSS_MESSAGE);
    const itemId = await withDb(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        "select id from public.intake_form_items where form_id = $1",
        [ctx.a.formId],
      );
      return rows[0].id;
    });
    await page.locator(`#pf-item-${itemId}`).check();
    await page.locator(`#pf-qty-${itemId}`).fill("12,5");
    await page.locator("#pf-consent").check();
    await page.getByTestId("antibot-memory-pass").click();
    await page.getByTestId("submit-request").click();
    await expect(page.getByTestId("intake-success")).toBeVisible({ timeout: 30_000 });
    expect(dialogs).toEqual([]);

    ctx.requestA = await requestIdOf(ctx.a);
    expect(await statusOf(ctx.requestA)).toEqual({ status: "new", assigned_to: null });

    // Una solicitud para la otra empresa (sirve para el ataque de aislamiento más abajo).
    await visitorSubmit(page, ctx.b, ctx.formRevision.b);
    ctx.requestB = await requestIdOf(ctx.b);
  });

  test("el Administrador la ve en la lista como sin asignar, con insignia en el menú y sin ningún precio", async () => {
    const { page } = ctx.admin;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(listPath(ctx.a));
    const row = page.getByTestId("request-row").first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(XSS_NAME); // texto plano, con sus signos
    await expect(row).toContainText("Sin asignar");
    await expect(row).toContainText("Hace");
    await expect(row).toContainText(`${SERVICE_NAME} (12,5 km)`);
    await expect(row).toContainText("Sin responsable");
    expect(await row.locator("img").count()).toBe(0);
    await expectNoPrices(page);

    // Insignia del menú: una solicitud nueva sin asignar
    await expect(page.getByRole("link", { name: "Solicitudes, 1 pendiente" })).toBeVisible();
    await expect(page.getByTestId("dock-badge")).toHaveText("1");

    // Filtros
    await page.getByTestId("filter-sin-asignar").click();
    await expect(page).toHaveURL(/estado=sin-asignar/);
    await expect(page.getByTestId("request-row")).toHaveCount(1);
    await page.getByTestId("filter-convertidas").click();
    await expect(page.getByTestId("request-row")).toHaveCount(0);
    await expect(page.getByText("Aún no hay solicitudes convertidas")).toBeVisible();
    await page.getByTestId("filter-mias").click();
    await expect(page.getByTestId("request-row")).toHaveCount(0);
    await page.getByTestId("filter-descartadas").click();
    await expect(page.getByTestId("request-row")).toHaveCount(0);
    await page.getByTestId("filter-todas").click();
    await expect(page.getByTestId("request-row")).toHaveCount(1);
  });

  test("el detalle muestra los datos descifrados como texto plano, el consentimiento y el marcador «Llega pronto»", async () => {
    const { page } = ctx.admin;
    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    await page.goto(detailPath(ctx.a, ctx.requestA));
    await expect(page.getByTestId("request-title")).toHaveText(XSS_NAME);
    const contact = page.getByTestId("request-contact");
    await expect(contact).toContainText(ctx.visitorEmail);
    await expect(contact).toContainText("+56 9 1234 5678");
    const message = page.getByTestId("request-message");
    await expect(message).toContainText("<script>alert(1)</script>");
    await expect(message).toContainText('& "comillas"');
    expect(await message.locator("script, img").count()).toBe(0);
    await expect(page.getByTestId("request-items")).toContainText(`${SERVICE_NAME}`);
    await expect(page.getByTestId("request-items")).toContainText("12,5 km");
    // Origen, consentimiento y estado
    await expect(page.getByRole("link", { name: /^Fletes / })).toBeVisible();
    const consent = page.getByTestId("request-consent");
    await expect(consent).toContainText("intake-v1");
    await expect(consent).toContainText(/\d{2}-\d{2}-\d{4} \d{2}:\d{2}/);
    await page.getByText("Ver el texto que aceptó").click();
    await expect(page.getByText(`Tus datos los recibirá ${ctx.a.name}`)).toBeVisible();
    await expect(page.getByTestId("request-assignee")).toHaveText("Nadie todavía");
    // «Crear cotización» solo como marcador
    await expect(page.getByTestId("convert-soon")).toBeDisabled();
    await expect(page.getByText("Llega pronto")).toBeVisible();
    await expectNoPrices(page);
    expect(dialogs).toEqual([]);

    // 375 px: sin desplazamiento horizontal ni en la lista ni en el detalle
    await page.setViewportSize(MOBILE);
    await page.goto(detailPath(ctx.a, ctx.requestA));
    await expect(page.getByTestId("request-title")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.goto(listPath(ctx.a));
    await expect(page.getByTestId("request-row").first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("el Comercial ve la solicitud con los datos de contacto pero no puede asignarla; el servidor lo rechaza (42501)", async () => {
    const { page, token } = ctx.sales;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(detailPath(ctx.a, ctx.requestA));
    await expect(page.getByTestId("request-contact")).toContainText(ctx.visitorEmail);
    await expect(page.getByTestId("assignee-select")).toHaveCount(0);
    await expect(page.getByTestId("assign-submit")).toHaveCount(0);
    await expect(page.getByTestId("discard-open")).toHaveCount(0);
    await expect(page.getByTestId("anonymize-open")).toHaveCount(0);

    // Directo al servidor, sin pasar por la pantalla
    const assign = await rpc(
      token,
      "assign_intake_request",
      { p_request_id: ctx.requestA, p_assignee_user_id: ctx.sales.userId },
      header(ctx.a),
    );
    expect(assign.status).toBeGreaterThanOrEqual(400);
    expect((assign.json as { code?: string }).code).toBe("42501");
    const discard = await rpc(
      token,
      "discard_intake_request",
      { p_request_id: ctx.requestA, p_reason: "spam", p_note: null },
      header(ctx.a),
    );
    expect((discard.json as { code?: string }).code).toBe("42501");
    const anonymize = await rpc(
      token,
      "anonymize_intake_request",
      { p_request_id: ctx.requestA, p_reason: "other" },
      header(ctx.a),
    );
    expect((anonymize.json as { code?: string }).code).toBe("42501");
    expect(await statusOf(ctx.requestA)).toEqual({ status: "new", assigned_to: null });
    // Sin insignia: no tiene solicitudes asignadas
    await expect(page.getByTestId("dock-badge")).toHaveCount(0);
  });

  test("el Administrador asigna a Carla: solo ofrece a Dueño, Administradores y Comerciales; Carla recibe un aviso sin datos del visitante", async () => {
    test.setTimeout(120_000);
    const { page } = ctx.admin;
    await page.goto(detailPath(ctx.a, ctx.requestA));
    const select = page.getByTestId("assignee-select");
    const options = await select.locator("option").allInnerTexts();
    expect(options.some((text) => text.includes(NAMES.sales))).toBe(true);
    expect(options.some((text) => text.includes(NAMES.admin))).toBe(true);
    expect(options.some((text) => text.includes(NAMES.owner))).toBe(true);
    // El lector (Dueño de la otra empresa) no aparece
    expect(options.some((text) => text.includes("Dueño Otra Empresa"))).toBe(false);
    await expect(page.getByTestId("assign-submit")).toBeDisabled();
    await select.selectOption({ label: `${NAMES.sales} · Comercial` });
    await page.getByTestId("assign-submit").click();
    await expect(page.getByTestId("request-assignee")).toHaveText(NAMES.sales);
    await expect(page.getByText("Asignada").first()).toBeVisible();
    expect(await statusOf(ctx.requestA)).toEqual({
      status: "assigned",
      assigned_to: ctx.sales.userId,
    });

    await expect
      .poll(async () => (await mailsTo(ctx.sales.email, "Te asignaron una solicitud")).length, {
        message: "debe llegar el aviso «Te asignaron una solicitud»",
        timeout: 45_000,
      })
      .toBe(1);
    const [mail] = await mailsTo(ctx.sales.email, "Te asignaron una solicitud");
    const content = `${mail.Text}\n${mail.HTML}`;
    expect(content).toContain(`/o/${ctx.a.tenantId}/solicitudes/${ctx.requestA}`);
    expect(content).toContain("Fletes");
    for (const secret of [
      XSS_NAME,
      "<img",
      "alert(1)",
      ctx.visitorEmail,
      "1234 5678",
      "comillas",
      SERVICE_NAME,
      "12,5",
    ]) {
      expect(content, `el aviso no puede llevar «${secret}»`).not.toContain(secret);
    }
    expect(await mailsTo(ctx.admin.email, "Te asignaron una solicitud")).toHaveLength(0);

    // Con la persona ya elegida, el botón de asignar queda inactivo (no se manda otro correo)
    await page.reload();
    await expect(page.getByTestId("assign-submit")).toBeDisabled();
  });

  test("Carla ve la insignia en el menú (escritorio y teléfono) y la solicitud en «Asignadas a mí»", async () => {
    const { page } = ctx.sales;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/o/${ctx.a.tenantId}`);
    await expect(page.getByRole("link", { name: "Solicitudes, 1 pendiente" })).toBeVisible();
    await expect(page.getByTestId("dock-badge")).toHaveText("1");
    await page.getByRole("link", { name: "Solicitudes, 1 pendiente" }).click();
    await expect(page).toHaveURL(/\/solicitudes$/);
    await page.getByTestId("filter-mias").click();
    await expect(page.getByTestId("request-row")).toHaveCount(1);
    await expect(page.getByTestId("request-row")).toContainText(`A cargo de ${NAMES.sales}`);

    // Teléfono: la insignia va en «Más» y en el destino dentro del menú
    await page.setViewportSize(MOBILE);
    await page.goto(`/o/${ctx.a.tenantId}`);
    await expect(page.getByTestId("more-badge")).toHaveText("1");
    await page.getByRole("button", { name: /Más opciones/ }).click();
    await expect(page.getByTestId("menu-badge-solicitudes")).toHaveText("1");
    await page.keyboard.press("Escape");
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("Carla descarta con motivo y la restaura; el Comercial solo toca las suyas", async () => {
    test.setTimeout(120_000);
    const { page, token } = ctx.sales;
    await page.goto(detailPath(ctx.a, ctx.requestA));
    await expect(page.getByTestId("assign-submit")).toHaveCount(0);
    await expect(page.getByTestId("anonymize-open")).toHaveCount(0);

    await page.getByTestId("discard-open").click();
    // Sin motivo no se descarta
    await page.getByTestId("discard-confirm").click();
    await expect(page.getByText("Elige el motivo para descartarla.")).toBeVisible();
    await page.getByTestId("discard-reason").selectOption("duplicate");
    await page.getByTestId("discard-note").fill("Es la misma de ayer");
    await page.getByTestId("discard-confirm").click();
    await expect(page.getByTestId("discard-dialog")).toHaveCount(0);
    await expect(page.getByText("Descartada").first()).toBeVisible();
    await expect(page.getByText("Solicitud duplicada")).toBeVisible();
    await expect(page.getByText("Es la misma de ayer")).toBeVisible();
    const discarded = await withDb(async (db) => {
      const { rows } = await db.query(
        "select status, discard_reason, discard_note from public.intake_requests where id = $1",
        [ctx.requestA],
      );
      return rows[0];
    });
    expect(discarded).toEqual({
      status: "discarded",
      discard_reason: "duplicate",
      discard_note: "Es la misma de ayer",
    });
    await page.goto(listPath(ctx.a, "descartadas"));
    await expect(page.getByTestId("request-row")).toHaveCount(1);
    // Ya no cuenta para la insignia
    await expect(page.getByTestId("dock-badge")).toHaveCount(0);

    await page.goto(detailPath(ctx.a, ctx.requestA));
    await page.getByTestId("restore-submit").click();
    await expect(page.getByTestId("request-assignee")).toHaveText("Nadie todavía");
    await expect(page.getByText("Sin asignar").first()).toBeVisible();
    expect(await statusOf(ctx.requestA)).toEqual({ status: "new", assigned_to: null });

    // Ya no es suya: no puede descartarla ni restaurarla
    const attempt = await rpc(
      token,
      "discard_intake_request",
      { p_request_id: ctx.requestA, p_reason: "spam", p_note: null },
      header(ctx.a),
    );
    expect((attempt.json as { code?: string }).code).toBe("42501");
    await page.reload();
    await expect(page.getByTestId("discard-open")).toHaveCount(0);
  });

  test("una solicitud de otra empresa no se abre desde esta: «No encontrado», con o sin pertenecer a ella", async () => {
    const { page } = ctx.admin;
    for (const path of [
      detailPath(ctx.a, ctx.requestB),
      detailPath(ctx.b, ctx.requestB),
      detailPath(ctx.a, randomUUID()),
      detailPath(ctx.a, "no-es-un-id"),
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: NOT_FOUND_HEADING }), path).toBeVisible();
      expect(await page.content()).not.toContain("Visitante Ficticio");
    }
    // Y nada de B aparece en la lista de A
    await page.goto(listPath(ctx.a, "todas"));
    await expect(page.locator("body")).not.toContainText("Visitante Ficticio");
    // El servidor tampoco la asigna ni la descarta con la cabecera de A
    for (const [name, args] of [
      [
        "assign_intake_request",
        { p_request_id: ctx.requestB, p_assignee_user_id: ctx.admin.userId },
      ],
      ["discard_intake_request", { p_request_id: ctx.requestB, p_reason: "spam", p_note: null }],
      ["anonymize_intake_request", { p_request_id: ctx.requestB, p_reason: "other" }],
    ] as [string, object][]) {
      const res = await rpc(ctx.admin.token, name, args, header(ctx.a));
      expect((res.json as { code?: string }).code, name).toBe("CP404");
    }
    expect((await statusOf(ctx.requestB)).status).toBe("new");
  });

  test("anonimizar vacía los datos, explica que es irreversible y deja la solicitud sin acciones", async () => {
    test.setTimeout(120_000);
    const { page } = ctx.admin;
    await page.goto(detailPath(ctx.a, ctx.requestA));
    await page.getByTestId("anonymize-open").click();
    const dialog = page.getByTestId("anonymize-dialog");
    await expect(dialog).toContainText("No se puede deshacer");
    await expect(dialog).toContainText("derecho de supresión");
    await expect(dialog).toContainText("ya no se podrá asignar ni convertir");
    // Sin motivo no se elimina
    await page.getByTestId("anonymize-confirm").click();
    await expect(page.getByText("Elige el motivo para eliminar los datos.")).toBeVisible();
    await page.getByTestId("anonymize-cancel").click();
    const before = await withDb(async (db) => {
      const { rows } = await db.query(
        "select contact_name_enc is not null as name, anonymized_at from public.intake_requests where id = $1",
        [ctx.requestA],
      );
      return rows[0];
    });
    expect(before).toEqual({ name: true, anonymized_at: null });

    await page.getByTestId("anonymize-open").click();
    await page.getByTestId("anonymize-reason").selectOption("data_subject_request");
    await page.getByTestId("anonymize-confirm").click();
    await expect(page.getByTestId("request-title")).toHaveText("Datos eliminados");
    await expect(page.getByTestId("data-deleted")).toBeVisible();
    await expect(page.getByTestId("assignee-select")).toHaveCount(0);
    await expect(page.getByTestId("convert-soon")).toHaveCount(0);
    await expect(page.getByTestId("anonymize-open")).toHaveCount(0);
    // Se vuelve a cargar: el HTML de la carga anterior aún trae los datos que ya se eliminaron.
    await page.reload();
    await expect(page.getByTestId("data-deleted")).toBeVisible();
    const html = await page.content();
    for (const gone of [ctx.visitorEmail, "1234 5678", "alert(1)", "comillas"]) {
      expect(html).not.toContain(gone);
    }
    // Se conservan los servicios y el consentimiento
    await expect(page.getByTestId("request-items")).toContainText(SERVICE_NAME);
    await expect(page.getByTestId("request-consent")).toContainText("intake-v1");

    const after = await withDb(async (db) => {
      const { rows } = await db.query(
        `select contact_name_enc, contact_email_enc, contact_phone_enc, message_enc, contact_email_hash,
                consent_ip_enc, anonymized_at is not null as anonymized
           from public.intake_requests where id = $1`,
        [ctx.requestA],
      );
      return rows[0];
    });
    expect(after).toEqual({
      contact_name_enc: null,
      contact_email_enc: null,
      contact_phone_enc: null,
      message_enc: null,
      contact_email_hash: null,
      consent_ip_enc: null,
      anonymized: true,
    });
    // En la lista también dice «Datos eliminados»
    await page.goto(listPath(ctx.a));
    await expect(page.getByTestId("request-row").first()).toContainText("Datos eliminados");
    // Y el servidor no deja asignarla aunque se pida directo desde la pantalla ya cargada
    await expectNoPrices(page);
  });

  test("el Observador ve la solicitud con sus datos de contacto pero no tiene acciones", async () => {
    // El lector de A es el Dueño de B: ve las solicitudes de A con datos de contacto, sin botones.
    const { page } = ctx.ownerB;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(detailPath(ctx.a, ctx.requestA));
    await expect(page.getByTestId("request-title")).toBeVisible();
    await expect(page.getByTestId("request-actions")).toHaveCount(0);
    await expect(page.getByTestId("dock-badge")).toHaveCount(0);
  });
});
