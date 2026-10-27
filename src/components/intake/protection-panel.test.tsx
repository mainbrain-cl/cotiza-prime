import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { summarize, type CounterRow } from "@/lib/intake/protection-model";
import { CapReachedAlert } from "./cap-reached-alert";
import {
  ProtectionCounters,
  ProtectionError,
  ProtectionExplainer,
  ProtectionSkeleton,
} from "./protection-panel";

const NOW = new Date("2026-10-07T15:00:00Z");
const ROW: CounterRow = {
  form_id: "11111111-1111-4111-8111-111111111111",
  day: "2026-10-07",
  accepted: 3,
  blocked_captcha: 2,
  blocked_rate: 1,
  blocked_cap: 0,
  blocked_paused: 0,
  blocked_invalid: 4,
};

describe("ProtectionCounters (H-092)", () => {
  it("sin movimiento muestra el estado vacío y ningún contador", () => {
    const markup = renderToStaticMarkup(
      <ProtectionCounters summary={summarize([], NOW)} emptyText="Sin movimiento todavía" />,
    );
    expect(markup).toContain("Sin movimiento todavía");
    expect(markup).not.toContain("protection-today-accepted");
  });

  it("con movimiento muestra las tres franjas y las seis cifras, solo números", () => {
    const markup = renderToStaticMarkup(
      <ProtectionCounters summary={summarize([ROW], NOW)} emptyText="vacío" />,
    );
    for (const period of ["today", "last7", "last30"]) {
      expect(markup).toContain(`data-testid="protection-${period}-accepted"`);
      expect(markup).toContain(`data-testid="protection-${period}-blockedInvalid"`);
    }
    expect(markup).toContain("Hoy");
    expect(markup).toContain("Últimos 7 días");
    expect(markup).toContain("Últimos 30 días");
    expect(markup).toContain("Bloqueadas por robot");
    expect(markup).toContain(">7</span> bloqueados");
    expect(markup).not.toMatch(/@|form_id|11111111/);
  });
});

describe("estados de la protección", () => {
  it("error: avisa sin detalle técnico", () => {
    const markup = renderToStaticMarkup(<ProtectionError />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("No pudimos cargar los contadores");
  });

  it("cargando: anuncia que está cargando", () => {
    const markup = renderToStaticMarkup(<ProtectionSkeleton />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Cargando");
  });

  it("la explicación no revela umbrales ni cómo se detecta un robot", () => {
    const markup = renderToStaticMarkup(<ProtectionExplainer />);
    const text = markup.replace(/<[^>]*>/g, " ");
    expect(text).toContain("anti-robot");
    expect(text).not.toMatch(/\d/);
    expect(text).not.toMatch(/trampa|sello|honeypot|captcha|turnstile/i);
  });
});

describe("CapReachedAlert", () => {
  it("el tope del formulario dice cuántas llegaron y ofrece subirlo", () => {
    const markup = renderToStaticMarkup(
      <CapReachedAlert
        state={{ reached: true, kind: "form", accepted: 2, cap: 2 }}
        href="/o/t/formularios/f#tope-diario"
      />,
    );
    expect(markup).toContain("Este formulario llegó a su tope de hoy: 2 solicitudes");
    expect(markup).toContain('href="/o/t/formularios/f#tope-diario"');
  });

  it("en el máximo de 200 no ofrece subirlo", () => {
    const markup = renderToStaticMarkup(
      <CapReachedAlert state={{ reached: true, kind: "form", accepted: 200, cap: 200 }} href="#" />,
    );
    expect(markup).not.toContain("Subir el tope");
    expect(markup).toContain("máximo permitido");
  });

  it("el tope de la organización no se puede subir desde aquí", () => {
    const markup = renderToStaticMarkup(
      <CapReachedAlert state={{ reached: true, kind: "org", accepted: 300, cap: 300 }} href="#" />,
    );
    expect(markup).toContain("300 solicitudes entre todos tus formularios");
    expect(markup).not.toContain("Subir el tope");
  });

  it("sin tope alcanzado no pinta nada", () => {
    expect(renderToStaticMarkup(<CapReachedAlert state={{ reached: false }} href="#" />)).toBe("");
  });
});
