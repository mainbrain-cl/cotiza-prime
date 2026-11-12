// Registro único de la prueba de aislamiento (H-012). Es lo que hay que actualizar cuando alguien
// agrega una tabla, una función o una ruta: `registry-guard.test.ts` falla si se olvida.
//
// Sin dependencias pesadas, para que también lo lea Playwright.
import { createHash, randomUUID } from "node:crypto";
import type { IsolationFixture, PersonaKey, Role } from "./fixture";

/**
 * Quién puede ver cada fila de una tabla:
 * - `business`: solo filas de la organización activa (y, si se declara, solo ciertos roles).
 * - `selector-tenants`: las organizaciones de las que la persona es miembro (el selector).
 * - `selector-members`: sus propias membresías, más las de la organización activa (H-010: las de quien ya se fue,
 *   solo para quien maneja el equipo).
 * - `profiles`: su propio perfil y el de quienes tienen una fila en `members` de la organización activa, activa o
 *   quitada (H-010: el nombre de quien se fue sigue visible para que sus cotizaciones lo muestren como autor).
 * - `own-user`: solo filas con su `user_id`.
 * - `public`: cualquiera, hasta sin sesión (los términos vigentes).
 * - `server-only`: nadie con pase; solo la llave maestra del servidor.
 */
export type Visibility =
  | "business"
  | "selector-tenants"
  | "selector-members"
  | "profiles"
  | "own-user"
  | "public"
  | "server-only";

export interface TableSpec {
  name: string;
  visibility: Visibility;
  /** Roles que leen filas de la organización activa (todos si falta). */
  rolesThatRead?: Role[];
  /** Columna con la que se busca "una fila por su identificador". */
  idColumn: string;
  /** SQL (después de `where`) de las filas que "son de B" y no deben cambiar jamás. */
  ownedByB: (fx: IsolationFixture) => string;
  /** Columnas que un pase puede leer: para el control positivo y como alternativa a `*`. */
  readColumns: string;
  /**
   * ¿La tabla da permiso de lectura solo por columnas (hay columnas privadas)? Entonces `select=*`
   * es rechazado para todos y los controles positivos piden las columnas legibles.
   */
  starSelectRejected?: boolean;
  /** Cuerpo de un intento de crear una fila apuntando a otra organización. */
  insertAttack: (fx: IsolationFixture, targetTenant: string, marker: string) => object;
  /** Cambio de un intento de editar una fila ajena (o propia sin permiso). */
  updateAttack: (marker: string) => object;
  /** ¿La fixture tiene al menos una fila de B en esta tabla? (G2) */
  hasFixtureRowsInB: boolean;
  /**
   * ¿Una persona con permiso puede crear y editar una fila PROPIA de esta tabla por la API?
   * Si sí, la prueba de escritura exige el control positivo: el mismo cuerpo apuntado a su propia
   * organización se acepta (así un rechazo no puede deberse a un cuerpo mal armado). Las demás
   * tablas se escriben solo por funciones o por el servidor.
   */
  ownWriteAccepted: boolean;
}

const byTenantB = (fx: IsolationFixture) => `tenant_id = '${fx.orgs.B.tenantId}'`;

export const ISOLATION_TABLES: TableSpec[] = [
  {
    name: "customers",
    visibility: "business",
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,display_name",
    insertAttack: (_fx, tenant, marker) => ({
      id: randomUUID(),
      tenant_id: tenant,
      kind: "person",
      display_name: marker,
    }),
    updateAttack: (marker) => ({ display_name: marker }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: true,
  },
  {
    name: "catalog_items",
    visibility: "business",
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,name,unit_price_clp",
    insertAttack: (_fx, tenant, marker) => ({
      id: randomUUID(),
      tenant_id: tenant,
      name: marker,
      unit: "service",
      unit_price_clp: 1,
    }),
    updateAttack: (marker) => ({ name: marker }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: true,
  },
  {
    name: "quotes",
    visibility: "business",
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,number_display,status,total_clp",
    insertAttack: (fx, tenant) => ({
      tenant_id: tenant,
      number_seq: 1,
      number_scope: "continuous",
      number_display: "ATAQUE-1",
      root_quote_id: randomUUID(),
      customer_id: fx.orgs.B.customerIds[0],
      creation_key: randomUUID(),
      tax_rate_bp: 1900,
      created_by: fx.personas.ana.userId,
    }),
    updateAttack: () => ({ total_clp: 1, status: "paid" }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "quote_items",
    visibility: "business",
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,quote_id,name,line_total_clp",
    starSelectRejected: true,
    insertAttack: (fx, tenant, marker) => ({
      id: randomUUID(),
      tenant_id: tenant,
      quote_id: fx.orgs.B.quoteIds[0],
      position: 9,
      name: marker,
      unit: "unit",
      tax_treatment: "exempt",
      quantity_milli: 1000,
      unit_price_clp: 1,
      discount_kind: "none",
      discount_value: 0,
      gross_clp: 1,
      discount_clp: 0,
      line_total_clp: 1,
    }),
    updateAttack: (marker) => ({ name: marker, unit_price_clp: 1 }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "quote_events",
    visibility: "business",
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,quote_id,type",
    insertAttack: (fx, tenant) => ({
      tenant_id: tenant,
      quote_id: fx.orgs.B.quoteIds[0],
      type: "ataque",
      actor_type: "user",
    }),
    updateAttack: () => ({ type: "ataque" }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "quote_packages",
    visibility: "business",
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,quote_id,state,email_subject",
    insertAttack: (fx, tenant) => ({
      id: randomUUID(),
      tenant_id: tenant,
      quote_id: fx.orgs.B.share!.quoteId,
      send_key: randomUUID(),
      issue_date: "2026-01-01",
      valid_until: "2026-12-31",
      email_subject: "ataque",
      email_body_md: "ataque",
      customer_snapshot_enc: "ataque",
      created_by: fx.personas.ana.userId,
    }),
    updateAttack: () => ({ state: "abandoned", email_subject: "ataque" }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "share_links",
    visibility: "business",
    idColumn: "id",
    ownedByB: byTenantB,
    // Sin `token_sha256`: el sello del token no se lee con un pase.
    readColumns: "id,tenant_id,quote_id,package_id,view_count",
    starSelectRejected: true,
    insertAttack: (fx, tenant) => ({
      id: randomUUID(),
      tenant_id: tenant,
      quote_id: fx.orgs.B.share!.quoteId,
      package_id: fx.orgs.B.share!.packageId,
      email_message_id: randomUUID(),
      token_sha256: "e".repeat(64),
    }),
    updateAttack: () => ({ revoked_at: new Date().toISOString(), revoke_reason: "manual" }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "share_link_views",
    visibility: "business",
    rolesThatRead: ["owner", "admin"],
    idColumn: "id",
    ownedByB: byTenantB,
    // Sin `ip_enc` ni `user_agent_short`: son datos personales de quien abrió el enlace.
    readColumns: "id,tenant_id,share_link_id,viewed_at",
    starSelectRejected: true,
    insertAttack: (fx, tenant) => ({
      tenant_id: tenant,
      share_link_id: fx.orgs.B.share!.shareLinkId,
    }),
    updateAttack: () => ({ user_agent_short: "ataque" }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "email_messages",
    visibility: "business",
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,quote_id,kind,status",
    insertAttack: (fx, tenant) => ({
      id: randomUUID(),
      tenant_id: tenant,
      quote_id: fx.orgs.B.share!.quoteId,
      package_id: fx.orgs.B.share!.packageId,
      kind: "internal_notice",
      to_email_enc: "ataque",
      to_email_hash: "c".repeat(64),
      provider: "memory",
    }),
    updateAttack: () => ({ status: "bounced", bounce_type: "hard" }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "quote_responses",
    visibility: "business",
    idColumn: "id",
    ownedByB: byTenantB,
    // Sin `ip_enc` ni `user_agent_short`: datos personales de quien respondió.
    readColumns: "id,tenant_id,quote_id,decision,responded_at",
    starSelectRejected: true,
    insertAttack: (fx, tenant) => ({
      id: randomUUID(),
      tenant_id: tenant,
      quote_id: fx.orgs.B.share!.quoteId,
      package_id: fx.orgs.B.share!.packageId,
      share_link_id: fx.orgs.B.share!.shareLinkId,
      decision: "rejected",
      response_key: randomUUID(),
      reason_code: "price_too_high",
      package_content_sha256: "b".repeat(64),
    }),
    updateAttack: () => ({ decision: "rejected", reason_code: "price_too_high" }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "intake_forms",
    visibility: "business",
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,name,title,status",
    // Sin `daily_cap`: el tope diario solo lo lee quien maneja formularios, por `intake_form_daily_caps`.
    starSelectRejected: true,
    insertAttack: (_fx, tenant, marker) => ({
      id: randomUUID(),
      tenant_id: tenant,
      name: marker,
      title: marker,
    }),
    updateAttack: (marker) => ({ title: marker, status: "published" }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "intake_form_items",
    visibility: "business",
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,form_id,public_name,unit",
    insertAttack: (fx, tenant, marker) => ({
      id: randomUUID(),
      tenant_id: tenant,
      form_id: fx.orgs.B.intake!.formId,
      position: 9,
      kind: "free",
      public_name: marker,
      unit: "unit",
    }),
    updateAttack: (marker) => ({ public_name: marker }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "intake_requests",
    visibility: "business",
    idColumn: "id",
    ownedByB: byTenantB,
    // Sin `consent_ip_enc`: la IP cifrada del consentimiento no la lee ningún pase.
    readColumns: "id,tenant_id,form_id,status,created_at",
    starSelectRejected: true,
    insertAttack: (fx, tenant) => ({
      id: randomUUID(),
      tenant_id: tenant,
      form_id: fx.orgs.B.intake!.formId,
      contact_name_enc: "ataque",
      contact_email_enc: "ataque",
      contact_email_hash: "a".repeat(64),
      items: [
        {
          form_item_id: fx.orgs.B.intake!.freeItemId,
          name: "ataque",
          unit: "unit",
          quantity_milli: 1000,
        },
      ],
      form_revision: 1,
      submit_key: randomUUID(),
      consent_template_version: "intake-v1",
      consent_text: "Acepto que la organización use mis datos para responder esta solicitud.",
      consent_text_sha256: createHash("sha256")
        .update("Acepto que la organización use mis datos para responder esta solicitud.")
        .digest("hex"),
    }),
    updateAttack: () => ({ status: "discarded", discard_reason: "spam" }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "intake_daily_counters",
    visibility: "business",
    // Los envíos bloqueados y los topes solo los ven Dueño y Administrador.
    rolesThatRead: ["owner", "admin"],
    idColumn: "form_id",
    ownedByB: byTenantB,
    readColumns: "tenant_id,form_id,day,accepted",
    insertAttack: (fx, tenant) => ({
      tenant_id: tenant,
      form_id: fx.orgs.B.intake!.formId,
      day: "2026-01-01",
      accepted: 999,
    }),
    updateAttack: () => ({ accepted: 0, blocked_cap: 0 }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "invitations",
    visibility: "business",
    // Las invitaciones (correo del invitado) solo las ven quienes manejan el equipo.
    rolesThatRead: ["owner", "admin"],
    idColumn: "id",
    ownedByB: byTenantB,
    // Sin `token_sha256`, `email_binding` ni `email_hash`: ningún pase los lee.
    readColumns: "id,tenant_id,role,status",
    starSelectRejected: true,
    insertAttack: (fx, tenant) => ({
      id: randomUUID(),
      tenant_id: tenant,
      email_enc: "ataque",
      email_hash: "d".repeat(64),
      email_binding: "d".repeat(64),
      role: "viewer",
      token_sha256: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      invited_by: fx.personas.ana.userId,
    }),
    updateAttack: () => ({ role: "admin", status: "revoked" }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "text_snippets",
    visibility: "business",
    // Todo miembro de la organización activa los lee; nadie escribe directo (solo las tres funciones).
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,kind,name,body",
    insertAttack: (_fx, tenant, marker) => ({
      id: randomUUID(),
      tenant_id: tenant,
      kind: "conditions",
      name: marker.slice(0, 80),
      body: marker,
    }),
    updateAttack: (marker) => ({ body: marker, name: marker.slice(0, 80) }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "approval_rules",
    visibility: "business",
    // Todo miembro de la organización activa la lee; nadie escribe directo (solo `set_approval_rule`) y el historial es de solo agregar.
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,version,mode,amount_threshold_clp",
    insertAttack: (fx, tenant) => ({
      tenant_id: tenant,
      version: 99,
      mode: "always",
      created_by: fx.personas.ana.userId,
    }),
    updateAttack: () => ({ mode: "never", amount_threshold_clp: 1 }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "numbering_settings",
    visibility: "business",
    idColumn: "tenant_id",
    ownedByB: byTenantB,
    readColumns: "tenant_id,prefix,mode",
    insertAttack: (_fx, tenant, marker) => ({ tenant_id: tenant, prefix: marker.slice(0, 8) }),
    updateAttack: () => ({ prefix: "ATAQUE" }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "numbering_sequences",
    visibility: "business",
    idColumn: "scope",
    ownedByB: byTenantB,
    readColumns: "tenant_id,scope,last_number",
    insertAttack: (_fx, tenant) => ({ tenant_id: tenant, scope: "continuous", last_number: 0 }),
    updateAttack: () => ({ last_number: 0 }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "audit_log",
    visibility: "business",
    rolesThatRead: ["owner"],
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,action,resource_type",
    insertAttack: (_fx, tenant, marker) => ({
      tenant_id: tenant,
      actor_type: "user",
      action: "ataque.registro",
      result: "success",
      details: { marker },
    }),
    updateAttack: (marker) => ({ details: { marker } }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "tenants",
    visibility: "selector-tenants",
    idColumn: "tenant_id",
    ownedByB: byTenantB,
    readColumns: "tenant_id,name,status",
    insertAttack: (_fx, tenant, marker) => ({ tenant_id: tenant, name: marker, rut: "76086428-5" }),
    updateAttack: (marker) => ({ name: marker }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "members",
    visibility: "selector-members",
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,user_id,role",
    insertAttack: (fx, tenant) => ({
      tenant_id: tenant,
      user_id: fx.personas.ana.userId,
      role: "owner",
    }),
    updateAttack: () => ({ role: "owner" }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "profiles",
    visibility: "profiles",
    idColumn: "user_id",
    ownedByB: (fx) => `user_id = '${fx.personas.beto.userId}'`,
    // Sin `last_tenant_id`: esa columna es privada de cada persona (migración 12).
    readColumns: "user_id,tenant_id,full_name",
    insertAttack: (fx, _tenant, marker) => ({ user_id: fx.personas.ana.userId, full_name: marker }),
    updateAttack: (marker) => ({ full_name: marker }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "legal_acceptances",
    visibility: "own-user",
    idColumn: "id",
    ownedByB: (fx) => `user_id = '${fx.personas.beto.userId}'`,
    readColumns: "id,tenant_id,user_id,document_id",
    insertAttack: (fx) => ({ user_id: fx.personas.beto.userId, context: "reaccept" }),
    updateAttack: () => ({ context: "signup" }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
  },
  {
    name: "legal_documents",
    visibility: "public",
    idColumn: "id",
    ownedByB: () => "true",
    readColumns: "id,tenant_id,kind,version",
    insertAttack: (_fx, _tenant, marker) => ({
      kind: "terms",
      version: marker,
      content_sha256: "0".repeat(64),
      published_at: new Date().toISOString(),
    }),
    updateAttack: () => ({ is_current: false }),
    hasFixtureRowsInB: false,
    ownWriteAccepted: false,
  },
  {
    name: "auth_rate_limits",
    visibility: "server-only",
    idColumn: "key_hash",
    ownedByB: () => "true",
    readColumns: "scope,key_hash,failures",
    insertAttack: (_fx, _tenant, marker) => ({
      scope: "login_ip",
      key_hash: "f".repeat(63) + (marker.length % 10),
    }),
    updateAttack: () => ({ failures: 0 }),
    hasFixtureRowsInB: false,
    ownWriteAccepted: false,
  },
  // Sprint 5 · H-118a: los avisos de activación del segundo paso y sus enlaces de anulación. Tablas de la plataforma (como
  // `auth_rate_limits`): solo el servidor las lee y las escribe, y siempre por funciones de la base.
  {
    name: "mfa_enrollment_alerts",
    visibility: "server-only",
    idColumn: "id",
    ownedByB: () => "true",
    readColumns: "id,tenant_id,user_id,factor_id,state",
    insertAttack: (fx, _tenant, marker) => ({
      user_id: fx.personas.ana.userId,
      factor_id: randomUUID(),
      state: "pending",
      expected_until: new Date().toISOString(),
      error_code: `ataque-${marker.length}`,
    }),
    updateAttack: () => ({ state: "closed" }),
    hasFixtureRowsInB: false,
    ownWriteAccepted: false,
  },
  {
    name: "mfa_annul_links",
    visibility: "server-only",
    idColumn: "id",
    ownedByB: () => "true",
    readColumns: "id,tenant_id,user_id,alert_id,token_sha256",
    insertAttack: (fx, _tenant, marker) => ({
      user_id: fx.personas.ana.userId,
      alert_id: randomUUID(),
      token_sha256: "f".repeat(63) + (marker.length % 10),
      expires_at: new Date().toISOString(),
    }),
    updateAttack: () => ({ used_at: new Date().toISOString() }),
    hasFixtureRowsInB: false,
    ownWriteAccepted: false,
  },
];

/** Cómo se llama a una función expuesta por la API (RPC) y qué se espera de ella. */
export interface RpcCase {
  /** Argumentos válidos de una llamada normal. */
  args: object;
  /** ¿Escribe o lee datos que exigen una organización activa propia? Entonces con una organización ajena debe fallar. */
  writesActiveTenant: boolean;
}

export const RPC_CASES: Record<string, RpcCase> = {
  set_numbering: {
    args: { p_prefix: "ATAQUE", p_mode: "yearly", p_start_number: 9999 },
    writesActiveTenant: true,
  },
  preview_next_quote_number: { args: {}, writesActiveTenant: false },
  accept_current_legal_documents: { args: {}, writesActiveTenant: false },
  create_tenant: {
    args: { p_name: "Negocio de ataque", p_rut: "76086428-5" },
    writesActiveTenant: false,
  },
  my_last_tenant_id: { args: {}, writesActiveTenant: false },
  // Ataque: apuntar el logo a un archivo que no existe en la carpeta de la organización activa.
  save_tenant_brand: {
    args: {
      p_primary_color: "#000000",
      p_secondary_color: "#000000",
      p_logo_mode: "set",
      p_logo_path: `${randomUUID()}/logo-000000000000.png`,
    },
    writesActiveTenant: true,
  },
  create_quote: {
    args: { p_customer_id: randomUUID(), p_creation_key: randomUUID() },
    writesActiveTenant: true,
  },
  save_quote_draft: {
    args: {
      p_quote_id: randomUUID(),
      p_expected_revision: 1,
      p_save_id: randomUUID(),
      p_header: { customer_id: randomUUID(), global_discount: { kind: "none", value: 0 } },
      p_items: [],
      p_expected_totals: {},
    },
    writesActiveTenant: true,
  },
  // Sprint 3 · envío de la cotización. Los argumentos son válidos en forma y apuntan a nada propio.
  prepare_quote_send: {
    args: {
      p_quote_id: randomUUID(),
      p_expected_revision: 1,
      p_send_key: randomUUID(),
      p_package_id: randomUUID(),
      p_email_message_id: randomUUID(),
      p_share_link_id: randomUUID(),
      p_token_sha256: "a".repeat(64),
      p_email_subject: "Ataque",
      p_email_body_md: "Ataque",
      p_to_email_enc: "ataque",
      p_to_email_hash: "b".repeat(64),
      p_customer_snapshot_enc: "ataque",
    },
    writesActiveTenant: true,
  },
  attach_quote_package_document: {
    args: {
      p_package_id: randomUUID(),
      p_pdf_path: `${randomUUID()}/${randomUUID()}/${randomUUID()}.pdf`,
      p_pdf_sha256: "a".repeat(64),
      p_pdf_bytes: 10,
      p_logo_path: null,
      p_document_snapshot: {},
      p_content_sha256: "b".repeat(64),
      p_token_sha256: "c".repeat(64),
    },
    writesActiveTenant: true,
  },
  confirm_email_dispatch: {
    args: {
      p_email_message_id: randomUUID(),
      p_provider: "memory",
      p_provider_message_id: "ataque",
      p_token_sha256: "c".repeat(64),
    },
    writesActiveTenant: true,
  },
  fail_email_dispatch: {
    args: {
      p_email_message_id: randomUUID(),
      p_error_code: "ataque",
      p_token_sha256: "c".repeat(64),
    },
    writesActiveTenant: true,
  },
  prepare_quote_resend: {
    args: {
      p_quote_id: randomUUID(),
      p_resend_key: randomUUID(),
      p_email_message_id: randomUUID(),
      p_share_link_id: randomUUID(),
      p_token_sha256: "a".repeat(64),
      p_to_email_enc: "ataque",
      p_to_email_hash: "b".repeat(64),
    },
    writesActiveTenant: true,
  },
  revoke_quote_links: { args: { p_quote_id: randomUUID() }, writesActiveTenant: true },
  // Sprint 4 · formularios públicos (M29). Los argumentos son válidos en forma y apuntan a nada propio.
  create_intake_form: {
    args: { p_form_id: randomUUID(), p_name: "Ataque" },
    writesActiveTenant: true,
  },
  save_intake_form: {
    args: { p_form_id: randomUUID(), p_expected_revision: 1, p_form: {}, p_items: null },
    writesActiveTenant: true,
  },
  set_intake_form_status: {
    args: { p_form_id: randomUUID(), p_status: "paused" },
    writesActiveTenant: true,
  },
  regenerate_intake_form_public_id: { args: { p_form_id: randomUUID() }, writesActiveTenant: true },
  // Lee (no escribe) el tope diario, pero exige organización activa propia y el permiso de manejar formularios.
  intake_form_daily_caps: { args: { p_form_id: randomUUID() }, writesActiveTenant: true },
  // Sprint 4 · solicitudes del formulario público (M32).
  assign_intake_request: {
    args: { p_request_id: randomUUID(), p_assignee_user_id: randomUUID() },
    writesActiveTenant: true,
  },
  discard_intake_request: {
    args: { p_request_id: randomUUID(), p_reason: "spam", p_note: null },
    writesActiveTenant: true,
  },
  restore_intake_request: { args: { p_request_id: randomUUID() }, writesActiveTenant: true },
  // Derecho de supresión de quien llenó el formulario (solo Dueño y Administrador).
  anonymize_intake_request: {
    args: { p_request_id: randomUUID(), p_reason: "data_subject_request" },
    writesActiveTenant: true,
  },
  convert_intake_request: {
    args: { p_request_id: randomUUID(), p_customer_id: randomUUID(), p_creation_key: randomUUID() },
    writesActiveTenant: true,
  },
  // Sprint 5 · invitar a un miembro (H-008). Los argumentos son válidos en forma y apuntan a nada propio.
  create_invitation: {
    args: {
      p_invitation_id: randomUUID(),
      p_email_enc: "ataque",
      p_email_hash: "e".repeat(64),
      p_email_binding: "e".repeat(64),
      p_token_sha256: "f".repeat(64),
      p_role: "viewer",
      p_email_message_id: randomUUID(),
      p_to_email_enc: "ataque",
    },
    writesActiveTenant: true,
  },
  resend_invitation: {
    args: {
      p_invitation_id: randomUUID(),
      p_email_binding: "e".repeat(64),
      p_token_sha256: "f".repeat(64),
      p_email_message_id: randomUUID(),
      p_to_email_enc: "ataque",
    },
    writesActiveTenant: true,
  },
  revoke_invitation: { args: { p_invitation_id: randomUUID() }, writesActiveTenant: true },
  // Sprint 5 · cambiar el rol de un miembro o quitarlo (H-010). Los argumentos son válidos en forma y apuntan a nada propio.
  // `list_members` no recibe argumentos: la organización sale de la membresía.
  list_members: { args: {}, writesActiveTenant: true },
  change_member_role: {
    args: { p_member_id: randomUUID(), p_new_role: "viewer", p_expected_role: "sales" },
    writesActiveTenant: true,
  },
  remove_member: {
    args: { p_member_id: randomUUID(), p_expected_role: "sales" },
    writesActiveTenant: true,
  },
  // Sprint 5 · textos listos para usar (H-048a). Los argumentos son válidos en forma y apuntan a nada propio.
  create_text_snippet: {
    args: {
      p_snippet_id: randomUUID(),
      p_kind: "conditions",
      p_name: "Ataque",
      p_body: "Texto de ataque.",
      p_is_default: false,
    },
    writesActiveTenant: true,
  },
  update_text_snippet: {
    args: {
      p_snippet_id: randomUUID(),
      p_expected_revision: 1,
      p_name: "Ataque",
      p_body: "Texto de ataque.",
      p_is_default: false,
    },
    writesActiveTenant: true,
  },
  delete_text_snippet: { args: { p_snippet_id: randomUUID() }, writesActiveTenant: true },
  // Sprint 5 · la regla de aprobación (H-040a). Los argumentos son válidos en forma y apuntan a nada propio.
  set_approval_rule: {
    args: {
      p_expected_version: 1,
      p_mode: "always",
      p_amount_threshold_clp: null,
      p_discount_threshold_bp: null,
    },
    writesActiveTenant: true,
  },
  // Sprint 5 · aceptar una invitación (H-009). Corren con sesión y SIN organización activa (la persona todavía no es
  // miembro; la organización la define la invitación y la decide la base), por eso no exigen una propia.
  invitation_preview: { args: { p_token_sha256: "a".repeat(64) }, writesActiveTenant: false },
  accept_invitation: { args: { p_token_sha256: "a".repeat(64) }, writesActiveTenant: false },
};

/** Funciones de `public` que solo ejecuta el servidor con la llave maestra: nadie con pase las llama. */
export const SERVER_ONLY_FUNCTIONS = [
  "auth_limit_locked_until",
  "auth_limit_record_failure",
  "auth_limit_clear",
  // Sprint 3: el portero del enlace del cliente (decisión 017)
  "share_link_read",
  "share_link_record_view",
  "share_link_respond",
  // Sprint 3 (H-031): destinatarios del aviso interno ya filtrados por la base, y su registro
  "share_notice_recipients",
  "internal_notice_register",
  "internal_notice_settle",
  // Sprint 3: los avisos del proveedor de correo (la ruta verifica la firma antes de llamarla)
  "record_email_event",
  // Sprint 4: el portero del formulario público (leer, recibir una solicitud, contar bloqueos) y sus avisos
  "intake_form_read",
  "intake_request_submit",
  "intake_record_block",
  "intake_notice_recipients",
  "intake_notice_register",
  "intake_notice_settle",
  // Sprint 5: cerrar el envío del correo de una invitación (el servidor, con lo que informó el proveedor)
  "invitation_email_settle",
  // Sprint 5: el aviso al Dueño cuando alguien que no lo es invita a un Administrador (destinatarios ya filtrados y registro)
  "invitation_notices_pending",
  "invitation_notice_recipients",
  "invitation_notice_register",
  // Sprint 5 · H-118a: el permiso de activación del segundo paso, la reserva y el cierre del aviso, y la reversión (el servidor)
  "mfa_alert_expect",
  "mfa_alerts_reserve",
  "mfa_alert_settle",
  "mfa_alert_revert",
  // Sprint 5 · H-118b: tomar, completar y soltar el enlace de anulación, y cerrar lo que quede de las sesiones (el servidor)
  "mfa_annul_claim",
  "mfa_annul_complete",
  "mfa_annul_release",
  "mfa_revoke_sessions",
];

/**
 * Qué tablas NO son "de negocio" y cómo se ven. Lista cerrada: toda otra tabla con `tenant_id`
 * debe declararse `business`. Así nadie puede esconder una tabla de negocio declarándola "public"
 * u "own-user" para que la prueba la trate con menos rigor. Agregar una entrada aquí es una
 * decisión de diseño que se revisa, no un trámite.
 */
export const NON_BUSINESS_VISIBILITY: Readonly<Record<string, Visibility>> = {
  legal_documents: "public",
  tenants: "selector-tenants",
  members: "selector-members",
  profiles: "profiles",
  legal_acceptances: "own-user",
  auth_rate_limits: "server-only",
  mfa_enrollment_alerts: "server-only",
  mfa_annul_links: "server-only",
};

/** Errores de declaración de visibilidad del registro (vacío si todo calza con la lista cerrada). */
export function visibilityDeclarationErrors(
  tables: readonly Pick<TableSpec, "name" | "visibility">[],
): string[] {
  const errors: string[] = [];
  for (const table of tables) {
    const expected = NON_BUSINESS_VISIBILITY[table.name] ?? "business";
    if (table.visibility !== expected) {
      errors.push(`${table.name}: declarada ${table.visibility}, debe ser ${expected}`);
    }
  }
  return errors;
}

/**
 * Una dirección de la aplicación (pantalla o ruta de servidor) y cómo se prueba.
 * - `tenant`: vive dentro de una organización (`/o/[tenantId]/...`) y exige `requireActiveTenant`.
 * - `none`: no hay organización que aislar (ingreso, registro, términos, `/api/v1/ping`, etc.).
 *   Cada una se declara a mano: una ruta nueva sin declarar rompe la guardia G5.
 * - `token`: la abre el cliente final SIN cuenta con el token de su enlace (`/c/[token]` y
 *   `/api/v1/public/quote-links/[token]/...`). La organización sale de la fila del enlace, nunca de la
 *   dirección; pasan por el portero (`src/lib/share/gateway.ts`) con el token y los límites validados.
 * - `signed`: la llama un proveedor externo (avisos de entrega del correo, `/api/v1/webhooks/...`), sin
 *   sesión ni token: solo vale con la firma del proveedor verificada ANTES de mirar el cuerpo o tocar
 *   la base (guardia 8e).
 * - `form`: la abre un desconocido SIN cuenta con el identificador público de un formulario (`/f/[publicId]`
 *   y `/api/v1/public/forms/[publicId]/...`). La organización sale de la fila del formulario, nunca de la
 *   dirección; pasan por el portero (`src/lib/intake/gateway.ts`). Estas rutas ESCRIBEN datos de un
 *   desconocido, así que toda ruta `form` con POST comprueba el `Origin` antes que cualquier otra cosa
 *   (guardia 10b).
 */
export type RouteScope = "tenant" | "none" | "token" | "signed" | "form";

export interface AppRoute {
  /** Como la escribe Next.js, p. ej. `/o/[tenantId]/clientes/[customerId]`. Sin grupos `(x)`. */
  path: string;
  /** `page` = page.*; `api` = route.* bajo `/api/v1`; `route` = otro route.* (p. ej. `/auth/callback`). */
  kind: "page" | "api" | "route";
  scope: RouteScope;
}

export const APP_ROUTES: AppRoute[] = [
  { path: "/", kind: "page", scope: "none" },
  { path: "/ingresar", kind: "page", scope: "none" },
  // H-004a: el código de la verificación en dos pasos (única pantalla que acepta una sesión parcial) y la seguridad de la
  // cuenta. Son de la persona, no de una organización.
  { path: "/ingresar/codigo", kind: "page", scope: "none" },
  { path: "/cuenta/seguridad", kind: "page", scope: "none" },
  // H-118b: pública y sin sesión. Al abrirla no lee ningún código ni consulta nada; solo la acción de servidor (con el código
  // del enlace, de un solo uso) hace algo. La acción pasa por el servicio de anulación, nunca por una organización.
  { path: "/cuenta/anular-dos-pasos", kind: "page", scope: "none" },
  { path: "/registro", kind: "page", scope: "none" },
  { path: "/aceptar-terminos", kind: "page", scope: "none" },
  { path: "/recuperar-contrasena", kind: "page", scope: "none" },
  { path: "/restablecer-contrasena", kind: "page", scope: "none" },
  { path: "/organizaciones/nueva", kind: "page", scope: "none" },
  { path: "/privacidad", kind: "page", scope: "none" },
  { path: "/terminos", kind: "page", scope: "none" },
  { path: "/auth/callback", kind: "route", scope: "none" },
  // H-009: la invitación se acepta con sesión y la decide la base; la ruta del enlace solo guarda una cookie.
  { path: "/invitacion", kind: "page", scope: "none" },
  { path: "/invitacion/[token]", kind: "route", scope: "none" },
  { path: "/auth/recuperar", kind: "route", scope: "none" },
  { path: "/api/v1/ping", kind: "api", scope: "none" },
  { path: "/api/v1/tenants/[tenantId]/logo", kind: "api", scope: "tenant" },
  { path: "/api/v1/tenants/[tenantId]/quotes/[quoteId]/pdf", kind: "api", scope: "tenant" },
  { path: "/api/v1/tenants/[tenantId]/intake-forms/[formId]/qr", kind: "api", scope: "tenant" },
  { path: "/c/[token]", kind: "page", scope: "token" },
  { path: "/api/v1/public/quote-links/[token]/pdf", kind: "api", scope: "token" },
  { path: "/api/v1/public/quote-links/[token]/view", kind: "api", scope: "token" },
  { path: "/api/v1/public/quote-links/[token]/accept", kind: "api", scope: "token" },
  { path: "/api/v1/public/quote-links/[token]/reject", kind: "api", scope: "token" },
  { path: "/f/[publicId]", kind: "page", scope: "form" },
  // H-093: la misma pantalla para pegar en el sitio web de la organización (sin marco de afuera).
  { path: "/f/[publicId]/incrustar", kind: "page", scope: "form" },
  { path: "/api/v1/public/forms/[publicId]/requests", kind: "api", scope: "form" },
  { path: "/api/v1/webhooks/email/[provider]", kind: "api", scope: "signed" },
  { path: "/o/[tenantId]", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/catalogo", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/catalogo/[itemId]", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/clientes", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/clientes/nuevo", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/clientes/[customerId]", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/clientes/[customerId]/editar", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/configuracion", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/configuracion/actividad", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/configuracion/aprobaciones", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/configuracion/empresa", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/configuracion/marca", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/configuracion/numeracion", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/configuracion/textos", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/configuracion/textos/nuevo", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/configuracion/textos/[snippetId]", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/cotizaciones", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/equipo", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/equipo/[memberId]", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/cotizaciones/nueva", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/cotizaciones/[quoteId]", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/cotizaciones/[quoteId]/enviar", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/formularios", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/formularios/nuevo", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/formularios/[formId]", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/solicitudes", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/solicitudes/[requestId]", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/solicitudes/[requestId]/convertir", kind: "page", scope: "tenant" },
];

/** Pantallas dentro de una organización (las que se atacan con la dirección de otra). */
export const TENANT_PAGES = APP_ROUTES.filter((r) => r.kind === "page" && r.scope === "tenant");

/** Dirección concreta de una ruta de pantalla para una organización (y un cliente, si lo pide). */
export function concretePath(
  route: AppRoute,
  tenantId: string,
  customerId: string,
  itemId: string,
  quoteId: string = itemId,
  formId: string = itemId,
  requestId: string = itemId,
  snippetId: string = itemId,
  memberId: string = itemId,
): string {
  return route.path
    .replace("[tenantId]", tenantId)
    .replace("[customerId]", customerId)
    .replace("[itemId]", itemId)
    .replace("[quoteId]", quoteId)
    .replace("[formId]", formId)
    .replace("[requestId]", requestId)
    .replace("[snippetId]", snippetId)
    .replace("[memberId]", memberId);
}

/** Qué se pide para "ver todo" de una tabla: `*`, o las columnas legibles si hay columnas privadas. */
export const allColumnsOf = (spec: Pick<TableSpec, "starSelectRejected" | "readColumns">) =>
  spec.starSelectRejected ? spec.readColumns : "*";

/** Personas con acceso de lectura a una organización, según el rol. */
export function canReadRole(spec: TableSpec, role: Role | null): boolean {
  if (role === null) return false;
  return spec.rolesThatRead ? spec.rolesThatRead.includes(role) : true;
}

export type { PersonaKey };
