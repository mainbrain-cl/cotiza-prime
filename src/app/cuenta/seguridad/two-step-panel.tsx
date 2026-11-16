"use client";

import { Check, Copy, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { ACCOUNT_SECURITY_NOTICES, ACCOUNT_SECURITY_PATH } from "@/lib/auth/paths";
import {
  regenerateRecoveryCodesAction,
  type RegenerateRecoveryCodesState,
} from "@/lib/auth/recovery-code-actions";
import { CodeField } from "@/components/auth/code-field";
import { Button } from "@/components/ui/button";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/auth/form-state";
import { formatManualKey } from "@/lib/auth/second-step";
import {
  cancelTotpEnrollmentAction,
  confirmTotpEnrollmentAction,
  startTotpEnrollmentAction,
  type ConfirmEnrollmentState,
  type TotpEnrollment,
} from "@/lib/auth/second-step-actions";
import { RecoveryCodesScreen } from "./recovery-codes-screen";

const COPIED_FEEDBACK_MS = 2000;
/** Lado del código QR en pantalla (px): lo bastante grande para que la cámara del teléfono lo lea. */
const QR_SIZE_PX = 200;

type Phase =
  | { name: "idle" }
  | { name: "scan"; enrollment: TotpEnrollment }
  | { name: "confirm"; enrollment: TotpEnrollment };

/** El estado de los códigos de respaldo de la cuenta, tal como lo lee la página (nunca trae los códigos). */
export type RecoveryInfo = {
  /** Cuántos códigos sin usar tiene el juego vigente (0 = no tiene). */
  total: number;
  /** La persona confirmó que guardó los códigos del juego vigente. */
  acknowledged: boolean;
  /** Cuándo se crearon (dd-mm-aaaa). */
  createdLabel: string | null;
};

/**
 * Lo que la pantalla guarda en memoria después de una acción: los códigos recién creados (solo viven aquí hasta apretar
 * «Listo»; recargar la página los borra) o el aviso de que la verificación quedó activa pero los códigos no se pudieron crear.
 * Vive en este componente (que no se desmonta) y no en el formulario, porque al activar la página se vuelve a pedir al
 * servidor y el formulario desaparece.
 */
type Reveal =
  | { kind: "codes"; codes: string[]; setId: string; after: "enrollment" | "regenerate" }
  | { kind: "codes_failed" };

/** Estados de «Seguridad de tu cuenta»: sin activar, activando (escanear y confirmar) y activada. Solo superficies sólidas. */
export function TwoStepPanel({
  active,
  sinceLabel,
  justEnabled,
  justCodesCreated,
  noticeEmail,
  accountEmail,
  recovery,
}: {
  active: boolean;
  sinceLabel: string | null;
  justEnabled: boolean;
  /** Recién se crearon códigos nuevos desde esta pantalla (aviso `?aviso=codigos`). */
  justCodesCreated: boolean;
  /** El correo al que se mandó el aviso de la activación (solo se muestra recién activada). */
  noticeEmail: string | null;
  /** El correo de la cuenta: solo para que el gestor de contraseñas complete la contraseña (campo oculto «username»). */
  accountEmail: string | null;
  /** Los códigos de respaldo de la cuenta; `null` si no se pudo leer o la verificación no está activa. */
  recovery: RecoveryInfo | null;
}) {
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();

  /** «Listo»: se borran los códigos de la memoria y se vuelve a la pantalla de seguridad, juntos (sin un parpadeo en medio). */
  function finishReveal(after: "enrollment" | "regenerate") {
    const notice =
      after === "enrollment"
        ? ACCOUNT_SECURITY_NOTICES.enabled
        : ACCOUNT_SECURITY_NOTICES.codesCreated;
    startTransition(() => {
      router.replace(`${ACCOUNT_SECURITY_PATH}?aviso=${notice}`);
      setReveal(null);
    });
  }

  function onEnrollmentResult(result: ConfirmEnrollmentState) {
    if (result.status === "enabled") {
      setReveal({
        kind: "codes",
        codes: result.recoveryCodes,
        setId: result.setId,
        after: "enrollment",
      });
    } else if (result.status === "enabled_without_codes") {
      setReveal({ kind: "codes_failed" });
      router.replace(`${ACCOUNT_SECURITY_PATH}?aviso=${ACCOUNT_SECURITY_NOTICES.enabled}`);
    }
  }

  if (reveal?.kind === "codes") {
    return (
      <RecoveryCodesScreen
        codes={reveal.codes}
        setId={reveal.setId}
        onDone={() => finishReveal(reveal.after)}
      />
    );
  }
  if (active || reveal?.kind === "codes_failed") {
    return (
      <ActivePanel
        sinceLabel={sinceLabel}
        justEnabled={justEnabled}
        justCodesCreated={justCodesCreated}
        noticeEmail={noticeEmail}
        accountEmail={accountEmail}
        recovery={recovery}
        codesFailed={reveal?.kind === "codes_failed"}
        onCodesCreated={(codes, setId) =>
          setReveal({ kind: "codes", codes, setId, after: "regenerate" })
        }
      />
    );
  }
  return <EnablePanel accountEmail={accountEmail} onResult={onEnrollmentResult} />;
}

function ActivePanel({
  sinceLabel,
  justEnabled,
  justCodesCreated,
  noticeEmail,
  accountEmail,
  recovery,
  codesFailed,
  onCodesCreated,
}: {
  sinceLabel: string | null;
  justEnabled: boolean;
  justCodesCreated: boolean;
  noticeEmail: string | null;
  accountEmail: string | null;
  recovery: RecoveryInfo | null;
  codesFailed: boolean;
  onCodesCreated: (codes: string[], setId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      {justEnabled ? (
        <FormAlert tone="success">
          Listo: la verificación en dos pasos quedó activa. Cerramos tu sesión en tus otros
          dispositivos.
          {noticeEmail ? ` Te enviamos un aviso a ${noticeEmail}.` : null}
        </FormAlert>
      ) : null}
      {justCodesCreated ? (
        <FormAlert tone="success">
          Listo: tus códigos de respaldo nuevos quedaron creados. Los anteriores ya no sirven.
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
      <RecoverySection
        recovery={recovery}
        codesFailed={codesFailed}
        accountEmail={accountEmail}
        onCodesCreated={onCodesCreated}
      />
    </div>
  );
}

/**
 * Los códigos de respaldo en la pantalla de seguridad (§3.6): si no hay, crearlos; si hay, cuándo se crearon y generar
 * otros (los anteriores dejan de servir); y si no se confirmó que se guardaron, avisarlo. Crear o generar pide la
 * contraseña Y el código de 6 números de la aplicación.
 */
function RecoverySection({
  recovery,
  codesFailed,
  accountEmail,
  onCodesCreated,
}: {
  recovery: RecoveryInfo | null;
  codesFailed: boolean;
  accountEmail: string | null;
  onCodesCreated: (codes: string[], setId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const hasCodes = (recovery?.total ?? 0) > 0;
  const unknown = recovery === null && !codesFailed;
  const needsAcknowledge = recovery !== null && hasCodes && !recovery.acknowledged;
  const buttonLabel = hasCodes || unknown ? "Generar códigos nuevos" : "Crear códigos de respaldo";

  return (
    <section
      aria-labelledby="recovery-heading"
      data-testid="recovery-section"
      className="flex flex-col gap-3 border-t border-border pt-5"
    >
      <h3 id="recovery-heading" className="text-md">
        Códigos de respaldo
      </h3>
      {codesFailed ? (
        <FormAlert tone="warning">
          La verificación quedó activa, pero no pudimos crear tus códigos de respaldo. Créalos
          ahora.
        </FormAlert>
      ) : null}
      {needsAcknowledge ? (
        <FormAlert tone="warning">
          No confirmaste que guardaste tus códigos de respaldo. Si no los guardaste, genera códigos
          nuevos.
        </FormAlert>
      ) : null}
      {unknown ? (
        <p className="text-fg-muted">No pudimos revisar tus códigos de respaldo ahora.</p>
      ) : hasCodes ? (
        <p className="text-fg-muted" data-testid="recovery-has-codes">
          Tienes códigos de respaldo
          {recovery?.createdLabel ? `, creados el ${recovery.createdLabel}` : ""}. Cada uno sirve
          una sola vez, para entrar si pierdes tu teléfono.
        </p>
      ) : (
        <p className="text-fg-muted" data-testid="recovery-no-codes">
          No tienes códigos de respaldo. Si pierdes tu teléfono, no podrás entrar.
        </p>
      )}
      {open ? (
        <RecoveryForm
          accountEmail={accountEmail}
          replacesPrevious={hasCodes || unknown}
          submitLabel={buttonLabel}
          onCancel={() => {
            setOpen(false);
            setTimeout(() => openRef.current?.focus(), 0);
          }}
          onCreated={onCodesCreated}
        />
      ) : (
        <Button
          ref={openRef}
          type="button"
          variant="secondary"
          size="lg"
          onClick={() => setOpen(true)}
        >
          {buttonLabel}
        </Button>
      )}
    </section>
  );
}

/** Contraseña y código de la aplicación para crear los códigos de respaldo. */
function RecoveryForm({
  accountEmail,
  replacesPrevious,
  submitLabel,
  onCancel,
  onCreated,
}: {
  accountEmail: string | null;
  replacesPrevious: boolean;
  submitLabel: string;
  onCancel: () => void;
  onCreated: (codes: string[], setId: string) => void;
}) {
  const [state, formAction] = useActionState<RegenerateRecoveryCodesState, FormData>(
    async (previous, formData) => {
      const result = await regenerateRecoveryCodesAction(previous, formData);
      // Desde aquí, no desde el formulario: el padre es quien guarda los códigos hasta apretar «Listo».
      if (result.status === "created") onCreated(result.recoveryCodes, result.setId);
      return result;
    },
    INITIAL_FORM_STATE,
  );
  const formState: FormState = state.status === "created" ? INITIAL_FORM_STATE : state;
  const passwordRef = useRef<HTMLInputElement>(null);
  const passwordError = formState.fieldErrors?.password;
  const codeError = formState.fieldErrors?.code;
  const onlyPasswordFailed = Boolean(passwordError) && !codeError;

  useEffect(() => {
    if (onlyPasswordFailed) passwordRef.current?.focus();
  }, [formState, onlyPasswordFailed]);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <p className="text-sm text-fg-muted">
        Para confirmar que eres tú, escribe tu contraseña y el código de 6 números que muestra tu
        aplicación (no uno de respaldo).
        {replacesPrevious ? " Los códigos anteriores dejarán de servir." : null}
      </p>
      {formState.message ? <FormAlert>{formState.message}</FormAlert> : null}
      <CodeField
        error={codeError}
        focusSignal={formState.status === "error" && !onlyPasswordFailed ? formState : undefined}
        autoFocus
      />
      <HiddenUsername accountEmail={accountEmail} />
      <PasswordField error={passwordError} inputRef={passwordRef} />
      <SubmitButton pendingLabel="Creando…">{submitLabel}</SubmitButton>
      <div className="flex justify-center">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

/** El correo va en un campo de texto SIN nombre (no se envía): solo para que el gestor de contraseñas sepa de qué cuenta es. */
function HiddenUsername({ accountEmail }: { accountEmail: string | null }) {
  if (!accountEmail) return null;
  return (
    <input
      type="text"
      autoComplete="username"
      value={accountEmail}
      readOnly
      tabIndex={-1}
      aria-hidden
      className="sr-only"
    />
  );
}

function PasswordField({
  error,
  inputRef,
}: {
  error?: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <Field
      label="Tu contraseña"
      hint="La pedimos de nuevo para confirmar que eres tú."
      error={error}
      required
    >
      {(control) => (
        <Input
          {...control}
          ref={inputRef}
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      )}
    </Field>
  );
}

function EnablePanel({
  accountEmail,
  onResult,
}: {
  accountEmail: string | null;
  onResult: (result: ConfirmEnrollmentState) => void;
}) {
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
          onResult={onResult}
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
  onResult,
  onBack,
  onCancel,
}: {
  enrollment: TotpEnrollment;
  accountEmail: string | null;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onResult: (result: ConfirmEnrollmentState) => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const [state, formAction] = useActionState<ConfirmEnrollmentState, FormData>(
    async (previous, formData) => {
      const result = await confirmTotpEnrollmentAction(previous, formData);
      // Los códigos de respaldo se entregan al componente de arriba, que no se desmonta cuando la página se actualiza al
      // quedar la verificación activa (este formulario sí desaparece).
      onResult(result);
      return result;
    },
    INITIAL_FORM_STATE,
  );
  const formState: FormState =
    state.status === "enabled" || state.status === "enabled_without_codes"
      ? INITIAL_FORM_STATE
      : state;
  const passwordRef = useRef<HTMLInputElement>(null);
  const passwordError = formState.fieldErrors?.password;
  const codeError = formState.fieldErrors?.code;
  // Si lo único que falló es la contraseña, el foco vuelve a ese campo; si falló el código (o ambos), vuelve al del código.
  const onlyPasswordFailed = Boolean(passwordError) && !codeError;

  useEffect(() => {
    if (onlyPasswordFailed) passwordRef.current?.focus();
  }, [formState, onlyPasswordFailed]);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <h2 ref={headingRef} tabIndex={-1} className="text-md outline-none">
        2. Escribe el código de tu aplicación y tu contraseña
      </h2>
      {formState.message ? <FormAlert>{formState.message}</FormAlert> : null}
      <input type="hidden" name="factorId" value={enrollment.factorId} />
      <CodeField
        error={codeError}
        focusSignal={formState.status === "error" && !onlyPasswordFailed ? formState : undefined}
        autoFocus
      />
      <HiddenUsername accountEmail={accountEmail} />
      <PasswordField error={passwordError} inputRef={passwordRef} />
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
