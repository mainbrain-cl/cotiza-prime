import { describe, expect, it } from "vitest";
import { MEMBER_ROLES, can, type PermissionAction } from "@/lib/permissions/matrix";
import { SETTINGS_SECTIONS, visibleSettingsSections } from "./sections";

const titlesFor = (allowed: (action: PermissionAction) => boolean) =>
  visibleSettingsSections(allowed).map((section) => section.title);

describe("las entradas de Configuración", () => {
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
