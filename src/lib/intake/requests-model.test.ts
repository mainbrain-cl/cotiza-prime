import { describe, expect, it } from "vitest";
import {
  DEFAULT_REQUEST_FILTER,
  formatRequestQuantity,
  isAnonymizeReason,
  isDiscardReason,
  isStale,
  parseRequestFilter,
  parseRequestItems,
  requestPermissions,
  summarizeRequestItems,
  timeSince,
} from "./requests-model";

const NOW = new Date("2026-10-07T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("parseRequestFilter", () => {
  it("acepta los filtros conocidos y vuelve a «todas» con cualquier otra cosa", () => {
    expect(parseRequestFilter("sin-asignar")).toBe("sin-asignar");
    expect(parseRequestFilter("mias")).toBe("mias");
    expect(parseRequestFilter("convertidas")).toBe("convertidas");
    expect(parseRequestFilter("descartadas")).toBe("descartadas");
    expect(parseRequestFilter("<script>")).toBe(DEFAULT_REQUEST_FILTER);
    expect(parseRequestFilter(undefined)).toBe(DEFAULT_REQUEST_FILTER);
    expect(parseRequestFilter(["mias"])).toBe(DEFAULT_REQUEST_FILTER);
  });
});

describe("requestPermissions (matriz del plan, §6)", () => {
  const ME = "me";
  const open = { status: "new", assignedTo: null, anonymized: false } as const;
  const mine = { status: "assigned", assignedTo: ME, anonymized: false } as const;
  const theirs = { status: "assigned", assignedTo: "otra", anonymized: false } as const;
  const discarded = { status: "discarded", assignedTo: ME, anonymized: false } as const;

  it("el Dueño y el Administrador asignan, descartan, restauran, anonimizan y convierten", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(requestPermissions(role, ME, open)).toEqual({
        canAssign: true,
        canDiscard: true,
        canRestore: false,
        canAnonymize: true,
        canConvert: true,
      });
      expect(requestPermissions(role, ME, discarded).canRestore).toBe(true);
    }
  });

  it("el Comercial no asigna ni anonimiza; descarta y restaura solo las asignadas a él", () => {
    expect(requestPermissions("sales", ME, mine)).toEqual({
      canAssign: false,
      canDiscard: true,
      canRestore: false,
      canAnonymize: false,
      canConvert: true,
    });
    expect(requestPermissions("sales", ME, theirs).canDiscard).toBe(false);
    expect(requestPermissions("sales", ME, theirs).canConvert).toBe(false);
    expect(requestPermissions("sales", ME, discarded).canRestore).toBe(true);
    expect(requestPermissions("sales", "otro", { ...discarded, assignedTo: ME }).canRestore).toBe(
      false,
    );
    // Sin responsable, el Comercial puede convertirla pero no descartarla.
    expect(requestPermissions("sales", ME, open).canConvert).toBe(true);
    expect(requestPermissions("sales", ME, open).canDiscard).toBe(false);
  });

  it("el Aprobador y el Observador solo miran", () => {
    for (const role of ["approver", "viewer"] as const) {
      expect(requestPermissions(role, ME, open)).toEqual({
        canAssign: false,
        canDiscard: false,
        canRestore: false,
        canAnonymize: false,
        canConvert: false,
      });
    }
  });

  it("una solicitud anonimizada no se asigna, no se convierte ni se vuelve a anonimizar", () => {
    const permissions = requestPermissions("owner", ME, { ...open, anonymized: true });
    expect(permissions.canAssign).toBe(false);
    expect(permissions.canConvert).toBe(false);
    expect(permissions.canAnonymize).toBe(false);
  });

  it("una convertida no se asigna ni se descarta", () => {
    const permissions = requestPermissions("owner", ME, {
      status: "converted",
      assignedTo: ME,
      anonymized: false,
    });
    expect(permissions.canAssign).toBe(false);
    expect(permissions.canDiscard).toBe(false);
    expect(permissions.canConvert).toBe(false);
  });
});

describe("servicios pedidos", () => {
  it("lee la copia congelada e ignora lo que no calza", () => {
    expect(
      parseRequestItems([
        { form_item_id: "x", name: "Flete", unit: "km", quantity_milli: 12_500 },
        { name: "" },
        null,
        "texto",
        { name: "Sin cantidad", unit: "service", quantity_milli: null },
      ]),
    ).toEqual([
      { name: "Flete", unit: "km", quantityMilli: 12_500 },
      { name: "Sin cantidad", unit: "service", quantityMilli: null },
    ]);
    expect(parseRequestItems(undefined)).toEqual([]);
    expect(parseRequestItems({ name: "x" })).toEqual([]);
  });

  it("escribe la cantidad con su unidad, sin ningún monto", () => {
    expect(formatRequestQuantity({ name: "a", unit: "km", quantityMilli: 12_500 })).toBe("12,5 km");
    expect(formatRequestQuantity({ name: "a", unit: "unit", quantityMilli: 3000 })).toBe(
      "3 unidades",
    );
    expect(formatRequestQuantity({ name: "a", unit: "service", quantityMilli: null })).toBe("");
    expect(formatRequestQuantity({ name: "a", unit: "service", quantityMilli: 2000 })).toBe("2");
  });

  it("resume en una línea y corta cuando son muchos", () => {
    expect(summarizeRequestItems([])).toBe("Sin servicios");
    const items = ["A", "B", "C", "D", "E"].map((name) => ({
      name,
      unit: "service",
      quantityMilli: null,
    }));
    expect(summarizeRequestItems(items)).toBe("A · B · C · y 2 más");
    expect(summarizeRequestItems(items.slice(0, 2))).toBe("A · B");
  });

  it("el resumen nunca trae signos de dinero", () => {
    const text = summarizeRequestItems([
      { name: "Flete urbano", unit: "km", quantityMilli: 4000 },
      { name: "Traslado", unit: "hour", quantityMilli: 1500 },
    ]);
    expect(text).not.toMatch(/[$]|clp|precio/i);
  });
});

describe("timeSince e isStale", () => {
  it("dice hace cuánto llegó, en español", () => {
    expect(timeSince(ago(10_000), NOW)).toBe("Hace un momento");
    expect(timeSince(ago(MINUTE), NOW)).toBe("Hace 1 minuto");
    expect(timeSince(ago(5 * MINUTE), NOW)).toBe("Hace 5 minutos");
    expect(timeSince(ago(HOUR), NOW)).toBe("Hace 1 hora");
    expect(timeSince(ago(3 * HOUR), NOW)).toBe("Hace 3 horas");
    expect(timeSince(ago(DAY), NOW)).toBe("Hace 1 día");
    expect(timeSince(ago(9 * DAY), NOW)).toBe("Hace 9 días");
  });

  it("una fecha futura o inválida no da números negativos", () => {
    expect(timeSince(new Date(NOW.getTime() + HOUR), NOW)).toBe("Hace un momento");
    expect(timeSince("no es una fecha", NOW)).toBe("Hace un momento");
  });

  it("solo las abiertas con más de un día se resaltan como sin atender", () => {
    expect(isStale("new", ago(25 * HOUR), NOW)).toBe(true);
    expect(isStale("assigned", ago(25 * HOUR), NOW)).toBe(true);
    expect(isStale("new", ago(2 * HOUR), NOW)).toBe(false);
    expect(isStale("converted", ago(10 * DAY), NOW)).toBe(false);
    expect(isStale("discarded", ago(10 * DAY), NOW)).toBe(false);
  });
});

describe("listas cerradas", () => {
  it("solo se aceptan los motivos de la lista", () => {
    expect(isDiscardReason("spam")).toBe(true);
    expect(isDiscardReason("duplicate")).toBe(true);
    expect(isDiscardReason("out_of_scope")).toBe(true);
    expect(isDiscardReason("other")).toBe(true);
    expect(isDiscardReason("porque sí")).toBe(false);
    expect(isAnonymizeReason("data_subject_request")).toBe(true);
    expect(isAnonymizeReason("wrong_data")).toBe(true);
    expect(isAnonymizeReason("spam")).toBe(false);
  });
});
