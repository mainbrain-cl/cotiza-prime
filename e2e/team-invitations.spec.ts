import { createHash } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { generateRut } from "../src/lib/chile/rut";
import { formatDate } from "../src/lib/format-date";
import { connect } from "../tests/db/helpers";
import { expect, randomTestIp, test } from "./fixtures";
import { TEST_PASSWORD, createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-008: el Dueño invita a una persona por correo con un rol, ve la invitación pendiente, la reenvía y la
// cancela; el correo llega a Mailpit con el enlace; un Comercial no ve «Tu equipo» ni puede ejecutar la
// acción. Todo es ficticio (correos @ejemplo.test). Los correos salen a Mailpit local (EMAIL_PROVIDER=mailpit).

// Con dos pruebas a la vez, el registro de cuentas supera los 5 s de espera: este archivo corre en orden.
test.describe.configure({ mode: "serial" });

const MAILBOX_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:56324";
const MOBILE = { width: 375, height: 812 };
const MS_PER_DAY = 86_400_000;
const INVITATION_DAYS = 7;
const ROLE_PHRASES = {
  admin: "Configura la organización, maneja el equipo, aprueba cotizaciones y confirma pagos.",
  approver: "Revisa y aprueba las cotizaciones antes de que salgan. No configura ni toca pagos.",
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

type MailDetail = { ID: string; HTML: string; Text: string; Subject: string };

async function mailsAll(address: string): Promise<MailDetail[]> {
  const search = await fetch(
    `${MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
  );
  const { messages } = (await search.json()) as { messages?: { ID: string }[] };
  const details: MailDetail[] = [];
  for (const { ID } of [...(messages ?? [])].reverse()) {
    details.push((await (await fetch(`${MAILBOX_URL}/api/v1/message/${ID}`)).json()) as MailDetail);
  }
  return details;
}

/** Solo las invitaciones: quien se registró en la prueba también recibió el correo de verificación. */
async function mailsTo(address: string): Promise<MailDetail[]> {
  return (await mailsAll(address)).filter((mail) => mail.Subject.includes("te invitó a"));
}

/** Espera `count` correos a esa dirección y devuelve todos, del más viejo al más nuevo. */
async function waitForMails(address: string, count: number): Promise<MailDetail[]> {
  let found: MailDetail[] = [];
  await expect
    .poll(
      async () => {
        found = await mailsTo(address);
        return found.length;
      },
      { message: `Esperaba ${count} correo(s) a ${address}`, timeout: 30_000 },
    )
    .toBe(count);
  return found;
}

function inviteLink(mail: MailDetail): { link: string; token: string } {
  const match = /href="(https?:\/\/[^"]*\/invitacion\/([A-Za-z0-9_-]{43}))"/.exec(mail.HTML);
  if (!match) throw new Error("El correo no trae el enlace de la invitación");
  return { link: match[1], token: match[2] };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function login(page: Page, email: string, tenantId: string) {
  await page.goto("/ingresar");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}$`));
}

async function newContext(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": randomTestIp() } });
}

/** Rellena el formulario de invitar y lo envía. */
async function invite(page: Page, email: string, role: keyof typeof ROLE_PHRASES) {
  await page.getByTestId("invite-email").fill(email);
  await page.getByTestId(`invite-role-${role}`).click();
  await page.getByTestId("invite-submit").click();
}

const rowOf = (page: Page, email: string) =>
  page.getByTestId("invitation-row").filter({ hasText: email });

test("el Dueño invita con un rol, la invitación queda pendiente, llega el correo con el enlace, se reenvía y se cancela", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const ownerEmail = uniqueEmail("equipo-dueno");
  const salesEmail = uniqueEmail("equipo-comercial");
  const invitee = uniqueEmail("equipo-invitada");
  const existingElsewhere = uniqueEmail("equipo-con-cuenta");

  await signUpAndVerify(page, ownerEmail, "Dueña Equipo");
  const tenantId = await createTenant(page, "Equipo Invitaciones Ltda", generateRut());

  // Un Comercial y una persona con cuenta que NO es de esta organización (para comparar respuestas).
  for (const [email, name] of [
    [salesEmail, "Comercial Equipo"],
    [existingElsewhere, "Con Cuenta Aparte"],
  ] as const) {
    const context = await newContext(browser, baseURL);
    try {
      await signUpAndVerify(await context.newPage(), email, name);
    } finally {
      await context.close();
    }
  }
  await withDb((db) =>
    db.query(
      `insert into public.members (tenant_id, user_id, role)
       select $1, id, 'sales' from auth.users where email = $2`,
      [tenantId, salesEmail],
    ),
  );

  // --- «Tu equipo» desde el menú, con su estado vacío y la frase de cada rol ANTES de elegir ---
  await page.goto(`/o/${tenantId}`);
  await page.getByRole("link", { name: "Equipo", exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/equipo$`));
  await expect(page.getByRole("heading", { name: "Tu equipo", level: 1 })).toBeVisible();
  await expect(page.getByText("No hay invitaciones pendientes")).toBeVisible();
  for (const phrase of Object.values(ROLE_PHRASES)) {
    await expect(page.getByTestId("invite-form").getByText(phrase)).toBeVisible();
  }
  // Los cuatro roles que se pueden dar; el Dueño no es una opción.
  await expect(page.getByTestId("invite-form").getByRole("radio")).toHaveCount(4);
  await expect(page.getByTestId("invite-form").getByText("Dueño")).toHaveCount(0);

  // --- validación: sin rol y con un correo roto ---
  await page.getByTestId("invite-email").fill("esto-no-es-un-correo");
  await page.getByTestId("invite-submit").click();
  await expect(page.getByText("Revisa el correo: no parece una dirección válida.")).toBeVisible();
  await expect(page.getByText("Elige el rol.")).toBeVisible();

  // --- invitar con rol Comercial (se captura la petición para repetirla después como Comercial) ---
  await page.getByTestId("invite-email").fill(invitee.toUpperCase());
  await page.getByTestId("invite-role-sales").click();
  const actionRequest = page.waitForRequest(
    (request) => request.method() === "POST" && !!request.headers()["next-action"],
  );
  await page.getByTestId("invite-submit").click();
  const captured = await actionRequest;
  const replay = {
    url: captured.url(),
    headers: Object.fromEntries(
      Object.entries(captured.headers()).filter(
        ([name]) => !["cookie", "content-length", "host"].includes(name.toLowerCase()),
      ),
    ),
    body: captured.postDataBuffer(),
  };

  await expect(page.getByText(`Enviamos la invitación a ${invitee}.`)).toBeVisible();
  const row = rowOf(page, invitee);
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("invitation-role")).toHaveText("Comercial");
  await expect(row.getByTestId("invitation-status")).toContainText("Enviada");
  const expectedExpiry = formatDate(new Date(Date.now() + INVITATION_DAYS * MS_PER_DAY));
  await expect(row.getByTestId("invitation-expiry")).toHaveText(`Vence el ${expectedExpiry}`);
  await expect(row).toContainText("Invitó Dueña Equipo");
  await expect(row.getByTestId("invitation-created")).toHaveText(
    `Invitada el ${formatDate(new Date())}`,
  );
  // El formulario quedó limpio para la siguiente invitación.
  await expect(page.getByTestId("invite-email")).toHaveValue("");

  // --- el correo: asunto, organización, rol con su frase, vencimiento y un enlace /invitacion/{código} ---
  const [firstMail] = await waitForMails(invitee, 1);
  expect(firstMail.Subject).toBe(
    "Dueña Equipo te invitó a Equipo Invitaciones Ltda en Cotiza Prime",
  );
  for (const body of [firstMail.HTML, firstMail.Text]) {
    expect(body).toContain("Equipo Invitaciones Ltda");
    expect(body).toContain("con el rol de Comercial");
    expect(body).toContain(ROLE_PHRASES.sales);
    expect(body).toContain(expectedExpiry);
  }
  const first = inviteLink(firstMail);
  expect(first.link.startsWith(`${baseURL}/invitacion/`)).toBe(true);
  // La base guarda solo la huella del código del enlace; el código mismo no está en ninguna parte.
  await withDb(async (db) => {
    const { rows } = await db.query<{ token_sha256: string; status: string; role: string }>(
      "select token_sha256, status, role from public.invitations where tenant_id = $1",
      [tenantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].token_sha256).toBe(sha256(first.token));
    expect(rows[0].role).toBe("sales");
    const leaks = await db.query(
      `select 1 from public.audit_log where tenant_id = $1
         and (details::text ilike '%' || $2 || '%' or details::text like '%' || $3 || '%')`,
      [tenantId, invitee.split("@")[0], first.token],
    );
    expect(leaks.rowCount).toBe(0);
    const mailRow = await db.query<{ status: string; provider: string }>(
      "select status, provider from public.email_messages where tenant_id = $1 and kind = 'invitation'",
      [tenantId],
    );
    expect(mailRow.rows).toEqual([{ status: "sent", provider: "mailpit" }]);
  });

  // --- repetir el mismo correo: se avisa, no se duplica ---
  await invite(page, invitee, "viewer");
  await expect(page.getByText("Ya hay una invitación pendiente para ese correo.")).toBeVisible();
  await expect(page.getByTestId("invitation-row")).toHaveCount(1);

  // --- invitar a un miembro actual ---
  await invite(page, salesEmail, "viewer");
  await expect(page.getByText("Esa persona ya es parte de tu equipo.")).toBeVisible();

  // --- con cuenta en otra parte o sin cuenta: la respuesta es la misma ---
  await invite(page, existingElsewhere, "approver");
  await expect(page.getByText(`Enviamos la invitación a ${existingElsewhere}.`)).toBeVisible();
  await expect(page.getByTestId("invitation-row")).toHaveCount(2);
  await expect(page.getByTestId("invitation-count")).toHaveText("2 de 50");
  await waitForMails(existingElsewhere, 1);

  // --- reenviar: recién enviada, la base pide esperar ---
  await row.getByTestId("invitation-resend").click();
  await expect(page.getByText("Espera 10 minutos para reenviarla.")).toBeVisible();
  expect(await mailsTo(invitee)).toHaveLength(1);
  // Pasados los 10 minutos (se adelanta el reloj de la invitación), el reenvío sale con un código nuevo.
  await withDb((db) =>
    db.query(
      "update public.invitations set last_sent_at = now() - interval '11 minutes' where tenant_id = $1",
      [tenantId],
    ),
  );
  await row.getByTestId("invitation-resend").click();
  await expect(page.getByText(`Reenviamos la invitación a ${invitee}.`)).toBeVisible();
  const mails = await waitForMails(invitee, 2);
  const second = inviteLink(mails[1]);
  expect(second.token).not.toBe(first.token);
  await withDb(async (db) => {
    const { rows } = await db.query<{ token_sha256: string; send_count: number }>(
      `select token_sha256, send_count from public.invitations
        where tenant_id = $1 and role = 'sales'`,
      [tenantId],
    );
    expect(rows).toEqual([{ token_sha256: sha256(second.token), send_count: 2 }]);
    // El código del primer correo ya no existe en la base.
    const old = await db.query("select 1 from public.invitations where token_sha256 = $1", [
      sha256(first.token),
    ]);
    expect(old.rowCount).toBe(0);
  });

  // --- vencida: se ve como vencida y el reenvío la deja vigente otra vez ---
  await withDb((db) =>
    db.query(
      `update public.invitations set expires_at = now() - interval '1 day',
         last_sent_at = now() - interval '2 days' where tenant_id = $1 and role = 'sales'`,
      [tenantId],
    ),
  );
  await page.reload();
  await expect(row.getByTestId("invitation-status")).toContainText("Vencida");
  await expect(row.getByTestId("invitation-expiry")).toContainText("Venció el");
  await row.getByTestId("invitation-resend").click();
  await expect(page.getByText(`Reenviamos la invitación a ${invitee}.`)).toBeVisible();
  await expect(row.getByTestId("invitation-status")).toContainText("Enviada");
  await expect(row.getByTestId("invitation-expiry")).toContainText("Vence el");

  // --- un Comercial no ve «Equipo», no entra a la pantalla y no puede ejecutar la acción ---
  const salesContext = await newContext(browser, baseURL);
  try {
    const salesPage = await salesContext.newPage();
    await login(salesPage, salesEmail, tenantId);
    await expect(salesPage.getByRole("link", { name: "Equipo", exact: true })).toHaveCount(0);
    await expect(salesPage.getByRole("link", { name: "Configuración", exact: true })).toHaveCount(
      0,
    );
    await salesPage.goto(`/o/${tenantId}/equipo`);
    await expect(salesPage.getByText("No tienes permiso para esto.")).toBeVisible();
    await expect(salesPage.getByTestId("invitation-list")).toHaveCount(0);
    await expect(salesPage.getByTestId("invite-form")).toHaveCount(0);
    await expect(salesPage.getByText(invitee)).toHaveCount(0);

    // La misma petición que hizo el Dueño, repetida con la sesión del Comercial: rechazada y sin efecto.
    const before = await withDb(async (db) =>
      Number(
        (
          await db.query<{ n: string }>(
            "select count(*) as n from public.invitations where tenant_id = $1",
            [tenantId],
          )
        ).rows[0].n,
      ),
    );
    const response = await salesContext.request.post(replay.url, {
      headers: replay.headers,
      data: replay.body ?? undefined,
    });
    expect(await response.text()).toContain("No tienes permiso para esto.");
    const after = await withDb(async (db) =>
      Number(
        (
          await db.query<{ n: string }>(
            "select count(*) as n from public.invitations where tenant_id = $1",
            [tenantId],
          )
        ).rows[0].n,
      ),
    );
    expect(after).toBe(before);
    expect(await mailsTo(invitee)).toHaveLength(3);
  } finally {
    await salesContext.close();
  }

  // --- teléfono (375 px): sin desplazamiento horizontal y con áreas táctiles de 44 px ---
  await page.setViewportSize(MOBILE);
  await page.goto(`/o/${tenantId}/equipo`);
  await expect(page.getByTestId("invitation-row")).toHaveCount(2);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  for (const testId of ["invite-submit", "invitation-resend", "invitation-revoke"]) {
    const target = page.getByTestId(testId).first();
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    expect(box?.height ?? 0, testId).toBeGreaterThanOrEqual(44);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // --- cancelar: pide confirmación, la fila desaparece y la invitación queda cancelada ---
  await rowOf(page, existingElsewhere).getByTestId("invitation-revoke").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Sí, cancelar" }).click();
  await expect(rowOf(page, existingElsewhere)).toHaveCount(0);
  await expect(page.getByTestId("invitation-count")).toHaveText("1 de 50");
  await withDb(async (db) => {
    const { rows } = await db.query<{ status: string; revoke_reason: string }>(
      "select status, revoke_reason from public.invitations where tenant_id = $1 and role = 'approver'",
      [tenantId],
    );
    expect(rows).toEqual([{ status: "revoked", revoke_reason: "cancelled" }]);
  });
  await rowOf(page, invitee).getByTestId("invitation-revoke").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Sí, cancelar" }).click();
  await expect(page.getByTestId("invitation-row")).toHaveCount(0);
  await expect(page.getByText("No hay invitaciones pendientes")).toBeVisible();
});

test("si el correo no puede salir, la invitación queda «pendiente, no enviada» con el botón para reenviar", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const ownerEmail = uniqueEmail("equipo-falla");
  await signUpAndVerify(page, ownerEmail, "Dueña Falla");
  const tenantId = await createTenant(page, "Equipo Falla Ltda", generateRut());
  await page.goto(`/o/${tenantId}/equipo`);

  // Un dominio fuera de la lista permitida en pruebas: el transporte lo rechaza y nada sale.
  const unreachable = "persona-sin-correo@dominio-no-permitido.com";
  await invite(page, unreachable, "viewer");
  await expect(page.getByText("no pudimos enviar el correo")).toBeVisible();
  const row = rowOf(page, unreachable);
  await expect(row.getByTestId("invitation-status")).toContainText("Pendiente, no enviada");
  await expect(row.getByTestId("invitation-resend")).toBeEnabled();
  await withDb(async (db) => {
    const { rows } = await db.query<{ status: string; error_code: string }>(
      "select status, error_code from public.email_messages where tenant_id = $1 and kind = 'invitation'",
      [tenantId],
    );
    expect(rows).toEqual([{ status: "failed", error_code: "recipient_not_allowed" }]);
  });

  // Como el primer correo nunca salió, se puede reintentar de inmediato (no hay que esperar 10 minutos).
  await row.getByTestId("invitation-resend").click();
  await expect(
    page.getByText("Actualizamos la invitación, pero no pudimos enviar el correo."),
  ).toBeVisible();
  await expect(page.getByText("Espera 10 minutos")).toHaveCount(0);
  await withDb(async (db) => {
    const { rows } = await db.query<{ send_count: number }>(
      "select send_count from public.invitations where tenant_id = $1",
      [tenantId],
    );
    expect(rows).toEqual([{ send_count: 2 }]);
  });
});

test("el Observador y el Aprobador tampoco ven «Tu equipo»", async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000);
  const ownerEmail = uniqueEmail("equipo-roles-dueno");
  await signUpAndVerify(page, ownerEmail, "Dueña Roles");
  const tenantId = await createTenant(page, "Equipo Roles Ltda", generateRut());
  const people = [
    { email: uniqueEmail("equipo-observador"), role: "viewer" },
    { email: uniqueEmail("equipo-aprobador"), role: "approver" },
  ];
  for (const person of people) {
    const context = await newContext(browser, baseURL);
    try {
      await signUpAndVerify(await context.newPage(), person.email, `Persona ${person.role}`);
    } finally {
      await context.close();
    }
    await withDb((db) =>
      db.query(
        `insert into public.members (tenant_id, user_id, role)
         select $1, id, $3 from auth.users where email = $2`,
        [tenantId, person.email, person.role],
      ),
    );
  }
  for (const person of people) {
    const context = await newContext(browser, baseURL);
    try {
      const memberPage = await context.newPage();
      await login(memberPage, person.email, tenantId);
      await expect(memberPage.getByRole("link", { name: "Equipo", exact: true })).toHaveCount(0);
      await memberPage.goto(`/o/${tenantId}/equipo`);
      await expect(memberPage.getByText("No tienes permiso para esto.")).toBeVisible();
      await expect(memberPage.getByTestId("invite-form")).toHaveCount(0);
    } finally {
      await context.close();
    }
  }
});

test("si alguien que no es el Dueño invita a un Administrador, el Dueño recibe un aviso sin el correo del invitado", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const ownerEmail = uniqueEmail("equipo-aviso-dueno");
  const adminEmail = uniqueEmail("equipo-aviso-admin");
  await signUpAndVerify(page, ownerEmail, "Dueña Aviso");
  const tenantId = await createTenant(page, "Equipo Aviso Ltda", generateRut());
  const setup = await newContext(browser, baseURL);
  try {
    await signUpAndVerify(await setup.newPage(), adminEmail, "Admin Aviso");
  } finally {
    await setup.close();
  }
  await withDb((db) =>
    db.query(
      `insert into public.members (tenant_id, user_id, role)
       select $1, id, 'admin' from auth.users where email = $2`,
      [tenantId, adminEmail],
    ),
  );

  /** Los avisos al Dueño (no sus correos de verificación ni las invitaciones). */
  const notices = async () =>
    (await mailsAll(ownerEmail)).filter((mail) => mail.Subject.includes("invitó a una persona a"));

  const adminContext = await newContext(browser, baseURL);
  try {
    const adminPage = await adminContext.newPage();
    await login(adminPage, adminEmail, tenantId);
    await adminPage.goto(`/o/${tenantId}/equipo`);

    // Admin invita a un Comercial: sin aviso.
    const salesInvitee = uniqueEmail("equipo-aviso-comercial");
    await invite(adminPage, salesInvitee, "sales");
    await expect(adminPage.getByText(`Enviamos la invitación a ${salesInvitee}.`)).toBeVisible();
    await waitForMails(salesInvitee, 1);
    expect(await notices()).toHaveLength(0);

    // Admin invita a un Administrador: el Dueño recibe el aviso.
    const adminInvitee = uniqueEmail("equipo-aviso-nuevo-admin");
    await invite(adminPage, adminInvitee, "admin");
    await expect(adminPage.getByText(`Enviamos la invitación a ${adminInvitee}.`)).toBeVisible();
    await waitForMails(adminInvitee, 1);
    await expect.poll(async () => (await notices()).length, { timeout: 30_000 }).toBe(1);
    const [notice] = await notices();
    expect(notice.Subject).toBe(
      "Admin Aviso invitó a una persona a Equipo Aviso Ltda como Administrador",
    );
    for (const body of [notice.Text, notice.HTML]) {
      expect(body).toContain("Admin Aviso invitó a una persona a Equipo Aviso Ltda");
      expect(body).toContain("con el rol de Administrador");
      expect(body).toContain(formatDate(new Date()));
      // Nada del invitado: ni su correo ni la parte de antes de la arroba.
      expect(body).not.toContain(adminInvitee);
      expect(body).not.toContain(adminInvitee.split("@")[0]);
    }
    expect(notice.HTML).toContain(`href="${baseURL}/o/${tenantId}/equipo"`);
  } finally {
    await adminContext.close();
  }

  // El Dueño invita a un Administrador: sin aviso (ya lo sabe).
  await page.goto(`/o/${tenantId}/equipo`);
  const ownInvitee = uniqueEmail("equipo-aviso-del-dueno");
  await invite(page, ownInvitee, "admin");
  await expect(page.getByText(`Enviamos la invitación a ${ownInvitee}.`)).toBeVisible();
  await waitForMails(ownInvitee, 1);
  expect(await notices()).toHaveLength(1);
  // El registro del aviso quedó anotado, una sola vez y enviado.
  await withDb(async (db) => {
    const { rows } = await db.query<{ status: string }>(
      "select status from public.email_messages where tenant_id = $1 and kind = 'invitation_notice'",
      [tenantId],
    );
    expect(rows).toEqual([{ status: "sent" }]);
  });
});
