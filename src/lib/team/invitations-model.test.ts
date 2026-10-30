import { describe, expect, it } from "vitest";
import {
  INVITATION_MAX_RESENDS,
  INVITATION_RESEND_MIN_MINUTES,
  invitationDisplay,
  nextResendAt,
  resendsLeft,
} from "./invitations-model";

const NOW = new Date("2026-10-30T15:00:00.000Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const future = minutes(60 * 24 * 3);
const display = (over: Partial<Parameters<typeof invitationDisplay>[0]> = {}) =>
  invitationDisplay({
    expiresAt: future,
    mailStatus: "sent",
    mailCreatedAt: minutes(-5),
    now: NOW,
    ...over,
  });

describe("cómo se ve una invitación pendiente", () => {
  it("enviada y vigente", () => {
    expect(display()).toEqual({
      label: "Enviada",
      tone: "accent",
      needsAttention: false,
      expired: false,
    });
    expect(display({ mailStatus: "delivered" }).label).toBe("Enviada");
  });

  it("vencida gana sobre cualquier estado del correo", () => {
    for (const mailStatus of ["sent", "failed", "bounced", "pending"] as const) {
      expect(display({ expiresAt: minutes(-1), mailStatus })).toEqual({
        label: "Vencida",
        tone: "neutral",
        needsAttention: true,
        expired: true,
      });
    }
    // Justo en el límite ya venció.
    expect(display({ expiresAt: NOW }).expired).toBe(true);
  });

  it("el correo que falló queda «pendiente, no enviada» y pide reenviar", () => {
    expect(display({ mailStatus: "failed" })).toEqual({
      label: "Pendiente, no enviada",
      tone: "warning",
      needsAttention: true,
      expired: false,
    });
  });

  it("el que rebotó o se marcó como spam avisa del rebote", () => {
    for (const mailStatus of ["bounced", "complained"] as const) {
      expect(display({ mailStatus })).toMatchObject({
        label: "El correo rebotó",
        tone: "danger",
        needsAttention: true,
      });
    }
  });

  it("un correo recién creado está «enviándose»; si lleva más de 2 minutos así, se da por no enviado", () => {
    expect(display({ mailStatus: "pending", mailCreatedAt: minutes(-1) }).label).toBe("Enviando…");
    expect(display({ mailStatus: "pending", mailCreatedAt: minutes(-3) })).toMatchObject({
      label: "Pendiente, no enviada",
      needsAttention: true,
    });
  });

  it("sin registro del correo no se afirma que salió", () => {
    expect(display({ mailStatus: null, mailCreatedAt: null })).toMatchObject({
      label: "Pendiente, no enviada",
      needsAttention: true,
    });
  });
});

describe("reenvíos", () => {
  it("cuenta los que quedan: el primer envío no es un reenvío", () => {
    expect(resendsLeft(1)).toBe(INVITATION_MAX_RESENDS);
    expect(resendsLeft(2)).toBe(INVITATION_MAX_RESENDS - 1);
    expect(resendsLeft(1 + INVITATION_MAX_RESENDS)).toBe(0);
    expect(resendsLeft(99)).toBe(0);
  });

  it("dice cuándo se podrá reenviar, o null si ya se puede o no quedan", () => {
    expect(nextResendAt(1, minutes(-3), NOW)).toEqual(minutes(INVITATION_RESEND_MIN_MINUTES - 3));
    expect(nextResendAt(1, minutes(-INVITATION_RESEND_MIN_MINUTES), NOW)).toBeNull();
    expect(nextResendAt(1, minutes(-30), NOW)).toBeNull();
    expect(nextResendAt(6, minutes(-1), NOW)).toBeNull();
  });
});
