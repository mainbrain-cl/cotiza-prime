import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeEmail } from "../../src/lib/normalize/email";
import { hashInvitationToken, invitationEmailBinding } from "../../src/lib/team/invitation-code";
import { connect } from "./helpers";

// La implementación de TypeScript (src/lib/normalize/email.ts) y la de SQL (app.normalize_email) deben
// responder igual a los mismos casos: la invitación sella el correo en un lado y lo compara en el otro
// (sprint 5, H-008 y H-009). Un desacuerdo dejaría a alguien sin poder aceptar, o permitiría invitar dos
// veces a quien ya es miembro.

const NBSP = " ";
const CASES: string[] = [
  "ana@ejemplo.test",
  "Ana@Ejemplo.TEST",
  "  ana@ejemplo.test  ",
  "\tana@ejemplo.test\n",
  "\r\nana@ejemplo.test\r\n",
  "\u000bana@ejemplo.test\u000c",
  `${NBSP}ana@ejemplo.test${NBSP}`,
  "﻿ana@ejemplo.test﻿",
  " ana@ejemplo.test ",
  "　ana@ejemplo.test　",
  " ana@ejemplo.test ",
  "a.na+ventas@ejemplo.test",
  "A.NA+VENTAS@EJEMPLO.TEST",
  "jos\u00e9@ejemplo.test", // acento compuesto (NFC)
  "jose\u0301@ejemplo.test", // e + acento combinado (NFD)
  "JOSE\u0301@EJEMPLO.TEST",
  "JOSÉ@EJEMPLO.TEST",
  "ñandú@ejemplo.cl",
  "ÑANDÚ@EJEMPLO.CL",
  "ana @ejemplo.test", // espacio interno: no se toca
  "",
  "   ",
  "x",
  "ÁÉÍÓÚÜ@EJEMPLO.TEST",
  "ångström@ejemplo.test",
];

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

describe("correo normalizado: TypeScript y SQL coinciden", () => {
  it.each(CASES.map((input, index) => [index, input] as const))(
    "caso %i",
    async (_index, input) => {
      const { rows } = await db.query<{ r: string }>("select app.normalize_email($1) as r", [input]);
      expect(rows[0].r).toBe(normalizeEmail(input));
    },
  );

  it("el vínculo del correo (huella del código + correo) también coincide", async () => {
    const sha = hashInvitationToken("codigo-de-prueba");
    for (const email of ["Ana@Ejemplo.test", "  ÑANDÚ@ejemplo.cl ", "josé@ejemplo.test", ""]) {
      const { rows } = await db.query<{ r: string }>("select app.invitation_binding($1, $2) as r", [
        sha,
        email,
      ]);
      expect(rows[0].r, email).toBe(invitationEmailBinding(sha, email));
    }
  });

  it("un correo nulo da nulo", async () => {
    const { rows } = await db.query<{ r: string | null }>("select app.normalize_email(null) as r");
    expect(rows[0].r).toBeNull();
  });
});
