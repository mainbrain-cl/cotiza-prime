import { describe, expect, it } from "vitest";
import { addDaysIso, todayInChile } from "@/lib/quotes/validity";
import {
  COUNTER_LABELS,
  DAILY_CAP_MAX,
  capStateOf,
  formCapReachedText,
  parseDailyCap,
  summarize,
  sumCounters,
  type CounterRow,
} from "./protection-model";

const FORM_A = "11111111-1111-4111-8111-111111111111";
const FORM_B = "22222222-2222-4222-8222-222222222222";

function row(day: string, partial: Partial<CounterRow> = {}, form = FORM_A): CounterRow {
  return {
    form_id: form,
    day,
    accepted: 0,
    blocked_captcha: 0,
    blocked_rate: 0,
    blocked_cap: 0,
    blocked_invalid: 0,
    ...partial,
  };
}

describe("el día de Chile (H-092)", () => {
  it("el cambio de día es a medianoche de Chile, no de UTC", () => {
    // 2026-10-07 02:30 UTC es 2026-10-06 23:30 en Chile (verano: UTC-3; invierno: UTC-4)
    expect(todayInChile(new Date("2026-10-07T02:30:00Z"))).toBe("2026-10-06");
    expect(todayInChile(new Date("2026-10-07T04:30:00Z"))).toBe("2026-10-07");
    // en invierno (UTC-4) la medianoche de Chile es a las 04:00 UTC
    expect(todayInChile(new Date("2026-07-15T03:59:00Z"))).toBe("2026-07-14");
    expect(todayInChile(new Date("2026-07-15T04:00:00Z"))).toBe("2026-07-15");
  });

  it("suma y resta días de calendario, también cruzando mes y año", () => {
    expect(addDaysIso("2026-10-07", -6)).toBe("2026-10-01");
    expect(addDaysIso("2026-03-02", -3)).toBe("2026-02-27");
    expect(addDaysIso("2027-01-02", -29)).toBe("2026-12-04");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("contadores de hoy, 7 y 30 días", () => {
  const now = new Date("2026-10-07T15:00:00Z"); // 2026-10-07 en Chile
  const rows = [
    row("2026-10-07", { accepted: 3, blocked_captcha: 2, blocked_invalid: 1 }),
    row("2026-10-07", { accepted: 1, blocked_rate: 4 }, FORM_B),
    row("2026-10-01", { blocked_cap: 5 }), // dentro de 7 días (hoy y 6 antes)
    row("2026-09-30", { blocked_invalid: 7 }), // fuera de 7, dentro de 30
    row("2026-09-08", { accepted: 10 }), // 29 días antes: dentro de 30
    row("2026-09-07", { accepted: 100 }), // 30 días antes: fuera
  ];

  it("separa las ventanas y suma cada motivo", () => {
    const summary = summarize(rows, now);
    expect(summary.today).toMatchObject({
      accepted: 4,
      blockedCaptcha: 2,
      blockedRate: 4,
      blockedInvalid: 1,
      blockedTotal: 7,
    });
    expect(summary.last7.blockedCap).toBe(5);
    expect(summary.last7.blockedInvalid).toBe(1);
    expect(summary.last30.blockedInvalid).toBe(8);
    expect(summary.last30.accepted).toBe(14);
    expect(summary.last30.blockedTotal).toBe(2 + 4 + 5 + 7 + 1);
  });

  it("sin filas todo es cero", () => {
    const summary = summarize([], now);
    expect(summary.today.accepted).toBe(0);
    expect(summary.last30.blockedTotal).toBe(0);
  });

  it("ignora valores raros (negativos, texto) en vez de romper la cuenta", () => {
    const odd = row("2026-10-07", {
      accepted: -5,
      blocked_rate: "x" as unknown as number,
      blocked_cap: 2,
    });
    expect(sumCounters([odd], "2026-10-07", "2026-10-07")).toMatchObject({
      accepted: 0,
      blockedRate: 0,
      blockedCap: 2,
    });
  });

  it("las cinco cifras de la pantalla (sin la de pausa, que no se cuenta) salen de las columnas leídas", () => {
    expect(COUNTER_LABELS.map((c) => c.key)).toEqual([
      "accepted",
      "blockedCaptcha",
      "blockedRate",
      "blockedCap",
      "blockedInvalid",
    ]);
  });
});

describe("tope alcanzado hoy", () => {
  it("el del formulario manda sobre el de la organización", () => {
    expect(capStateOf({ formAccepted: 2, dailyCap: 2, orgAccepted: 300 })).toEqual({
      reached: true,
      kind: "form",
      accepted: 2,
      cap: 2,
      orgAlsoReached: true,
    });
  });
  it("avisa cuando la organización también llegó al suyo, porque subir el del formulario no serviría", () => {
    expect(capStateOf({ formAccepted: 2, dailyCap: 2, orgAccepted: 100 })).toMatchObject({
      kind: "form",
      orgAlsoReached: false,
    });
  });
  it("si se bajó el tope bajo lo ya recibido, el texto dice las dos cifras", () => {
    expect(capStateOf({ formAccepted: 10, dailyCap: 5, orgAccepted: 10 })).toMatchObject({
      reached: true,
      accepted: 10,
      cap: 5,
    });
    expect(formCapReachedText(10, 5)).toBe(
      "Este formulario llegó a su tope de hoy: recibió 10 solicitudes y su tope es 5",
    );
  });
  it("llega al tope de la organización aunque el formulario tenga cupo", () => {
    expect(capStateOf({ formAccepted: 10, dailyCap: 50, orgAccepted: 300 })).toMatchObject({
      reached: true,
      kind: "org",
    });
  });
  it("con cupo en los dos no avisa", () => {
    expect(capStateOf({ formAccepted: 1, dailyCap: 2, orgAccepted: 5 })).toEqual({
      reached: false,
    });
  });
  it("el texto cuenta en singular y plural", () => {
    expect(formCapReachedText(1, 1)).toBe(
      "Este formulario llegó a su tope de hoy: recibió 1 solicitud y su tope es 1",
    );
    expect(formCapReachedText(2, 2)).toBe(
      "Este formulario llegó a su tope de hoy: recibió 2 solicitudes y su tope es 2",
    );
  });
});

describe("validación del tope diario (1 a 200)", () => {
  it("acepta enteros entre 1 y 200", () => {
    for (const ok of ["1", "50", "200", " 7 ", 1, 200]) {
      expect(parseDailyCap(ok).ok, String(ok)).toBe(true);
    }
    expect(parseDailyCap("120")).toEqual({ ok: true, value: 120 });
  });
  it("rechaza todo lo demás", () => {
    const bad = [
      "0",
      "201",
      "-1",
      "1.5",
      "1,5",
      "abc",
      "",
      " ",
      "1e2",
      "+5",
      "０５",
      null,
      undefined,
    ];
    for (const value of bad) {
      expect(parseDailyCap(value as string).ok, String(value)).toBe(false);
    }
    expect(parseDailyCap(0).ok).toBe(false);
    expect(parseDailyCap(DAILY_CAP_MAX + 1).ok).toBe(false);
    expect(parseDailyCap(2.5).ok).toBe(false);
    expect(parseDailyCap(Number.NaN).ok).toBe(false);
  });
});
