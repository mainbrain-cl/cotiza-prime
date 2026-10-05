import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  describeValidity,
  isoToDisplay,
  isValidIsoDate,
  parseValidityDate,
  parseValidityDays,
  todayInChile,
} from "./validity";

describe("fechas de vigencia", () => {
  it("hoy se cuenta en la hora de Chile, no en UTC", () => {
    // 02:30 UTC del 6 de octubre es todavía el 5 de octubre en Chile.
    expect(todayInChile(new Date("2026-10-06T02:30:00Z"))).toBe("2026-10-05");
    expect(todayInChile(new Date("2026-10-06T12:00:00Z"))).toBe("2026-10-06");
  });

  it("suma días cruzando meses y años", () => {
    expect(addDaysIso("2026-10-05", 15)).toBe("2026-10-20");
    expect(addDaysIso("2026-12-20", 15)).toBe("2027-01-04");
    expect(addDaysIso("2028-02-20", 10)).toBe("2028-03-01");
  });

  it("valida fechas reales y las muestra como dd-mm-aaaa", () => {
    expect(isValidIsoDate("2028-02-29")).toBe(true);
    expect(isValidIsoDate("2027-02-29")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("05-10-2026")).toBe(false);
    expect(isoToDisplay("2026-10-05")).toBe("05-10-2026");
  });

  it("días: entre 1 y 365, enteros", () => {
    expect(parseValidityDays("15")).toEqual({ ok: true, value: 15 });
    expect(parseValidityDays(" 365 ")).toEqual({ ok: true, value: 365 });
    for (const bad of ["", "0", "366", "1,5", "abc", "-1"]) {
      expect(parseValidityDays(bad).ok).toBe(false);
    }
  });

  it("fecha: no pasada, salvo la ya guardada", () => {
    expect(parseValidityDate("2026-10-05", "2026-10-05", null)).toEqual({
      ok: true,
      value: "2026-10-05",
    });
    expect(parseValidityDate("2026-10-04", "2026-10-05", null).ok).toBe(false);
    expect(parseValidityDate("2026-10-04", "2026-10-05", "2026-10-04").ok).toBe(true);
  });

  it("describe cuándo vence antes de enviar", () => {
    expect(describeValidity({ mode: "days", days: 15 }, "2026-10-05")).toBe(
      "Vence 15 días después de enviarla. Si la envías hoy, vence el 20-10-2026.",
    );
    expect(describeValidity({ mode: "days", days: 1 }, "2026-10-05")).toContain("1 día después");
    // quien solo mira: sin "si la envías hoy"
    expect(describeValidity({ mode: "days", days: 15 }, "2026-10-05", false)).toBe(
      "Vence 15 días después del envío.",
    );
    expect(describeValidity({ mode: "date", date: "2026-12-31" }, "2026-10-05")).toBe(
      "Vence el 31-12-2026.",
    );
  });
});
