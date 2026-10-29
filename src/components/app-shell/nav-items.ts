import {
  ClipboardList,
  FileText,
  House,
  Inbox,
  Settings,
  Tags,
  Users,
  type LucideIcon,
} from "lucide-react";
import { can, type PermissionAction } from "@/lib/permissions/matrix";

export type NavItem = {
  /** Parte de la dirección después de `/o/{tenantId}`; vacío es el inicio. */
  segment: string;
  label: string;
  icon: LucideIcon;
  /** Permiso que pide el destino: el menú solo lo muestra a quien lo tiene (el servidor igual lo exige). */
  permission: PermissionAction;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { segment: "", label: "Inicio", icon: House, permission: "org.view" },
  { segment: "cotizaciones", label: "Cotizaciones", icon: FileText, permission: "org.view" },
  // Lo que piden por el formulario público (H-089). La insignia cuenta las que esperan a esta persona.
  { segment: "solicitudes", label: "Solicitudes", icon: Inbox, permission: "org.view" },
  { segment: "clientes", label: "Clientes", icon: Users, permission: "org.view" },
  { segment: "catalogo", label: "Catálogo", icon: Tags, permission: "org.view" },
  // Todos los roles pueden ver los formularios; solo quienes manejan la organización los cambian.
  { segment: "formularios", label: "Formularios", icon: ClipboardList, permission: "org.view" },
  // «Configuración» solo la ven el Dueño y los Administradores (supuesto 12 del sprint 5).
  {
    segment: "configuracion",
    label: "Configuración",
    icon: Settings,
    permission: "settings.manage",
  },
] as const;

/** Los destinos del menú que corresponden a este rol. */
export function visibleNavItems(role: string): readonly NavItem[] {
  return NAV_ITEMS.filter((item) => can(role, item.permission));
}

/** Los cuatro destinos de la barra inferior del teléfono: el resto va en "Más". */
export const MOBILE_PRIMARY_SEGMENTS = ["", "cotizaciones", "clientes"] as const;

export function isActive(pathname: string, basePath: string, segment: string): boolean {
  const target = segment === "" ? basePath : `${basePath}/${segment}`;
  return segment === ""
    ? pathname === target
    : pathname === target || pathname.startsWith(`${target}/`);
}

/** Insignias del menú por destino (`segment`): cuántas cosas esperan a la persona. Sin entrada, sin insignia. */
export type NavBadges = Readonly<Record<string, number>>;

/** Texto que lee el lector de pantalla para un destino con insignia: «Solicitudes, 3 pendientes». */
export function labelWithBadge(label: string, count: number | undefined): string {
  if (!count) return label;
  return `${label}, ${count} ${count === 1 ? "pendiente" : "pendientes"}`;
}

/** La insignia no pasa de este número: «99+». */
const BADGE_MAX = 99;
export function badgeText(count: number): string {
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}
