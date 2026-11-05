import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { generateRut } from "../src/lib/chile/rut";
import { formatDate } from "../src/lib/format-date";
import { connect } from "../tests/db/helpers";
import {
  adminCreateUser,
  TEST_PASSWORD as ACCOUNT_PASSWORD,
} from "../tests/support/local-supabase";
import { expect, randomTestIp, test } from "./fixtures";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-010: el Dueño y los Administradores ven a su equipo, cambian el rol de un miembro (se aplica en su siguiente
// clic) y lo quitan (pierde el acceso en su siguiente clic aunque tenga la sesión abierta; lo que hizo se
// conserva). Nadie toca al Dueño ni a sí mismo. Los demás roles no ven nada. Todo es ficticio (@ejemplo.test) y
// cada prueba crea sus propias cuentas y su propia organización.

// El registro de cuentas bajo carga supera los 5 s de espera: este archivo corre en orden.
test.describe.configure({ mode: "serial" });

const MOBILE = { width: 375, height: 812 };
const NO_PERMISSION = "No tienes permiso para esto.";
const ROLE_PHRASES = {
  sales:
    "Arma y envía sus propias cotizaciones, registra clientes y atiende solicitudes. Lo demás lo ve sin cambiarlo.",
  viewer: "Ve todo lo de la organización, pero no cambia nada.",
};

async function withDb<T>(fn: (db: import("pg").Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

async function newContext(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": randomTestIp() } });
}

/** Una cuenta lista para ingresar (correo confirmado y términos aceptados), sin pasar por el registro. */
async function createAccount(label: string, fullName: string): Promise<string> {
  const email = uniqueEmail(label);
  const legal = await withDb((db) =>
    db.query<{ kind: string; version: string }>(
      "select kind, version from public.legal_documents where is_current",
    ),
  );
  await adminCreateUser(email, {
    full_name: fullName,
    accepted_legal: Object.fromEntries(legal.rows.map((row) => [row.kind, row.version])),
  });
  return email;
}

async function login(page: Page, email: string, tenantId: string) {
  await page.goto("/ingresar");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(ACCOUNT_PASSWORD);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}$`));
}

type Person = { email: string; name: string; memberId: string; userId: string; role: string };

/** Suma a la organización una cuenta nueva con ese rol (como lo haría una invitación aceptada). */
async function addPerson(tenantId: string, role: string, name: string): Promise<Person> {
  const email = await createAccount(`equipo-${role}`, name);
  return withDb(async (db) => {
    const { rows } = await db.query<{ id: string; user_id: string }>(
      `insert into public.members (tenant_id, user_id, role)
       select $1, id, $3 from auth.users where email = $2 returning id, user_id`,
      [tenantId, email, role],
    );
    return { email, name, memberId: rows[0].id, userId: rows[0].user_id, role };
  });
}

/** El Dueño se registra por la pantalla (el camino real) y crea su organización. */
async function startOrganization(page: Page, label: string) {
  const ownerEmail = uniqueEmail(`${label.toLowerCase()}-dueno`);
  const ownerName = `Dueña ${label}`;
  await signUpAndVerify(page, ownerEmail, ownerName);
  const tenantId = await createTenant(page, `Equipo ${label} Ltda`, generateRut());
  const ownerMemberId = await withDb(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `select m.id from public.members m join auth.users u on u.id = m.user_id
        where m.tenant_id = $1 and u.email = $2`,
      [tenantId, ownerEmail],
    );
    return rows[0].id;
  });
  return { ownerEmail, ownerName, tenantId, ownerMemberId };
}

const rowOf = (page: Page, person: { email: string }) =>
  page.getByTestId("member-row").filter({ hasText: person.email });
const roleDialog = (page: Page, person: Person) =>
  page.getByTestId(`member-role-${person.memberId}-dialog`);
const removeDialog = (page: Page, person: Person) =>
  page.getByTestId(`member-remove-${person.memberId}-dialog`);

async function openRoleDialog(page: Page, person: Person) {
  await rowOf(page, person).getByTestId("member-change-role").click();
  await expect(roleDialog(page, person)).toBeVisible();
}

const dbRole = (memberId: string) =>
  withDb(async (db) => {
    const { rows } = await db.query<{ role: string; status: string }>(
      "select role, status from public.members where id = $1",
      [memberId],
    );
    return rows[0];
  });

test("el Dueño ve a su equipo y cambia a una Comercial a Observadora: al recargar le desaparece «Nueva cotización»", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const { ownerName, ownerEmail, tenantId } = await startOrganization(page, "Roles");
  // Tres personas más para armar un equipo de cinco (no se usan por separado).
  await addPerson(tenantId, "admin", "Admin Uno");
  await addPerson(tenantId, "approver", "Aprobador Uno");
  const sales = await addPerson(tenantId, "sales", "Comercial Uno");
  await addPerson(tenantId, "viewer", "Observador Uno");

  // --- la lista: nombre, correo, rol con su frase, fecha de ingreso; el Dueño primero y sin acciones ---
  await page.goto(`/o/${tenantId}/equipo`);
  await expect(page.getByRole("heading", { name: "Tu equipo", level: 1 })).toBeVisible();
  await expect(page.getByTestId("member-row")).toHaveCount(5);
  await expect(page.getByTestId("member-count")).toHaveText("5");
  const ownerRow = page.getByTestId("member-row").first();
  await expect(ownerRow).toContainText(ownerName);
  await expect(ownerRow).toContainText("(tú)");
  await expect(ownerRow.getByTestId("member-role")).toHaveText("Dueño");
  await expect(ownerRow.getByTestId("member-change-role")).toHaveCount(0);
  await expect(ownerRow.getByTestId("member-remove")).toHaveCount(0);
  await expect(ownerRow.getByTestId("member-lock-note")).toContainText(
    "El Dueño no se puede cambiar ni quitar desde aquí.",
  );
  await expect(ownerRow.getByTestId("member-email")).toHaveText(ownerEmail);
  const salesRow = rowOf(page, sales);
  await expect(salesRow).toContainText(sales.name);
  await expect(salesRow.getByTestId("member-role")).toHaveText("Comercial");
  await expect(salesRow.getByTestId("member-role-description")).toHaveText(ROLE_PHRASES.sales);
  await expect(salesRow.getByTestId("member-joined")).toHaveText(
    `Ingresó el ${formatDate(new Date())}`,
  );
  await expect(page.getByTestId("member-change-role")).toHaveCount(4);
  await expect(page.getByTestId("member-remove")).toHaveCount(4);
  // El formulario de invitar y las invitaciones siguen ahí.
  await expect(page.getByTestId("invite-form")).toBeVisible();

  // --- la Comercial tiene «Nueva cotización» ---
  const salesContext = await newContext(browser, baseURL);
  try {
    const salesPage = await salesContext.newPage();
    await login(salesPage, sales.email, tenantId);
    await salesPage.goto(`/o/${tenantId}/cotizaciones`);
    await expect(salesPage.getByRole("link", { name: "Nueva cotización" })).toBeVisible();

    // --- el diálogo: los cuatro roles con su frase, el actual marcado; el mismo rol no se acepta ---
    await openRoleDialog(page, sales);
    const dialog = roleDialog(page, sales);
    await expect(dialog.getByRole("radio")).toHaveCount(4);
    await expect(dialog.getByText("Dueño")).toHaveCount(0);
    await expect(dialog.getByText(ROLE_PHRASES.viewer)).toBeVisible();
    await expect(dialog.getByTestId("member-role-option-sales")).toContainText("(rol actual)");
    await page.getByTestId(`member-role-${sales.memberId}-confirm`).click();
    await expect(dialog.getByText("Elige un rol distinto del actual.")).toBeVisible();
    expect((await dbRole(sales.memberId)).role).toBe("sales");

    // --- cambiar a Observador, con doble clic: se aplica una sola vez ---
    await dialog.getByTestId("member-role-option-viewer").click();
    await page.getByTestId(`member-role-${sales.memberId}-confirm`).dblclick();
    await expect(salesRow.getByTestId("member-role")).toHaveText("Observador");
    await expect(
      page.getByText("El rol ahora es Observador. Se aplica en su siguiente clic."),
    ).toBeVisible();
    await expect(roleDialog(page, sales)).toHaveCount(0);
    expect((await dbRole(sales.memberId)).role).toBe("viewer");

    // --- en su siguiente carga, la Comercial ya no puede crear cotizaciones ---
    await salesPage.reload();
    await expect(salesPage.getByRole("link", { name: "Nueva cotización" })).toHaveCount(0);
    await salesPage.goto(`/o/${tenantId}/cotizaciones/nueva`);
    await expect(salesPage.getByText(NO_PERMISSION)).toBeVisible();
  } finally {
    await salesContext.close();
  }

  // --- la base lo registró una sola vez, sin el correo de nadie ---
  await withDb(async (db) => {
    const audit = await db.query<{ details: Record<string, unknown>; actor_user_id: string }>(
      `select details, actor_user_id from public.audit_log
        where tenant_id = $1 and action = 'member.role_changed' and resource_id = $2`,
      [tenantId, sales.memberId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details).toEqual({
      old_role: "sales",
      new_role: "viewer",
      cancelled_invitations: 0,
    });
    expect(JSON.stringify(audit.rows[0])).not.toContain("@");
  });

  // --- el registro de actividad del Dueño lo cuenta en español ---
  await page.goto(`/o/${tenantId}/configuracion/actividad`);
  const changed = page
    .getByTestId("audit-row")
    .filter({ hasText: "Se cambió el rol de un miembro" });
  await expect(changed).toHaveCount(1);
  // Dice a QUIÉN afectó (sin correos, el registro es lo que se lo cuenta al Dueño), y nunca muestra un correo.
  await expect(changed).toContainText("Cambió el rol de Comercial Uno de Comercial a Observador");
  await expect(changed).toContainText("Miembro: Comercial Uno");
  await expect(changed).not.toContainText("@");

  // --- otra organización de la misma Dueña no ve esa frase ni a esa persona ---
  await page.goto("/organizaciones/nueva");
  const otherTenantId = await createTenant(page, "Otra Org Registro Ltda", generateRut());
  await page.goto(`/o/${otherTenantId}/configuracion/actividad`);
  await expect(page.getByTestId("audit-row").first()).toBeVisible();
  await expect(page.getByText("Comercial Uno")).toHaveCount(0);
  await expect(page.getByTestId("audit-row").filter({ hasText: "Cambió el rol de" })).toHaveCount(
    0,
  );
});

test("quitar a alguien con la sesión abierta: su siguiente clic le muestra «No encontrado» y su cotización conserva su nombre", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const { tenantId } = await startOrganization(page, "Quitar");
  const sales = await addPerson(tenantId, "sales", "Comercial Que Se Va");
  const other = await addPerson(tenantId, "viewer", "Observador Que Se Queda");

  // Una cotización de la Comercial, con un cliente (se monta directo en la base).
  const quoteDisplay = "COT-2026-8101";
  await withDb(async (db) => {
    const customer = await db.query<{ id: string }>(
      `insert into public.customers (id, tenant_id, kind, display_name)
       values ($1, $2, 'company', 'Cliente Que Queda Ltda') returning id`,
      [randomUUID(), tenantId],
    );
    await db.query(
      `insert into public.quotes
         (id, tenant_id, number_seq, number_scope, number_display, root_quote_id, customer_id,
          creation_key, tax_rate_bp, status, created_by,
          subtotal_taxable_clp, subtotal_clp, net_taxable_clp, tax_clp, total_clp)
       values ($1, $2, 8101, 'continuous', $3, $1, $4, gen_random_uuid(), 1900, 'draft', $5,
               100000, 100000, 100000, 19000, 119000)`,
      [randomUUID(), tenantId, quoteDisplay, customer.rows[0].id, sales.userId],
    );
  });

  const salesContext = await newContext(browser, baseURL);
  try {
    const salesPage = await salesContext.newPage();
    await login(salesPage, sales.email, tenantId);
    await salesPage.goto(`/o/${tenantId}/cotizaciones`);
    await expect(
      salesPage.getByTestId("quote-row").filter({ hasText: quoteDisplay }),
    ).toContainText("Comercial Que Se Va");

    // --- el Dueño la quita: el diálogo explica qué pasa ---
    await page.goto(`/o/${tenantId}/equipo`);
    await expect(page.getByTestId("member-row")).toHaveCount(3);
    await rowOf(page, sales).getByTestId("member-remove").click();
    const dialog = removeDialog(page, sales);
    await expect(dialog).toContainText("¿Quitar a Comercial Que Se Va del equipo?");
    await expect(dialog).toContainText("Perderá el acceso en su siguiente clic.");
    for (const phrase of [
      "Sus cotizaciones siguen existiendo con su nombre.",
      "Sus borradores quedan solo para leer.",
      "Las invitaciones que envió se cancelan.",
      "Sus solicitudes asignadas quedan sin responsable.",
    ]) {
      await expect(dialog.getByText(phrase)).toBeVisible();
    }
    // Cancelar no quita a nadie.
    await page.getByTestId(`member-remove-${sales.memberId}-cancel`).click();
    await expect(removeDialog(page, sales)).toHaveCount(0);
    expect((await dbRole(sales.memberId)).status).toBe("active");

    await rowOf(page, sales).getByTestId("member-remove").click();
    await page.getByTestId(`member-remove-${sales.memberId}-confirm`).click();
    await expect(rowOf(page, sales)).toHaveCount(0);
    await expect(page.getByTestId("member-row")).toHaveCount(2);
    await expect(
      page.getByText("La persona salió del equipo. Pierde el acceso en su siguiente clic."),
    ).toBeVisible();

    // --- en la otra sesión, que seguía abierta, el siguiente clic ya no encuentra nada ---
    await salesPage.getByRole("link", { name: "Clientes", exact: true }).first().click();
    await expect(salesPage.getByRole("heading", { name: "No encontrado" })).toBeVisible();
    await expect(salesPage.getByText("Cliente Que Queda Ltda")).toHaveCount(0);
    await salesPage.reload();
    await expect(salesPage.getByRole("heading", { name: "No encontrado" })).toBeVisible();
    await salesPage.goto(`/o/${tenantId}/cotizaciones`);
    await expect(salesPage.getByRole("heading", { name: "No encontrado" })).toBeVisible();
    await expect(salesPage.getByText(quoteDisplay)).toHaveCount(0);
  } finally {
    await salesContext.close();
  }

  // --- la cotización sigue existiendo y muestra el nombre de quien se fue ---
  await page.goto(`/o/${tenantId}/cotizaciones`);
  await expect(page.getByTestId("quote-row").filter({ hasText: quoteDisplay })).toContainText(
    "Comercial Que Se Va",
  );
  await withDb(async (db) => {
    const row = await db.query<{
      status: string;
      removed_by: string | null;
      removed_at: Date | null;
    }>("select status, removed_by, removed_at from public.members where id = $1", [sales.memberId]);
    expect(row.rows[0].status).toBe("removed");
    expect(row.rows[0].removed_by).not.toBeNull();
    expect(row.rows[0].removed_at).not.toBeNull();
    const quote = await db.query(
      "select 1 from public.quotes where tenant_id = $1 and number_display = $2",
      [tenantId, quoteDisplay],
    );
    expect(quote.rowCount).toBe(1);
  });

  // --- su borrador queda solo para leer, y el aviso dice la verdad: quien lo armó ya no está ---
  const quoteId = await withDb(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.quotes where tenant_id = $1 and number_display = $2",
      [tenantId, quoteDisplay],
    );
    return rows[0].id;
  });
  await page.goto(`/o/${tenantId}/cotizaciones/${quoteId}`);
  await expect(
    page.getByText("Quien armó este borrador ya no está en el equipo; queda solo para leer."),
  ).toBeVisible();
  await expect(page.getByText("Solo Comercial Que Se Va puede editar este borrador")).toHaveCount(
    0,
  );

  // --- su ficha ya no existe, y los demás siguen igual ---
  await page.goto(`/o/${tenantId}/equipo/${sales.memberId}`);
  await expect(page.getByRole("heading", { name: "No encontrado" })).toBeVisible();
  await page.goto(`/o/${tenantId}/equipo`);
  await expect(page.getByTestId("member-row")).toHaveCount(2);
  await expect(rowOf(page, other)).toBeVisible();

  // --- el registro de actividad lo cuenta en español ---
  await page.goto(`/o/${tenantId}/configuracion/actividad`);
  const removed = page
    .getByTestId("audit-row")
    .filter({ hasText: "Se quitó a un miembro del equipo" });
  await expect(removed).toHaveCount(1);
  await expect(removed).toContainText("Quitó a Comercial Que Se Va del equipo");
  await expect(removed).not.toContainText("@");
});

test("el Administrador no tiene acciones sobre el Dueño ni sobre sí mismo; los demás roles ven «No tienes permiso»; la ficha del miembro", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(420_000);
  const { tenantId, ownerEmail, ownerName, ownerMemberId } = await startOrganization(
    page,
    "Permisos",
  );
  const admin = await addPerson(tenantId, "admin", "Admin Permisos");
  const approver = await addPerson(tenantId, "approver", "Aprobador Permisos");
  const sales = await addPerson(tenantId, "sales", "Comercial Permisos");
  const viewer = await addPerson(tenantId, "viewer", "Observador Permisos");

  // Otra organización de la misma Dueña: su miembro no se ve desde esta (ni por la ficha).
  await page.goto("/organizaciones/nueva");
  const otherTenantId = await createTenant(page, "Otra Org Permisos Ltda", generateRut());
  const otherMemberId = await withDb(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.members where tenant_id = $1 and role = 'owner'",
      [otherTenantId],
    );
    return rows[0].id;
  });

  // --- Aprobador, Comercial y Observador: sin permiso, por la lista y por la ficha, sin ver a nadie ---
  for (const person of [approver, sales, viewer]) {
    const context = await newContext(browser, baseURL);
    try {
      const memberPage = await context.newPage();
      await login(memberPage, person.email, tenantId);
      await expect(memberPage.getByRole("link", { name: "Equipo", exact: true })).toHaveCount(0);
      for (const path of [`equipo`, `equipo/${sales.memberId}`, `equipo/${ownerMemberId}`]) {
        await memberPage.goto(`/o/${tenantId}/${path}`);
        await expect(memberPage.getByText(NO_PERMISSION)).toBeVisible();
        await expect(memberPage.getByTestId("member-row")).toHaveCount(0);
        await expect(memberPage.getByTestId("member-card")).toHaveCount(0);
        await expect(memberPage.getByText(ownerEmail)).toHaveCount(0);
        await expect(memberPage.getByText(ownerName)).toHaveCount(0);
      }
    } finally {
      await context.close();
    }
  }

  // --- el Administrador: acciones sobre otros, ninguna sobre el Dueño ni sobre sí mismo ---
  const adminContext = await newContext(browser, baseURL);
  try {
    const adminPage = await adminContext.newPage();
    await login(adminPage, admin.email, tenantId);
    await adminPage.goto(`/o/${tenantId}/equipo`);
    await expect(adminPage.getByTestId("member-row")).toHaveCount(5);
    const ownerRow = adminPage.getByTestId("member-row").filter({ hasText: ownerEmail });
    await expect(ownerRow.getByTestId("member-role")).toHaveText("Dueño");
    await expect(ownerRow.getByTestId("member-change-role")).toHaveCount(0);
    await expect(ownerRow.getByTestId("member-remove")).toHaveCount(0);
    const ownRow = rowOf(adminPage, admin);
    await expect(ownRow).toContainText("(tú)");
    await expect(ownRow.getByTestId("member-change-role")).toHaveCount(0);
    await expect(ownRow.getByTestId("member-remove")).toHaveCount(0);
    await expect(ownRow.getByTestId("member-lock-note")).toContainText(
      "No puedes cambiar tu propio rol",
    );
    for (const person of [approver, sales, viewer]) {
      await expect(rowOf(adminPage, person).getByTestId("member-change-role")).toBeVisible();
      await expect(rowOf(adminPage, person).getByTestId("member-remove")).toBeVisible();
    }

    // --- la ficha del Dueño y la propia: sin botones; las de otros, con ellos ---
    await adminPage.goto(`/o/${tenantId}/equipo/${ownerMemberId}`);
    await expect(adminPage.getByTestId("member-title")).toHaveText(ownerName);
    await expect(adminPage.getByTestId("member-lock-note")).toBeVisible();
    await expect(adminPage.getByTestId("member-change-role")).toHaveCount(0);
    await adminPage.goto(`/o/${tenantId}/equipo/${admin.memberId}`);
    await expect(adminPage.getByTestId("member-title")).toContainText("(tú)");
    await expect(adminPage.getByTestId("member-remove")).toHaveCount(0);

    // --- un miembro de otra organización, un id inventado o uno mal escrito: «No encontrado» ---
    for (const bad of [otherMemberId, randomUUID(), "no-es-un-id"]) {
      await adminPage.goto(`/o/${tenantId}/equipo/${bad}`);
      await expect(adminPage.getByRole("heading", { name: "No encontrado" })).toBeVisible();
      await expect(adminPage.getByTestId("member-card")).toHaveCount(0);
    }

    // --- la ficha de un miembro: sus datos y las mismas acciones; quitarlo lleva de vuelta a la lista ---
    await adminPage.goto(`/o/${tenantId}/equipo`);
    await rowOf(adminPage, viewer).getByTestId("member-name").click();
    await expect(adminPage).toHaveURL(new RegExp(`/o/${tenantId}/equipo/${viewer.memberId}$`));
    await expect(adminPage.getByTestId("member-title")).toHaveText(viewer.name);
    await expect(adminPage.getByTestId("member-card").getByTestId("member-email")).toHaveText(
      viewer.email,
    );
    await expect(adminPage.getByTestId("member-card")).toContainText(ROLE_PHRASES.viewer);
    await expect(adminPage.getByTestId("member-joined")).toHaveText(
      `Ingresó el ${formatDate(new Date())}`,
    );
    await adminPage.getByTestId("member-change-role").click();
    await adminPage.getByTestId(`member-role-${viewer.memberId}-cancel`).click();
    await adminPage.getByTestId("member-remove").click();
    await adminPage.getByTestId(`member-remove-${viewer.memberId}-confirm`).click();
    await expect(adminPage).toHaveURL(new RegExp(`/o/${tenantId}/equipo$`));
    await expect(adminPage.getByTestId("member-row")).toHaveCount(4);
    await expect(rowOf(adminPage, viewer)).toHaveCount(0);
    expect((await dbRole(viewer.memberId)).status).toBe("removed");

    // --- un Administrador puede cambiar el rol de otro: aquí, sube a la Comercial. Primero se captura la petición
    //     (sin dejarla salir) para repetirla con la sesión de un Aprobador ---
    type Replay = { url: string; headers: Record<string, string>; body: Buffer | null };
    let replay: Replay | null = null;
    await adminPage.route("**/*", async (route) => {
      const request = route.request();
      if (!replay && request.method() === "POST" && request.headers()["next-action"]) {
        replay = {
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
    await openRoleDialog(adminPage, sales);
    await roleDialog(adminPage, sales).getByTestId("member-role-option-admin").click();
    await adminPage.getByTestId(`member-role-${sales.memberId}-confirm`).click();
    await expect(roleDialog(adminPage, sales)).toContainText("Revisa tu conexión");
    await adminPage.unroute("**/*");
    expect(replay).not.toBeNull();
    expect((await dbRole(sales.memberId)).role).toBe("sales");

    // La misma petición, con la sesión del Aprobador: rechazada, sin base de por medio y sin efecto.
    const approverContext = await newContext(browser, baseURL);
    try {
      const approverPage = await approverContext.newPage();
      await login(approverPage, approver.email, tenantId);
      const captured = replay as unknown as Replay;
      const response = await approverContext.request.post(captured.url, {
        headers: captured.headers,
        data: captured.body ?? undefined,
      });
      expect(await response.text()).toContain(NO_PERMISSION);
      expect((await dbRole(sales.memberId)).role).toBe("sales");
    } finally {
      await approverContext.close();
    }

    // Con la sesión del Administrador, la misma acción sí se aplica.
    await adminPage.getByTestId(`member-role-${sales.memberId}-confirm`).click();
    await expect(rowOf(adminPage, sales).getByTestId("member-role")).toHaveText("Administrador");
  } finally {
    await adminContext.close();
  }

  expect((await dbRole(sales.memberId)).role).toBe("admin");
});

test("en teléfono la lista y los diálogos caben sin desplazarse y con botones de 44 px; sin conexión el aviso sale en el diálogo y no se pierde lo elegido", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  const { tenantId } = await startOrganization(page, "Telefono");
  const sales = await addPerson(tenantId, "sales", "Comercial Telefono");

  await page.setViewportSize(MOBILE);
  await page.goto(`/o/${tenantId}/equipo`);
  await expect(page.getByTestId("member-row")).toHaveCount(2);
  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  expect(await overflow()).toBeLessThanOrEqual(0);
  const salesRow = rowOf(page, sales);
  for (const testId of ["member-change-role", "member-remove"]) {
    const target = salesRow.getByTestId(testId);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    expect(box?.height ?? 0, testId).toBeGreaterThanOrEqual(44);
  }

  // El diálogo de cambiar el rol, en el teléfono.
  await openRoleDialog(page, sales);
  expect(await overflow()).toBeLessThanOrEqual(0);
  const option = roleDialog(page, sales).getByTestId("member-role-option-viewer");
  expect((await option.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await option.click();

  // --- sin conexión: el aviso sale en el mismo diálogo, lo elegido sigue marcado y no se cambia nada ---
  await context.setOffline(true);
  await expect(roleDialog(page, sales).getByTestId("offline-notice")).toBeVisible();
  await page.getByTestId(`member-role-${sales.memberId}-confirm`).click();
  await expect(roleDialog(page, sales)).toContainText("Revisa tu conexión");
  await expect(roleDialog(page, sales).getByRole("radio", { name: /Observador/ })).toBeChecked();
  expect((await dbRole(sales.memberId)).role).toBe("sales");

  // --- al volver la conexión, el mismo diálogo funciona ---
  await context.setOffline(false);
  await expect(roleDialog(page, sales).getByTestId("offline-notice")).toHaveCount(0);
  await page.getByTestId(`member-role-${sales.memberId}-confirm`).click();
  await expect(rowOf(page, sales).getByTestId("member-role")).toHaveText("Observador");
  expect((await dbRole(sales.memberId)).role).toBe("viewer");
});

test("dos pestañas cambiando el mismo rol: la segunda recibe el aviso «El rol cambió» y no pisa el cambio", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  const { tenantId } = await startOrganization(page, "Pestanas");
  const sales = await addPerson(tenantId, "sales", "Comercial Pestañas");

  await page.goto(`/o/${tenantId}/equipo`);
  const second = await context.newPage();
  await second.goto(`/o/${tenantId}/equipo`);
  await expect(rowOf(second, sales).getByTestId("member-role")).toHaveText("Comercial");

  // La primera pestaña cambia a Observador.
  await openRoleDialog(page, sales);
  await roleDialog(page, sales).getByTestId("member-role-option-viewer").click();
  await page.getByTestId(`member-role-${sales.memberId}-confirm`).click();
  await expect(rowOf(page, sales).getByTestId("member-role")).toHaveText("Observador");

  // La segunda todavía cree que es Comercial e intenta pasarla a Aprobador.
  await openRoleDialog(second, sales);
  await roleDialog(second, sales).getByTestId("member-role-option-approver").click();
  await second.getByTestId(`member-role-${sales.memberId}-confirm`).click();
  await expect(roleDialog(second, sales)).toContainText("El rol cambió mientras lo editabas");
  await expect(roleDialog(second, sales).getByRole("radio", { name: /Aprobador/ })).toBeChecked();
  expect((await dbRole(sales.memberId)).role).toBe("viewer");

  // Quitarla con el rol viejo también se rechaza.
  await second.getByTestId(`member-role-${sales.memberId}-cancel`).click();
  await rowOf(second, sales).getByTestId("member-remove").click();
  await second.getByTestId(`member-remove-${sales.memberId}-confirm`).click();
  await expect(removeDialog(second, sales)).toContainText("El rol cambió mientras lo editabas");
  expect((await dbRole(sales.memberId)).status).toBe("active");

  // Al recargar ve cómo quedó.
  await second.reload();
  await expect(rowOf(second, sales).getByTestId("member-role")).toHaveText("Observador");
});
