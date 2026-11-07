import {
  Building2,
  FileText,
  Hash,
  Palette,
  ScrollText,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import type { PermissionAction } from "@/lib/permissions/matrix";

export type SettingsSection = {
  path: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** Lo que exige la pantalla a la que lleva: si la persona no lo tiene, la entrada no se muestra. */
  permission: PermissionAction;
};

/**
 * Las entradas de «Configuración». Cada una pide el MISMO permiso que exige su pantalla de destino (la de «Tu equipo»
 * pide `team.manage`, la del registro de actividad `audit.read`): mostrar un enlace que lleva a «No tienes permiso»
 * confunde, y no deben depender de un permiso general como `settings.manage`.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    path: "configuracion/empresa",
    title: "Empresa",
    description: "Nombre, RUT, rubro y datos de contacto.",
    icon: Building2,
    permission: "settings.manage",
  },
  {
    path: "configuracion/marca",
    title: "Marca",
    description: "Tu logo y tus colores, para que tus clientes te reconozcan.",
    icon: Palette,
    permission: "settings.manage",
  },
  {
    path: "configuracion/numeracion",
    title: "Numeración",
    description: "Prefijo, formato y desde qué número parten tus cotizaciones.",
    icon: Hash,
    permission: "settings.manage",
  },
  {
    path: "configuracion/textos",
    title: "Textos listos",
    description:
      "Escribe una vez el correo base, las condiciones, las exclusiones y las notas al pie.",
    icon: FileText,
    permission: "settings.manage",
  },
  {
    path: "equipo",
    title: "Tu equipo",
    description: "Invita a personas por correo y elige qué puede hacer cada una.",
    icon: UsersRound,
    permission: "team.manage",
  },
  {
    path: "configuracion/actividad",
    title: "Registro de actividad",
    description: "Quién hizo cada acción sensible y cuándo. Solo lo ve el Dueño.",
    icon: ScrollText,
    permission: "audit.read",
  },
];

/** Las entradas que esta persona puede abrir, según `allowed` (normalmente `can(role, acción)`). */
export function visibleSettingsSections(
  allowed: (action: PermissionAction) => boolean,
): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => allowed(section.permission));
}
