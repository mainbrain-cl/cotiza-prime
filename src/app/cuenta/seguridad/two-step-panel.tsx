"use client";

import { Check, Copy, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { CodeField } from "@/components/auth/code-field";
import { Button } from "@/components/ui/button";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { INITIAL_FORM_STATE } from "@/lib/auth/form-state";
import { formatManualKey } from "@/lib/auth/second-step";
import {
  cancelTotpEnrollmentAction,
  confirmTotpEnrollmentAction,
  startTotpEnrollmentAction,
  type TotpEnrollment,
} from "@/lib/auth/second-step-actions";

const COPIED_FEEDBACK_MS = 2000;
/** Lado del código QR en pantalla (px): lo bastante grande para que la cámara del teléfono lo lea. */
const QR_SIZE_PX = 200;

type Phase =
  | { name: "idle" }
  | { name: "scan"; enrollment: TotpEnrollment }
  | { name: "confirm"; enrollment: TotpEnrollment };

/** Estados de «Seguridad de tu cuenta»: sin activar, activando (escanear y confirmar) y activada. Solo superficies sólidas. */
export function TwoStepPanel({
  active,
  sinceLabel,
  justEnabled,
  noticeEmail,
  accountEmail,
}: {
  active: boolean;
  sinceLabel: string | null;
  justEnabled: boolean;
  /** El correo al que se mandó el aviso de la activación (solo se muestra recién activada). */
  noticeEmail: string | null;
  /** El correo de la cuenta: solo para que el gestor de contraseñas complete la contraseña (campo oculto «username»). */
  accountEmail: string | null;
}) {
  if (active) {
    return (
      <ActivePanel sinceLabel={sinceLabel} justEnabled={justEnabled} noticeEmail={noticeEmail} />
    );
  }
  return <EnablePanel accountEmail={accountEmail} />;
}

function ActivePanel({
  sinceLabel,
  justEnabled,
  noticeEmail,
}: {
  sinceLabel: string | null;
  justEnabled: boolean;
  noticeEmail: string | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      {justEnabled ? (
        <FormAlert tone="success">
          Listo: la verificación en dos pasos quedó activa. Cerramos tu sesión en tus otros
          dispositivos.
          {noticeEmail ? ` Te enviamos un aviso a ${noticeEmail}.` : null}
        </FormAlert>
      ) : null}
      <div className="flex items-start gap-3">
        <ShieldCheck
          aria-hidden
          strokeWidth={1.75}
          className="mt-0.5 size-6 shrink-0 text-success"
        />
        <div className="flex flex-col gap-1">
          <h2 className="text-md" data-testid="two-step-active">
            La verificación en dos pasos está activa
          </h2>
          <p className="text-fg-muted">
            {sinceLabel ? `Está activa desde el ${sinceLabel}. ` : null}
            Cada vez que ingreses te pediremos el código de tu aplicación.
          </p>
        </div>
      </div>
    </div>
  );
}

function EnablePanel({ accountEmail }: { accountEmail: string | null }) {
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [startError, setStartError] = useState<string | null>(null);
  const [alreadyActive, setAlreadyActive] = useState(false);
  const [pending, startTransition] = useTransition();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const activateRef = useRef<HTMLButtonElement>(null);
  const cancelledRef = useRef(false);
  const router = useRouter();

  // Al cancelar, el foco vuelve al botón «Activar» (si no, se pierde al desaparecer el paso).
  useEffect(() => {
    if (phase.name === "idle" && cancelledRef.current) {
      cancelledRef.current = false;
      activateRef.current?.focus();
    }
  }, [phase.name]);

  function cancel() {
    // Se quita de Supabase el intento a medias (sin esperar la respuesta: la persona sale de inmediato y, si no se puede
    // quitar, el próximo «Activar» limpia los restos).
    if (phase.name !== "idle") {
      cancelTotpEnrollmentAction(phase.enrollment.factorId).catch(() => {});
    }
    cancelledRef.current = true;
    setPhase({ name: "idle" });
  }

  // Al llegar al paso de escanear, el foco pasa a su título. En el paso del código el foco va directo al campo
  // (autoFocus): es lo único que hay que hacer ahí.
  useEffect(() => {
    if (phase.name === "scan") headingRef.current?.focus();
  }, [phase.name]);

  function start() {
    setStartError(null);
    startTransition(async () => {
      const result = await startTotpEnrollmentAction();
      if (result.status === "started") setPhase({ name: "scan", enrollment: result.enrollment });
      else if (result.status === "already_active") {
        setAlreadyActive(true);
        router.refresh();
      } else setStartError(result.message);
    });
  }

  if (alreadyActive) {
    return (
      <FormAlert tone="success">
        La verificación en dos pasos ya está activa. Actualizando…
      </FormAlert>
    );
  }

  if (phase.name === "idle") {
    return (
      <div className="flex flex-col gap-4">
        <OfflineNotice />
        {startError ? <FormAlert>{startError}</FormAlert> : null}
        <p className="text-fg-muted">
          Además de tu contraseña, te pediremos un código de 6 números que genera una aplicación en
          tu teléfono. Así tu cuenta queda mejor protegida.
        </p>
        <p className="text-sm text-fg-subtle">
          Al activarla cerraremos tu sesión en tus otros dispositivos.
        </p>
        <Button
          ref={activateRef}
          size="lg"
          onClick={start}
          disabled={pending}
          aria-disabled={pending}
        >
          {pending ? "Preparando…" : "Activar la verificación en dos pasos"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <OfflineNotice />
      {phase.name === "scan" ? (
        <ScanStep
          enrollment={phase.enrollment}
          headingRef={headingRef}
          onNext={() => setPhase({ name: "confirm", enrollment: phase.enrollment })}
          onCancel={cancel}
        />
      ) : (
        <ConfirmStep
          enrollment={phase.enrollment}
          accountEmail={accountEmail}
          headingRef={headingRef}
          onBack={() => setPhase({ name: "scan", enrollment: phase.enrollment })}
          onCancel={cancel}
        />
      )}
    </div>
  );
}

function ScanStep({
  enrollment,
  headingRef,
  onNext,
  onCancel,
}: {
  enrollment: TotpEnrollment;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onNext: () => void;
  onCancel: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(enrollment.secret);
      setCopied(true);
    } catch {
      // Sin permiso del navegador: la clave sigue a la vista para copiarla a mano.
    }
  }

  return (
    <>
      <h2 ref={headingRef} tabIndex={-1} className="text-md outline-none">
        1. Escanea este código con tu aplicación
      </h2>
      <p className="text-sm text-fg-muted">
        Por ejemplo Google Authenticator, Microsoft Authenticator o 1Password.
      </p>
      <div className="flex justify-center">
        {/* Fondo blanco fijo con relleno: el código se lee aunque la pantalla esté en modo oscuro. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- imagen en data URL entregada por Supabase Auth */}
        <img
          src={enrollment.qrCode}
          alt="Código QR para tu aplicación de códigos"
          width={QR_SIZE_PX}
          height={QR_SIZE_PX}
          style={{ width: QR_SIZE_PX, height: QR_SIZE_PX }}
          className="bg-white rounded-md p-3"
        />
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-sm text-fg-muted">¿No puedes escanearlo? Escribe esta clave:</p>
        <p
          data-testid="totp-secret"
          className="rounded-sm border border-border bg-surface-2 px-3 py-2 font-mono text-sm tracking-wider break-all"
        >
          {formatManualKey(enrollment.secret)}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={copy}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? "Copiada" : "Copiar"}
          </Button>
          {/* El cambio de «Copiar» a «Copiada» se anuncia a lectores de pantalla sin mover el foco. */}
          <span role="status" aria-live="polite" className="sr-only">
            {copied ? "Clave copiada." : ""}
          </span>
          <a
            href={enrollment.uri}
            className="inline-flex min-h-11 items-center font-semibold text-accent underline-offset-4 hover:underline md:hidden"
          >
            Abrir en mi aplicación de códigos
          </a>
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <Button size="lg" onClick={onNext} className="sm:flex-1">
          Ya la escaneé
        </Button>
        <Button size="lg" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </>
  );
}

function ConfirmStep({
  enrollment,
  accountEmail,
  headingRef,
  onBack,
  onCancel,
}: {
  enrollment: TotpEnrollment;
  accountEmail: string | null;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onBack: () => void;
  onCancel: () => void;
}) {
  const [state, formAction] = useActionState(confirmTotpEnrollmentAction, INITIAL_FORM_STATE);
  const passwordRef = useRef<HTMLInputElement>(null);
  const passwordError = state.fieldErrors?.password;
  const codeError = state.fieldErrors?.code;
  // Si lo único que falló es la contraseña, el foco vuelve a ese campo; si falló el código (o ambos), vuelve al del código.
  const onlyPasswordFailed = Boolean(passwordError) && !codeError;

  useEffect(() => {
    if (onlyPasswordFailed) passwordRef.current?.focus();
  }, [state, onlyPasswordFailed]);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <h2 ref={headingRef} tabIndex={-1} className="text-md outline-none">
        2. Escribe el código de tu aplicación y tu contraseña
      </h2>
      {state.message ? <FormAlert>{state.message}</FormAlert> : null}
      <input type="hidden" name="factorId" value={enrollment.factorId} />
      <CodeField
        error={codeError}
        focusSignal={state.status === "error" && !onlyPasswordFailed ? state : undefined}
        autoFocus
      />
      {/* El correo va en un campo de texto SIN nombre (no se envía): solo para que el gestor de contraseñas sepa de qué cuenta es. */}
      {accountEmail ? (
        <input
          type="text"
          autoComplete="username"
          value={accountEmail}
          readOnly
          tabIndex={-1}
          aria-hidden
          className="sr-only"
        />
      ) : null}
      <Field
        label="Tu contraseña"
        hint="La pedimos de nuevo para confirmar que eres tú."
        error={passwordError}
        required
      >
        {(control) => (
          <Input
            {...control}
            ref={passwordRef}
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        )}
      </Field>
      <SubmitButton pendingLabel="Activando…">Confirmar y activar</SubmitButton>
      <div className="flex flex-wrap justify-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Volver a la clave
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
