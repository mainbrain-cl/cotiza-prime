import { FileText, House, Settings, Tags, Users, type LucideIcon } from "lucide-react";

export type NavItem = {
  /** Parte de la dirección después de `/o/{tenantId}`; vacío es el inicio. */
  segment: string;
  label: string;
  icon: LucideIcon;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { segment: "", label: "Inicio", icon: House },
  { segment: "cotizaciones", label: "Cotizaciones", icon: FileText },
  { segment: "clientes", label: "Clientes", icon: Users },
  { segment: "catalogo", label: "Catálogo", icon: Tags },
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
