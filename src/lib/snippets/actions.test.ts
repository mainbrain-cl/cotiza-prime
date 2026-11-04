import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASIC_FORMAT_ERROR_MESSAGES } from "@/lib/email/basic-format";
import { MEMBER_ROLES, NO_PERMISSION_MESSAGE } from "@/lib/permissions/matrix";
import {
  SNIPPET_CONFLICT,
  SNIPPET_GENERIC_FAILURE,
  SNIPPET_NAME_TAKEN,
  SNIPPET_NOT_FOUND,
  SNIPPET_TOO_MANY,
} from "./errors";
import { SNIPPET_VARIABLE_PROBLEM_MESSAGES } from "./model";
import { SNIPPET_DEFAULT_ONLY_EMAIL_MESSAGE } from "./schemas";

// Las acciones de «Textos listos» con un falso miembro de cada rol: quien no administra la organización recibe el
// mensaje único y la base NI SE CONSULTA; quien sí, llega a las funciones de la base con los datos limpios.

const TENANT_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0001";
const USER_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0002";
const SNIPPET_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0003";

const rpc = vi.fn();
const maybeSingle = vi.fn();
const from = vi.fn();
const revalidatePath = vi.fn();
let role = "owner";

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));
vi.mock("@/lib/tenant/active-tenant", () => ({
  requireActiveTenant: vi.fn(async () => ({
    tenantId: TENANT_ID,
    tenantName: "Negocio de Prueba",
    role,
    userId: USER_ID,
    supabase: { rpc, from },
  })),
}));

const { createSnippetAction, updateSnippetAction, deleteSnippetAction } = await import("./actions");

const logged: string[] = [];

beforeEach(() => {
  role = "owner";
  rpc.mockReset();
  maybeSingle.mockReset();
  revalidatePath.mockReset();
  from.mockReset();
  // text_snippets.select("kind").eq().eq().maybeSingle(): el tipo guardado del texto
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq"]) builder[method] = vi.fn(() => builder);
  builder.maybeSingle = maybeSingle;
  from.mockReturnValue(builder);
  maybeSingle.mockResolvedValue({ data: { kind: "email_body" }, error: null });
  logged.length = 0;
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

const MANAGERS = ["owner", "admin"];
const createInput = (over: Record<string, unknown> = {}) => ({
  id: SNIPPET_ID,
  kind: "conditions",
  name: "Pago a 30 días",
  body: "Pago a 30 días.",
  isDefault: false,
  ...over,
});
const updateInput = (over: Record<string, unknown> = {}) => ({
  id: SNIPPET_ID,
  expectedRevision: 2,
  name: "Pago a 30 días",
  body: "Pago a 30 días corridos.",
  isDefault: false,
  ...over,
});
const dbError = (code: string, message: string) => ({ data: null, error: { code, message } });

describe("quien no administra la organización no llega a la base", () => {
  const withoutPermission = MEMBER_ROLES.filter((r) => !MANAGERS.includes(r));

  it.each(withoutPermission)("%s: crear da «sin permiso» y no se consulta nada", async (r) => {
    role = r;
    const result = await createSnippetAction(TENANT_ID, createInput());
    expect(result).toEqual({ status: "error", kind: "forbidden", message: NO_PERMISSION_MESSAGE });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(withoutPermission)("%s: cambiar da «sin permiso» y no se consulta nada", async (r) => {
    role = r;
    const result = await updateSnippetAction(TENANT_ID, updateInput());
    expect(result).toEqual({ status: "error", kind: "forbidden", message: NO_PERMISSION_MESSAGE });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it.each(withoutPermission)("%s: eliminar da «sin permiso» y no se consulta nada", async (r) => {
    role = r;
    const result = await deleteSnippetAction(TENANT_ID, SNIPPET_ID);
    expect(result).toEqual({ status: "error", kind: "forbidden", message: NO_PERMISSION_MESSAGE });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it.each(withoutPermission)(
    "%s: el permiso se mira antes que los datos (datos rotos, mismo mensaje)",
    async (r) => {
      role = r;
      expect(await createSnippetAction(TENANT_ID, { cualquier: "cosa" })).toMatchObject({
        kind: "forbidden",
      });
      expect(await updateSnippetAction(TENANT_ID, null)).toMatchObject({ kind: "forbidden" });
      expect(await deleteSnippetAction(TENANT_ID, "no-es-un-uuid")).toMatchObject({
        kind: "forbidden",
      });
    },
  );
});

describe("crear", () => {
  it.each(MANAGERS)("%s crea: la base recibe los datos y la pantalla se refresca", async (r) => {
    role = r;
    rpc.mockResolvedValue({
      data: { result: "created", id: SNIPPET_ID, revision: 1 },
      error: null,
    });
    const result = await createSnippetAction(
      TENANT_ID,
      createInput({ name: "  Pago a 30 días  ", body: "Pago.\r\nGracias.  " }),
    );
    expect(result).toEqual({
      status: "ok",
      outcome: "created",
      message: "Guardamos el texto.",
      id: SNIPPET_ID,
      revision: 1,
    });
    expect(rpc).toHaveBeenCalledWith("create_text_snippet", {
      p_snippet_id: SNIPPET_ID,
      p_kind: "conditions",
      p_name: "Pago a 30 días",
      p_body: "Pago.\nGracias.",
      p_is_default: false,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/o/${TENANT_ID}/configuracion/textos`);
    expect(revalidatePath).toHaveBeenCalledWith(
      `/o/${TENANT_ID}/configuracion/textos/${SNIPPET_ID}`,
    );
  });

  it("doble clic: el mismo identificador devuelve «exists» y se trata como éxito", async () => {
    rpc.mockResolvedValue({ data: { result: "exists", id: SNIPPET_ID, revision: 1 }, error: null });
    const result = await createSnippetAction(TENANT_ID, createInput());
    expect(result).toMatchObject({ status: "ok", outcome: "exists", id: SNIPPET_ID });
  });

  it("«exists» no dice «Guardamos el texto.»: avisa que ya estaba guardado y que se revise", async () => {
    rpc.mockResolvedValue({ data: { result: "exists", id: SNIPPET_ID, revision: 1 }, error: null });
    const result = await createSnippetAction(TENANT_ID, createInput({ name: "Otro nombre" }));
    expect(result).toMatchObject({
      status: "ok",
      outcome: "exists",
      message: "Este texto ya estaba guardado; revisa que quedó como querías.",
    });
    rpc.mockResolvedValue({
      data: { result: "created", id: SNIPPET_ID, revision: 1 },
      error: null,
    });
    expect(await createSnippetAction(TENANT_ID, createInput())).toMatchObject({
      outcome: "created",
      message: "Guardamos el texto.",
    });
  });

  it("un texto del correo con variables y marcado como inicial pasa", async () => {
    rpc.mockResolvedValue({
      data: { result: "created", id: SNIPPET_ID, revision: 1 },
      error: null,
    });
    const result = await createSnippetAction(
      TENANT_ID,
      createInput({ kind: "email_body", body: "Estimado {{cliente}}", isDefault: true }),
    );
    expect(result.status).toBe("ok");
    expect(rpc).toHaveBeenCalledWith(
      "create_text_snippet",
      expect.objectContaining({ p_is_default: true, p_body: "Estimado {{cliente}}" }),
    );
  });

  describe("validación: se rechaza antes de llamar a la base", () => {
    it.each([
      ["nombre vacío", createInput({ name: "   " }), "name"],
      ["nombre de 81 caracteres", createInput({ name: "a".repeat(81) }), "name"],
      ["texto vacío", createInput({ body: "" }), "body"],
      ["texto de 4.001 caracteres", createInput({ body: "a".repeat(4001) }), "body"],
      [
        "variable desconocida",
        createInput({ kind: "email_body", body: "Hola {{telefono}}" }),
        "body",
      ],
      ["variable en condiciones", createInput({ body: "Hola {{cliente}}" }), "body"],
      ["texto inicial en condiciones", createInput({ isDefault: true }), "isDefault"],
      ["tipo inventado", createInput({ kind: "otro" }), "kind"],
    ])("%s", async (_name, input, field) => {
      const result = await createSnippetAction(TENANT_ID, input);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.kind).toBe("invalid");
        expect(result.fieldErrors?.[field as "name"]).toBeTruthy();
      }
      expect(rpc).not.toHaveBeenCalled();
    });

    it.each([
      ["enlace que muestra otra dirección", "Mira [https://banco.cl](https://estafa.example/x)"],
      [
        "más de 20 enlaces",
        Array.from({ length: 21 }, (_v, i) => `[a${i}](https://ejemplo.cl/${i})`).join(" "),
      ],
    ])("correo con %s: no se guarda y se dice qué corregir", async (_name, body) => {
      const result = await createSnippetAction(
        TENANT_ID,
        createInput({ kind: "email_body", body }),
      );
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.kind).toBe("invalid");
        expect(result.fieldErrors?.body).toBe(
          BASIC_FORMAT_ERROR_MESSAGES[
            body.includes("estafa") ? "misleading_link" : "too_many_links"
          ],
        );
        // El mensaje nunca repite lo que escribió la persona.
        expect(result.message).not.toContain("estafa.example");
      }
      expect(rpc).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it("un correo normal, con negrita, lista y un enlace honesto, sigue guardando", async () => {
      rpc.mockResolvedValue({
        data: { result: "created", id: SNIPPET_ID, revision: 1 },
        error: null,
      });
      const body =
        "Hola {{cliente}}\n\n**Importante**\n- uno\n- dos\n[Nuestra web](https://ejemplo.cl)";
      const result = await createSnippetAction(
        TENANT_ID,
        createInput({ kind: "email_body", body }),
      );
      expect(result.status).toBe("ok");
      expect(rpc).toHaveBeenCalledTimes(1);
    });

    it("los otros tres tipos no pasan por la revisión del correo", async () => {
      rpc.mockResolvedValue({
        data: { result: "created", id: SNIPPET_ID, revision: 1 },
        error: null,
      });
      const misleading = "Mira [https://banco.cl](https://estafa.example/x)";
      for (const kind of ["conditions", "exclusions", "footer_note"]) {
        const result = await createSnippetAction(
          TENANT_ID,
          createInput({ kind, body: misleading }),
        );
        expect(result.status).toBe("ok");
      }
      expect(rpc).toHaveBeenCalledTimes(3);
    });

    it("un texto de exactamente 4.000 caracteres pasa", async () => {
      rpc.mockResolvedValue({
        data: { result: "created", id: SNIPPET_ID, revision: 1 },
        error: null,
      });
      const result = await createSnippetAction(TENANT_ID, createInput({ body: "a".repeat(4000) }));
      expect(result.status).toBe("ok");
    });

    it("datos que no son un objeto, o con campos de más, no llegan a la base", async () => {
      for (const input of [null, "texto", 42, createInput({ tenant_id: randomUUID() })]) {
        const result = await createSnippetAction(TENANT_ID, input);
        expect(result).toMatchObject({ status: "error", kind: "invalid" });
      }
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["42501", "forbidden", "forbidden", NO_PERMISSION_MESSAGE],
    ["CP404", "not_found", "not_found", SNIPPET_NOT_FOUND],
    ["CP422", "name_taken", "invalid", SNIPPET_NAME_TAKEN],
    ["CP422", "too_many_snippets", "limit", SNIPPET_TOO_MANY],
    ["CP422", "unknown_variable", "invalid", SNIPPET_VARIABLE_PROBLEM_MESSAGES.unknown_variable],
    ["CP422", "default_only_email", "invalid", SNIPPET_DEFAULT_ONLY_EMAIL_MESSAGE],
    ["XX000", "algo_raro", "other", SNIPPET_GENERIC_FAILURE],
  ])("la base responde %s «%s»", async (code, reason, kind, message) => {
    rpc.mockResolvedValue(dbError(code, reason));
    const result = await createSnippetAction(TENANT_ID, createInput());
    expect(result).toMatchObject({ status: "error", kind, message });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("un problema de un campo viaja con el campo, para mostrarlo bajo él", async () => {
    rpc.mockResolvedValue(dbError("CP422", "name_taken"));
    const result = await createSnippetAction(TENANT_ID, createInput());
    expect(result).toMatchObject({ fieldErrors: { name: SNIPPET_NAME_TAKEN } });
  });

  it("una respuesta con otra forma es un error genérico, y el log lleva solo el código", async () => {
    rpc.mockResolvedValue({ data: { result: "raro" }, error: null });
    const result = await createSnippetAction(
      TENANT_ID,
      createInput({ name: "Nombre-secreto", body: "Texto-secreto" }),
    );
    expect(result).toMatchObject({ status: "error", kind: "other" });
    const lines = logged.join("\n");
    expect(lines).toContain("snippet_create_failed");
    expect(lines).not.toContain("secreto");
  });

  it("un error inesperado de la base se registra solo con su código", async () => {
    rpc.mockResolvedValue(dbError("XX000", "detalle con Texto-secreto"));
    await createSnippetAction(TENANT_ID, createInput({ body: "Texto-secreto" }));
    const lines = logged.join("\n");
    expect(lines).toContain("XX000");
    expect(lines).not.toContain("secreto");
  });
});

describe("cambiar", () => {
  it.each(MANAGERS)(
    "%s cambia: valida con el tipo guardado y manda la revisión que vio",
    async (r) => {
      role = r;
      rpc.mockResolvedValue({
        data: { result: "updated", id: SNIPPET_ID, revision: 3 },
        error: null,
      });
      maybeSingle.mockResolvedValue({ data: { kind: "conditions" }, error: null });
      const result = await updateSnippetAction(TENANT_ID, updateInput());
      expect(result).toEqual({
        status: "ok",
        outcome: "updated",
        message: "Guardamos los cambios.",
        id: SNIPPET_ID,
        revision: 3,
      });
      expect(rpc).toHaveBeenCalledWith("update_text_snippet", {
        p_snippet_id: SNIPPET_ID,
        p_expected_revision: 2,
        p_name: "Pago a 30 días",
        p_body: "Pago a 30 días corridos.",
        p_is_default: false,
      });
      expect(revalidatePath).toHaveBeenCalledWith(`/o/${TENANT_ID}/configuracion/textos`);
    },
  );

  it("sin cambios: «unchanged», sin refrescar nada de más", async () => {
    rpc.mockResolvedValue({
      data: { result: "unchanged", id: SNIPPET_ID, revision: 2 },
      error: null,
    });
    const result = await updateSnippetAction(TENANT_ID, updateInput());
    expect(result).toMatchObject({ status: "ok", outcome: "unchanged", revision: 2 });
  });

  it("las variables se revisan con el tipo GUARDADO, no con uno que mande el navegador", async () => {
    const body = "Hola {{cliente}}";
    // Guardado como condiciones: las variables no valen.
    maybeSingle.mockResolvedValue({ data: { kind: "conditions" }, error: null });
    const rejected = await updateSnippetAction(TENANT_ID, updateInput({ body }));
    expect(rejected).toMatchObject({ status: "error", kind: "invalid" });
    expect(rpc).not.toHaveBeenCalled();
    // Guardado como correo: sí valen.
    maybeSingle.mockResolvedValue({ data: { kind: "email_body" }, error: null });
    rpc.mockResolvedValue({
      data: { result: "updated", id: SNIPPET_ID, revision: 3 },
      error: null,
    });
    const accepted = await updateSnippetAction(TENANT_ID, updateInput({ body }));
    expect(accepted.status).toBe("ok");
  });

  it("marcar como texto inicial un texto que no es del correo se rechaza con el tipo guardado", async () => {
    maybeSingle.mockResolvedValue({ data: { kind: "exclusions" }, error: null });
    const result = await updateSnippetAction(TENANT_ID, updateInput({ isDefault: true }));
    expect(result).toMatchObject({
      status: "error",
      fieldErrors: { isDefault: SNIPPET_DEFAULT_ONLY_EMAIL_MESSAGE },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("un correo con enlace engañoso no se guarda al editar; un correo normal sí", async () => {
    const misleading = "Mira [https://banco.cl](https://estafa.example/x)";
    maybeSingle.mockResolvedValue({ data: { kind: "email_body" }, error: null });
    const rejected = await updateSnippetAction(TENANT_ID, updateInput({ body: misleading }));
    expect(rejected).toMatchObject({
      status: "error",
      kind: "invalid",
      fieldErrors: { body: BASIC_FORMAT_ERROR_MESSAGES.misleading_link },
    });
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValue({
      data: { result: "updated", id: SNIPPET_ID, revision: 3 },
      error: null,
    });
    const accepted = await updateSnippetAction(
      TENANT_ID,
      updateInput({ body: "Hola {{cliente}} [web](https://ejemplo.cl)" }),
    );
    expect(accepted.status).toBe("ok");
  });

  it("los otros tipos guardados no pasan por la revisión del correo al editar", async () => {
    rpc.mockResolvedValue({
      data: { result: "updated", id: SNIPPET_ID, revision: 3 },
      error: null,
    });
    for (const kind of ["conditions", "exclusions", "footer_note"]) {
      maybeSingle.mockResolvedValue({ data: { kind }, error: null });
      const result = await updateSnippetAction(
        TENANT_ID,
        updateInput({ body: "Mira [https://banco.cl](https://estafa.example/x)" }),
      );
      expect(result.status).toBe("ok");
    }
  });

  it("si el navegador manda un tipo, se rechaza (el tipo no cambia nunca)", async () => {
    const result = await updateSnippetAction(TENANT_ID, updateInput({ kind: "email_body" }));
    expect(result).toMatchObject({ status: "error", kind: "invalid" });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("un texto que no está (o es de otra organización) da «no encontrado» sin llamar a la función", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const result = await updateSnippetAction(TENANT_ID, updateInput());
    expect(result).toEqual({ status: "error", kind: "not_found", message: SNIPPET_NOT_FOUND });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("validación de nombre, texto y revisión antes de consultar", async () => {
    for (const input of [
      updateInput({ name: "" }),
      updateInput({ body: "a".repeat(4001) }),
      updateInput({ expectedRevision: 0 }),
      updateInput({ expectedRevision: 1.5 }),
      updateInput({ id: "no-es-un-uuid" }),
    ]) {
      expect(await updateSnippetAction(TENANT_ID, input)).toMatchObject({
        status: "error",
        kind: "invalid",
      });
    }
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("otra persona guardó antes: avisa que recargue y no refresca nada", async () => {
    rpc.mockResolvedValue(dbError("CP409", "revision_conflict"));
    const result = await updateSnippetAction(TENANT_ID, updateInput());
    expect(result).toEqual({ status: "error", kind: "conflict", message: SNIPPET_CONFLICT });
    expect(SNIPPET_CONFLICT).toContain("Recarga para ver la versión actual");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["42501", "forbidden", "forbidden"],
    ["CP404", "snippet_not_found", "not_found"],
    ["CP422", "name_taken", "invalid"],
    ["CP422", "invalid_body", "invalid"],
    ["XX000", "x", "other"],
  ])("la base responde %s «%s»", async (code, reason, kind) => {
    rpc.mockResolvedValue(dbError(code, reason));
    expect(await updateSnippetAction(TENANT_ID, updateInput())).toMatchObject({
      status: "error",
      kind,
    });
  });

  it("si no se puede leer el tipo guardado, es un error genérico", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { code: "XX000", message: "x" } });
    expect(await updateSnippetAction(TENANT_ID, updateInput())).toMatchObject({
      status: "error",
      kind: "other",
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("eliminar", () => {
  it.each(MANAGERS)("%s elimina y la lista se refresca", async (r) => {
    role = r;
    rpc.mockResolvedValue({ data: { result: "deleted" }, error: null });
    expect(await deleteSnippetAction(TENANT_ID, SNIPPET_ID)).toEqual({
      status: "ok",
      outcome: "deleted",
      message: "Eliminamos el texto.",
    });
    expect(rpc).toHaveBeenCalledWith("delete_text_snippet", { p_snippet_id: SNIPPET_ID });
    expect(revalidatePath).toHaveBeenCalledWith(`/o/${TENANT_ID}/configuracion/textos`);
  });

  it("borrar algo que ya no existe es un éxito (segunda pestaña, doble clic)", async () => {
    rpc.mockResolvedValue(dbError("CP404", "snippet_not_found"));
    expect(await deleteSnippetAction(TENANT_ID, SNIPPET_ID)).toMatchObject({
      status: "ok",
      outcome: "deleted",
    });
  });

  it("pero «no hay organización» no se disfraza de éxito", async () => {
    rpc.mockResolvedValue(dbError("CP404", "not_found"));
    expect(await deleteSnippetAction(TENANT_ID, SNIPPET_ID)).toMatchObject({
      status: "error",
      kind: "not_found",
    });
  });

  it("un identificador roto da «no encontrado» sin consultar", async () => {
    expect(await deleteSnippetAction(TENANT_ID, "no-es-un-uuid")).toEqual({
      status: "error",
      kind: "not_found",
      message: SNIPPET_NOT_FOUND,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sin permiso en la base (42501) y errores inesperados", async () => {
    rpc.mockResolvedValue(dbError("42501", "forbidden"));
    expect(await deleteSnippetAction(TENANT_ID, SNIPPET_ID)).toMatchObject({
      kind: "forbidden",
      message: NO_PERMISSION_MESSAGE,
    });
    rpc.mockResolvedValue(dbError("XX000", "x"));
    expect(await deleteSnippetAction(TENANT_ID, SNIPPET_ID)).toMatchObject({ kind: "other" });
  });
});
