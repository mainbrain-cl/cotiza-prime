import { randomUUID } from "node:crypto";
import { consentFingerprint } from "../src/lib/intake/consent-fingerprint";
import { HONEYPOT_FIELD } from "../src/lib/intake/submit-schema";
import { rest, rpc } from "../tests/support/local-supabase";
import { expect, randomTestIp, test, type Page } from "./fixtures";
import {
  addMember,
  expectNoHorizontalScroll,
  formItemIds,
  header,
  newOrg,
  newPerson,
  visitorsSubmit,
  withDb,
  type Org,
  type Person,
} from "./intake-support";

// H-092: que el formulario no se llene de basura. Todo ficticio. Una organización nueva por corrida (A, con
// Dueño y un Comercial; y B, con su propio Dueño) para no tocar la semilla ni sus topes del día. El visitante
// provoca bloqueos (robot, datos inválidos, envíos seguidos, tope diario) y el Dueño los ve contados, sin
// ningún dato personal. Los demás roles no ven el panel ni pueden cambiar el tope.

const MOBILE = { width: 375, height: 812 };
const SERVICE = "Traslado por kilómetro";
const NOT_FOUND_HEADING = "No encontrado";
/** Sello de tiempo y clave de envío que el servidor entrega juntos (van seguidos en los datos de la página). */
const STAMP_IN_HTML =
  /(v1\.\d{9,12}\.[A-Za-z0-9_-]{43})\\*",\\*"submitKey\\*":\\*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
/** El sello de tiempo del formulario pide al menos 3 segundos entre mostrarlo y enviarlo. */
const AFTER_MIN_FILL_MS = 3_500;

const KEYS = ["accepted", "blockedCaptcha", "blockedRate", "blockedCap", "blockedInvalid"] as const;
type Key = (typeof KEYS)[number];
type Counts = Record<Key, number>;
const PERIODS = [
  { id: "today", days: 1 },
  { id: "last7", days: 7 },
  { id: "last30", days: 30 },
] as const;

const ctx = {} as {
  owner: Person;
  sales: Person;
  ownerB: Person;
  a: Org;
  b: Org;
};

const editorUrl = (org: Org) => `/o/${org.tenantId}/formularios/${org.formId}`;
const listUrl = (org: Org) => `/o/${org.tenantId}/formularios`;

/** Lo que cuenta la base para el formulario, en los últimos `days` días de Chile (hoy incluido). */
async function dbCounts(org: Org, days: number): Promise<Counts> {
  return withDb(async (db) => {
    const { rows } = await db.query<Record<string, number>>(
      `select coalesce(sum(accepted),0)::int as "accepted", coalesce(sum(blocked_captcha),0)::int as "blockedCaptcha",
              coalesce(sum(blocked_rate),0)::int as "blockedRate", coalesce(sum(blocked_cap),0)::int as "blockedCap",
              coalesce(sum(blocked_invalid),0)::int as "blockedInvalid"
         from public.intake_daily_counters
        where form_id = $1 and day > (now() at time zone 'America/Santiago')::date - $2::int`,
      [org.formId, days],
    );
    return rows[0] as unknown as Counts;
  });
}

/** Cuántas solicitudes hay guardadas de verdad para el formulario. */
const savedRequests = (org: Org) =>
  withDb(async (db) => {
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from public.intake_requests where form_id = $1",
      [org.formId],
    );
    return rows[0].n;
  });

const dbForm = (org: Org) =>
  withDb(async (db) => {
    const { rows } = await db.query<{ daily_cap: number; revision: number }>(
      "select daily_cap, revision from public.intake_forms where id = $1",
      [org.formId],
    );
    return rows[0];
  });

/** Lo que muestra el panel en una de sus tres franjas. */
async function panelCounts(page: Page, period: string): Promise<Counts> {
  const out = {} as Counts;
  for (const key of KEYS) {
    const text = await page.getByTestId(`protection-${period}-${key}`).first().innerText();
    // el panel escribe «1.500» (punto de miles)
    out[key] = Number(text.replace(/\./g, "").trim());
  }
  return out;
}

/** El panel (en el editor o en la lista) dice exactamente lo que cuenta la base, en las tres franjas. */
async function expectPanelMatchesDb(page: Page, org: Org) {
  for (const period of PERIODS) {
    expect(await panelCounts(page, period.id), period.id).toEqual(await dbCounts(org, period.days));
  }
}

const fingerprints = new Map<string, string>();
async function fingerprintOf(page: Page, org: Org): Promise<string> {
  const known = fingerprints.get(org.publicId);
  if (known) return known;
  const reader = await page.context().newPage();
  try {
    await reader.goto(`/f/${org.publicId}`);
    const text = await reader.locator('label[for="pf-consent"]').textContent();
    expect(text, "el aviso de privacidad está a la vista").toBeTruthy();
    const fingerprint = consentFingerprint(text!, null);
    fingerprints.set(org.publicId, fingerprint);
    return fingerprint;
  } finally {
    await reader.close();
  }
}

/**
 * Hace como el navegador: pide la página (sello de tiempo ligado a su clave de envío), espera el mínimo de
 * llenado y envía directo a la API desde una IP propia. `overrides` cambia lo que se manda.
 */
async function submitRaw(page: Page, org: Org, overrides: Record<string, unknown> = {}) {
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const ip = randomTestIp();
  const fingerprint = await fingerprintOf(page, org);
  const html = await (
    await page.request.get(`/f/${org.publicId}`, { headers: { "x-forwarded-for": ip } })
  ).text();
  const found = STAMP_IN_HTML.exec(html);
  expect(found, "la página trae el sello de tiempo y su clave de envío").toBeTruthy();
  const [, token, submitKey] = found!;
  const itemId = (await formItemIds(org)).get(SERVICE)!;
  await page.waitForTimeout(AFTER_MIN_FILL_MS);
  return page.request.post(`/api/v1/public/forms/${org.publicId}/requests`, {
    headers: { origin, "x-forwarded-for": ip },
    data: {
      name: "Visitante Ficticio",
      email: `visitante-${randomUUID().slice(0, 8)}@ejemplo.test`,
      items: [{ formItemId: itemId, quantity: "3" }],
      consent: true,
      submitKey,
      consentFingerprint: fingerprint,
      formRevision: org.revision,
      [HONEYPOT_FIELD]: "",
      renderToken: token,
      antibotToken: "test-pass",
      ...overrides,
    },
  });
}

/** La persona llena el formulario público en pantalla y lo envía con la verificación anti-robot de pruebas. */
async function submitInScreen(page: Page, org: Org, name: string, email: string) {
  const itemId = (await formItemIds(org)).get(SERVICE)!;
  await page.goto(`/f/${org.publicId}`);
  await expect(page.getByTestId("form-view")).toBeVisible();
  await page.locator("#pf-name").fill(name);
  await page.locator("#pf-email").fill(email);
  await page.locator(`#pf-item-${itemId}`).check();
  await page.locator(`#pf-qty-${itemId}`).fill("12,5");
  await page.locator("#pf-consent").check();
  await page.getByTestId("antibot-memory-pass").click();
  await page.getByTestId("submit-request").click();
}

async function setCap(page: Page, value: string) {
  await page.getByTestId("daily-cap-input").fill(value);
  await page.getByTestId("daily-cap-save").click();
}

test.describe.configure({ mode: "serial" });

test.describe("H-092 · que el formulario no se llene de basura", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    ctx.owner = await newPerson(browser, "proteccion", "Dueña Protección");
    ctx.sales = await newPerson(browser, "carla", "Carla Comercial");
    ctx.ownerB = await newPerson(browser, "proteccionb", "Dueño Otra Empresa");
    const items = [
      { name: SERVICE, unit: "km", catalogItemId: null, quantityMode: "required" as const },
    ];
    ctx.a = await newOrg(ctx.owner, `Negocio Protección ${randomUUID().slice(0, 6)}`, items);
    ctx.b = await newOrg(ctx.ownerB, `Negocio Otro ${randomUUID().slice(0, 6)}`, items);
    await addMember(ctx.a, ctx.sales, "sales");
  });

  test.afterAll(async () => {
    for (const person of [ctx.owner, ctx.sales, ctx.ownerB]) await person?.context.close();
  });

  test("al partir el panel está vacío, con el tope en 50 y la explicación de las defensas", async () => {
    const page = ctx.owner.page;
    await page.goto(editorUrl(ctx.a));
    await expect(page.getByRole("heading", { name: "Protección contra abusos" })).toBeVisible();
    await expect(page.getByTestId("protection-empty")).toContainText("Todavía no hay movimiento");
    await expect(page.getByTestId("protection-counters")).toHaveCount(0);
    await expect(page.getByTestId("daily-cap-input")).toHaveValue("50");
    await expect(page.getByTestId("cap-reached")).toHaveCount(0);

    // La explicación está, en lenguaje simple, y no revela umbrales ni cómo se detecta un robot
    const explainer = page.getByTestId("protection-explainer");
    await explainer.locator("summary").click();
    const text = await explainer.innerText();
    for (const word of ["anti-robot", "envíos seguidos", "Tope diario"])
      expect(text).toContain(word);
    expect(text).not.toMatch(/\b\d+\s*(minutos|segundos|horas)\b/i);
    expect(text).not.toMatch(/trampa|sello|honeypot|pf_ref|captcha|turnstile|IP\b/i);
  });

  test("un robot y un envío con datos inválidos se bloquean sin guardar nada y el panel los cuenta", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const before = await dbCounts(ctx.a, 1);
    const robot = await submitRaw(page, ctx.a, { antibotToken: "test-fail" });
    expect(robot.status()).toBe(403);
    const invalid = await submitRaw(page, ctx.a, { email: "esto-no-es-un-correo" });
    expect(invalid.status()).toBeGreaterThanOrEqual(400);
    expect(invalid.status()).toBeLessThan(500);
    // el bloqueo por robot no guarda nada: ni una solicitud
    expect(await savedRequests(ctx.a)).toBe(0);
    await visitorsSubmit(page, ctx.a, [
      { name: "Primera Persona", email: "primera@cliente.test", items: { [SERVICE]: "4" } },
    ]);
    const after = await dbCounts(ctx.a, 1);
    expect(after.blockedCaptcha).toBe(before.blockedCaptcha + 1);
    expect(after.blockedInvalid).toBe(before.blockedInvalid + 1);
    expect(after.accepted).toBe(before.accepted + 1);

    // El Dueño lo ve en el editor: valores exactos en las tres franjas
    const owner = ctx.owner.page;
    await owner.goto(editorUrl(ctx.a));
    await expect(owner.getByTestId("protection-counters")).toBeVisible();
    expect(await panelCounts(owner, "today")).toEqual({
      accepted: 1,
      blockedCaptcha: 1,
      blockedRate: 0,
      blockedCap: 0,
      blockedInvalid: 1,
    });
    await expectPanelMatchesDb(owner, ctx.a);
    await expect(owner.getByTestId("protection-today-blocked")).toHaveText("2");
    // la lista también tiene su panel, con la suma de todos los formularios
    await owner.goto(listUrl(ctx.a));
    await expect(owner.getByTestId("protection-counters")).toBeVisible();
    await expectPanelMatchesDb(owner, ctx.a);
  });

  test("al pasar el límite de envíos seguidos se ve «espera unos minutos», no se guarda nada y se cuenta", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    // Una conexión fija (la del visitante): el límite es por conexión
    const ip = randomTestIp();
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      extraHTTPHeaders: { "x-forwarded-for": ip },
    });
    try {
      const page = await context.newPage();
      const origin = new URL(test.info().project.use.baseURL!).origin;
      const url = `/api/v1/public/forms/${ctx.a.publicId}/requests`;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const res = await page.request.post(url, { headers: { origin }, data: {} });
        expect(res.status(), `intento ${attempt}`).not.toBe(429);
      }
      const before = await dbCounts(ctx.a, 1);
      const requestsBefore = await savedRequests(ctx.a);
      await page.setViewportSize(MOBILE);
      await submitInScreen(page, ctx.a, "Persona Apurada", "apurada@cliente.test");
      await expect(page.getByTestId("intake-banner")).toContainText(/espera unos minutos/i, {
        timeout: 30_000,
      });
      await expectNoHorizontalScroll(page);
      const after = await dbCounts(ctx.a, 1);
      expect(after.accepted).toBe(before.accepted);
      expect(after.blockedRate).toBeGreaterThan(before.blockedRate);
      // lo bloqueado no se guarda: ni una solicitud más en la base
      expect(await savedRequests(ctx.a)).toBe(requestsBefore);
    } finally {
      await context.close();
    }
    // el panel del Dueño sigue diciendo lo mismo que la base
    await ctx.owner.page.goto(editorUrl(ctx.a));
    await expectPanelMatchesDb(ctx.owner.page, ctx.a);
  });

  test("el Dueño sube y baja el tope desde el editor, con validación, y la revisión del formulario no se mueve", async () => {
    const page = ctx.owner.page;
    const revision = (await dbForm(ctx.a)).revision;
    await page.goto(editorUrl(ctx.a));
    await expect(page.getByTestId("daily-cap-input")).toHaveValue("50");
    await expect(page.getByTestId("daily-cap-form")).toContainText(
      "este formulario no recibe más solicitudes hoy",
    );
    await expect(page.getByTestId("daily-cap-form")).toContainText("300");

    // en pantalla: lo inválido no llega al servidor
    for (const bad of ["0", "201", "abc", "1,5", "-3"]) {
      await setCap(page, bad);
      await expect(page.getByTestId("daily-cap-form").getByRole("alert")).toContainText(
        "entero entre 1 y 200",
      );
      expect((await dbForm(ctx.a)).daily_cap, bad).toBe(50);
    }
    // en el servidor y en la base: llamado directo también se rechaza
    for (const value of [0, 201]) {
      const res = await rpc(
        ctx.owner.token,
        "save_intake_form",
        {
          p_form_id: ctx.a.formId,
          p_expected_revision: revision,
          p_form: { daily_cap: value },
          p_items: null,
        },
        header(ctx.a),
      );
      expect(res.status, `tope ${value}`).toBeGreaterThanOrEqual(400);
    }
    expect((await dbForm(ctx.a)).daily_cap).toBe(50);

    // subirlo, bajarlo y dejarlo en 2
    await setCap(page, "200");
    await expect.poll(async () => (await dbForm(ctx.a)).daily_cap).toBe(200);
    await setCap(page, "1");
    await expect.poll(async () => (await dbForm(ctx.a)).daily_cap).toBe(1);
    await setCap(page, "2");
    await expect.poll(async () => (await dbForm(ctx.a)).daily_cap).toBe(2);
    expect((await dbForm(ctx.a)).revision).toBe(revision);
    await page.reload();
    await expect(page.getByTestId("daily-cap-input")).toHaveValue("2");
    // el editor no se queda con «cambios sin guardar» por esto
    await expect(page.getByText("Todo guardado.")).toBeVisible();
  });

  test("con tope 2 la tercera solicitud ve «no recibe más solicitudes hoy» y el Dueño ve el aviso en la lista y en el editor", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    // ya hay 1 aceptada hoy: otra más llega al tope
    await visitorsSubmit(page, ctx.a, [
      { name: "Segunda Persona", email: "segunda@cliente.test", items: { [SERVICE]: "5" } },
    ]);
    const before = await dbCounts(ctx.a, 1);
    expect(before.accepted).toBe(2);

    await page.setViewportSize(MOBILE);
    await submitInScreen(page, ctx.a, "Tercera Persona", "tercera@cliente.test");
    await expect(page.getByTestId("intake-banner")).toContainText("no recibe más solicitudes hoy", {
      timeout: 30_000,
    });
    await expectNoHorizontalScroll(page);
    const after = await dbCounts(ctx.a, 1);
    expect(after.accepted).toBe(2);
    expect(after.blockedCap).toBe(before.blockedCap + 1);

    const owner = ctx.owner.page;
    // lista
    await owner.goto(listUrl(ctx.a));
    const row = owner.getByTestId("intake-form-row").first();
    await expect(row.getByTestId("cap-reached")).toContainText(
      "Este formulario llegó a su tope de hoy: recibió 2 solicitudes y su tope es 2",
    );
    await expectPanelMatchesDb(owner, ctx.a);
    // editor, con enlace para subirlo
    await owner.goto(editorUrl(ctx.a));
    await expect(owner.getByTestId("cap-reached")).toContainText(
      "Este formulario llegó a su tope de hoy: recibió 2 solicitudes y su tope es 2",
    );
    await expect(owner.getByTestId("protection-today-blockedCap")).toHaveText(
      String(after.blockedCap),
    );
    await expectPanelMatchesDb(owner, ctx.a);
    await owner.getByTestId("cap-raise-link").click();
    await expect(owner).toHaveURL(/#tope-diario$/);
    await expect(owner.getByTestId("daily-cap-input")).toBeInViewport();
  });

  test("el Comercial no ve el panel ni los bloqueos, y no puede cambiar el tope (42501)", async () => {
    const carla = ctx.sales.page;
    // el aviso de tope sigue vigente para el Dueño: Carla no lo ve
    for (const url of [editorUrl(ctx.a), listUrl(ctx.a)]) {
      await carla.goto(url);
      await expect(carla.locator("h1")).toBeVisible();
      // sin el tope (columna privada) el editor y la lista cargan igual: ni error ni «0»
      await expect(carla.getByTestId("form-load-error")).toHaveCount(0);
      await expect(carla.getByTestId("protection-panel")).toHaveCount(0);
      await expect(carla.getByTestId("daily-cap-form")).toHaveCount(0);
      await expect(carla.getByTestId("cap-reached")).toHaveCount(0);
      expect(await carla.locator("body").innerText()).not.toContain("Protección contra abusos");
    }
    // directo a la base
    const revision = (await dbForm(ctx.a)).revision;
    const change = await rpc(
      ctx.sales.token,
      "save_intake_form",
      {
        p_form_id: ctx.a.formId,
        p_expected_revision: revision,
        p_form: { daily_cap: 150 },
        p_items: null,
      },
      header(ctx.a),
    );
    expect(change.status).toBeGreaterThanOrEqual(400);
    expect((change.json as { code?: string }).code).toBe("42501");
    expect((await dbForm(ctx.a)).daily_cap).toBe(2);
    // el tope es una columna privada: nadie lo lee por la tabla (ni el Dueño); por la función, solo el Dueño
    for (const token of [ctx.sales.token, ctx.owner.token]) {
      const direct = await rest(token, "intake_forms?select=daily_cap", { headers: header(ctx.a) });
      expect(direct.status).toBeGreaterThanOrEqual(400);
    }
    const capAsSales = await rpc(ctx.sales.token, "intake_form_daily_caps", {}, header(ctx.a));
    expect(capAsSales.status).toBeGreaterThanOrEqual(400);
    expect((capAsSales.json as { code?: string }).code).toBe("42501");
    const capAsOwner = await rpc(ctx.owner.token, "intake_form_daily_caps", {}, header(ctx.a));
    expect(capAsOwner.status).toBe(200);
    expect(capAsOwner.json).toEqual([{ form_id: ctx.a.formId, daily_cap: 2 }]);
    // los contadores: el Comercial no lee ninguna fila; el Dueño sí
    const asSales = await rest(ctx.sales.token, "intake_daily_counters?select=form_id", {
      headers: header(ctx.a),
    });
    expect(asSales.json).toEqual([]);
    const asOwner = await rest(ctx.owner.token, "intake_daily_counters?select=form_id", {
      headers: header(ctx.a),
    });
    expect((asOwner.json as unknown[]).length).toBeGreaterThan(0);
  });

  test("el Dueño sube el tope desde el aviso y el aviso desaparece", async () => {
    const owner = ctx.owner.page;
    await owner.goto(editorUrl(ctx.a));
    await expect(owner.getByTestId("cap-reached")).toBeVisible();
    await setCap(owner, "5");
    await expect.poll(async () => (await dbForm(ctx.a)).daily_cap).toBe(5);
    await owner.reload();
    await expect(owner.getByTestId("cap-reached")).toHaveCount(0);
    await owner.goto(listUrl(ctx.a));
    await expect(owner.getByTestId("cap-reached")).toHaveCount(0);
  });

  test("un formulario de otra organización no se edita ni se lee desde la propia", async () => {
    const before = await dbForm(ctx.a);
    // pantalla: la B no encuentra el formulario de la A
    const ownerB = ctx.ownerB.page;
    await ownerB.goto(editorUrl({ ...ctx.b, formId: ctx.a.formId }));
    await expect(ownerB.getByRole("heading", { name: NOT_FOUND_HEADING })).toBeVisible();
    await expect(ownerB.getByTestId("protection-panel")).toHaveCount(0);
    // base: con su propia organización, el formulario ajeno no existe; con la ajena, no es miembro
    const asOwnOrg = await rpc(
      ctx.ownerB.token,
      "save_intake_form",
      {
        p_form_id: ctx.a.formId,
        p_expected_revision: before.revision,
        p_form: { daily_cap: 7 },
        p_items: null,
      },
      header(ctx.b),
    );
    expect(asOwnOrg.status).toBeGreaterThanOrEqual(400);
    const asForeignOrg = await rpc(
      ctx.ownerB.token,
      "save_intake_form",
      {
        p_form_id: ctx.a.formId,
        p_expected_revision: before.revision,
        p_form: { daily_cap: 7 },
        p_items: null,
      },
      header(ctx.a),
    );
    expect(asForeignOrg.status).toBeGreaterThanOrEqual(400);
    expect((await dbForm(ctx.a)).daily_cap).toBe(before.daily_cap);
    // sus contadores tampoco se ven desde la B
    const foreign = await rest(
      ctx.ownerB.token,
      `intake_daily_counters?form_id=eq.${ctx.a.formId}`,
      {
        headers: header(ctx.b),
      },
    );
    expect(foreign.json).toEqual([]);
  });

  test("el panel no muestra datos personales ni direcciones de conexión, y se ve bien a 375 px", async () => {
    const owner = ctx.owner.page;
    await owner.setViewportSize(MOBILE);
    for (const url of [editorUrl(ctx.a), listUrl(ctx.a)]) {
      await owner.goto(url);
      const panel = owner.getByTestId("protection-panel");
      await expect(panel).toBeVisible();
      const text = await panel.innerText();
      expect(text).not.toMatch(/@/);
      expect(text).not.toMatch(/2001:db8|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      expect(text).not.toContain(ctx.a.publicId);
      for (const person of [
        "Visitante",
        "Primera Persona",
        "Segunda Persona",
        "Tercera Persona",
        "Persona Apurada",
      ]) {
        expect(text).not.toContain(person);
      }
      await expectNoHorizontalScroll(owner);
    }
    // los campos del panel son tocables en el teléfono (44 px)
    await owner.goto(editorUrl(ctx.a));
    const save = owner.getByTestId("daily-cap-save");
    // el panel llega por partes (Suspense): se espera a que esté antes de medirlo
    await expect(save).toBeVisible();
    const box = await save.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});
