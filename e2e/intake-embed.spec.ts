import "../tests/support/stub-server-only"; // debe ir primero
import { randomUUID } from "node:crypto";
import { buildEmbedSnippet } from "../src/lib/intake/embed";
import { rpc } from "../tests/support/local-supabase";
import {
  addMember,
  formItemIds,
  header,
  newOrg,
  newPerson,
  requestIdsOf,
  withDb,
  type Org,
  type Person,
} from "./intake-support";
import { expect, test, type Page } from "./fixtures";

// H-093: poner el formulario público en el sitio web de la organización. Todo ficticio. Sitios falsos
// servidos con `page.route`; el navegador de verdad aplica `frame-ancestors`. Una organización nueva por
// corrida (A con Dueña y Comercial, B con su Dueño) para no tocar la semilla ni sus topes del día.

const SITE_OK = "https://sitio-permitido.test";
const SITE_OTHER = "https://otro.test";
const MOBILE = { width: 375, height: 812 };
const INITIAL_HEIGHT_PX = 640;

const ctx = {} as {
  ownerA: Person;
  sales: Person;
  ownerB: Person;
  a: Org;
  b: Org;
  /** Organización que nunca se leyó antes del marco en pausa (la lectura de sitios se recuerda 60 s). */
  c: Org;
  appOrigin: string;
  serviceName: string;
};

const bodyOf = (res: { json: unknown }) => res.json as { code?: string; message?: string };

/** Guarda la lista de sitios con la función de la base (como lo hace el panel). */
async function saveOrigins(org: Org, origins: string[]) {
  const row = await withDb(async (db) => {
    const { rows } = await db.query<{ revision: number }>(
      "select revision from public.intake_forms where id = $1",
      [org.formId],
    );
    return rows[0].revision;
  });
  return rpc(
    org.token,
    "save_intake_form",
    {
      p_form_id: org.formId,
      p_expected_revision: row,
      p_form: { embed_origins: origins },
      p_items: null,
    },
    header(org),
  );
}

/** Un sitio falso en `origin` que pega el código de `org` y anota cada mensaje que le llega. */
async function serveSite(
  page: Page,
  origin: string,
  org: Org,
  extraBody = "",
  options: { pre?: string; scattered?: boolean } = {},
) {
  let snippet = buildEmbedSnippet(ctx.appOrigin, org.publicId);
  if (options.scattered) {
    // Como lo deja un editor tipo WordPress: el marco envuelto en un <p> y el script en otro lugar de la página.
    const at = snippet.indexOf("<script>");
    snippet = `<p>${snippet.slice(0, at)}</p><div>otro bloque</div><footer>${snippet.slice(at)}</footer>`;
  }
  await page.route(`${origin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sitio de prueba</title></head>
<body style="margin:0;background:#fde68a"><h1>Mi sitio</h1>
<script>window.__msgs=[];addEventListener("message",function(e){window.__msgs.push({origin:e.origin,data:e.data})})</script>
${options.pre ?? ""}${snippet}${extraBody}</body></html>`,
    }),
  );
}

const messagesOf = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __msgs: { origin: string; data: unknown }[] }).__msgs ?? [],
  );

const csp = (headers: Record<string, string>) => headers["content-security-policy"] ?? "";

// Chromium bloquea que un sitio público (https) cargue un marco de una dirección local (localhost): es una
// protección del navegador contra ataques a la red local, que no existe en producción (la aplicación vive
// en una dirección pública). Solo para esta prueba se apaga esa comprobación.
test.use({
  launchOptions: {
    args: [
      "--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWarn,PrivateNetworkAccessSendPreflights,BlockInsecurePrivateNetworkRequests",
    ],
  },
});

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const suffix = randomUUID().slice(0, 6);
  ctx.serviceName = "Flete urbano";
  ctx.appOrigin = new URL(test.info().project.use.baseURL!).origin;
  ctx.ownerA = await newPerson(browser, "emb-a", "Dueña Incrustada");
  ctx.a = await newOrg(ctx.ownerA, `Incrustada A ${suffix}`, [
    { name: ctx.serviceName, unit: "service", catalogItemId: null, quantityMode: "none" },
  ]);
  ctx.sales = await newPerson(browser, "emb-sales", "Carla Comercial");
  await addMember(ctx.a, ctx.sales, "sales");
  ctx.ownerB = await newPerson(browser, "emb-b", "Dueño B");
  ctx.b = await newOrg(ctx.ownerB, `Incrustada B ${suffix}`, [
    { name: "Traslado B", unit: "service", catalogItemId: null, quantityMode: "none" },
  ]);
  await ctx.ownerB.page.goto("/organizaciones/nueva");
  ctx.c = await newOrg(ctx.ownerB, `Incrustada C ${suffix}`, [
    { name: "Traslado C", unit: "service", catalogItemId: null, quantityMode: "none" },
  ]);
});

test.afterAll(async () => {
  for (const person of [ctx.ownerA, ctx.sales, ctx.ownerB]) await person?.context.close();
});

test("el Dueño agrega sitios con avisos claros, guarda, queda en auditoría y el código se actualiza", async () => {
  test.setTimeout(240_000);
  const page = ctx.ownerA.page;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/o/${ctx.a.tenantId}/formularios/${ctx.a.formId}`);

  const panel = page.getByTestId("embed-panel");
  await expect(panel).toBeVisible();
  // Sin sitios autorizados: el aviso lo dice.
  await expect(page.getByTestId("embed-empty-warning")).toContainText("no carga en ninguna web");
  // El código para pegar y el enlace público están a la vista.
  const snippet = page.getByTestId("embed-snippet");
  const snippetText = await snippet.inputValue();
  expect(snippetText).toContain(`${ctx.appOrigin}/f/${ctx.a.publicId}/incrustar`);
  expect(snippetText).toContain("<iframe");
  expect(snippetText).toContain("event.origin");
  expect(snippetText).toContain(`<iframe data-cotiza-prime="${ctx.a.publicId}"`);
  await expect(page.getByTestId("embed-delay-note")).toContainText("hasta un minuto");
  // El cuadro del código usa letra de 16 px (el iPhone no hace zoom al tocarlo).
  expect(await snippet.evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
  await expect(page.getByTestId("public-link")).toContainText(`/f/${ctx.a.publicId}`);
  await expect(page.getByTestId("embed-copy")).toBeVisible();

  // La pantalla rechaza lo peligroso y lo explica.
  const input = page.getByTestId("embed-origin-input");
  const rejected: [string, RegExp][] = [
    ["http://sitio.cl", /https:\/\//],
    ["https://*.sitio.cl", /comodines/],
    ["https://sitio.cl; script-src *", /espacios|signos/],
    ["https://sitio.cl/ruta", /ruta|barra/],
    ["https://sitio.cl/", /ruta|barra/],
    ["HTTPS://SITIO.CL", /https:\/\//],
    ["https://SITIO.cl", /minúsculas/],
    ["sitio.cl", /https:\/\//],
    ["https://diseño.cl", /xn--[\s\S]*con y sin www/],
  ];
  for (const [value, message] of rejected) {
    await input.fill(value);
    await page.getByTestId("embed-origin-add").click();
    await expect(
      panel.getByRole("alert").filter({ hasText: message }).first(),
      value,
    ).toBeVisible();
    await expect(page.getByTestId("embed-origins")).toHaveCount(0);
  }

  // Un sitio válido se agrega, se guarda y queda al recargar.
  await input.fill(SITE_OK);
  await page.getByTestId("embed-origin-add").click();
  await expect(page.getByTestId("embed-origins")).toContainText(SITE_OK);
  await expect(page.getByTestId("embed-empty-warning")).toHaveCount(0);
  await page.getByTestId("embed-save").click();
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "sitios autorizados" }),
  ).toBeVisible();
  const stored = await withDb(async (db) => {
    const { rows } = await db.query<{ embed_origins: string[] }>(
      "select embed_origins from public.intake_forms where id = $1",
      [ctx.a.formId],
    );
    return rows[0].embed_origins;
  });
  expect(stored).toEqual([SITE_OK]);
  // Auditoría: lista anterior y nueva.
  const audit = await withDb(async (db) => {
    const { rows } = await db.query<{ details: { old: string[]; new: string[] } }>(
      `select details from public.audit_log where resource_id = $1 and action = 'intake_form.embed_origins_changed' order by id`,
      [ctx.a.formId],
    );
    return rows.map((row) => row.details);
  });
  expect(audit).toEqual([{ old: [], new: [SITE_OK] }]);
  await page.reload();
  await expect(page.getByTestId("embed-origins")).toContainText(SITE_OK);
  // Guardar los sitios no movió el formulario (el enlace público es el mismo).
  await expect(page.getByTestId("public-link")).toContainText(`/f/${ctx.a.publicId}`);
});

test("en el sitio autorizado el formulario carga con su marca, ajusta su altura y envía la solicitud", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await serveSite(page, SITE_OK, ctx.a);
  const framed = page.waitForResponse((r) => r.url().includes(`/f/${ctx.a.publicId}/incrustar`));
  await page.goto(`${SITE_OK}/contacto`);
  const response = await framed;
  // La cabecera autoriza SOLO ese sitio; sin X-Frame-Options ni CORS; privada y sin indexar.
  const headers = response.headers();
  expect(csp(headers)).toContain(`frame-ancestors ${SITE_OK};`);
  expect(headers["x-frame-options"]).toBeUndefined();
  expect(headers["access-control-allow-origin"]).toBeUndefined();
  expect(headers["cache-control"]).toMatch(/no-store|no-cache/);
  expect(headers["cache-control"]).not.toMatch(/public|s-maxage|max-age=[1-9]/);
  expect(headers["x-robots-tag"]).toContain("noindex");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["strict-transport-security"]).toContain("max-age=");

  const frame = page.frameLocator("iframe");
  await expect(frame.getByTestId("form-view")).toBeVisible();
  // Con la marca de la organización y sin nada de Cotiza Prime.
  await expect(frame.getByText(ctx.a.name).first()).toBeVisible();
  // (El aviso de privacidad nombra a Cotiza Prime como encargado: es texto legal, no un enlace ni un pie.)
  await expect(frame.locator("footer")).toHaveCount(0);
  await expect(frame.locator("a")).toHaveCount(0);
  // Sin marco de afuera: el fondo del documento es transparente.
  const backgrounds = await frame.locator("body").evaluate((el) => ({
    body: getComputedStyle(el).backgroundColor,
    html: getComputedStyle(document.documentElement).backgroundColor,
  }));
  expect(backgrounds.body).toBe("rgba(0, 0, 0, 0)");
  expect(backgrounds.html).toBe("rgba(0, 0, 0, 0)");

  // La altura del marco se ajusta al contenido por el mensaje de altura.
  const frameHeight = () =>
    page.locator("iframe").evaluate((el) => el.getBoundingClientRect().height);
  await expect
    .poll(async () => {
      const body = await frame.locator("body").evaluate((el) => el.getBoundingClientRect().height);
      return (
        Math.abs((await frameHeight()) - body) <= 2 && (await frameHeight()) !== INITIAL_HEIGHT_PX
      );
    })
    .toBe(true);
  const heightBefore = await frameHeight();
  expect(heightBefore).toBeGreaterThanOrEqual(200);
  expect(heightBefore).toBeLessThanOrEqual(4_000);

  // Los mensajes llevan SOLO source, type y height, y vienen de la aplicación.
  const messages = await messagesOf(page);
  expect(messages.length).toBeGreaterThan(0);
  for (const message of messages) {
    expect(message.origin).toBe(ctx.appOrigin);
    expect(Object.keys(message.data as object).sort()).toEqual(["height", "source", "type"]);
    expect(message.data).toMatchObject({ source: "cotiza-prime", type: "resize" });
    const text = JSON.stringify(message.data);
    for (const secret of [ctx.a.publicId, ctx.a.name, ctx.a.tenantId, ctx.a.formId, "email"]) {
      expect(text).not.toContain(secret);
    }
  }
  // La página incrustada no escucha lo que le manden desde afuera: un mensaje falso no cambia nada.
  await page.evaluate(() =>
    document
      .querySelector("iframe")
      ?.contentWindow?.postMessage({ source: "cotiza-prime", type: "resize", height: 50 }, "*"),
  );
  await page.waitForTimeout(300);
  expect(Math.abs((await frameHeight()) - heightBefore)).toBeLessThanOrEqual(2);
  // Un mensaje falso al sitio desde otro origen tampoco cambia la altura (el script revisa de dónde viene).
  await page.evaluate(() =>
    window.postMessage({ source: "cotiza-prime", type: "resize", height: 3_999 }, "*"),
  );
  await page.waitForTimeout(300);
  expect(Math.abs((await frameHeight()) - heightBefore)).toBeLessThanOrEqual(2);

  // Funciona igual que el enlace: envío completo y confirmación.
  const ids = await formItemIds(ctx.a);
  const before = (await requestIdsOf(ctx.a)).length;
  await frame.locator("#pf-name").fill("Visitante Incrustado");
  await frame.locator("#pf-email").fill(`visitante-${randomUUID().slice(0, 8)}@ejemplo.test`);
  await frame.locator(`#pf-item-${ids.get(ctx.serviceName)}`).check();
  await frame.locator("#pf-consent").check();
  await frame.getByTestId("antibot-memory-pass").click();
  await frame.getByTestId("submit-request").click();
  await expect(frame.getByTestId("intake-success")).toBeVisible({ timeout: 30_000 });
  await expect(frame.getByTestId("intake-success-message")).toContainText(
    "Gracias, te escribiremos.",
  );
  expect((await requestIdsOf(ctx.a)).length).toBe(before + 1);
});

test("a 375 px el formulario incrustado se ve bien y se ajusta al ancho de la página", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE);
  await serveSite(page, SITE_OK, ctx.a);
  await page.goto(`${SITE_OK}/contacto`);
  const frame = page.frameLocator("iframe");
  await expect(frame.getByTestId("form-view")).toBeVisible();
  const iframeBox = await page.locator("iframe").boundingBox();
  expect(Math.round(iframeBox!.width)).toBe(MOBILE.width);
  const overflowInside = await frame
    .locator("html")
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflowInside).toBeLessThanOrEqual(0);
  const overflowOutside = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflowOutside).toBeLessThanOrEqual(0);
  // El campo de nombre mide 16 px (el iPhone no hace zoom) y el botón de enviar se puede tocar.
  const fontSize = await frame.locator("#pf-name").evaluate((el) => getComputedStyle(el).fontSize);
  expect(fontSize).toBe("16px");
  const submit = await frame.getByTestId("submit-request").boundingBox();
  expect(submit!.height).toBeGreaterThanOrEqual(44);
});

test("en un sitio NO autorizado el marco no carga (el navegador lo bloquea) y el contenido no se ve", async ({
  page,
}) => {
  await serveSite(page, SITE_OTHER, ctx.a);
  const framed = page.waitForResponse((r) => r.url().includes(`/f/${ctx.a.publicId}/incrustar`));
  await page.goto(`${SITE_OTHER}/contacto`);
  const response = await framed;
  const policy = csp(response.headers());
  expect(policy).toContain(`frame-ancestors ${SITE_OK};`);
  expect(policy).not.toContain(SITE_OTHER);
  // El navegador bloquea el marco: ni el formulario ni la marca aparecen.
  const frame = page.frameLocator("iframe");
  await page.waitForTimeout(1_500);
  await expect(frame.getByTestId("form-view")).toHaveCount(0);
  await expect(frame.getByText(ctx.a.name)).toHaveCount(0);
  const messages = await messagesOf(page);
  expect(
    messages.filter((m) => (m.data as { source?: string })?.source === "cotiza-prime"),
  ).toEqual([]);
});

test("sin sitios autorizados no carga en ninguna web", async ({ page }) => {
  // La organización B no autorizó ningún sitio.
  for (const site of [SITE_OK, SITE_OTHER]) {
    await serveSite(page, site, ctx.b);
    const framed = page.waitForResponse((r) => r.url().includes(`/f/${ctx.b.publicId}/incrustar`));
    await page.goto(`${site}/contacto`);
    const response = await framed;
    expect(csp(response.headers()), site).toContain("frame-ancestors 'none'");
    expect(response.headers()["x-frame-options"]).toBeUndefined();
    await page.waitForTimeout(1_000);
    await expect(page.frameLocator("iframe").getByTestId("form-view"), site).toHaveCount(0);
    await page.unroute(`${site}/**`);
  }
});

test("el resto sigue sin poder enmarcarse: /f/<id>, /o/*, /c/*, la API y el PDF", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const invented = "A".repeat(22);
  // El enlace normal del formulario: X-Frame-Options DENY y 'none', aunque tenga sitios autorizados.
  const plain = await page.request.get(`/f/${ctx.a.publicId}`);
  expect(plain.status()).toBe(200);
  expect(plain.headers()["x-frame-options"]).toBe("DENY");
  expect(csp(plain.headers())).toContain("frame-ancestors 'none'");
  // Y de verdad no se puede incrustar en el sitio autorizado.
  await serveSite(page, SITE_OK, { ...ctx.a, publicId: ctx.a.publicId }, "");
  await page.route(`${SITE_OK}/normal`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>x</title><iframe id="plain" src="${ctx.appOrigin}/f/${ctx.a.publicId}" style="width:600px;height:400px"></iframe>`,
    }),
  );
  await page.goto(`${SITE_OK}/normal`);
  await page.waitForTimeout(2_000);
  await expect(page.frameLocator("#plain").getByTestId("form-view")).toHaveCount(0);

  const denied: [string, string][] = [
    [`/f/${ctx.a.publicId}/otra`, "ruta inexistente bajo /f"],
    [`/f/${invented}`, "formulario inventado"],
    // Next no distingue mayúsculas: estas variantes no son el formulario incrustable y no se pueden enmarcar.
    [`/F/${ctx.a.publicId}/incrustar`, "mayúscula en /F"],
    [`/F/${ctx.a.publicId}/INCRUSTAR`, "mayúsculas en todo"],
    [`/f/${ctx.a.publicId}/INCRUSTAR`, "INCRUSTAR"],
    [`/f/${ctx.a.publicId}/Incrustar`, "Incrustar"],
    [`/c/${invented}${invented}`, "enlace del cliente"],
    [`/ingresar`, "ingreso"],
    [`/api/v1/ping`, "API"],
    [`/api/v1/public/forms/${invented}/requests`, "API pública del formulario"],
    [`/api/v1/tenants/${ctx.a.tenantId}/intake-forms/${ctx.a.formId}/qr`, "QR"],
  ];
  for (const [path, what] of denied) {
    const res = await page.request.get(path);
    expect(res.headers()["x-frame-options"], `${what} (${path})`).toBe("DENY");
    expect(csp(res.headers()), `${what} (${path})`).toContain("frame-ancestors 'none'");
  }
  // Pantallas de la organización (con sesión): DENY.
  const owner = ctx.ownerA.page;
  for (const path of [`/o/${ctx.a.tenantId}`, `/o/${ctx.a.tenantId}/formularios`]) {
    const res = await owner.request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()["x-frame-options"], path).toBe("DENY");
    expect(csp(res.headers()), path).toContain("frame-ancestors 'none'");
  }
  // El PDF de la cotización solo se enmarca desde la propia aplicación (vista previa de enviar): no cambió.
  const pdf = await page.request.get(
    `/api/v1/tenants/${ctx.a.tenantId}/quotes/${randomUUID()}/pdf`,
  );
  expect(pdf.headers()["x-frame-options"]).toBe("SAMEORIGIN");
  expect(csp(pdf.headers())).toContain("frame-ancestors 'self'");
});

test("formulario en pausa o inexistente: el marco muestra «no está disponible» con el contacto", async ({
  page,
}) => {
  // Se pausa el formulario de B con una lista autorizada.
  expect((await saveOrigins(ctx.b, [SITE_OK])).status).toBeLessThan(300);
  const paused = await rpc(
    ctx.b.token,
    "set_intake_form_status",
    { p_form_id: ctx.b.formId, p_status: "paused" },
    header(ctx.b),
  );
  expect(paused.status).toBeLessThan(300);
  // La misma página, abierta directo (sin marco): el aviso de «no disponible», con el contacto.
  await page.goto(`/f/${ctx.b.publicId}/incrustar`);
  await expect(page.getByTestId("intake-state-title")).toHaveText(
    "Este formulario no está disponible",
  );
  await expect(page.getByTestId("intake-unavailable")).toContainText(ctx.b.name);
  await expect(page.getByTestId("intake-contact")).toContainText("@ejemplo.test");
  await expect(page.getByTestId("form-view")).toHaveCount(0);
  // Un formulario inexistente muestra lo mismo, sin contacto y sin revelar nada.
  await page.goto(`/f/${"Z".repeat(22)}/incrustar`);
  await expect(page.getByTestId("intake-state-title")).toHaveText(
    "Este formulario no está disponible",
  );
  await expect(page.getByTestId("intake-contact")).toHaveCount(0);
  // Se reanuda para no dejar el formulario en pausa.
  await rpc(
    ctx.b.token,
    "set_intake_form_status",
    { p_form_id: ctx.b.formId, p_status: "published" },
    header(ctx.b),
  );
});

test("DENTRO del sitio autorizado, el formulario en pausa muestra el aviso con el contacto; en otro sitio no carga", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // La organización C nunca se leyó antes: la lista de sitios no está recordada.
  expect((await saveOrigins(ctx.c, [SITE_OK])).status).toBeLessThan(300);
  const paused = await rpc(
    ctx.c.token,
    "set_intake_form_status",
    { p_form_id: ctx.c.formId, p_status: "paused" },
    header(ctx.c),
  );
  expect(paused.status).toBeLessThan(300);

  await page.setViewportSize({ width: 1280, height: 900 });
  await serveSite(page, SITE_OK, ctx.c);
  const framed = page.waitForResponse((r) => r.url().includes(`/f/${ctx.c.publicId}/incrustar`));
  await page.goto(`${SITE_OK}/contacto`);
  const response = await framed;
  expect(csp(response.headers())).toContain(`frame-ancestors ${SITE_OK};`);
  expect(response.headers()["x-frame-options"]).toBeUndefined();
  const frame = page.frameLocator("iframe");
  await expect(frame.getByTestId("intake-state-title")).toHaveText(
    "Este formulario no está disponible",
  );
  await expect(frame.getByTestId("intake-contact")).toContainText("@ejemplo.test");
  await expect(frame.getByTestId("form-view")).toHaveCount(0);
  // Y el marco mide lo que mide el aviso (no queda un recuadro bloqueado ni un hueco de 640 px).
  await expect
    .poll(async () => (await page.locator("iframe").boundingBox())!.height)
    .not.toBe(INITIAL_HEIGHT_PX);

  // En un sitio no autorizado sigue sin cargar: ni aviso ni contacto.
  await page.unroute(`${SITE_OK}/**`);
  await serveSite(page, SITE_OTHER, ctx.c);
  await page.goto(`${SITE_OTHER}/contacto`);
  await page.waitForTimeout(1_500);
  await expect(page.frameLocator("iframe").getByTestId("intake-state-title")).toHaveCount(0);
  await expect(page.frameLocator("iframe").getByTestId("intake-contact")).toHaveCount(0);

  // Se reanuda para no dejar el formulario en pausa.
  await rpc(
    ctx.c.token,
    "set_intake_form_status",
    { p_form_id: ctx.c.formId, p_status: "published" },
    header(ctx.c),
  );
});

test("a 375 px, al enviar dentro del marco el éxito queda a la vista; el aviso de scroll no lleva datos y funciona aunque el código esté repartido", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize(MOBILE);
  // Mucho contenido arriba (el marco queda lejos de la parte alta de la página) y el código repartido como lo
  // deja un editor: marco dentro de un <p> y script en el pie.
  await serveSite(page, SITE_OK, ctx.a, "", {
    pre: '<div style="height:1500px">Contenido de la empresa</div>',
    scattered: true,
  });
  await page.goto(`${SITE_OK}/contacto`);
  const frame = page.frameLocator("iframe");
  await page.locator("iframe").scrollIntoViewIfNeeded();
  await expect(frame.getByTestId("form-view")).toBeVisible();

  const ids = await formItemIds(ctx.a);
  await frame.locator("#pf-name").fill("Visitante Móvil");
  await frame.locator("#pf-email").fill(`movil-${randomUUID().slice(0, 8)}@ejemplo.test`);
  await frame.locator(`#pf-item-${ids.get(ctx.serviceName)}`).check();
  await frame.locator("#pf-consent").check();
  await frame.getByTestId("antibot-memory-pass").click();
  // Se baja al final del formulario antes de enviar: sin el aviso, el éxito quedaría fuera de la pantalla.
  await frame.getByTestId("submit-request").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 400));
  await frame.getByTestId("submit-request").click();
  await expect(frame.getByTestId("intake-success")).toBeVisible({ timeout: 30_000 });

  // El mensaje de scroll llegó, sin ningún dato.
  await expect
    .poll(async () =>
      (await messagesOf(page)).filter((m) => (m.data as { type?: string })?.type === "scroll"),
    )
    .toHaveLength(1);
  const scrollMessage = (await messagesOf(page)).find(
    (m) => (m.data as { type?: string })?.type === "scroll",
  )!;
  expect(scrollMessage.origin).toBe(ctx.appOrigin);
  expect(scrollMessage.data).toEqual({ source: "cotiza-prime", type: "scroll" });

  // El éxito queda a la vista de la página de la empresa (el marco subió a la parte alta de la pantalla).
  await expect
    .poll(async () => {
      const box = await frame.getByTestId("intake-success").boundingBox();
      return !!box && box.y >= -1 && box.y < MOBILE.height;
    })
    .toBe(true);
  // El foco está en el título de la confirmación.
  await expect(frame.getByTestId("intake-success-title")).toBeFocused();
  // Un mensaje de scroll falso desde otro origen no mueve nada.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => window.postMessage({ source: "cotiza-prime", type: "scroll" }, "*"));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("el envío legítimo funciona en el marco y un Origin «null» o ajeno se rechaza", async ({
  page,
}) => {
  const url = `/api/v1/public/forms/${ctx.a.publicId}/requests`;
  for (const origin of ["null", "https://malo.test", SITE_OK]) {
    const res = await page.request.post(url, { headers: { origin }, data: {} });
    expect(res.status(), origin).toBe(403);
  }
  const noOrigin = await page.request.post(url, { data: {} });
  expect(noOrigin.status()).toBe(403);
});

test("la base rechaza sitios peligrosos, y ni la Comercial ni otra organización pueden cambiar la lista", async () => {
  const bad = [
    ["https://sitio.cl; script-src *"],
    ["http://sitio.cl"],
    ["*"],
    ["https://*.sitio.cl"],
    ["https://sitio.cl/ruta"],
    ["https://sitio.cl\nContent-Type: x"],
    ["https://SITIO.cl"],
    Array.from({ length: 11 }, (_, i) => `https://s${i}.cl`),
  ];
  for (const origins of bad) {
    const res = await saveOrigins(ctx.a, origins);
    expect(res.status, JSON.stringify(origins)).toBeGreaterThanOrEqual(400);
    expect(bodyOf(res).code).toBe("CP422");
  }
  const kept = await withDb(async (db) => {
    const { rows } = await db.query<{ embed_origins: string[] }>(
      "select embed_origins from public.intake_forms where id = $1",
      [ctx.a.formId],
    );
    return rows[0].embed_origins;
  });
  expect(kept).toEqual([SITE_OK]);

  // Carla (Comercial): no ve el panel y la base le responde 42501.
  const salesPage = ctx.sales.page;
  await salesPage.goto(`/o/${ctx.a.tenantId}/formularios/${ctx.a.formId}`);
  await expect(salesPage.getByTestId("status-panel")).toBeVisible();
  await expect(salesPage.getByTestId("embed-panel")).toHaveCount(0);
  await expect(salesPage.getByTestId("embed-snippet")).toHaveCount(0);
  const asSales = await rpc(
    ctx.sales.token,
    "save_intake_form",
    {
      p_form_id: ctx.a.formId,
      p_expected_revision: 1,
      p_form: { embed_origins: ["https://carla.cl"] },
      p_items: null,
    },
    header(ctx.a),
  );
  expect(bodyOf(asSales).code).toBe("42501");

  // La Dueña de A no puede editar el formulario de B, ni con la organización de A ni con la de B.
  const attacks = [
    { tenant: ctx.a, formId: ctx.b.formId },
    { tenant: ctx.b, formId: ctx.b.formId },
  ];
  for (const attack of attacks) {
    const res = await rpc(
      ctx.ownerA.token,
      "save_intake_form",
      {
        p_form_id: attack.formId,
        p_expected_revision: 1,
        p_form: { embed_origins: ["https://intruso.cl"] },
        p_items: null,
      },
      header(attack.tenant),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(["42501", "CP404"]).toContain(bodyOf(res).code);
  }
  const theirs = await withDb(async (db) => {
    const { rows } = await db.query<{ embed_origins: string[] }>(
      "select embed_origins from public.intake_forms where id = $1",
      [ctx.b.formId],
    );
    return rows[0].embed_origins;
  });
  expect(theirs).toEqual([SITE_OK]);
  // Y desde la pantalla: el formulario de B no se abre con la organización de A.
  await ctx.ownerA.page.goto(`/o/${ctx.a.tenantId}/formularios/${ctx.b.formId}`);
  await expect(ctx.ownerA.page.getByTestId("embed-panel")).toHaveCount(0);
});

test("al crear un enlace nuevo el código cambia y el código viejo deja de servir", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = ctx.ownerA.page;
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.goto(`/o/${ctx.a.tenantId}/formularios/${ctx.a.formId}`);
  const oldSnippet = await owner.getByTestId("embed-snippet").inputValue();
  expect(oldSnippet).toContain(ctx.a.publicId);
  await owner.getByTestId("regenerate-open").click();
  await owner.getByTestId("regenerate-confirm").click();
  await expect(owner.getByTestId("regenerate-dialog")).toHaveCount(0);
  await expect
    .poll(async () => owner.getByTestId("embed-snippet").inputValue())
    .not.toBe(oldSnippet);
  const newSnippet = await owner.getByTestId("embed-snippet").inputValue();
  expect(newSnippet).not.toContain(ctx.a.publicId);
  // Los sitios autorizados se conservan en el panel.
  await expect(owner.getByTestId("embed-origins")).toContainText(SITE_OK);
  // El código viejo ya no sirve: el formulario viejo no existe, así que lo que se ve es el aviso de
  // «no está disponible», nunca el formulario. (El permiso de enmarcar se recuerda hasta 60 s en memoria;
  // el contenido deja de servirse al instante.)
  await serveSite(page, SITE_OK, ctx.a);
  await page.goto(`${SITE_OK}/contacto`);
  const frame = page.frameLocator("iframe");
  await expect(frame.getByTestId("intake-state-title")).toHaveText(
    "Este formulario no está disponible",
  );
  await expect(frame.getByTestId("form-view")).toHaveCount(0);
});
