import { describe, expect, it } from "vitest";
import {
  LINE_RULES_CHANGED_MESSAGE,
  LINE_RULES_DISCOUNT_MESSAGE,
  LINE_RULES_MIXED_MESSAGE,
  LINE_RULES_NO_DISCOUNTS_MESSAGE,
  LINE_RULES_NOT_ALLOWED_MESSAGE,
  LINE_RULES_PRICE_LOCKED_MESSAGE,
  SAVE_CONFLICT_MESSAGE,
  SAVE_FAILED,
  mapSaveRpcError,
} from "./save-error";

describe("los errores del guardado", () => {
  it("varias clases de problema dan un aviso neutro y un error por línea", () => {
    const { result, log } = mapSaveRpcError({
      code: "CP422",
      message: "line_rules_invalid: price_locked@0,discount_over_cap@2,global_discount_over_cap",
    });
    expect(log).toBeUndefined();
    expect(result).toEqual({
      status: "invalid",
      message: LINE_RULES_MIXED_MESSAGE,
      fieldErrors: {
        "items.0.price":
          "El precio de este servicio cambió o se bloqueó en el catálogo. Actualiza la línea para usar el precio de hoy.",
        "items.2.discount": "El descuento pasa del máximo que permite tu organización.",
        globalDiscount: "El descuento pasa del máximo que permite tu organización.",
      },
    });
  });

  it("el mensaje general depende de qué regla se rompió", () => {
    const message = (list: string) =>
      (
        mapSaveRpcError({ code: "CP422", message: `line_rules_invalid: ${list}` }).result as {
          message: string;
        }
      ).message;
    expect(message("price_locked@0,price_locked@3")).toBe(LINE_RULES_PRICE_LOCKED_MESSAGE);
    expect(message("discount_over_cap@1")).toBe(LINE_RULES_DISCOUNT_MESSAGE);
    expect(message("discount_over_cap@1,global_discount_over_cap")).toBe(
      LINE_RULES_DISCOUNT_MESSAGE,
    );
    expect(message("global_discount_over_cap")).toBe(LINE_RULES_DISCOUNT_MESSAGE);
    expect(message("catalog_item_not_allowed@2")).toBe(LINE_RULES_NOT_ALLOWED_MESSAGE);
    expect(message("price_locked@0,catalog_item_not_allowed@2")).toBe(LINE_RULES_MIXED_MESSAGE);
    // Un código que esta versión no conoce: el mensaje de siempre.
    expect(message("nuevo@3")).toBe(LINE_RULES_CHANGED_MESSAGE);
    expect(message("price_locked@0,nuevo@3")).toBe(LINE_RULES_CHANGED_MESSAGE);
    expect(LINE_RULES_CHANGED_MESSAGE).toBe(
      "Tu organización cambió sus reglas de precio. Recarga para ver las vigentes.",
    );
  });

  it("con el tope en 0 dice que la organización no permite descuentos, en el aviso general y en cada campo", () => {
    const { result } = mapSaveRpcError(
      {
        code: "CP422",
        message: "line_rules_invalid: discount_over_cap@1,global_discount_over_cap",
      },
      { maxDiscountBp: 0 },
    );
    expect(result).toEqual({
      status: "invalid",
      message: LINE_RULES_NO_DISCOUNTS_MESSAGE,
      fieldErrors: {
        "items.1.discount": "Tu organización no permite descuentos.",
        globalDiscount: "Tu organización no permite descuentos.",
      },
    });
    expect(LINE_RULES_NO_DISCOUNTS_MESSAGE).toBe(
      "Tu organización no permite descuentos. Quita los descuentos marcados.",
    );
  });

  it("con un tope mayor que 0 dice la cifra; sin tope conocido, el mensaje de siempre", () => {
    const fieldError = (options?: { maxDiscountBp: number | null }) =>
      (
        mapSaveRpcError(
          { code: "CP422", message: "line_rules_invalid: discount_over_cap@0" },
          options,
        ).result as { fieldErrors: Record<string, string> }
      ).fieldErrors["items.0.discount"];
    expect(fieldError({ maxDiscountBp: 1_000 })).toBe(
      "El descuento pasa del máximo que permite tu organización (10 %).",
    );
    expect(fieldError()).toBe("El descuento pasa del máximo que permite tu organización.");
    expect(fieldError({ maxDiscountBp: null })).toBe(
      "El descuento pasa del máximo que permite tu organización.",
    );
  });

  it("el gancho de H-042 pone el error en el nombre de la línea", () => {
    const { result } = mapSaveRpcError({
      code: "CP422",
      message: "line_rules_invalid: catalog_item_not_allowed@1",
    });
    expect(result).toMatchObject({
      status: "invalid",
      message: LINE_RULES_NOT_ALLOWED_MESSAGE,
      fieldErrors: { "items.1.name": "No tienes permiso para cotizar este servicio." },
    });
  });

  it("un código que esta versión no conoce cae en el aviso general del formulario", () => {
    const { result } = mapSaveRpcError({ code: "CP422", message: "line_rules_invalid: nuevo@3" });
    expect(result).toMatchObject({
      status: "invalid",
      fieldErrors: { form: expect.stringMatching(/Revisa los precios y descuentos/) },
    });
  });

  it("los demás errores de datos siguen como antes", () => {
    expect(mapSaveRpcError({ code: "CP422", message: "validity_in_past" }).result).toEqual({
      status: "invalid",
      message: "La fecha de vigencia no puede estar en el pasado.",
      fieldErrors: { validity: "La fecha de vigencia no puede estar en el pasado." },
    });
    expect(
      mapSaveRpcError({ code: "CP422", message: "catalog_item_unavailable" }).result,
    ).toMatchObject({ status: "invalid", fieldErrors: {} });
    expect(mapSaveRpcError({ code: "CP422", message: "otra cosa" }).result).toMatchObject({
      message: "Revisa los datos de la cotización e intenta de nuevo.",
    });
  });

  it("conflicto, no editable, sin permiso y no encontrada", () => {
    expect(mapSaveRpcError({ code: "CP409" }).result).toEqual({
      status: "conflict",
      message: SAVE_CONFLICT_MESSAGE,
    });
    expect(mapSaveRpcError({ code: "CP423" }).result.status).toBe("not_editable");
    expect(mapSaveRpcError({ code: "42501" }).result.status).toBe("forbidden");
    expect(mapSaveRpcError({ code: "CP404" }).result.status).toBe("not_found");
  });

  it("los inesperados se registran (solo el evento) y no dan detalle técnico", () => {
    const mismatch = mapSaveRpcError({ code: "CP500", message: "totales" });
    expect(mismatch.log).toBe("quote_calc_mismatch");
    expect(mismatch.result.status).toBe("error");
    const other = mapSaveRpcError({ code: "XX000", message: "secreto interno" });
    expect(other).toEqual({
      result: { status: "error", message: SAVE_FAILED },
      log: "quote_save_failed",
    });
  });
});
