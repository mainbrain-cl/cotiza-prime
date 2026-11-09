// H-011b · Cada rol ve y puede hacer solo lo que le corresponde (PROYECTO.md §5.2, matriz en
// src/lib/permissions/matrix.ts). Corre en el proyecto `isolation` porque usa las personas de la
// organización A de la fixture, con la sesión ya iniciada (ver isolation.setup.ts):
//   Ana = Dueña, Mixta = Administradora, Darío = Aprobador, Sofía = Comercial, Dante = Observador.
// Todo es ficticio. Ninguna prueba cambia a las personas ni su rol: lo que sí se pisa (el borrador de Ana,
// un cliente nuevo) solo se escribe con el permiso de quien lo hace, y se comprueba en la base.
//
// Ya cubierto en otros archivos (no se repite aquí):
// - Pasar a alguien de Comercial a Observador y que «Nueva cotización» desaparezca al recargar:
//   e2e/member-management.spec.ts (primera prueba).
// - Quitar a alguien con la sesión abierta en otra pestaña («No encontrado» en su siguiente clic y la
//   cotización conserva su nombre): e2e/member-management.spec.ts (segunda prueba).
// - Invitar, aceptar con cuenta nueva o existente, correo distinto, invitación vencida:
//   e2e/team-invitations.spec.ts y e2e/team-accept-invitation.spec.ts.
import type { Browser, BrowserContext, Locator } from "@playwright/test";
import { MEMBER_ROLES, NO_PERMISSION_MESSAGE, ROLE_LABELS } from "../src/lib/permissions/matrix";
import type { MemberRole } from "../src/lib/permissions/matrix";
import { connect } from "../tests/db/helpers";
import type { PersonaKey } from "../tests/isolation/fixture";
import { TENANT_PAGES, concretePath } from "../tests/isolation/registry";
import { expect as baseExpect, randomTestIp, test, type Page } from "./fixtures";
import { loadFixture, stateFile } from "./isolation-support";

/** Quién hace de cada rol en la organización A de la fixture. */
const ROLE_PERSONA: Readonly<Record<MemberRole, PersonaKey>> = {
  owner: "ana",
  admin: "mixta",
  approver: "dario",
  sales: "sofia",
  viewer: "dante",
};

const ALL: readonly MemberRole[] = MEMBER_ROLES;
const MANAGERS: readonly MemberRole[] = ["owner", "admin"];
const WRITERS: readonly MemberRole[] = ["owner", "admin", "sales"];
const OWNER_ONLY: readonly MemberRole[] = ["owner"];

/**
 * Con el servidor de desarrollo cada pantalla se compila al abrirla por primera vez y, con otras pruebas
 * corriendo a la vez, una vuelta por toda la aplicación puede tardar varios minutos; con la app compilada
 * son segundos. Los tiempos son holgados a propósito: no esperan nada fijo, solo no se rinden antes de tiempo.
 */
const LONG_TEST_TIMEOUT_MS = 600_000;
const READY_TIMEOUT_MS = 30_000;
/** `expect` con espera holgada (ver arriba): sigue esperando por la condición, no por un tiempo fijo. */
const expect = baseExpect.configure({ timeout: READY_TIMEOUT_MS });

// ---------------------------------------------------------------------------------------------
// Qué roles abren cada pantalla (escrito a mano desde PROYECTO.md §5.2, no leído de la matriz: si la
// matriz cambiara sin querer, esta tabla lo delata). Quien no la abre ve «No tienes permiso para esto».
// Toda pantalla registrada en tests/isolation/registry.ts tiene que estar aquí: una pantalla nueva
// rompe la primera prueba hasta que alguien decida qué roles la ven.
// ---------------------------------------------------------------------------------------------
const PAGES: Readonly<Record<string, { who: readonly MemberRole[]; heading: string | RegExp }>> = {
  "/o/[tenantId]": { who: ALL, heading: "Inicio" },
  "/o/[tenantId]/catalogo": { who: ALL, heading: "Catálogo" },
  "/o/[tenantId]/catalogo/[itemId]": { who: ALL, heading: /^CANARIO-A-\w+ Servicio 1$/ },
  "/o/[tenantId]/clientes": { who: ALL, heading: "Clientes" },
  "/o/[tenantId]/clientes/nuevo": { who: WRITERS, heading: "Nuevo cliente" },
  "/o/[tenantId]/clientes/[customerId]": {
    who: ALL,
    heading: /^CANARIO-A-\w+ Cliente compartido$/,
  },
  "/o/[tenantId]/clientes/[customerId]/editar": { who: WRITERS, heading: "Editar cliente" },
  "/o/[tenantId]/configuracion": { who: MANAGERS, heading: "Configuración" },
  "/o/[tenantId]/configuracion/actividad": { who: OWNER_ONLY, heading: "Registro de actividad" },
  "/o/[tenantId]/configuracion/empresa": { who: MANAGERS, heading: "Tu empresa" },
  "/o/[tenantId]/configuracion/marca": { who: MANAGERS, heading: "Tu marca" },
  "/o/[tenantId]/configuracion/numeracion": {
    who: MANAGERS,
    heading: "Numeración de cotizaciones",
  },
  "/o/[tenantId]/configuracion/textos": { who: MANAGERS, heading: "Textos listos" },
  "/o/[tenantId]/configuracion/textos/nuevo": { who: MANAGERS, heading: "Nuevo texto" },
  "/o/[tenantId]/configuracion/textos/[snippetId]": { who: MANAGERS, heading: "Editar texto" },
  "/o/[tenantId]/cotizaciones": { who: ALL, heading: "Cotizaciones" },
  "/o/[tenantId]/equipo": { who: MANAGERS, heading: "Tu equipo" },
  "/o/[tenantId]/equipo/[memberId]": { who: MANAGERS, heading: /^Ana CANARIO-A-\w+/ },
  "/o/[tenantId]/cotizaciones/nueva": { who: WRITERS, heading: "Nueva cotización" },
  "/o/[tenantId]/cotizaciones/[quoteId]": { who: ALL, heading: /^AAA-\d{4}-\d+$/ },
  // El Dueño y los Administradores y Comercial abren la pantalla de enviar aunque el borrador no sea
  // suyo: ahí ven el aviso «Solo X puede enviar este borrador». El Aprobador y el Observador, no.
  "/o/[tenantId]/cotizaciones/[quoteId]/enviar": { who: WRITERS, heading: /^Enviar AAA-/ },
  "/o/[tenantId]/formularios": { who: ALL, heading: "Formularios" },
  "/o/[tenantId]/formularios/nuevo": { who: MANAGERS, heading: "Nuevo formulario" },
  "/o/[tenantId]/formularios/[formId]": { who: ALL, heading: /^Formulario CANARIO-A-/ },
  "/o/[tenantId]/solicitudes": { who: ALL, heading: "Solicitudes" },
  "/o/[tenantId]/solicitudes/[requestId]": { who: ALL, heading: /^Visitante CANARIO-A-/ },
  "/o/[tenantId]/solicitudes/[requestId]/convertir": {
    who: WRITERS,
    heading: "Crear cotización desde la solicitud",
  },
};

/** El menú de cada rol, en orden. «Equipo» y «Configuración» solo para quien maneja la organización. */
const COMMON_MENU = [
  "Inicio",
  "Cotizaciones",
  "Solicitudes",
  "Clientes",
  "Catálogo",
  "Formularios",
];
const MENU: Readonly<Record<MemberRole, readonly string[]>> = {
  owner: [...COMMON_MENU, "Equipo", "Configuración"],
  admin: [...COMMON_MENU, "Equipo", "Configuración"],
  approver: COMMON_MENU,
  sales: COMMON_MENU,
  viewer: COMMON_MENU,
};

/**
 * Botones y enlaces que cambian algo, en la pantalla donde viven, y qué roles los ven. Sirve en los dos
 * sentidos: quien debe verlos los ve, y quien no, no. (El borrador de la fixture es de Ana, así que los de
 * «editar la cotización» son solo de ella: el Dueño y el Administrador editan únicamente lo propio.)
 */
type Control = {
  page: string;
  label: string;
  find: (page: Page) => Locator;
  who: readonly MemberRole[];
};
const CONTROLS: readonly Control[] = [
  {
    page: "/o/[tenantId]/catalogo",
    label: "Agregar al catálogo",
    find: (page) => page.getByRole("button", { name: "Agregar al catálogo" }),
    who: MANAGERS,
  },
  {
    page: "/o/[tenantId]/catalogo/[itemId]",
    label: "Guardar cambios del servicio",
    find: (page) => page.getByRole("button", { name: "Guardar cambios" }),
    who: MANAGERS,
  },
  {
    page: "/o/[tenantId]/catalogo/[itemId]",
    label: "Desactivar servicio",
    find: (page) => page.getByRole("button", { name: "Desactivar servicio" }),
    who: MANAGERS,
  },
  {
    page: "/o/[tenantId]/clientes",
    label: "Nuevo cliente",
    find: (page) => page.getByRole("link", { name: "Nuevo cliente" }),
    who: WRITERS,
  },
  {
    page: "/o/[tenantId]/clientes/[customerId]",
    label: "Editar cliente",
    find: (page) => page.getByRole("link", { name: "Editar", exact: true }),
    who: WRITERS,
  },
  {
    page: "/o/[tenantId]/cotizaciones",
    label: "Nueva cotización",
    find: (page) => page.getByRole("link", { name: "Nueva cotización" }),
    who: WRITERS,
  },
  {
    page: "/o/[tenantId]/cotizaciones/[quoteId]",
    label: "Guardar cotización (borrador propio)",
    find: (page) => page.getByTestId("save-quote"),
    who: OWNER_ONLY,
  },
  {
    page: "/o/[tenantId]/cotizaciones/[quoteId]",
    label: "Enviar al cliente (borrador propio)",
    find: (page) => page.getByRole("link", { name: "Enviar al cliente" }),
    who: OWNER_ONLY,
  },
  {
    page: "/o/[tenantId]/formularios",
    label: "Crear formulario",
    find: (page) => page.getByTestId("new-form"),
    who: MANAGERS,
  },
  {
    page: "/o/[tenantId]/formularios/[formId]",
    label: "Guardar formulario",
    find: (page) => page.getByTestId("save-form"),
    who: MANAGERS,
  },
  {
    page: "/o/[tenantId]/formularios/[formId]",
    label: "Pausar formulario",
    find: (page) => page.getByTestId("pause-form"),
    who: MANAGERS,
  },
  {
    page: "/o/[tenantId]/solicitudes/[requestId]",
    label: "Asignar solicitud",
    find: (page) => page.getByTestId("assign-submit"),
    who: MANAGERS,
  },
  {
    page: "/o/[tenantId]/solicitudes/[requestId]",
    label: "Descartar solicitud",
    find: (page) => page.getByTestId("discard-open"),
    who: MANAGERS,
  },
  {
    page: "/o/[tenantId]/solicitudes/[requestId]",
    label: "Anonimizar datos",
    find: (page) => page.getByTestId("anonymize-open"),
    who: MANAGERS,
  },
  {
    // La solicitud de la fixture no tiene a nadie asignado: el Comercial puede convertirla.
    page: "/o/[tenantId]/solicitudes/[requestId]",
    label: "Crear cotización desde la solicitud",
    find: (page) => page.getByRole("link", { name: "Crear cotización" }),
    who: WRITERS,
  },
];

// ---------------------------------------------------------------------------------------------
// Ayudantes
// ---------------------------------------------------------------------------------------------

async function withDb<T>(fn: (db: import("pg").Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

function addressOf(pattern: string): string {
  const A = loadFixture().orgs.A;
  const route = TENANT_PAGES.find((r) => r.path === pattern);
  if (!route) throw new Error(`La pantalla ${pattern} no está en el registro de aislamiento`);
  return concretePath(
    route,
    A.tenantId,
    A.customerIds[0],
    A.catalogIds[0],
    A.quoteIds[0],
    A.intake!.formId,
    A.intake!.requestId,
    A.snippets!.emailId,
    A.ownerMemberId,
  );
}

/**
 * Abre la pantalla y espera a que termine de armarse. Next envía las partes lentas después del resto
 * (React las deja en un contenedor aparte, `S:n`, hasta revelarlas): si se mira justo al cargar, un botón
 * que sí existe puede no estar todavía y «no hay ningún botón» saldría bien por error. Por eso se espera
 * a que no quede ninguna parte pendiente antes de mirar si algo falta.
 */
async function openSettled(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status(), `${path}: debe responder 200`).toBe(200);
  await page.waitForFunction(
    () => document.querySelector('[id^="S:"], template[id^="B:"]') === null,
  );
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
}

const noPermission = (page: Page) => page.getByTestId("no-permission");
const firstHeading = (page: Page) => page.getByRole("heading", { level: 1 }).first();

async function personaContext(browser: Browser, persona: PersonaKey): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: test.info().project.use.baseURL,
    storageState: stateFile(persona),
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
}

/**
 * Lo que hay en la pantalla que cambia algo: botones, campos y enlaces de acción. Deja afuera lo que solo
 * mira o busca (búsquedas, «Copiar enlace», el tamaño de papel del PDF) y la vista previa del formulario
 * público, que es inerte (no se envía nada). Si la lista no está vacía, el rol ve algo que no debería.
 */
async function changeControls(page: Page): Promise<string[]> {
  return page
    .locator("main")
    .first()
    .evaluate((main) => {
      const preview = main.querySelector('[aria-labelledby="preview-title"]');
      const labelOf = (el: Element) =>
        (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim() ||
        el.getAttribute("name") ||
        el.id ||
        el.tagName.toLowerCase();
      const found: string[] = [];
      for (const el of main.querySelectorAll<HTMLInputElement>("button, input, textarea, select")) {
        // `:disabled` también cuenta lo que desactiva un `<fieldset disabled>` (el editor del formulario público).
        if (preview?.contains(el) || el.matches(":disabled") || el.type === "hidden") continue;
        const label = labelOf(el);
        const readOnly =
          el.type === "search" ||
          el.name === "q" ||
          el.id === "pdf-paper" ||
          (el.tagName === "BUTTON" && /^(Buscar|Copiar enlace)$/.test(label));
        if (!readOnly) found.push(`${el.tagName.toLowerCase()} «${label}»`);
      }
      for (const link of main.querySelectorAll("a[href]")) {
        const href = link.getAttribute("href") ?? "";
        const label = labelOf(link);
        if (
          /\/(nuevo|editar|enviar|convertir)(\?|$)/.test(href) ||
          /^(Nuev[ao]|Editar|Agregar|Crear|Enviar|Convertir)\b/.test(label)
        ) {
          found.push(`enlace «${label}»`);
        }
      }
      return found;
    });
}

type Replay = { url: string; headers: Record<string, string>; body: Buffer | null };

/**
 * Hace lo que hace la persona en la pantalla (`trigger`) pero intercepta el pedido de la acción del
 * servidor y lo aborta: no llega nada, y queda guardado para repetirlo con la sesión de otra persona
 * (el equivalente a forzar la acción por fuera de la pantalla).
 */
async function captureServerAction(page: Page, trigger: () => Promise<void>): Promise<Replay> {
  const box: { replay: Replay | null } = { replay: null };
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (!box.replay && request.method() === "POST" && request.headers()["next-action"]) {
      box.replay = {
        url: request.url(),
        headers: Object.fromEntries(
          Object.entries(request.headers()).filter(
            ([name]) => !["cookie", "content-length", "host"].includes(name.toLowerCase()),
          ),
        ),
        body: request.postDataBuffer(),
      };
      await route.abort();
      return;
    }
    await route.continue();
  });
  await trigger();
  await expect
    .poll(() => box.replay, { message: "la pantalla debía enviar la acción del servidor" })
    .not.toBeNull();
  await page.unroute("**/*");
  return box.replay as unknown as Replay;
}

async function sendReplay(context: BrowserContext, replay: Replay): Promise<string> {
  const response = await context.request.post(replay.url, {
    headers: replay.headers,
    data: replay.body ?? undefined,
    maxRedirects: 0,
  });
  return response.text();
}

const draftState = (quoteId: string) =>
  withDb(async (db) => {
    const { rows } = await db.query<{ revision: number; observations: string | null }>(
      "select revision, observations from public.quotes where id = $1",
      [quoteId],
    );
    return rows[0];
  });

// ---------------------------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------------------------

test("la tabla de pantallas por rol cubre todas las pantallas de la organización, ni una más ni una menos", () => {
  expect(Object.keys(PAGES).sort()).toEqual(TENANT_PAGES.map((route) => route.path).sort());
});

for (const role of MEMBER_ROLES) {
  test.describe(`${ROLE_LABELS[role]}`, () => {
    test.use({ storageState: stateFile(ROLE_PERSONA[role]) });

    test("el menú trae solo los destinos que le corresponden", async ({ page }) => {
      const A = loadFixture().orgs.A;
      await openSettled(page, `/o/${A.tenantId}`);
      const menu = page.locator('aside[aria-label="Menú lateral"] nav[aria-label="Principal"] a');
      await expect(menu).toHaveCount(MENU[role].length);
      const names = await menu.evaluateAll((links) =>
        links.map((link) => link.getAttribute("aria-label") ?? link.textContent ?? ""),
      );
      // La insignia de «Solicitudes» agrega «, 1 pendiente» al nombre: se compara el principio.
      expect(
        names.map((name, index) =>
          name.startsWith(MENU[role][index] ?? "\0") ? MENU[role][index] : name,
        ),
      ).toEqual([...MENU[role]]);
    });

    test("cada pantalla muestra su contenido o «No tienes permiso para esto», y sin datos cuando no corresponde", async ({
      page,
    }) => {
      test.setTimeout(LONG_TEST_TIMEOUT_MS);
      const fx = loadFixture();
      for (const route of TENANT_PAGES) {
        const spec = PAGES[route.path];
        const path = addressOf(route.path);
        await openSettled(page, path);
        const html = await page.content();
        // Nunca nada de otra organización, tenga el rol que tenga. (La Administradora también es miembro de
        // B, así que el nombre de B sí aparece en su selector de organizaciones: se descuenta.)
        const withoutSwitcher = html.replaceAll(fx.orgs.B.name, "");
        expect(withoutSwitcher, `${path}: datos de B`).not.toContain(fx.orgs.B.canary);
        expect(html, `${path}: datos de C`).not.toContain(fx.orgs.C.canary);
        if (spec.who.includes(role)) {
          await expect(noPermission(page), `${path}: debía abrir`).toHaveCount(0);
          await expect(firstHeading(page), `${path}: título`).toHaveText(spec.heading);
        } else {
          await expect(noPermission(page), `${path}: debía negar`).toBeVisible();
          await expect(firstHeading(page)).toHaveText("Sin permiso");
          await expect(page.getByText(NO_PERMISSION_MESSAGE)).toBeVisible();
          // Sin datos: ni el texto marcado de la propia organización A (ni de ninguna otra).
          expect(
            withoutSwitcher,
            `${path}: «No tienes permiso» no puede traer datos`,
          ).not.toContain("CANARIO-");
        }
      }
    });

    test("ve los botones de acción que le tocan y ninguno de los que no", async ({ page }) => {
      test.setTimeout(LONG_TEST_TIMEOUT_MS);
      const pages = [...new Set(CONTROLS.map((control) => control.page))];
      for (const pattern of pages) {
        await openSettled(page, addressOf(pattern));
        for (const control of CONTROLS.filter((c) => c.page === pattern)) {
          const target = control.find(page);
          if (control.who.includes(role)) {
            await expect(target, `${pattern}: «${control.label}» debía verse`).toBeVisible();
          } else {
            await expect(target, `${pattern}: «${control.label}» no debía verse`).toHaveCount(0);
          }
        }
      }
    });
  });
}

test.describe("Observador", () => {
  test.use({ storageState: stateFile(ROLE_PERSONA.viewer) });

  test("recorre toda la aplicación sin ver ni un botón, campo o enlace para cambiar algo", async ({
    page,
  }) => {
    test.setTimeout(LONG_TEST_TIMEOUT_MS);
    for (const route of TENANT_PAGES) {
      const path = addressOf(route.path);
      await openSettled(page, path);
      expect(
        await changeControls(page),
        `${path}: el Observador no debe poder cambiar nada`,
      ).toEqual([]);
    }
  });
});

test.describe("Dueña (control del detector)", () => {
  test.use({ storageState: stateFile(ROLE_PERSONA.owner) });

  test("el detector de controles para cambiar algo sí los encuentra donde existen", async ({
    page,
  }) => {
    // Si el detector no viera nada ni en las pantallas de la Dueña, «el Observador no ve ninguno» no
    // probaría nada.
    for (const pattern of [
      "/o/[tenantId]/catalogo",
      "/o/[tenantId]/clientes",
      "/o/[tenantId]/cotizaciones",
      "/o/[tenantId]/cotizaciones/[quoteId]",
      "/o/[tenantId]/formularios",
      "/o/[tenantId]/solicitudes/[requestId]",
    ]) {
      await openSettled(page, addressOf(pattern));
      expect(
        (await changeControls(page)).length,
        `${pattern}: debería haber controles`,
      ).toBeGreaterThan(0);
    }
  });
});

test.describe("Borrador de Ana (Dueña) visto por los demás roles", () => {
  test("Ana lo edita; todos los demás lo ven en solo lectura, con el motivo, y no pueden enviarlo", async ({
    browser,
  }) => {
    test.setTimeout(LONG_TEST_TIMEOUT_MS);
    const fx = loadFixture();
    const author = fx.personas.ana.fullName;
    const draft = addressOf("/o/[tenantId]/cotizaciones/[quoteId]");
    const send = addressOf("/o/[tenantId]/cotizaciones/[quoteId]/enviar");

    const ana = await personaContext(browser, "ana");
    try {
      const page = await ana.newPage();
      await openSettled(page, draft);
      await expect(page.getByTestId("quote-editor")).toBeVisible();
      await expect(page.getByTestId("save-quote")).toBeVisible();
      await expect(page.getByTestId("quote-read-only")).toHaveCount(0);
    } finally {
      await ana.close();
    }

    const cases: { persona: PersonaKey; reason: string }[] = [
      // El Administrador y el Comercial pueden editar cotizaciones, pero solo las suyas.
      { persona: "mixta", reason: `Solo ${author} puede editar este borrador. Tú puedes verlo.` },
      { persona: "sofia", reason: `Solo ${author} puede editar este borrador. Tú puedes verlo.` },
      // El Aprobador y el Observador no editan cotizaciones de nadie.
      { persona: "dario", reason: "Tu rol solo permite ver las cotizaciones." },
      { persona: "dante", reason: "Tu rol solo permite ver las cotizaciones." },
    ];
    for (const { persona, reason } of cases) {
      const context = await personaContext(browser, persona);
      try {
        const page = await context.newPage();
        await openSettled(page, draft);
        // Ven la cotización completa (todos ven todo dentro de su organización)...
        await expect(page.getByTestId("quote-read-only")).toBeVisible();
        await expect(page.getByTestId("quote-line")).toHaveCount(2);
        await expect(page.getByText(reason)).toBeVisible();
        // ...pero sin editor, sin guardar y sin enviar.
        await expect(page.getByTestId("quote-editor")).toHaveCount(0);
        await expect(page.getByTestId("save-quote")).toHaveCount(0);
        await expect(page.getByRole("link", { name: "Enviar al cliente" })).toHaveCount(0);

        // La pantalla de enviar: el Administrador y el Comercial la abren y se les dice por qué no
        // pueden; el Aprobador y el Observador ven «No tienes permiso».
        await openSettled(page, send);
        if (persona === "mixta" || persona === "sofia") {
          await expect(page.getByTestId("send-blocker")).toContainText(
            `Solo ${author} puede enviar este borrador. Tú puedes verlo.`,
          );
          await expect(page.getByTestId("send-submit")).toHaveCount(0);
        } else {
          await expect(noPermission(page)).toBeVisible();
          await expect(page.getByTestId("send-submit")).toHaveCount(0);
        }
      } finally {
        await context.close();
      }
    }
  });

  test("forzar el guardado del borrador de Ana con la sesión de otro rol se rechaza y no cambia nada; el de Ana sí se aplica", async ({
    browser,
  }) => {
    test.setTimeout(LONG_TEST_TIMEOUT_MS);
    const fx = loadFixture();
    const quoteId = fx.orgs.A.quoteIds[0];
    const marker = `FORZADO-GUARDADO ${fx.runId}`;
    const before = await draftState(quoteId);

    // Ana arma el pedido de guardar; se intercepta y no llega (queda el borrador intacto).
    const ana = await personaContext(browser, "ana");
    try {
      const anaPage = await ana.newPage();
      await openSettled(anaPage, addressOf("/o/[tenantId]/cotizaciones/[quoteId]"));
      await anaPage.getByLabel("Observaciones").fill(marker);
      const replay = await captureServerAction(anaPage, () =>
        anaPage.getByTestId("save-quote").click(),
      );
      expect(await draftState(quoteId)).toEqual(before);

      const cases: { persona: PersonaKey; message: string }[] = [
        // Ven «puede editar cotizaciones» en general; la base exige que sea el autor.
        { persona: "mixta", message: "Solo quien creó este borrador puede editarlo." },
        { persona: "sofia", message: "Solo quien creó este borrador puede editarlo." },
        // Sin permiso para editar cotizaciones: se corta antes de tocar la base.
        { persona: "dario", message: NO_PERMISSION_MESSAGE },
        { persona: "dante", message: NO_PERMISSION_MESSAGE },
      ];
      for (const { persona, message } of cases) {
        const context = await personaContext(browser, persona);
        try {
          await openSettled(await context.newPage(), addressOf("/o/[tenantId]"));
          const reply = await sendReplay(context, replay);
          expect(reply, `${persona}: debía rechazarse`).toContain('"status":"forbidden"');
          expect(reply, `${persona}: motivo`).toContain(message);
          expect(reply, `${persona}: no debía guardar`).not.toContain('"status":"saved"');
          expect(await draftState(quoteId), `${persona}: el borrador no debía cambiar`).toEqual(
            before,
          );
        } finally {
          await context.close();
        }
      }

      // Control: el mismo pedido, con la sesión de la autora, sí se aplica. Sin esto, un rechazo podría
      // deberse a un pedido mal armado y no al rol.
      const accepted = await sendReplay(ana, replay);
      expect(accepted).toContain('"status":"saved"');
      const after = await draftState(quoteId);
      expect(after.observations).toBe(marker);
      expect(after.revision).toBe(before.revision + 1);
    } finally {
      await ana.close();
    }
  });
});

test.describe("Crear un cliente por fuera de la pantalla", () => {
  test("el Aprobador y el Observador reciben «No tienes permiso» y no se crea nada; la Comercial sí lo crea", async ({
    browser,
  }) => {
    test.setTimeout(LONG_TEST_TIMEOUT_MS);
    const fx = loadFixture();
    const name = `ROLES cliente forzado ${fx.runId}`;
    const countCustomers = () =>
      withDb(async (db) => {
        const { rows } = await db.query<{ n: string }>(
          "select count(*)::text as n from public.customers where display_name = $1 and tenant_id = $2",
          [name, fx.orgs.A.tenantId],
        );
        return Number(rows[0].n);
      });

    const ana = await personaContext(browser, "ana");
    try {
      const anaPage = await ana.newPage();
      await openSettled(anaPage, addressOf("/o/[tenantId]/clientes/nuevo"));
      await anaPage.getByLabel(/^(Nombre|Razón social)/).fill(name);
      const replay = await captureServerAction(anaPage, () =>
        anaPage.getByRole("button", { name: "Guardar cliente" }).click(),
      );
      expect(await countCustomers()).toBe(0);

      for (const persona of ["dario", "dante"] as const) {
        const context = await personaContext(browser, persona);
        try {
          await openSettled(await context.newPage(), addressOf("/o/[tenantId]"));
          const reply = await sendReplay(context, replay);
          expect(reply, `${persona}: debía rechazarse`).toContain(NO_PERMISSION_MESSAGE);
          expect(await countCustomers(), `${persona}: no debía crear nada`).toBe(0);
        } finally {
          await context.close();
        }
      }

      // Control: la Comercial sí puede crear clientes, y el mismo pedido lo crea.
      const sofia = await personaContext(browser, "sofia");
      try {
        await openSettled(await sofia.newPage(), addressOf("/o/[tenantId]"));
        await sendReplay(sofia, replay);
        expect(await countCustomers()).toBe(1);
      } finally {
        await sofia.close();
      }
    } finally {
      await ana.close();
    }
  });
});
