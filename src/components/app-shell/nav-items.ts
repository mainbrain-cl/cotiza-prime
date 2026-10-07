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

export type NavItem = {
  /** Parte de la dirección después de `/o/{tenantId}`; vacío es el inicio. */
  segment: string;
  label: string;
  icon: LucideIcon;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { segment: "", label: "Inicio", icon: House },
  { segment: "cotizaciones", label: "Cotizaciones", icon: FileText },
  // Lo que piden por el formulario público (H-089). La insignia cuenta las que esperan a esta persona.
  { segment: "solicitudes", label: "Solicitudes", icon: Inbox },
  { segment: "clientes", label: "Clientes", icon: Users },
  { segment: "catalogo", label: "Catálogo", icon: Tags },
  // Todos los roles pueden ver los formularios; solo el Dueño y los Administradores los cambian.
  { segment: "formularios", label: "Formularios", icon: ClipboardList },
  { segment: "configuracion", label: "Configuración", icon: Settings },
] as const;

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
