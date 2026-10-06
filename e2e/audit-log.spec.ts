import { generateRut } from "../src/lib/chile/rut";
import { connect } from "../tests/db/helpers";
import { expect, randomTestIp, test } from "./fixtures";
import { TEST_PASSWORD, createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-014: el Dueño ve quién hizo cada acción sensible; nadie más, y solo la propia organización.

async function withDb<T>(fn: (db: import("pg").Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

test("el Dueño ve y filtra el registro; no se puede editar; otros roles y otras organizaciones no lo ven", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const ownerEmail = uniqueEmail("audit-dueno");
  const memberEmail = uniqueEmail("audit-miembro");
  const otherOwnerEmail = uniqueEmail("audit-otro");

  await signUpAndVerify(page, ownerEmail, "Dueña Registro");
  const tenantId = await createTenant(page, "Registro Actividad Ltda", generateRut());

  const newContext = () =>
    browser.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": randomTestIp() } });

  // Un miembro Comercial que luego pasa a Administrador, y que ingresa a la plataforma
  const memberSetup = await newContext();
  try {
    await signUpAndVerify(await memberSetup.newPage(), memberEmail, "Miembro Registro");
  } finally {
    await memberSetup.close();
  }
  await withDb(async (db) => {
    await db.query(
      `insert into public.members (tenant_id, user_id, role)
       select $1, id, 'sales' from auth.users where email = $2`,
      [tenantId, memberEmail],
    );
    await db.query(
      `update public.members set role = 'admin'
       where tenant_id = $1 and user_id = (select id from auth.users where email = $2)`,
      [tenantId, memberEmail],
    );
  });
  const memberContext = await newContext();
  const memberPage = await memberContext.newPage();
  try {
    await memberPage.goto("/ingresar");
    await memberPage.getByLabel("Correo").fill(memberEmail);
    await memberPage.getByLabel("Contraseña").fill(TEST_PASSWORD);
    await memberPage.getByRole("button", { name: "Ingresar" }).click();
    await expect(memberPage).toHaveURL(new RegExp(`/o/${tenantId}$`));

    // El Administrador ve el índice de configuración sin el registro, y la pantalla no existe para él
    await memberPage.goto(`/o/${tenantId}/configuracion`);
    await expect(
      memberPage.getByRole("heading", { name: "Configuración", level: 1 }),
    ).toBeVisible();
    await expect(memberPage.getByRole("link", { name: /Registro de actividad/ })).toHaveCount(0);
    await memberPage.goto(`/o/${tenantId}/configuracion/actividad`);
    await expect(memberPage.getByRole("heading", { name: "No encontrado" })).toBeVisible();
  } finally {
    await memberContext.close();
  }

  // El Dueño llega desde Configuración
  await page.goto(`/o/${tenantId}/configuracion`);
  await page.getByRole("link", { name: /Registro de actividad/ }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/configuracion/actividad$`));
  await expect(
    page.getByRole("heading", { name: "Registro de actividad", level: 1 }),
  ).toBeVisible();

  // Fecha y hora, quién, qué hizo y sobre qué
  const rows = page.getByTestId("audit-row");
  const created = rows.filter({ hasText: "Se creó la organización" });
  await expect(created).toHaveCount(1);
  await expect(created).toContainText("Dueña Registro");
  await expect(created).toContainText("Organización");
  await expect(created).toContainText(/\d{2}-\d{2}-\d{4} \d{2}:\d{2}/);
  await expect(rows.filter({ hasText: "Se sumó un miembro" })).toHaveCount(2);
  const roleChange = rows.filter({ hasText: "Rol: Comercial → Administrador" });
  await expect(roleChange).toHaveCount(1);
  await expect(roleChange).toContainText("Cambió un miembro");
  await expect(roleChange).toContainText("El sistema");
  const logins = rows.filter({ hasText: "Ingresó a la plataforma" });
  await expect(logins).toHaveCount(1);
  await expect(logins).toContainText("Miembro Registro");

  // Filtrar por tipo de acción
  await page.getByLabel("Tipo de acción").selectOption("member.updated");
  await page.getByRole("button", { name: "Filtrar", exact: true }).click();
  await expect(page).toHaveURL(/accion=member\.updated/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Cambió un miembro");

  // Filtrar por persona: solo lo que hizo esa persona
  await page.getByRole("link", { name: "Limpiar filtros" }).click();
  await expect(page.getByLabel("Tipo de acción")).toHaveValue("");
  await expect(page.getByLabel("Persona")).toHaveValue("");
  await page.getByLabel("Persona").selectOption({ label: "Miembro Registro" });
  await page.getByRole("button", { name: "Filtrar", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Ingresó a la plataforma");
  await expect(rows.first()).toContainText("Miembro Registro");

  // Combinados, sin coincidencias
  await page.getByLabel("Tipo de acción").selectOption("member.updated");
  await page.getByRole("button", { name: "Filtrar", exact: true }).click();
  await expect(page.getByTestId("no-results")).toBeVisible();
  await page.getByRole("link", { name: "Limpiar filtros" }).click();
  await expect(page.getByLabel("Tipo de acción")).toHaveValue("");
  await expect(page.getByLabel("Persona")).toHaveValue("");
  await expect(rows.first()).toBeVisible();

  // Nadie edita ni borra: la pantalla no ofrece ninguna acción, y la base lo rechaza
  await expect(page.getByRole("button", { name: /Editar|Borrar|Eliminar|Quitar/ })).toHaveCount(0);
  await withDb(async (db) => {
    await expect(
      db.query(`update public.audit_log set action = 'x.y' where tenant_id = $1`, [tenantId]),
    ).rejects.toThrow(/append-only|no se puede|forbid/i);
    await expect(
      db.query(`delete from public.audit_log where tenant_id = $1`, [tenantId]),
    ).rejects.toThrow(/append-only/i);
  });

  // Paginación: de a 25 registros
  await withDb((db) =>
    db.query(
      `insert into public.audit_log (tenant_id, actor_type, action, resource_type, result, occurred_at)
       select $1, 'system', 'customer.updated', 'customer', 'success', now() - make_interval(mins => g)
       from generate_series(1, 30) g`,
      [tenantId],
    ),
  );
  await page.goto(`/o/${tenantId}/configuracion/actividad`);
  await expect(rows).toHaveCount(25);
  await expect(page.getByTestId("page-status")).toContainText("Página 1 de 2");
  await page.getByRole("link", { name: "Siguiente" }).click();
  await expect(page).toHaveURL(/pagina=2/);
  await expect(page.getByTestId("page-status")).toContainText("Página 2 de 2");

  // Otra organización: su Dueño ve solo lo suyo y la pantalla de esta no existe para él
  const otherContext = await newContext();
  const otherPage = await otherContext.newPage();
  try {
    await signUpAndVerify(otherPage, otherOwnerEmail, "Otra Dueña");
    const otherTenantId = await createTenant(otherPage, "Otra Organización Ltda", generateRut());
    await otherPage.goto(`/o/${otherTenantId}/configuracion/actividad`);
    const otherRows = otherPage.getByTestId("audit-row");
    await expect(otherRows.filter({ hasText: "Se creó la organización" })).toHaveCount(1);
    await expect(otherRows.filter({ hasText: "Cambió un miembro" })).toHaveCount(0);
    await expect(otherRows.filter({ hasText: "Ingresó a la plataforma" })).toHaveCount(0);
    await expect(otherPage.getByText("Miembro Registro")).toHaveCount(0);
    await expect(otherPage.getByText("Dueña Registro")).toHaveCount(0);
    // Filtrar por una persona de la otra organización no trae nada
    const memberId = await withDb(
      async (db) =>
        (
          await db.query<{ id: string }>("select id from auth.users where email = $1", [
            memberEmail,
          ])
        ).rows[0].id,
    );
    await otherPage.goto(`/o/${otherTenantId}/configuracion/actividad?persona=${memberId}`);
    await expect(otherPage.getByTestId("no-results")).toBeVisible();
    await otherPage.goto(`/o/${tenantId}/configuracion/actividad`);
    await expect(otherPage.getByRole("heading", { name: "No encontrado" })).toBeVisible();
  } finally {
    await otherContext.close();
  }

  // Teléfono: tarjetas y sin desplazamiento horizontal
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/o/${tenantId}/configuracion/actividad`);
  await expect(page.getByTestId("audit-cards").locator("li").first()).toBeVisible();
  await expect(page.getByTestId("audit-table")).toBeHidden();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
