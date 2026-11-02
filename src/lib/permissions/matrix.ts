/**
 * LA matriz de permisos de Cotiza Prime: el ÚNICO lugar del código donde se escriben los nombres de los
 * roles y qué puede hacer cada uno (PROYECTO.md §5.2; docs/arquitectura/sprint-5-equipo-y-permisos.md §3).
 *
 * Son datos puros: sirven en el servidor, en las pantallas y en el menú, y se pueden leer desde el
 * navegador. El permiso real se exige igual en el servidor (`require.ts`) y en la base de datos
 * (`app.role_can`, migración `role_matrix`); la prueba `tests/db/permissions-parity.test.ts` comprueba
 * que las dos respondan lo mismo para cada acción y cada rol. Cambiar esta tabla obliga a cambiar la
 * migración y la prueba de `matrix.test.ts`, a propósito.
 *
 * Una guardia (`src/lib/permissions/guards.test.ts`) falla si el nombre de un rol aparece
 * escrito fuera de esta carpeta: nadie vuelve a copiar listas de roles en una pantalla.
 *
 * Dos formas de permiso por acción:
 * - `any`: el rol puede hacerlo sobre cualquier recurso de la organización.
 * - `own`: el rol puede hacerlo solo si el recurso es «suyo» (lo creó, o la solicitud está asignada a
 *   él, según la acción). Quién es «suyo» lo decide cada lugar con `ctx.isOwn`.
 */

export const MEMBER_ROLES = ["owner", "admin", "approver", "sales", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Cómo se llama cada rol en la interfaz. Única fuente: menú, selector de organización, auditoría. */
export const ROLE_LABELS: Readonly<Record<MemberRole, string>> = {
  owner: "Dueño",
  admin: "Administrador",
  approver: "Aprobador",
  sales: "Comercial",
  viewer: "Observador",
};

/** La frase que explica qué puede hacer cada rol (para invitar, para el correo y para la lista del equipo). */
export const ROLE_DESCRIPTIONS: Readonly<Record<MemberRole, string>> = {
  owner: "Tiene todo el control de la organización: configuración, equipo, pagos y plan.",
  admin: "Configura la organización, maneja el equipo, aprueba cotizaciones y confirma pagos.",
  approver: "Revisa y aprueba las cotizaciones antes de que salgan. No configura ni toca pagos.",
  sales:
    "Arma y envía sus propias cotizaciones, registra clientes y atiende solicitudes. Lo demás lo ve sin cambiarlo.",
  viewer: "Ve todo lo de la organización, pero no cambia nada.",
};

/** El único mensaje cuando falta permiso: igual en pantallas, acciones y rutas. */
export const NO_PERMISSION_MESSAGE = "No tienes permiso para esto.";

type PermissionRule = {
  readonly any?: readonly MemberRole[];
  readonly own?: readonly MemberRole[];
};

const EVERYONE: readonly MemberRole[] = MEMBER_ROLES;
const MANAGERS: readonly MemberRole[] = ["owner", "admin"];
const WRITERS: readonly MemberRole[] = ["owner", "admin", "sales"];

/**
 * Todas las acciones, también las de sprints futuros (sin pantalla todavía), para que nadie invente
 * otra lista. El orden y los nombres son los mismos de la función `app.role_can` de la base.
 */
export const PERMISSIONS = {
  /** Ver todo lo de la organización (decisión 009: todos ven todo dentro de su organización). */
  "org.view": { any: EVERYONE },

  "quote.create": { any: WRITERS },
  /** Editar y enviar un borrador: solo el autor (decisión 009), aunque sea Dueño o Administrador. */
  "quote.edit": { own: WRITERS },
  "quote.send": { own: WRITERS },
  /** Reenviar el correo y revocar el enlace: el Dueño y los Administradores en todas; el Comercial en las suyas. */
  "quote.resend": { any: MANAGERS, own: ["sales"] },
  "quote.link.revoke": { any: MANAGERS, own: ["sales"] },
  /** Ver quién abrió el enlace del cliente y desde dónde (son datos personales). */
  "quote.link_views.read": { any: MANAGERS },
  /** Sprint 6. */
  "quote.approval.request": { own: WRITERS },
  "quote.approve": { any: ["owner", "admin", "approver"] },

  /** Sprint 6 y 7: el dinero. Nunca el Comercial ni el Aprobador. */
  "bank_account.manage": { any: MANAGERS },
  "payment.confirm": { any: MANAGERS },
  "payment.second.request": { any: MANAGERS, own: ["sales"] },

  /** Crear y editar clientes: cualquier Comercial puede editar cualquier cliente (supuesto 19). */
  "customer.write": { any: WRITERS },

  "catalog.manage": { any: MANAGERS },
  /** Sprint 5 (H-041): cambiar un precio que está bloqueado en el catálogo. */
  "catalog.price_lock.override": { any: MANAGERS },

  /** Empresa, marca, numeración, plantillas, textos y reglas. Los demás roles no ven «Configuración» (supuesto 12). */
  "settings.manage": { any: MANAGERS },
  /** Invitar, cambiar el rol y quitar miembros; ver la lista del equipo con sus correos (supuesto 14). */
  "team.manage": { any: MANAGERS },

  "intake.forms.manage": { any: MANAGERS },
  /** Los contadores y el estado de la protección contra abusos del formulario (H-092). */
  "intake.protection.read": { any: MANAGERS },
  "intake.requests.assign": { any: MANAGERS },
  "intake.requests.anonymize": { any: MANAGERS },
  /** Descartar y restaurar: el Comercial solo las asignadas a él. */
  "intake.requests.discard": { any: MANAGERS, own: ["sales"] },
  "intake.requests.restore": { any: MANAGERS, own: ["sales"] },
  /** Convertir en cotización: el Comercial las asignadas a él o las que nadie tiene. */
  "intake.requests.convert": { any: MANAGERS, own: ["sales"] },

  /** Registro de actividad: solo el Dueño, en la pantalla y en la base (supuesto 13). */
  "audit.read": { any: ["owner"] },

  /** El plan de pago de Cotiza Prime, eliminar y transferir la organización: solo el Dueño. */
  "tenant.billing.manage": { any: ["owner"] },
  "tenant.delete": { any: ["owner"] },
  "tenant.transfer": { any: ["owner"] },
} as const satisfies Record<string, PermissionRule>;

export type PermissionAction = keyof typeof PERMISSIONS;

export const PERMISSION_ACTIONS = Object.keys(PERMISSIONS) as PermissionAction[];

/** Contexto de una consulta de permiso: ¿el recurso es «suyo»? */
export type PermissionContext = { readonly isOwn?: boolean };

function ruleOf(action: string): PermissionRule | null {
  return Object.hasOwn(PERMISSIONS, action) ? PERMISSIONS[action as PermissionAction] : null;
}

/**
 * ¿Este rol puede hacer esta acción? Con `ctx.isOwn` verdadero suma lo que el rol puede hacer solo
 * sobre lo suyo. Un rol o una acción desconocidos siempre dan «no».
 */
export function can(
  role: string | null | undefined,
  action: PermissionAction,
  ctx: PermissionContext = {},
): boolean {
  const rule = ruleOf(action);
  if (!rule || !role) return false;
  if (rule.any?.some((allowed) => allowed === role)) return true;
  return ctx.isOwn === true && (rule.own?.some((allowed) => allowed === role) ?? false);
}

/**
 * ¿Existe alguna forma en que este rol pueda hacer la acción (sobre cualquier recurso o sobre uno
 * suyo)? Sirve para cortar temprano en una pantalla o acción donde todavía no se sabe de quién es el
 * recurso; el detalle (¿es suyo?) lo vuelve a verificar la base de datos.
 */
export function canEver(role: string | null | undefined, action: PermissionAction): boolean {
  const rule = ruleOf(action);
  if (!rule || !role) return false;
  return (
    (rule.any?.some((allowed) => allowed === role) ?? false) ||
    (rule.own?.some((allowed) => allowed === role) ?? false)
  );
}

/** Roles que pueden hacer la acción en algún caso (cualquiera o sobre lo suyo), en el orden de `MEMBER_ROLES`. */
export function rolesThatCanEver(action: PermissionAction): MemberRole[] {
  return MEMBER_ROLES.filter((role) => canEver(role, action));
}

/**
 * Roles a los que se puede asignar una solicitud: los que pueden convertirla en cotización. Lo vuelve a
 * exigir la base en `assign_intake_request`.
 */
export const ASSIGNABLE_ROLES: readonly MemberRole[] = rolesThatCanEver("intake.requests.convert");

/** Roles que se pueden dar a un miembro nuevo o existente: todos menos el Dueño, que es único (H-111 lo traspasa). */
export const GRANTABLE_ROLES: readonly MemberRole[] = MEMBER_ROLES.filter(
  (role) => role !== "owner",
);

/** ¿Es un rol que se puede dar al invitar o al cambiar a un miembro? (Todos menos el Dueño.) */
export function isGrantableRole(value: unknown): value is MemberRole {
  return typeof value === "string" && (GRANTABLE_ROLES as readonly string[]).includes(value);
}

export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === "string" && (MEMBER_ROLES as readonly string[]).includes(value);
}

/** Nombre de un rol para mostrar; un valor desconocido se devuelve tal cual. */
export function roleLabel(role: string): string {
  return isMemberRole(role) ? ROLE_LABELS[role] : role;
}
