// Datos de prueba ficticios para Supabase LOCAL (modelo-datos.md §8.1 y §9.3).
// Uso: npm run db:seed. Es idempotente: puede correr varias veces.
// Se niega a correr si la URL de Supabase no es local. Nunca datos reales.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { computeCheckDigit, normalizeRut } from "../src/lib/chile/rut";
import { encryptPii } from "../src/lib/crypto/pii";
import { searchHash } from "../src/lib/crypto/search-hash";
import { normalizeEmail } from "../src/lib/normalize/email";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const TEST_PASSWORD = "Prueba-Cotiza-2026"; // solo para cuentas ficticias locales
const CUSTOMERS_PER_TENANT = 5;

type Role = "owner" | "admin" | "approver" | "sales" | "viewer";

const TENANTS = [
  { key: "A", name: "Negocio Demo 1", rutBody: "76000001", industry: "services" },
  { key: "B", name: "Negocio Demo 2", rutBody: "76000002", industry: "logistics" },
] as const;

type TenantKey = (typeof TENANTS)[number]["key"];

const PEOPLE: {
  email: string;
  fullName: string;
  memberships: { tenant: TenantKey; role: Role; removed?: boolean }[];
}[] = [
  {
    email: "ana@ejemplo.test",
    fullName: "Ana Prueba",
    memberships: [{ tenant: "A", role: "owner" }],
  },
  {
    email: "beto@ejemplo.test",
    fullName: "Beto Prueba",
    memberships: [{ tenant: "B", role: "owner" }],
  },
  {
    // Solo puede haber un Dueño activo por organización: la persona mixta es Administradora de ambas.
    email: "mixta@ejemplo.test",
    fullName: "Mixta Prueba",
    memberships: [
      { tenant: "A", role: "admin" },
      { tenant: "B", role: "admin" },
    ],
  },
  {
    email: "ex@ejemplo.test",
    fullName: "Ex Prueba",
    memberships: [{ tenant: "A", role: "sales", removed: true }],
  },
];

const SERVICES = [
  { name: "Flete urbano", unit: "service", price: 45000 },
  { name: "Mudanza completa", unit: "day", price: 280000 },
  { name: "Traslado por kilómetro", unit: "km", price: 1200 },
  { name: "Instalación técnica", unit: "hour", price: 18000 },
  { name: "Embalaje de muebles", unit: "unit", price: 6500 },
] as const;

const CUSTOMER_NAMES = [
  "Comercial Los Aromos",
  "Constructora Cordillera",
  "María Fernández Soto",
  "Ferretería El Tornillo",
  "Juan Pablo Rojas",
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name} (revisa .env.local)`);
  return value;
}

function assertLocal(url: string): void {
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) {
    throw new Error(`Por seguridad, el seed solo corre contra Supabase local, no contra ${url}`);
  }
}

function check<T>(label: string, result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

/** UUID estable derivado de un texto, para que correr dos veces no duplique filas. */
function stableUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function findUserId(admin: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const found = data.users.find((u) => u.email === email);
    if (found) return found.id;
    if (data.users.length < 200) return null;
  }
}

async function seedUsers(admin: SupabaseClient): Promise<Map<string, string>> {
  const docs = check(
    "legal_documents",
    await admin.from("legal_documents").select("id, kind, version").eq("is_current", true),
  ) as { id: string; kind: string; version: string }[];
  const acceptedLegal = Object.fromEntries(docs.map((d) => [d.kind, d.version]));

  const ids = new Map<string, string>();
  for (const person of PEOPLE) {
    let id = await findUserId(admin, person.email);
    if (!id) {
      const { data, error } = await admin.auth.admin.createUser({
        email: person.email,
        password: TEST_PASSWORD,
        email_confirm: true,
        user_metadata: {
          full_name: person.fullName,
          ...(docs.length > 0 ? { accepted_legal: acceptedLegal } : {}),
        },
      });
      if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
      id = data.user.id;
    }
    ids.set(person.email, id);

    // Si había documentos vigentes y la cuenta ya existía sin aceptación, se registra ahora.
    for (const doc of docs) {
      check(
        "legal_acceptances",
        await admin
          .from("legal_acceptances")
          .upsert(
            { user_id: id, document_id: doc.id, context: "signup" },
            { onConflict: "user_id,document_id", ignoreDuplicates: true },
          ),
      );
    }
  }
  return ids;
}

async function seedTenants(
  admin: SupabaseClient,
  ownerIds: Map<TenantKey, string>,
): Promise<Map<TenantKey, string>> {
  const result = new Map<TenantKey, string>();
  for (const t of TENANTS) {
    const rut = `${t.rutBody}-${computeCheckDigit(t.rutBody)}`;
    const existing = check(
      "tenants",
      await admin.from("tenants").select("tenant_id").eq("rut", rut).eq("kind", "organization"),
    ) as { tenant_id: string }[];
    let tenantId = existing[0]?.tenant_id;
    if (!tenantId) {
      const created = check(
        "tenants insert",
        await admin
          .from("tenants")
          .insert({
            name: t.name,
            rut,
            industry: t.industry,
            contact_email: `contacto.${t.key.toLowerCase()}@ejemplo.test`,
            created_by: ownerIds.get(t.key),
          })
          .select("tenant_id")
          .single(),
      ) as { tenant_id: string };
      tenantId = created.tenant_id;
    }
    check(
      "numbering_settings",
      await admin
        .from("numbering_settings")
        .upsert({ tenant_id: tenantId }, { onConflict: "tenant_id", ignoreDuplicates: true }),
    );
    result.set(t.key, tenantId);
  }
  return result;
}

async function seedMembers(
  admin: SupabaseClient,
  userIds: Map<string, string>,
  tenantIds: Map<TenantKey, string>,
): Promise<void> {
  for (const person of PEOPLE) {
    for (const m of person.memberships) {
      const row = {
        tenant_id: tenantIds.get(m.tenant)!,
        user_id: userIds.get(person.email)!,
        role: m.role,
        status: m.removed ? "removed" : "active",
        removed_at: m.removed ? new Date().toISOString() : null,
      };
      const existing = check(
        "members select",
        await admin
          .from("members")
          .select("id")
          .eq("tenant_id", row.tenant_id)
          .eq("user_id", row.user_id),
      ) as { id: string }[];
      if (existing.length === 0) {
        check("members insert", await admin.from("members").insert(row));
      }
    }
  }
}

async function seedCatalog(admin: SupabaseClient, tenantId: string): Promise<void> {
  const existing = check(
    "catalog select",
    await admin.from("catalog_items").select("name").eq("tenant_id", tenantId),
  ) as { name: string }[];
  const have = new Set(existing.map((r) => r.name));
  const rows = SERVICES.filter((s) => !have.has(s.name)).map((s) => ({
    tenant_id: tenantId,
    name: s.name,
    unit: s.unit,
    unit_price_clp: s.price,
  }));
  if (rows.length > 0) check("catalog insert", await admin.from("catalog_items").insert(rows));
}

async function seedCustomers(
  admin: SupabaseClient,
  tenantKey: TenantKey,
  tenantId: string,
): Promise<void> {
  const ids = Array.from({ length: CUSTOMERS_PER_TENANT }, (_, i) =>
    stableUuid(`seed-customer|${tenantId}|${i}`),
  );
  const existing = check(
    "customers select",
    await admin.from("customers").select("id").eq("tenant_id", tenantId).in("id", ids),
  ) as { id: string }[];
  const have = new Set(existing.map((r) => r.id));

  const rows = ids.flatMap((id, i) => {
    if (have.has(id)) return [];
    const ctx = (field: string) => ({ table: "customers", field, tenantId, rowId: id });
    const email = normalizeEmail(`cliente${i + 1}.${tenantKey.toLowerCase()}@ejemplo.test`);
    const rutBody = String(15_000_000 + i * 111_111 + (tenantKey === "A" ? 0 : 7));
    const rut = normalizeRut(`${rutBody}-${computeCheckDigit(rutBody)}`)!;
    return [
      {
        id,
        tenant_id: tenantId,
        kind: i % 2 === 0 ? "company" : "person",
        display_name: CUSTOMER_NAMES[i],
        email_enc: encryptPii(email, ctx("email")),
        email_hash: searchHash("email", tenantId, email),
        phone_enc: encryptPii(`+56 9 0000 00${String(i + 10)}`, ctx("phone")),
        rut_enc: encryptPii(rut, ctx("rut")),
        rut_hash: searchHash("rut", tenantId, rut),
        address_enc: encryptPii(`Calle Ficticia ${100 + i}, Santiago`, ctx("address")),
      },
    ];
  });
  if (rows.length > 0) check("customers insert", await admin.from("customers").insert(rows));
}

async function main(): Promise<void> {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  assertLocal(url);
  const admin = createClient(url, requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log("PRUEBAS (Supabase local):", url);
  const userIds = await seedUsers(admin);
  const ownerByTenant = new Map<TenantKey, string>([
    ["A", userIds.get("ana@ejemplo.test")!],
    ["B", userIds.get("beto@ejemplo.test")!],
  ]);
  const tenantIds = await seedTenants(admin, ownerByTenant);
  await seedMembers(admin, userIds, tenantIds);
  for (const [key, tenantId] of tenantIds) {
    await seedCatalog(admin, tenantId);
    await seedCustomers(admin, key, tenantId);
  }
  console.log(
    `Listo: ${userIds.size} personas, ${tenantIds.size} organizaciones. Contraseña de prueba: ${TEST_PASSWORD}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
