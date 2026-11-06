// Fixture de la prueba de aislamiento (H-012): organizaciones, personas y datos ficticios.
//
// No usa Vitest, así que la comparten Vitest (montaje global) y Playwright (e2e/isolation.setup.ts).
// Todo se crea por los caminos reales: cuentas con la API de administración de Auth, organizaciones
// y datos con PostgREST y el pase de cada dueña o dueño. La llave maestra y `pg` solo sirven para
// montar lo que ningún camino legítimo permite (membresías ajenas, archivar) y para verificar.
// NUNCA se usan para atacar.
//
// No se borra nada al terminar (la auditoría es de solo agregar): cada ejecución usa su `runId`.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { buildCustomerInsertRow } from "@/lib/customers/record";
import { encryptPii } from "@/lib/crypto/pii";
import { buildNewInvitation } from "@/lib/team/record";
import { calculateQuote } from "@/lib/quotes/calc";
import type { CustomerInput } from "@/lib/customers/schemas";
import { PLATFORM_TENANT_ID, TENANT_HEADER } from "@/lib/tenant/constants";
import { connect } from "../db/helpers";
import {
  adminCreateUser,
  localEnv,
  rest,
  rpc,
  signIn,
  storage,
  type Session,
} from "../support/local-supabase";

export type PersonaKey = "ana" | "beto" | "carla" | "mixta" | "ex" | "dante";
export type OrgKey = "A" | "B" | "C";
export type Role = "owner" | "admin" | "approver" | "sales" | "viewer";

export const PERSONA_KEYS: PersonaKey[] = ["ana", "beto", "carla", "mixta", "ex", "dante"];
export const ORG_KEYS: OrgKey[] = ["A", "B", "C"];

/** RUT ficticio válido para las organizaciones y para el cliente que se repite en A y en B. */
const ORG_RUT = "76086428-5";
export const SHARED_CUSTOMER_RUT = "12345678-5";
const SHARED_CUSTOMER_EMAIL = "compartido@ejemplo.test";
/** RUT y correo que existen SOLO en un cliente de B (P23: registrarlos en A no debe avisar de duplicado). */
export const ONLY_B_CUSTOMER_RUT = "11111111-1";
export const ONLY_B_CUSTOMER_EMAIL = "solo-b@ejemplo.test";

/** Prefijo de numeración que identifica a cada organización en las pruebas. */
export const NUMBERING_PREFIX: Record<"A" | "B", string> = { A: "AAA", B: "BBB" };
const NUMBERING_START: Record<"A" | "B", number> = { A: 100, B: 500 };

export interface Persona {
  key: PersonaKey;
  email: string;
  userId: string;
  fullName: string;
  session: Session;
}

/** PNG de 1 × 1 píxel, válido: es el "logo" de las organizaciones de la fixture. */
export const FIXTURE_LOGO_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
export const LOGO_BUCKET = "tenant-logos";
export const QUOTE_DOCUMENTS_BUCKET = "quote-documents";
/** PDF mínimo (no hace falta que se abra): es el "documento congelado" de la fixture. */
export const FIXTURE_PDF = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

export interface OrgData {
  tenantId: string;
  /** Ruta del logo en Storage (`{tenant_id}/logo-....png`); C no tiene. */
  logoPath: string | null;
  name: string;
  /** Texto que solo aparece en datos de esa organización: si sale en otra respuesta, hay filtración. */
  canary: string;
  customerIds: string[];
  catalogIds: string[];
  /** Cotizaciones de la organización (con líneas cuyo nombre lleva el canario). A y B tienen una. */
  quoteIds: string[];
  /** Cotización enviada con paquete y enlace (A y B; C no tiene). */
  share: ShareData | null;
  /** Formulario público publicado, con sus servicios y una solicitud recibida (A y B; C no tiene). */
  intake: IntakeData | null;
  /** Una invitación pendiente al equipo, hecha por la dueña (A y B; C no tiene). */
  invitation: InvitationData | null;
  /** Textos guardados (H-048a), creados por la dueña con su pase (A y B; C no tiene). */
  snippets: SnippetsData | null;
  /** La fila de `members` de la dueña (H-010): sirve para atacar y abrir la ficha de un miembro (`/equipo/[memberId]`). */
  ownerMemberId: string;
}

/** Dos textos guardados de una organización: uno del correo (texto inicial) y unas condiciones. Ambos llevan el canario. */
export interface SnippetsData {
  emailId: string;
  emailName: string;
  /** Texto en claro (con el canario y una variable): si sale en otra respuesta, hay filtración. */
  emailBody: string;
  conditionsId: string;
  conditionsName: string;
  conditionsBody: string;
}

/** Una invitación pendiente: el correo en claro sirve para comprobar que nunca sale de su organización. */
export interface InvitationData {
  invitationId: string;
  /** Correo en claro de la persona invitada (solo en la fixture; en la base va cifrado). */
  email: string;
  /** Huella del código secreto del enlace (el código mismo no se guarda en ningún lado). */
  tokenSha256: string;
  emailMessageId: string;
}

/** Un formulario público publicado y una solicitud ya recibida (solo A y B). */
export interface IntakeData {
  formId: string;
  /** Identificador público actual (el de la dirección `/f/...`). */
  publicId: string;
  revision: number;
  /** Servicio libre del formulario. */
  freeItemId: string;
  /** Servicio del formulario copiado desde el catálogo. */
  catalogFormItemId: string;
  /** Servicio del catálogo de la organización al que apunta el anterior. */
  catalogItemId: string;
  /** Solicitud ya recibida por este formulario (con datos de contacto cifrados y con el canario). */
  requestId: string;
  /** Texto en claro de lo que se cifró en la solicitud (sirve para comprobar que no se descifra en otra fila). */
  contactEmail: string;
}

/** Una cotización ya enviada, con su paquete congelado y su enlace (solo A y B). */
export interface ShareData {
  quoteId: string;
  packageId: string;
  shareLinkId: string;
  /** El token en claro (en producción solo viaja en el correo): sirve para atacar "como cliente". */
  token: string;
  tokenSha256: string;
  pdfPath: string;
  emailMessageId: string;
  responseId: string;
}

export interface IsolationFixture {
  runId: string;
  personas: Record<PersonaKey, Persona>;
  orgs: Record<OrgKey, OrgData>;
  /** Identificador de un registro de auditoría de la plataforma (nunca visible a una organización). */
  platformAuditId: number;
  /** Clave de la fila de `auth_rate_limits` que monta la fixture. */
  rateLimitKeyHash: string;
}

const SEED_CUSTOMERS = (org: OrgKey, canary: string): CustomerInput[] => [
  ...seedCustomers(org, canary),
  ...(org === "B"
    ? [
        {
          kind: "company" as const,
          displayName: `${canary} Cliente solo de B`,
          rut: ONLY_B_CUSTOMER_RUT,
          email: ONLY_B_CUSTOMER_EMAIL,
          phone: null,
          address: null,
        },
      ]
    : []),
];

const seedCustomers = (org: OrgKey, canary: string): CustomerInput[] => [
  {
    kind: "company",
    displayName: `${canary} Cliente compartido`,
    rut: SHARED_CUSTOMER_RUT,
    email: SHARED_CUSTOMER_EMAIL,
    phone: "+56912345678",
    address: `Calle ${canary} 123`,
  },
  {
    kind: "person",
    displayName: `${canary} Cliente ${org} dos`,
    rut: null,
    email: null,
    phone: null,
    address: null,
  },
];

const org = (tenantId: string) => ({ [TENANT_HEADER]: tenantId });

async function mustOk<T>(
  promise: Promise<{ status: number; json: unknown; text: string }>,
  what: string,
): Promise<T> {
  const res = await promise;
  if (res.status >= 300)
    throw new Error(`Fixture: falló ${what} (${res.status}): ${res.text.slice(0, 200)}`);
  return res.json as T;
}

/** Arma toda la fixture. Tarda unos segundos: se llama una vez por ejecución. */
export async function createIsolationFixture(runId: string): Promise<IsolationFixture> {
  const db = await connect();
  try {
    return await build(db, runId);
  } finally {
    await db.end();
  }
}

async function build(db: Client, runId: string): Promise<IsolationFixture> {
  // Versiones vigentes de términos y privacidad: así las cuentas entran sin la pantalla de aceptar.
  const { rows: docs } = await db.query<{ kind: string; version: string }>(
    `select kind, version from public.legal_documents where is_current`,
  );
  const acceptedLegal = Object.fromEntries(docs.map((d) => [d.kind, d.version]));

  const canary = (key: OrgKey) => `CANARIO-${key}-${runId}`;
  const names: Record<PersonaKey, string> = {
    ana: `Ana ${canary("A")}`,
    beto: `Beto ${canary("B")}`,
    carla: `Carla ${canary("C")}`,
    mixta: "Mixta Doble",
    ex: "Ex Miembro",
    dante: "Dante Lector",
  };

  const personas = {} as Record<PersonaKey, Persona>;
  for (const key of PERSONA_KEYS) {
    const email = `${key}-${runId}@ejemplo.test`;
    await adminCreateUser(email, { full_name: names[key], accepted_legal: acceptedLegal });
    const session = await signIn(email);
    personas[key] = { key, email, userId: session.userId, fullName: names[key], session };
  }

  // Organizaciones: cada dueña la crea con su propio pase (camino legítimo)
  const orgs = {} as Record<OrgKey, OrgData>;
  const owners: Record<OrgKey, PersonaKey> = { A: "ana", B: "beto", C: "carla" };
  for (const key of ORG_KEYS) {
    const name = key === "A" ? `Negocio A ${runId}` : `${canary(key)} Negocio ${key}`;
    const tenantId = await mustOk<string>(
      rpc(personas[owners[key]].session.accessToken, "create_tenant", {
        p_name: name,
        p_rut: ORG_RUT,
        p_industry: "services",
      }),
      `create_tenant ${key}`,
    );
    orgs[key] = {
      tenantId,
      name,
      canary: key === "A" ? canary("A") : canary(key),
      logoPath: null,
      customerIds: [],
      catalogIds: [],
      quoteIds: [],
      share: null,
      intake: null,
      invitation: null,
      snippets: null,
      ownerMemberId: (
        await db.query<{ id: string }>(
          "select id from public.members where tenant_id = $1 and user_id = $2",
          [tenantId, personas[owners[key]].userId],
        )
      ).rows[0].id,
    };
  }

  // Membresías que ningún camino legítimo da todavía (invitaciones llegan en el sprint 4)
  const addMember = (tenantId: string, userId: string, role: Role) =>
    db.query(`insert into public.members (tenant_id, user_id, role) values ($1, $2, $3)`, [
      tenantId,
      userId,
      role,
    ]);
  await addMember(orgs.A.tenantId, personas.mixta.userId, "admin");
  await addMember(orgs.B.tenantId, personas.mixta.userId, "admin");
  await addMember(orgs.A.tenantId, personas.dante.userId, "viewer");
  await addMember(orgs.A.tenantId, personas.ex.userId, "sales");
  // Mixta usó B por última vez: es el dato que no debe filtrarse a sus compañeros de A (criterio 3)
  await db.query(`update public.profiles set last_tenant_id = $1 where user_id = $2`, [
    orgs.B.tenantId,
    personas.mixta.userId,
  ]);

  // Numeración, catálogo y clientes, por el camino legítimo (pase de la dueña y su cabecera)
  for (const key of ["A", "B"] as const) {
    const owner = personas[owners[key]];
    const token = owner.session.accessToken;
    const headers = org(orgs[key].tenantId);
    await mustOk(
      rpc(
        token,
        "set_numbering",
        {
          p_prefix: NUMBERING_PREFIX[key],
          p_mode: "yearly",
          p_start_number: NUMBERING_START[key],
        },
        headers,
      ),
      `set_numbering ${key}`,
    );
    for (let i = 1; i <= 2; i++) {
      const id = randomUUID();
      await mustOk(
        rest(token, "catalog_items", {
          method: "POST",
          headers,
          body: {
            id,
            tenant_id: orgs[key].tenantId,
            name: `${orgs[key].canary} Servicio ${i}`,
            description: `Descripción ${orgs[key].canary}`,
            unit: "service",
            unit_price_clp: 10_000 * i,
          },
        }),
        `catálogo ${key}`,
      );
      orgs[key].catalogIds.push(id);
    }
    // Logo: la sesión de las personas ya no sube a Storage (sube el servidor, migración 19); aquí lo
    // sube la llave maestra, como la aplicación, y se registra con la función `save_tenant_brand`.
    const logoPath = `${orgs[key].tenantId}/logo-${key === "A" ? "aaaaaaaaaaaa" : "bbbbbbbbbbbb"}.png`;
    const { secretKey } = localEnv();
    await mustOk(
      storage(secretKey, "POST", `object/${LOGO_BUCKET}/${logoPath}`, {
        headers: { apikey: secretKey },
        body: FIXTURE_LOGO_PNG,
        contentType: "image/png",
      }),
      `logo ${key}`,
    );
    await mustOk(
      rpc(
        token,
        "save_tenant_brand",
        {
          p_primary_color: "#2b54e0",
          p_secondary_color: "#0f1729",
          p_logo_mode: "set",
          p_logo_path: logoPath,
        },
        headers,
      ),
      `marca ${key}`,
    );
    orgs[key].logoPath = logoPath;
    for (const input of SEED_CUSTOMERS(key, orgs[key].canary)) {
      const id = randomUUID();
      const row = buildCustomerInsertRow(input, orgs[key].tenantId, id);
      await mustOk(
        rest(token, "customers", { method: "POST", headers, body: row }),
        `cliente ${key}`,
      );
      orgs[key].customerIds.push(id);
    }
  }
  // Una cotización con dos líneas en A y en B, por el camino legítimo (create_quote + save_quote_draft).
  // El texto de las líneas lleva el canario de la organización: si sale en otra respuesta, hay filtración.
  for (const key of ["A", "B"] as const) {
    const token = personas[owners[key]].session.accessToken;
    const headers = org(orgs[key].tenantId);
    const created = await mustOk<{ quote_id: string; number_display: string }[]>(
      rpc(
        token,
        "create_quote",
        { p_customer_id: orgs[key].customerIds[0], p_creation_key: randomUUID() },
        headers,
      ),
      `create_quote ${key}`,
    );
    const quoteId = created[0].quote_id;
    const items = [
      {
        id: randomUUID(),
        catalog_item_id: orgs[key].catalogIds[0],
        name: `${orgs[key].canary} Línea del catálogo`,
        description: `Detalle ${orgs[key].canary}`,
        unit: "service",
        tax_treatment: "taxable",
        quantity_milli: 2500,
        unit_price_clp: 10_000,
        discount_kind: "percent",
        discount_value: 1000,
      },
      {
        id: randomUUID(),
        name: `${orgs[key].canary} Línea libre`,
        description: null,
        unit: "unit",
        tax_treatment: "exempt",
        quantity_milli: 1000,
        unit_price_clp: 5_000,
        discount_kind: "none",
        discount_value: 0,
      },
    ];
    const calc = calculateQuote({
      lines: [
        {
          quantityMilli: 2500,
          unitPriceClp: 10_000,
          taxTreatment: "taxable",
          discount: { kind: "percent", bp: 1000 },
        },
        {
          quantityMilli: 1000,
          unitPriceClp: 5_000,
          taxTreatment: "exempt",
          discount: { kind: "none" },
        },
      ],
      globalDiscount: { kind: "none" },
      taxRateBp: 1900,
    });
    if (!calc.ok) throw new Error("Fixture: el cálculo de la cotización de prueba falló");
    await mustOk(
      rpc(
        token,
        "save_quote_draft",
        {
          p_quote_id: quoteId,
          p_expected_revision: 1,
          p_save_id: randomUUID(),
          p_header: {
            customer_id: orgs[key].customerIds[0],
            global_discount: { kind: "none", value: 0 },
          },
          p_items: items,
          p_expected_totals: calc.totals,
        },
        headers,
      ),
      `save_quote_draft ${key}`,
    );
    orgs[key].quoteIds.push(quoteId);
  }
  // Una cotización enviada (paquete congelado, enlace y aperturas) en A y en B. Se monta con `pg`:
  // las funciones de envío necesitan al servidor de la aplicación, y esto solo prepara los datos.
  for (const key of ["A", "B"] as const) {
    orgs[key].share = await buildShareData(db, key, orgs[key], personas[owners[key]], runId);
  }
  // Un formulario público publicado en A y en B, por el camino legítimo (funciones con el pase de la dueña).
  for (const key of ["A", "B"] as const) {
    orgs[key].intake = await buildIntakeData(db, orgs[key], personas[owners[key]]);
  }
  // Una invitación pendiente en A y en B, por el camino legítimo (la función con el pase de la dueña).
  for (const key of ["A", "B"] as const) {
    orgs[key].invitation = await buildInvitationData(orgs[key], personas[owners[key]], key);
  }
  // Textos guardados en A y en B, por el camino legítimo (las funciones con el pase de la dueña).
  for (const key of ["A", "B"] as const) {
    orgs[key].snippets = await buildSnippetsData(orgs[key], personas[owners[key]], key);
  }
  // C: un cliente, y luego se archiva
  {
    const id = randomUUID();
    const row = buildCustomerInsertRow(SEED_CUSTOMERS("C", canary("C"))[1], orgs.C.tenantId, id);
    await mustOk(
      rest(personas.carla.session.accessToken, "customers", {
        method: "POST",
        headers: org(orgs.C.tenantId),
        body: row,
      }),
      "cliente C",
    );
    orgs.C.customerIds.push(id);
  }
  await db.query(
    `update public.tenants set status = 'archived', archived_at = now() where tenant_id = $1`,
    [orgs.C.tenantId],
  );

  // Un registro de auditoría de la plataforma y una fila del limitador de intentos
  const audit = await db.query<{ id: string }>(
    `insert into public.audit_log (tenant_id, actor_type, action, result, details)
     values ($1, 'system', 'test.platform_event', 'success', $2) returning id::text`,
    [PLATFORM_TENANT_ID, JSON.stringify({ runId })],
  );
  const rateLimitKeyHash = [
    ...randomUUID().replaceAll("-", ""),
    ...randomUUID().replaceAll("-", ""),
  ].join("");
  await db.query(
    `insert into public.auth_rate_limits (scope, key_hash, failures) values ('login_ip', $1, 1)`,
    [rateLimitKeyHash],
  );

  return {
    runId,
    personas,
    orgs,
    platformAuditId: Number(audit.rows[0].id),
    rateLimitKeyHash,
  };
}

async function buildSnippetsData(
  data: OrgData,
  owner: Persona,
  key: OrgKey,
): Promise<SnippetsData> {
  const headers = org(data.tenantId);
  const make = async (kind: string, name: string, body: string, isDefault: boolean) => {
    const id = randomUUID();
    const result = await mustOk<{ result: string }>(
      rpc(
        owner.session.accessToken,
        "create_text_snippet",
        { p_snippet_id: id, p_kind: kind, p_name: name, p_body: body, p_is_default: isDefault },
        headers,
      ),
      `create_text_snippet ${key} ${kind}`,
    );
    if (result.result !== "created")
      throw new Error(`Fixture: el texto ${kind} de ${key} no se creó`);
    return id;
  };
  const emailName = `${data.canary} Saludo`;
  const emailBody = `Estimado {{cliente}}: texto del correo ${data.canary}.`;
  const conditionsName = `${data.canary} Condiciones`;
  const conditionsBody = `Condiciones ${data.canary}: pago a 30 días.`;
  return {
    emailId: await make("email_body", emailName, emailBody, true),
    emailName,
    emailBody,
    conditionsId: await make("conditions", conditionsName, conditionsBody, false),
    conditionsName,
    conditionsBody,
  };
}

async function buildInvitationData(
  data: OrgData,
  owner: Persona,
  key: OrgKey,
): Promise<InvitationData> {
  const email = `invitada-${key.toLowerCase()}-${randomUUID().slice(0, 8)}@ejemplo.test`;
  const invitation = buildNewInvitation(data.tenantId, email, "viewer");
  const result = await mustOk<{ result: string }>(
    rpc(owner.session.accessToken, "create_invitation", invitation.params, org(data.tenantId)),
    `create_invitation ${key}`,
  );
  if (result.result !== "created") throw new Error(`Fixture: la invitación de ${key} no se creó`);
  return {
    invitationId: invitation.invitationId,
    email,
    tokenSha256: invitation.params.p_token_sha256,
    emailMessageId: invitation.emailMessageId,
  };
}

async function buildIntakeData(db: Client, data: OrgData, owner: Persona): Promise<IntakeData> {
  const token = owner.session.accessToken;
  const headers = org(data.tenantId);
  // Para publicar, la organización necesita un correo de contacto (el alta de la fixture no lo pide).
  await db.query(`update public.tenants set contact_email = $2 where tenant_id = $1`, [
    data.tenantId,
    `contacto-${data.canary.toLowerCase()}@ejemplo.test`,
  ]);
  const formId = randomUUID();
  const created = await mustOk<{ public_id: string; revision: number }>(
    rpc(
      token,
      "create_intake_form",
      { p_form_id: formId, p_name: `Formulario ${data.canary}` },
      headers,
    ),
    "create_intake_form",
  );
  const freeItemId = randomUUID();
  const catalogFormItemId = randomUUID();
  const saved = await mustOk<{ revision: number }>(
    rpc(
      token,
      "save_intake_form",
      {
        p_form_id: formId,
        p_expected_revision: created.revision,
        p_form: {
          title: `Pide tu cotización ${data.canary}`,
          intro: `Introducción ${data.canary}`,
          success_message: `Gracias ${data.canary}`,
        },
        p_items: [
          {
            id: freeItemId,
            kind: "free",
            public_name: `Servicio libre ${data.canary}`,
            public_description: `Detalle ${data.canary}`,
            unit: "service",
            quantity_mode: "optional",
          },
          {
            id: catalogFormItemId,
            kind: "catalog",
            catalog_item_id: data.catalogIds[0],
            public_name: `Servicio de catálogo ${data.canary}`,
            unit: "service",
            quantity_mode: "required",
            min_qty_milli: 1000,
            max_qty_milli: 100000,
          },
        ],
      },
      headers,
    ),
    "save_intake_form",
  );
  await mustOk(
    rpc(token, "set_intake_form_status", { p_form_id: formId, p_status: "published" }, headers),
    "set_intake_form_status",
  );
  // Una solicitud recibida y los contadores del día. Se monta con `pg` (los datos llegan ya cifrados, con el
  // sello `intake_requests.<campo>|tenant|id`; así los trae la aplicación).
  const requestId = randomUUID();
  const contactEmail = `visitante-${data.canary.toLowerCase()}@ejemplo.test`;
  const seal = (field: string) => ({
    table: "intake_requests",
    field,
    tenantId: data.tenantId,
    rowId: requestId,
  });
  await db.query(
    `insert into public.intake_requests
       (id, tenant_id, form_id, contact_name_enc, contact_email_enc, contact_phone_enc, message_enc,
        contact_email_hash, items, form_revision, submit_key, consent_template_version, consent_text,
        consent_text_sha256, consent_ip_enc, desired_date)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, 'intake-v1', $12, $13, $14, current_date + 30)`,
    [
      requestId,
      data.tenantId,
      formId,
      encryptPii(`Visitante ${data.canary}`, seal("contact_name")),
      encryptPii(contactEmail, seal("contact_email")),
      encryptPii("+56912345678", seal("contact_phone")),
      encryptPii(`Mensaje ${data.canary}`, seal("message")),
      createHash("sha256").update(`correo-${requestId}`).digest("hex"),
      JSON.stringify([
        {
          form_item_id: freeItemId,
          catalog_item_id: null,
          name: `Servicio libre ${data.canary}`,
          unit: "service",
          quantity_milli: 2000,
        },
      ]),
      saved.revision,
      randomUUID(),
      "texto-de-consentimiento",
      createHash("sha256").update("texto-de-consentimiento").digest("hex"),
      encryptPii("203.0.113.9", seal("consent_ip")),
    ],
  );
  await db.query(
    `insert into public.intake_daily_counters (tenant_id, form_id, day, accepted, blocked_rate)
     values ($1, $2, app.current_business_date(), 1, 2)`,
    [data.tenantId, formId],
  );
  return {
    formId,
    publicId: created.public_id,
    revision: saved.revision,
    freeItemId,
    catalogFormItemId,
    catalogItemId: data.catalogIds[0],
    requestId,
    contactEmail,
  };
}

async function buildShareData(
  db: Client,
  key: "A" | "B",
  data: OrgData,
  owner: Persona,
  runId: string,
): Promise<ShareData> {
  const headers = org(data.tenantId);
  const created = await mustOk<{ quote_id: string }[]>(
    rpc(
      owner.session.accessToken,
      "create_quote",
      { p_customer_id: data.customerIds[0], p_creation_key: randomUUID() },
      headers,
    ),
    `create_quote (enviada) ${key}`,
  );
  const quoteId = created[0].quote_id;
  const packageId = randomUUID();
  const shareLinkId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const tokenSha256 = createHash("sha256").update(token).digest("hex");
  const pdfPath = `${data.tenantId}/${quoteId}/${packageId}.pdf`;
  const { secretKey } = localEnv();
  await mustOk(
    storage(secretKey, "POST", `object/${QUOTE_DOCUMENTS_BUCKET}/${pdfPath}`, {
      headers: { apikey: secretKey },
      body: FIXTURE_PDF,
      contentType: "application/pdf",
    }),
    `pdf congelado ${key}`,
  );
  await db.query(
    `insert into public.quote_packages
       (id, tenant_id, quote_id, send_key, issue_date, valid_until, email_subject, email_body_md,
        customer_snapshot_enc, created_by)
     values ($1, $2, $3, $4, app.current_business_date(), app.current_business_date() + 15, $5, $6, $8, $7)`,
    [
      packageId,
      data.tenantId,
      quoteId,
      randomUUID(),
      `Cotización ${data.canary}`,
      `Texto del correo ${data.canary}`,
      owner.userId,
      // Datos del cliente al enviar, cifrados y sellados con la tabla, la organización y el paquete.
      encryptPii(
        JSON.stringify({ name: `Cliente ${data.canary}`, email: "cliente@ejemplo.test" }),
        {
          table: "quote_packages",
          field: "customer_snapshot",
          tenantId: data.tenantId,
          rowId: packageId,
        },
      ),
    ],
  );
  await db.query(
    `update public.quote_packages set pdf_path = $1, pdf_sha256 = $2, pdf_bytes = $3,
       document_snapshot = $4::jsonb, content_sha256 = $5, state = 'ready'
     where tenant_id = $6 and id = $7`,
    [
      pdfPath,
      createHash("sha256").update(FIXTURE_PDF).digest("hex"),
      FIXTURE_PDF.length,
      // Una copia del documento con la forma real (la pantalla del cliente la valida entera) más las
      // marcas de la prueba. La organización lleva el canario para reconocer de quién es lo que se ve.
      JSON.stringify({
        canary: data.canary,
        runId,
        paper: "letter",
        brand: {
          primary: "#2b54e0",
          secondary: "#0f1729",
          primaryText: "#2b54e0",
          onPrimary: "#ffffff",
          primaryTint: "#eaeefc",
        },
        organization: { name: `Empresa ${data.canary}`, detailLines: ["contacto@ejemplo.test"] },
        quote: {
          number: "COT-2026-0001",
          versionLabel: null,
          issueDate: "01-10-2026",
          validUntil: "31-12-2026",
          validityNote: null,
        },
        preparedBy: { name: "Vendedora Ficticia", detailLines: [] },
        lines: [
          {
            name: `Servicio ${data.canary}`,
            description: null,
            exempt: false,
            quantity: "1",
            unit: "servicio",
            unitPrice: "$10.000",
            discount: "—",
            total: "$10.000",
          },
        ],
        totals: {
          subtotal: "$10.000",
          globalDiscount: null,
          netTaxable: "$10.000",
          exempt: null,
          taxLabel: "IVA 19%",
          tax: "$1.900",
          total: "$11.900",
        },
        observations: null,
        conditions: null,
        paymentTerms: null,
      }),
      createHash("sha256").update(`content-${packageId}`).digest("hex"),
      data.tenantId,
      packageId,
    ],
  );
  await db.query(
    `update public.quote_packages set state = 'sent' where tenant_id = $1 and id = $2`,
    [data.tenantId, packageId],
  );
  const emailMessageId = randomUUID();
  const responseId = randomUUID();
  // El enlace y su correo se crean juntos (cada uno apunta al otro; la relación se revisa al confirmar).
  await db.query("begin");
  try {
    await db.query(
      `insert into public.share_links
         (id, tenant_id, quote_id, package_id, email_message_id, token_sha256, activated_at,
          first_viewed_at, last_viewed_at, view_count)
       values ($1, $2, $3, $4, $5, $6, now(), now(), now(), 1)`,
      [shareLinkId, data.tenantId, quoteId, packageId, emailMessageId, tokenSha256],
    );
    await db.query(
      `insert into public.email_messages
         (id, tenant_id, quote_id, package_id, share_link_id, kind, to_email_enc, to_email_hash, provider,
          provider_message_id, status, sent_at, created_by)
       values ($1, $2, $3, $4, $5, 'quote', $9, $6, 'memory', $7, 'sent', now(), $8)`,
      [
        emailMessageId,
        data.tenantId,
        quoteId,
        packageId,
        shareLinkId,
        createHash("sha256").update(`correo-${packageId}`).digest("hex"),
        `fixture-${packageId}`,
        owner.userId,
        encryptPii("cliente@ejemplo.test", {
          table: "email_messages",
          field: "to_email",
          tenantId: data.tenantId,
          rowId: emailMessageId,
        }),
      ],
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
  await db.query(
    `insert into public.share_link_views (tenant_id, share_link_id, ip_enc, user_agent_short)
     values ($1, $2, $4, $3)`,
    [
      data.tenantId,
      shareLinkId,
      `Agente ${data.canary}`,
      encryptPii("203.0.113.7", {
        table: "share_link_views",
        field: "ip",
        tenantId: data.tenantId,
        rowId: shareLinkId,
      }),
    ],
  );
  await db.query(
    `update public.quotes set status = 'sent', sent_at = now(), valid_until = app.current_business_date() + 15,
       current_package_id = $1 where tenant_id = $2 and id = $3`,
    [packageId, data.tenantId, quoteId],
  );
  // El cliente aceptó: la respuesta queda en el registro de conformidad.
  await db.query(
    `update public.quotes set status = 'accepted', responded_at = now(),
       first_viewed_at = coalesce(first_viewed_at, now()) where tenant_id = $1 and id = $2`,
    [data.tenantId, quoteId],
  );
  await db.query(
    `insert into public.quote_responses
       (id, tenant_id, quote_id, package_id, share_link_id, decision, response_key, acceptor_name_enc,
        package_content_sha256, acceptance_text_version, ip_enc, user_agent_short)
     values ($1, $2, $3, $4, $5, 'accepted', $6, $9, $7, 'v1', $10, $8)`,
    [
      responseId,
      data.tenantId,
      quoteId,
      packageId,
      shareLinkId,
      randomUUID(),
      createHash("sha256").update(`content-${packageId}`).digest("hex"),
      `Agente ${data.canary}`,
      encryptPii(`Aceptante ${data.canary}`, {
        table: "quote_responses",
        field: "acceptor_name",
        tenantId: data.tenantId,
        rowId: responseId,
      }),
      encryptPii("203.0.113.7", {
        table: "quote_responses",
        field: "ip",
        tenantId: data.tenantId,
        rowId: responseId,
      }),
    ],
  );
  return {
    quoteId,
    packageId,
    shareLinkId,
    token,
    tokenSha256,
    pdfPath,
    emailMessageId,
    responseId,
  };
}

/** Quita a "ex" de la organización A (el camino real todavía no existe: llega en el sprint 4). */
export async function removeExMember(fx: IsolationFixture): Promise<void> {
  const db = await connect();
  try {
    await db.query(
      `update public.members set status = 'removed', removed_at = now()
       where tenant_id = $1 and user_id = $2 and status = 'active'`,
      [fx.orgs.A.tenantId, fx.personas.ex.userId],
    );
  } finally {
    await db.end();
  }
}
