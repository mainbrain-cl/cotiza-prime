// H-012 · Aislamiento de punta a punta, desde el navegador (P21–P26 de docs/arquitectura/h-012-aislamiento.md).
// Personas reales con sesión iniciada por pantalla (ver isolation.setup.ts). Todo ficticio.
// Sin reintentos: si una de estas falla, es una falla.
import "../tests/support/stub-server-only"; // debe ir primero
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { PLATFORM_TENANT_ID, TENANT_HEADER } from "../src/lib/tenant/constants";
import { connect } from "../tests/db/helpers";
import {
  ONLY_B_CUSTOMER_EMAIL,
  ONLY_B_CUSTOMER_RUT,
  SHARED_CUSTOMER_RUT,
} from "../tests/isolation/fixture";
import { APP_ROUTES, TENANT_PAGES, concretePath } from "../tests/isolation/registry";
import { expect, test, type Page } from "./fixtures";
import { countRows, loadFixture, stateFile } from "./isolation-support";

const NOT_FOUND_HEADING = "No encontrado";
/** Un token con la forma correcta (43 caracteres base64url) que no existe en ninguna parte. */
const INVENTED_SHARE_TOKEN = "A".repeat(43);

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** Registros de "acceso denegado" de la plataforma que nombran ese identificador y esa persona. */
async function deniedEvents(userId: string, resourceId: string): Promise<{ reason: string }[]> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ details: { reason: string } }>(
      `select details from public.audit_log
       where action = 'tenant.access_denied' and result = 'denied' and tenant_id = $1
         and actor_user_id = $2 and resource_id = $3`,
      [PLATFORM_TENANT_ID, userId, resourceId],
    );
    return rows.map((r) => r.details);
  });
}

/** Cuántas filas tiene la organización B entre las tablas de negocio y su auditoría. */
async function bRowCount(tenantId: string): Promise<number> {
  return withDb(async (db) => {
    let total = 0;
    for (const table of [
      "customers",
      "catalog_items",
      "audit_log",
      "members",
      "numbering_sequences",
      "quotes",
      "quote_items",
      "quote_events",
    ]) {
      total += await countRows(db, `select 1 from public.${table} where tenant_id = $1`, [
        tenantId,
      ]);
    }
    return total;
  });
}

async function mainText(page: Page): Promise<string> {
  return (await page.locator("main").first().innerText()).replace(/\s+/g, " ").trim();
}

async function expectNotFound(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status(), `${path}: debe responder 404`).toBe(404);
  await expect(page.getByRole("heading", { name: NOT_FOUND_HEADING })).toBeVisible();
}

const PAGE_ROUTES = TENANT_PAGES;

test.describe("Ana (Dueña de A) frente a la organización B", () => {
  test.use({ storageState: stateFile("ana") });
  // Las direcciones ajenas que se dejan registradas por persona tienen tope (20 por ventana, ver
  // login-rate-limit.ts). P22 necesita que se registre una por cada pantalla, así que corre primero
  // y sola: en paralelo con P22b sus intentos se comparten el tope y las pantallas nuevas lo pasan.
  test.describe.configure({ mode: "serial" });

  test("P22 · toda dirección de B da 'No encontrado', sin datos de B, y deja constancia en la plataforma", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const fx = loadFixture();
    const B = fx.orgs.B;
    const rowsBefore = await bRowCount(B.tenantId);

    for (const route of PAGE_ROUTES) {
      const path = concretePath(
        route,
        B.tenantId,
        B.customerIds[0],
        B.catalogIds[0],
        B.quoteIds[0],
      );
      await expectNotFound(page, path);
      const html = await page.content();
      expect(html, path).not.toContain(B.canary);
      expect(html, path).not.toContain(fx.personas.beto.userId);
    }

    // El cliente de B pedido DESDE la organización A: la pantalla es de A, así que el "No encontrado"
    // sale de la propia página (con 200, porque ya empezó a enviarse). Debe ser idéntico al de un
    // cliente que no existe en ninguna parte: no se puede distinguir "es de otra organización".
    const missing = await page.goto(`/o/${fx.orgs.A.tenantId}/clientes/${crypto.randomUUID()}`);
    await expect(page.getByRole("heading", { name: NOT_FOUND_HEADING })).toBeVisible();
    const missingText = await mainText(page);
    const foreign = await page.goto(`/o/${fx.orgs.A.tenantId}/clientes/${B.customerIds[0]}`);
    await expect(page.getByRole("heading", { name: NOT_FOUND_HEADING })).toBeVisible();
    expect(foreign?.status()).toBe(missing?.status());
    expect(await mainText(page)).toBe(missingText);
    expect(await page.content()).not.toContain(B.canary);

    // Lo mismo con una cotización de B pedida DESDE la organización A: idéntico a una que no existe.
    await page.goto(`/o/${fx.orgs.A.tenantId}/cotizaciones/${crypto.randomUUID()}`);
    await expect(page.getByRole("heading", { name: NOT_FOUND_HEADING })).toBeVisible();
    const missingQuoteText = await mainText(page);
    const foreignQuote = await page.goto(`/o/${fx.orgs.A.tenantId}/cotizaciones/${B.quoteIds[0]}`);
    await expect(page.getByRole("heading", { name: NOT_FOUND_HEADING })).toBeVisible();
    expect(foreignQuote?.status()).toBe(missing?.status());
    expect(await mainText(page)).toBe(missingQuoteText);
    expect(await page.content()).not.toContain(B.canary);

    // H-028: el PDF de una cotización de B pedido DESDE la organización A es idéntico a pedir uno que
    // no existe, y no entrega ningún byte del documento ni del dato de prueba de B.
    const pdfPath = (quoteId: string) =>
      `/api/v1/tenants/${fx.orgs.A.tenantId}/quotes/${quoteId}/pdf`;
    const missingPdf = await page.request.get(pdfPath(crypto.randomUUID()));
    const foreignPdf = await page.request.get(pdfPath(B.quoteIds[0]));
    expect(missingPdf.status()).toBe(404);
    expect(foreignPdf.status()).toBe(404);
    expect(foreignPdf.headers()["content-type"]).toBe(missingPdf.headers()["content-type"]);
    expect(await foreignPdf.text()).toBe(await missingPdf.text());
    // y con el pase de Ana pero la dirección de B también: 404
    const foreignTenantPdf = await page.request.get(
      `/api/v1/tenants/${B.tenantId}/quotes/${B.quoteIds[0]}/pdf`,
    );
    expect(foreignTenantPdf.status()).toBe(404);

    // constancia en la plataforma (nunca en B), sin datos personales
    const events = await deniedEvents(fx.personas.ana.userId, B.tenantId);
    // (otra prueba de este archivo, P22b, escribe el mismo identificador en mayúsculas: "invalid_id")
    const notMember = events.filter((e) => e.reason === "not_a_member");
    expect(notMember.length).toBeGreaterThanOrEqual(PAGE_ROUTES.length);
    expect(events.every((e) => ["not_a_member", "invalid_id"].includes(e.reason))).toBe(true);
    // B no recibió ninguna fila nueva: ni datos, ni auditoría visible para su Dueño
    expect(await bRowCount(B.tenantId)).toBe(rowsBefore);
  });

  test("P22b · organización ajena, inexistente o mal escrita: mismo código y mismo texto", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const fx = loadFixture();
    const B = fx.orgs.B.tenantId;
    const random = crypto.randomUUID();
    const reference = await (async () => {
      await expectNotFound(page, `/o/${random}/clientes`);
      return mainText(page);
    })();
    const variants = [
      `/o/${B}/clientes`, // existe, es de otra persona
      `/o/${B}`,
      "/o/no-es-un-uuid/clientes",
      `/o/${B.toUpperCase()}/clientes`,
      `/o/${B.replaceAll("-", "")}/clientes`,
      `/o/${PLATFORM_TENANT_ID}/clientes`, // la organización "plataforma"
      `/o/${fx.orgs.C.tenantId}/clientes`, // archivada y de otra persona
    ];
    for (const path of variants) {
      await expectNotFound(page, path);
      expect(await mainText(page), path).toBe(reference);
    }
  });

  test("P22c · las pantallas de su organización no se guardan en caché compartida", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const fx = loadFixture();
    for (const route of PAGE_ROUTES) {
      const path = concretePath(
        route,
        fx.orgs.A.tenantId,
        fx.orgs.A.customerIds[0],
        fx.orgs.A.catalogIds[0],
        fx.orgs.A.quoteIds[0],
      );
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      const cacheControl = response?.headers()["cache-control"] ?? "";
      // En producción la regla de next.config.ts exige "private, no-store" (la verifica
      // src/lib/security-headers.test.ts y se comprobó contra `next start`); el servidor de
      // desarrollo pone "no-cache": en ningún caso puede ser una caché compartida con vida.
      expect(cacheControl, `${path}: Cache-Control`).toMatch(/private|no-store|no-cache/);
      expect(cacheControl, `${path}: Cache-Control`).not.toMatch(/public|s-maxage|max-age=[1-9]/);
    }
  });

  test("P21 · la cabecera de organización que mande el navegador se ignora; la API pública no muestra datos", async ({
    page,
  }) => {
    const fx = loadFixture();
    // con la cabecera de B en el pedido, la pantalla de A sigue mostrando solo A
    const response = await page.request.get(`/o/${fx.orgs.A.tenantId}/clientes`, {
      headers: { [TENANT_HEADER]: fx.orgs.B.tenantId },
    });
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain(fx.orgs.A.canary);
    expect(html).not.toContain(fx.orgs.B.canary);
    // y la pantalla de B no se abre con ninguna cabecera
    const attack = await page.request.get(`/o/${fx.orgs.B.tenantId}/clientes`, {
      headers: { [TENANT_HEADER]: fx.orgs.B.tenantId },
    });
    expect(attack.status()).toBe(404);
    expect(await attack.text()).not.toContain(fx.orgs.B.canary);

    // rutas de la API: las públicas no devuelven datos de nadie; las que no, dan 404 con una organización ajena
    for (const route of APP_ROUTES.filter((r) => r.kind === "api")) {
      if (route.scope === "token") {
        // Con un token inventado, la API pública no entrega nada de nadie (404, o 405 si solo acepta POST).
        const res = await page.request.get(route.path.replace("[token]", INVENTED_SHARE_TOKEN), {
          headers: { [TENANT_HEADER]: fx.orgs.B.tenantId },
        });
        expect([404, 405], route.path).toContain(res.status());
        expect(await res.text()).not.toContain(fx.orgs.B.canary);
      } else if (route.scope === "signed") {
        // Aviso firmado del proveedor de correo: un GET no es válido (405) y un POST sin firma da 401,
        // sin datos de nadie.
        const path = route.path.replace("[provider]", "resend");
        const get = await page.request.get(path, {
          headers: { [TENANT_HEADER]: fx.orgs.B.tenantId },
        });
        expect(get.status(), path).toBe(405);
        expect(await get.text()).not.toContain(fx.orgs.B.canary);
        const post = await page.request.post(path, {
          headers: { [TENANT_HEADER]: fx.orgs.B.tenantId },
          data: {},
        });
        expect(post.status(), path).toBe(401);
        expect(await post.text()).not.toContain(fx.orgs.B.canary);
      } else if (route.scope === "none") {
        const res = await page.request.get(route.path, {
          headers: { [TENANT_HEADER]: fx.orgs.B.tenantId },
        });
        expect(res.status()).toBe(200);
        expect(await res.text()).not.toContain(fx.orgs.B.canary);
      } else {
        // Ana (con sesión, miembro solo de A) pide una dirección de B: 404, con o sin cabecera.
        const attackPath = concretePath(route, fx.orgs.B.tenantId, "", "", fx.orgs.B.quoteIds[0]);
        const res = await page.request.get(attackPath, {
          headers: { [TENANT_HEADER]: fx.orgs.B.tenantId },
        });
        expect(res.status(), attackPath).toBe(404);
        expect(await res.text()).not.toContain(fx.orgs.B.canary);
      }
    }
  });

  test("P27 · el token de B abierto con la sesión de Ana: se ve como cliente, sin rastro en A; el de A no cuenta", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const fx = loadFixture();
    const A = fx.orgs.A;
    const B = fx.orgs.B;
    const tables = [
      "quotes",
      "quote_events",
      "quote_responses",
      "share_links",
      "share_link_views",
      "email_messages",
      "audit_log",
    ];
    const fingerprintOf = (tenantId: string) =>
      withDb(async (db) => {
        const out: Record<string, string> = {};
        for (const table of tables) {
          const { rows } = await db.query<{ h: string }>(
            `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h
               from public.${table} t where tenant_id = $1`,
            [tenantId],
          );
          out[table] = rows[0].h;
        }
        return out;
      });
    const viewsOf = (shareLinkId: string) =>
      withDb((db) =>
        countRows(db, "select 1 from public.share_link_views where share_link_id = $1", [
          shareLinkId,
        ]),
      );

    // Ana abre el enlace de B: lo ve como lo vería cualquier cliente (no es miembro de B).
    // La propia página avisa de la apertura (como cliente): se espera ese aviso antes de contar.
    const pageBeacon = page.waitForResponse(
      (r) => r.url().endsWith("/view") && r.request().method() === "POST",
    );
    const opened = await page.goto(`/c/${B.share!.token}`);
    expect(opened?.status()).toBe(200);
    await expect(page.getByTestId("share-quote")).toContainText(B.canary);
    expect((await pageBeacon).status()).toBe(200);
    const origin = new URL(page.url()).origin;
    const post = (token: string) =>
      page.request.post(`/api/v1/public/quote-links/${token}/view`, { headers: { origin } });

    const beforeA = await fingerprintOf(A.tenantId);
    const beforeViewsB = await viewsOf(B.share!.shareLinkId);
    const asClient = await post(B.share!.token);
    expect(asClient.status()).toBe(200);
    expect(await asClient.json()).toEqual({ recorded: true });
    // la apertura quedó en B (como cliente) y A no cambió en nada
    expect(await viewsOf(B.share!.shareLinkId)).toBe(beforeViewsB + 1);
    expect(await fingerprintOf(A.tenantId)).toEqual(beforeA);

    // Ana abre el enlace de SU organización: es miembro, así que no cuenta
    const beforeViewsA = await viewsOf(A.share!.shareLinkId);
    const asMember = await post(A.share!.token);
    expect(asMember.status()).toBe(200);
    expect(await asMember.json()).toEqual({ recorded: false, reason: "member" });
    expect(await viewsOf(A.share!.shareLinkId)).toBe(beforeViewsA);
    expect(await fingerprintOf(A.tenantId)).toEqual(beforeA);

    // un POST sin el origen de la aplicación se rechaza
    const noOrigin = await page.request.post(`/api/v1/public/quote-links/${B.share!.token}/view`);
    expect(noOrigin.status()).toBe(403);

    // H-031: Ana responde con el token de B. Su sesión no le da nada: B ya tiene una respuesta, así que
    // la decisión que quedó no cambia, y A no cambia en nada.
    const afterViewsA = await fingerprintOf(A.tenantId);
    const beforeResponseB = await fingerprintOf(B.tenantId);
    const respond = (kind: "accept" | "reject", data: object) =>
      page.request.post(`/api/v1/public/quote-links/${B.share!.token}/${kind}`, {
        headers: { origin },
        data: { responseKey: randomUUID(), ...data },
      });
    const accept = await respond("accept", { name: "Ana Atacante", confirmed: true });
    expect(accept.status()).toBe(200);
    expect(await accept.json()).toEqual({ status: "already_responded", decision: "accepted" });
    const reject = await respond("reject", { reasonCode: "price_too_high" });
    expect(reject.status()).toBe(200);
    expect(await reject.json()).toEqual({ status: "already_responded", decision: "accepted" });
    expect(await fingerprintOf(B.tenantId)).toEqual(beforeResponseB);
    expect(await fingerprintOf(A.tenantId)).toEqual(afterViewsA);
    // sin el origen de la aplicación, tampoco
    const noOriginRespond = await page.request.post(
      `/api/v1/public/quote-links/${B.share!.token}/accept`,
      { data: { responseKey: randomUUID(), name: "Ana Atacante", confirmed: true } },
    );
    expect(noOriginRespond.status()).toBe(403);
  });

  test("P23 · un RUT que solo existe en B no se reconoce como duplicado en A", async ({ page }) => {
    test.setTimeout(180_000);
    const fx = loadFixture();
    const A = fx.orgs.A.tenantId;
    const fill = async (name: string, rut: string, email: string) => {
      await page.goto(`/o/${A}/clientes/nuevo`);
      await page.getByLabel(/^(Nombre|Razón social)/).fill(name);
      await page.getByLabel("RUT (opcional)").fill(rut);
      await page.getByLabel("Correo (opcional)").fill(email);
      await page.getByRole("button", { name: "Guardar cliente" }).click();
    };

    // RUT y correo que solo tiene un cliente de B: se guarda directo, sin aviso
    await fill(`P23 ${fx.runId}`, ONLY_B_CUSTOMER_RUT, ONLY_B_CUSTOMER_EMAIL);
    await expect(page).toHaveURL(new RegExp(`/o/${A}/clientes/[0-9a-f-]{36}\\?creado=1$`));
    await expect(page.getByTestId("duplicate-warning")).toHaveCount(0);

    // control: con el RUT que SÍ tiene un cliente de A, el aviso aparece y solo nombra al de A
    await fill(`P23 control ${fx.runId}`, SHARED_CUSTOMER_RUT, "otro-correo@ejemplo.test");
    const warning = page.getByTestId("duplicate-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(fx.orgs.A.canary);
    await expect(warning).not.toContainText(fx.orgs.B.canary);
  });

  test("P25 · un pedido de la pantalla con el identificador de A cambiado por el de B no escribe en ninguna", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const fx = loadFixture();
    const A = fx.orgs.A.tenantId;
    const B = fx.orgs.B.tenantId;
    const marker = `ATAQUE-P25-${fx.runId}`;
    await page.goto(`/o/${A}/clientes/nuevo`);

    let tampered = 0;
    await page.route(`**/o/${A}/clientes/nuevo`, async (route) => {
      const request = route.request();
      const body = request.postData();
      if (request.method() !== "POST" || body === null) return route.continue();
      const replaced = body.split(A).join(B);
      if (replaced !== body) tampered++;
      await route.continue({ postData: replaced });
    });

    await page.getByLabel(/^(Nombre|Razón social)/).fill(marker);
    await page.getByRole("button", { name: "Guardar cliente" }).click();
    await expect
      .poll(() => tampered, {
        message: "el pedido de la acción debía llevar el identificador de A",
      })
      .toBeGreaterThan(0);
    await page.waitForTimeout(1500);

    await withDb(async (db) => {
      expect(
        await countRows(db, `select 1 from public.customers where display_name = $1`, [marker]),
      ).toBe(0);
    });
    // y queda constancia del intento sobre B
    expect((await deniedEvents(fx.personas.ana.userId, B)).length).toBeGreaterThan(0);
  });
});

test.describe("Mixta (en A y en B) con dos pestañas", () => {
  test.use({ storageState: stateFile("mixta") });

  test("P24 · cada pestaña ve solo su organización y lo que crea queda donde se creó", async ({
    context,
  }) => {
    test.setTimeout(240_000);
    const fx = loadFixture();
    const { A, B } = fx.orgs;
    const tabA = await context.newPage();
    const tabB = await context.newPage();
    await tabA.goto(`/o/${A.tenantId}/clientes`);
    await tabB.goto(`/o/${B.tenantId}/clientes`);

    const customerLink = (page: Page, canary: string) =>
      page.getByRole("link", { name: new RegExp(`${canary} Cliente`) });
    await expect(customerLink(tabA, A.canary).first()).toBeVisible();
    await expect(customerLink(tabA, B.canary)).toHaveCount(0);
    await expect(customerLink(tabB, B.canary).first()).toBeVisible();
    await expect(customerLink(tabB, A.canary)).toHaveCount(0);

    // crea un cliente en la pestaña de A, con la pestaña de B abierta
    const name = `P24 ${fx.runId}`;
    await tabA.goto(`/o/${A.tenantId}/clientes/nuevo`);
    await tabA.getByLabel(/^(Nombre|Razón social)/).fill(name);
    await tabA.getByRole("button", { name: "Guardar cliente" }).click();
    await expect(tabA).toHaveURL(new RegExp(`/o/${A.tenantId}/clientes/[0-9a-f-]{36}\\?creado=1$`));

    await tabB.reload();
    await expect(tabB.getByRole("link", { name })).toHaveCount(0);
    await tabA.goto(`/o/${A.tenantId}/clientes`);
    await expect(tabA.getByRole("link", { name })).toBeVisible();

    await withDb(async (db) => {
      expect(
        await countRows(
          db,
          `select 1 from public.customers where display_name = $1 and tenant_id = $2`,
          [name, A.tenantId],
        ),
      ).toBe(1);
      expect(
        await countRows(
          db,
          `select 1 from public.customers where display_name = $1 and tenant_id = $2`,
          [name, B.tenantId],
        ),
      ).toBe(0);
    });

    // los datos de B no aparecen en la pestaña de A ni al pedir direcciones de B desde ella
    await tabA.goto(`/o/${B.tenantId}/clientes`);
    await expect(customerLink(tabA, A.canary)).toHaveCount(0);
    await expect(tabA.getByRole("heading", { name: "Clientes" })).toBeVisible(); // Mixta sí es miembro de B: ve B, no A
  });
});

test.describe("Quien dejó de ser miembro y quien tiene la organización archivada", () => {
  test("P26 · 'ex' en la organización A y Carla en la archivada C: 'No encontrado' y constancia", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const fx = loadFixture();
    const cases = [
      { persona: "ex" as const, tenant: fx.orgs.A.tenantId, canary: fx.orgs.A.canary },
      { persona: "carla" as const, tenant: fx.orgs.C.tenantId, canary: fx.orgs.C.canary },
    ];
    for (const { persona, tenant, canary } of cases) {
      const context = await browser.newContext({
        baseURL: test.info().project.use.baseURL,
        storageState: stateFile(persona),
        extraHTTPHeaders: {
          "x-forwarded-for": `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}::1`,
        },
      });
      const page = await context.newPage();
      for (const sub of ["", "/clientes", "/catalogo", `/clientes/${fx.orgs.A.customerIds[0]}`]) {
        await expectNotFound(page, `/o/${tenant}${sub}`);
        expect(await page.content(), `${persona} ${sub}`).not.toContain(canary);
      }
      const events = await deniedEvents(fx.personas[persona].userId, tenant);
      expect(events.length, `${persona}: debe quedar registrado`).toBeGreaterThanOrEqual(4);
      await context.close();
    }
  });
});

test.describe("Sin sesión", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("una dirección de una organización lleva a ingresar y no muestra nada", async ({ page }) => {
    const fx = loadFixture();
    await page.goto(`/o/${fx.orgs.A.tenantId}/clientes`);
    await expect(page).toHaveURL(/\/ingresar/);
    expect(await page.content()).not.toContain(fx.orgs.A.canary);
  });
});
