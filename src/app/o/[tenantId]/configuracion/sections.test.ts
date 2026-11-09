import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MEMBER_ROLES, can, type PermissionAction } from "@/lib/permissions/matrix";
import { SETTINGS_SECTIONS, visibleSettingsSections } from "./sections";

const titlesFor = (allowed: (action: PermissionAction) => boolean) =>
  visibleSettingsSections(allowed).map((section) => section.title);

/** El permiso que la pantalla de destino exige de verdad: se lee de su código, no de la lista de entradas. */
function permissionRequiredByPage(sectionPath: string): string[] {
  const file = path.join(process.cwd(), "src/app/o/[tenantId]", sectionPath, "page.tsx");
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/pagePermission\(\s*active\s*,\s*"([a-z_.]+)"\s*\)/g)].map(
    (match) => match[1],
  );
}

describe("las entradas de Configuración", () => {
  for (const section of SETTINGS_SECTIONS) {
    it(`«${section.title}» pide el mismo permiso que exige su pantalla (${section.path})`, () => {
      expect(permissionRequiredByPage(section.path)).toEqual([section.permission]);
    });
  }

  it("«Tu equipo» pide `team.manage`, no `settings.manage`, y el registro de actividad `audit.read`", () => {
    const byPath = Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s.path, s.permission]));
    expect(byPath["equipo"]).toBe("team.manage");
    expect(byPath["configuracion/actividad"]).toBe("audit.read");
  });

  it("con `settings.manage` pero sin `team.manage`, «Tu equipo» no aparece", () => {
    const titles = titlesFor((action) => action === "settings.manage");
    expect(titles).toContain("Empresa");
    expect(titles).not.toContain("Tu equipo");
    expect(titles).not.toContain("Registro de actividad");
  });

  it("con `team.manage` pero sin `settings.manage`, solo aparece «Tu equipo»", () => {
    expect(titlesFor((action) => action === "team.manage")).toEqual(["Tu equipo"]);
  });

  for (const role of MEMBER_ROLES) {
    it(`${role}: cada entrada visible es una que su rol puede abrir, y ninguna que puede abrir falta`, () => {
      const shown = visibleSettingsSections((action) => can(role, action));
      for (const section of SETTINGS_SECTIONS) {
        expect(shown.includes(section), section.path).toBe(can(role, section.permission));
      }
    });
  }
});
