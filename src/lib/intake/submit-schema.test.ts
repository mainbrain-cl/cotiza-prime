import { describe, expect, it } from "vitest";
import {
  buildSubmitSchema,
  chileToday,
  addOneYear,
  fieldErrors,
  type IntakeFormConfig,
} from "./submit-schema";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

const ITEM_A = "11111111-1111-4111-8111-111111111111";
const ITEM_B = "22222222-2222-4222-8222-222222222222";
const ITEM_C = "33333333-3333-4333-8333-333333333333";
const TODAY = "2026-10-07";

const CONFIG: IntakeFormConfig = {
  fields: {
    phone: "optional",
    company: "optional",
    comuna: "off",
    serviceAddress: "required",
    desiredDate: "optional",
    message: "optional",
  },
  items: [
    { id: ITEM_A, quantityMode: "required", minQtyMilli: 1_000, maxQtyMilli: 50_000 },
    { id: ITEM_B, quantityMode: "optional" },
    { id: ITEM_C, quantityMode: "none" },
  ],
};

function valid(overrides: Record<string, unknown> = {}) {
  return {
    name: "Ana Pérez",
    email: "Ana@Empresa.CL",
    serviceAddress: "Av. Siempre Viva 742",
    items: [{ formItemId: ITEM_A, quantity: "2,5" }],
    consent: true,
    submitKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    formRevision: 3,
    website: "",
    renderToken: "v1.1.x",
    antibotToken: "test-pass",
    ...overrides,
  };
}

const schema = buildSubmitSchema(CONFIG, { today: TODAY });

function errorsOf(input: unknown, s = schema) {
  const result = s.safeParse(input);
  if (result.success) throw new Error("se esperaba un error");
  return fieldErrors(result.error);
}

describe("envío válido", () => {
  it("normaliza y devuelve los datos", () => {
    const result = schema.safeParse(valid({ phone: " +56   9 1111 2222 ", company: "  Acme  " }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      name: "Ana Pérez",
      email: "ana@empresa.cl",
      phone: "+56 9 1111 2222",
      company: "Acme",
      comuna: null,
      serviceAddress: "Av. Siempre Viva 742",
      message: null,
      desiredDate: null,
      items: [{ formItemId: ITEM_A, quantityMilli: 2500 }],
      consent: true,
      formRevision: 3,
    });
  });

  it("pasa los textos a NFC", () => {
    const decomposed = `Jose${cp(0x0301)} Mun${cp(0x0303)}oz`;
    const result = schema.safeParse(valid({ name: decomposed }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe(decomposed.normalize("NFC"));
      expect(result.data.name.length).toBe(decomposed.length - 2);
    }
  });

  it("acepta el mensaje con saltos de línea y los normaliza a LF", () => {
    const result = schema.safeParse(valid({ message: "Hola\r\nnecesito\ncotizar\ttodo" }));
    expect(result.success && result.data.message).toBe("Hola\nnecesito\ncotizar\ttodo");
  });

  it("acepta un mensaje de exactamente 2.000 caracteres", () => {
    expect(schema.safeParse(valid({ message: "a".repeat(2000) })).success).toBe(true);
  });
});

describe("nombre y correo", () => {
  it("nombre de 1 o 121 caracteres es inválido; de 2 y 120 es válido", () => {
    expect(errorsOf(valid({ name: "A" })).name).toMatch(/al menos 2/);
    expect(errorsOf(valid({ name: "a".repeat(121) })).name).toMatch(/Máximo 120/);
    expect(schema.safeParse(valid({ name: "Al" })).success).toBe(true);
    expect(schema.safeParse(valid({ name: "a".repeat(120) })).success).toBe(true);
  });

  it("nombre solo de espacios o ausente", () => {
    expect(errorsOf(valid({ name: "     " })).name).toBeDefined();
    expect(errorsOf(valid({ name: undefined })).name).toBe("Este dato es obligatorio.");
    expect(errorsOf(valid({ name: 5 })).name).toBeDefined();
  });

  it.each(["", "sin-arroba", "a@b", "a b@c.cl", "@c.cl", "a@@c.cl", "a@c.cl\nBcc: x@y.cl"])(
    "correo inválido %j",
    (email) => {
      expect(errorsOf(valid({ email })).email).toBeDefined();
    },
  );

  it("correo demasiado largo", () => {
    expect(errorsOf(valid({ email: `${"a".repeat(250)}@x.cl` })).email).toBeDefined();
  });

  it("recorta y pone en minúsculas el correo", () => {
    const result = schema.safeParse(valid({ email: "  Ana+Etiqueta@Empresa.CL " }));
    expect(result.success && result.data.email).toBe("ana+etiqueta@empresa.cl");
  });
});

describe("caracteres prohibidos", () => {
  const forbidden: [string, string][] = [
    ["nulo", cp(0)],
    ["escape", cp(0x1b)],
    ["salto de línea en una línea", "\n"],
    ["tabulador en una línea", "\t"],
    ["DEL", cp(0x7f)],
    ["control C1", cp(0x85)],
    ["LRE", cp(0x202a)],
    ["RLO", cp(0x202e)],
    ["LRI", cp(0x2066)],
    ["PDI", cp(0x2069)],
    ["ancho cero", cp(0x200b)],
    ["ZWJ", cp(0x200d)],
    ["marca RTL", cp(0x200f)],
    ["unión de palabras", cp(0x2060)],
    ["BOM", cp(0xfeff)],
    ["relleno hangul", cp(0x3164)],
    ["guion blando", cp(0x00ad)],
    ["etiqueta", cp(0xe0041)],
    ["separador de línea", cp(0x2028)],
    ["sustituto suelto", "\ud800"],
  ];

  it.each(forbidden)("rechaza %s en nombre, empresa y dirección", (_label, ch) => {
    for (const field of ["name", "company", "serviceAddress"]) {
      const errors = errorsOf(valid({ [field]: `Texto ${ch} normal` }));
      expect(errors[field], field).toMatch(/caracteres que no se pueden usar/);
    }
  });

  it.each(
    forbidden.filter(
      ([label]) => label !== "salto de línea en una línea" && label !== "tabulador en una línea",
    ),
  )("rechaza %s en el mensaje", (_label, ch) => {
    expect(errorsOf(valid({ message: `Hola ${ch} mundo` })).message).toBeDefined();
  });

  it("rechaza invisibles en el correo y el teléfono", () => {
    expect(errorsOf(valid({ email: `ana${cp(0x200b)}@empresa.cl` })).email).toBeDefined();
    expect(errorsOf(valid({ phone: `+56${cp(0x202e)}912345678` })).phone).toBeDefined();
  });
});

describe("modos de campo", () => {
  it("off: vacío da null y con valor se rechaza", () => {
    expect(schema.safeParse(valid({ comuna: "" })).success).toBe(true);
    expect(errorsOf(valid({ comuna: "Ñuñoa" })).comuna).toBe("Este formulario no pide este dato.");
  });

  it("required: vacío se rechaza", () => {
    expect(errorsOf(valid({ serviceAddress: "" })).serviceAddress).toBeDefined();
    expect(errorsOf(valid({ serviceAddress: undefined })).serviceAddress).toBeDefined();
  });

  it("optional: vacío da null, con valor se valida", () => {
    expect(schema.safeParse(valid({ phone: "  " })).success).toBe(true);
    expect(errorsOf(valid({ phone: "123" })).phone).toMatch(/teléfono válido/);
    expect(errorsOf(valid({ company: "X" })).company).toMatch(/al menos 2/);
  });

  it("todos los campos opcionales pueden ir ausentes", () => {
    const input = valid();
    expect(schema.safeParse(input).success).toBe(true);
  });

  it("mensaje de 2.001 caracteres", () => {
    expect(errorsOf(valid({ message: "a".repeat(2001) })).message).toMatch(/Máximo 2000/);
  });

  it("nunca se puede pedir RUT: una clave de más se rechaza", () => {
    const errors = errorsOf(valid({ rut: "11.111.111-1" }));
    expect(errors.form).toBeDefined();
    expect(JSON.stringify(errors)).not.toContain("rut");
  });
});

describe("teléfono", () => {
  it.each(["+56 9 1234 5678", "912345678", "(2) 2345-6789", "+56912345678"])(
    "acepta %s",
    (phone) => {
      expect(schema.safeParse(valid({ phone })).success).toBe(true);
    },
  );
  it.each(["abc", "12345", "1".repeat(16), "+56 9 1234 5678 ext 12", "<script>"])(
    "rechaza %s",
    (phone) => {
      expect(errorsOf(valid({ phone })).phone).toBeDefined();
    },
  );
});

describe("fecha deseada", () => {
  it("acepta hoy y un año exacto; rechaza ayer y un año y un día", () => {
    expect(schema.safeParse(valid({ desiredDate: TODAY })).success).toBe(true);
    expect(schema.safeParse(valid({ desiredDate: "2027-10-07" })).success).toBe(true);
    expect(errorsOf(valid({ desiredDate: "2026-10-06" })).desiredDate).toMatch(/anterior a hoy/);
    expect(errorsOf(valid({ desiredDate: "2027-10-08" })).desiredDate).toMatch(/más de un año/);
  });

  it.each(["2026-02-30", "2026-13-01", "07-10-2026", "2026/10/10", "mañana", "2026-10-1"])(
    "rechaza %s",
    (desiredDate) => {
      expect(errorsOf(valid({ desiredDate })).desiredDate).toMatch(/fecha válida/);
    },
  );

  it("el 29 de febrero da hasta el 28 de febrero del año siguiente", () => {
    expect(addOneYear("2028-02-29")).toBe("2029-02-28");
    expect(addOneYear("2026-10-07")).toBe("2027-10-07");
  });

  it("chileToday devuelve YYYY-MM-DD y usa hora de Chile", () => {
    expect(chileToday(new Date("2026-10-07T12:00:00Z"))).toBe("2026-10-07");
    // 02:00 UTC del 8 es todavía el 7 en Chile (UTC-3 en octubre).
    expect(chileToday(new Date("2026-10-08T02:00:00Z"))).toBe("2026-10-07");
    expect(chileToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("ítems", () => {
  it("0 ítems y más de 30 se rechazan", () => {
    expect(errorsOf(valid({ items: [] })).items).toMatch(/al menos un servicio/);
    const many = Array.from({ length: 31 }, () => ({ formItemId: ITEM_B }));
    expect(errorsOf(valid({ items: many })).items).toMatch(/hasta 30/);
  });

  it("30 ítems distintos permitidos por la configuración se aceptan", () => {
    const ids = Array.from(
      { length: 30 },
      (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
    );
    const config: IntakeFormConfig = {
      ...CONFIG,
      items: ids.map((id) => ({ id, quantityMode: "none" })),
    };
    const s = buildSubmitSchema(config, { today: TODAY });
    expect(s.safeParse(valid({ items: ids.map((formItemId) => ({ formItemId })) })).success).toBe(
      true,
    );
  });

  it("un ítem de otro formulario se rechaza", () => {
    const errors = errorsOf(
      valid({ items: [{ formItemId: "44444444-4444-4444-8444-444444444444", quantity: "1" }] }),
    );
    expect(errors["items.0.formItemId"]).toMatch(/ya no está disponible/);
  });

  it("un ítem repetido se rechaza", () => {
    const errors = errorsOf(
      valid({
        items: [
          { formItemId: ITEM_A, quantity: "1" },
          { formItemId: ITEM_A, quantity: "2" },
        ],
      }),
    );
    expect(errors["items.1.formItemId"]).toMatch(/más de una vez/);
  });

  it("formItemId que no es uuid", () => {
    expect(
      errorsOf(valid({ items: [{ formItemId: "1; drop table" }] }))["items.0.formItemId"],
    ).toBeDefined();
  });

  it("cantidad requerida: ausente, vacía, con punto decimal o con letras", () => {
    expect(errorsOf(valid({ items: [{ formItemId: ITEM_A }] }))["items.0.quantity"]).toMatch(
      /Escribe la cantidad/,
    );
    expect(
      errorsOf(valid({ items: [{ formItemId: ITEM_A, quantity: "  " }] }))["items.0.quantity"],
    ).toBeDefined();
    expect(
      errorsOf(valid({ items: [{ formItemId: ITEM_A, quantity: "2.5" }] }))["items.0.quantity"],
    ).toMatch(/coma/);
    expect(
      errorsOf(valid({ items: [{ formItemId: ITEM_A, quantity: "dos" }] }))["items.0.quantity"],
    ).toBeDefined();
    expect(
      errorsOf(valid({ items: [{ formItemId: ITEM_A, quantity: "-1" }] }))["items.0.quantity"],
    ).toBeDefined();
  });

  it("respeta mínimo y máximo del ítem", () => {
    expect(
      errorsOf(valid({ items: [{ formItemId: ITEM_A, quantity: "0,5" }] }))["items.0.quantity"],
    ).toBe("La cantidad mínima es 1.");
    expect(
      errorsOf(valid({ items: [{ formItemId: ITEM_A, quantity: "50,001" }] }))["items.0.quantity"],
    ).toBe("La cantidad máxima es 50.");
    const ok = schema.safeParse(valid({ items: [{ formItemId: ITEM_A, quantity: "50" }] }));
    expect(ok.success && ok.data.items[0].quantityMilli).toBe(50_000);
  });

  it("cantidad opcional: puede faltar (null) o venir", () => {
    const missing = schema.safeParse(valid({ items: [{ formItemId: ITEM_B }] }));
    expect(missing.success && missing.data.items[0].quantityMilli).toBeNull();
    const given = schema.safeParse(valid({ items: [{ formItemId: ITEM_B, quantity: "1.250" }] }));
    expect(given.success && given.data.items[0].quantityMilli).toBe(1_250_000);
  });

  it("sin cantidad: se rechaza si viene", () => {
    expect(
      schema.safeParse(valid({ items: [{ formItemId: ITEM_C, quantity: null }] })).success,
    ).toBe(true);
    expect(
      errorsOf(valid({ items: [{ formItemId: ITEM_C, quantity: "1" }] }))["items.0.quantity"],
    ).toBeDefined();
  });

  it("claves de dinero en un ítem se rechazan", () => {
    expect(
      schema.safeParse(valid({ items: [{ formItemId: ITEM_A, quantity: "1", unitPriceClp: 10 }] }))
        .success,
    ).toBe(false);
  });
});

describe("consentimiento, claves y trampas", () => {
  it.each([false, "true", 1, undefined, null])("consent %j se rechaza", (consent) => {
    expect(errorsOf(valid({ consent })).consent).toMatch(/aviso de privacidad/);
  });

  it("submitKey y requestId deben ser uuid", () => {
    expect(errorsOf(valid({ submitKey: "abc" })).submitKey).toBeDefined();
    expect(errorsOf(valid({ requestId: 5 })).requestId).toBeDefined();
  });

  it.each([1.5, -1, "3", 2_147_483_648, Number.NaN])(
    "formRevision %j se rechaza",
    (formRevision) => {
      expect(errorsOf(valid({ formRevision })).formRevision).toBeDefined();
    },
  );

  it("el campo trampa debe ir vacío o ausente", () => {
    expect(schema.safeParse(valid({ website: "" })).success).toBe(true);
    const without: Record<string, unknown> = valid();
    delete without.website;
    expect(schema.safeParse(without).success).toBe(true);
    expect(errorsOf(valid({ website: "http://spam.example" })).website).toBeDefined();
  });

  it("faltan tokens", () => {
    expect(errorsOf(valid({ renderToken: "" })).renderToken).toBeDefined();
    expect(errorsOf(valid({ antibotToken: "" })).antibotToken).toBeDefined();
    expect(errorsOf(valid({ antibotToken: "a".repeat(2049) })).antibotToken).toBeDefined();
    expect(errorsOf(valid({ renderToken: "a".repeat(201) })).renderToken).toBeDefined();
  });

  it("un cuerpo que no es objeto se rechaza", () => {
    for (const input of [null, "x", 5, [], undefined]) {
      expect(schema.safeParse(input).success).toBe(false);
    }
  });

  it("claves desconocidas (tenant_id, status...) se rechazan sin repetir el nombre", () => {
    const errors = errorsOf(valid({ tenant_id: "x", status: "converted" }));
    expect(errors.form).toMatch(/Recarga la página/);
    expect(JSON.stringify(errors)).not.toMatch(/tenant_id|status/);
  });

  it("los mensajes de error no repiten lo que escribió la persona", () => {
    const secret = "PERSONA-ESCRIBIO-ESTO";
    const errors = errorsOf(
      valid({ name: "x", email: secret, phone: secret, desiredDate: secret }),
    );
    expect(JSON.stringify(errors)).not.toContain(secret);
  });
});
