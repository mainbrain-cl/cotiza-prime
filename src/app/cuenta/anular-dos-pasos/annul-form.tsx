"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { FormAlert, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { INITIAL_FORM_STATE } from "@/lib/auth/form-state";
import { annulSecondStepAction } from "@/lib/auth/mfa-annul-actions";
import { MFA_ANNUL_MISSING_CODE_MESSAGE } from "@/lib/auth/mfa-annul-messages";
import { HOME_PATH, LOGIN_PATH } from "@/lib/auth/paths";
import { cn } from "@/lib/utils";

/** Botón rojo y sólido (color de peligro, superficie opaca): anular es una acción que no se deshace. */
const DANGER_SOLID = "bg-danger text-on-accent hover:bg-danger/90";

/**
 * El código del enlace viene en la parte «#» de la dirección: el navegador no la manda al servidor, así que nunca queda en
 * registros de acceso ni la ve un escáner de enlaces. Aquí se copia a un campo oculto y se BORRA de la dirección (para que no
 * quede en el historial ni se comparta sin querer al copiar la dirección). Solo llega al servidor cuando se aprieta el botón.
 */
export function AnnulForm() {
  const [state, formAction] = useActionState(annulSecondStepAction, INITIAL_FORM_STATE);
  const [token, setToken] = useState("");
  const [missingCode, setMissingCode] = useState(false);

  useEffect(() => {
    const fromHash = window.location.hash.replace(/^#/, "");
    if (!fromHash) return;
    // En desarrollo el efecto corre dos veces: la segunda ya no ve el «#», y no se pisa lo copiado.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- leer la dirección del navegador solo se puede hacer aquí
    setToken(fromHash);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);

  if (state.status === "saved") {
    return (
      <div className="flex flex-col gap-4" data-testid="annul-done">
        <FormAlert tone="success">{state.message}</FormAlert>
        <Link
          href={LOGIN_PATH}
          className={cn(buttonVariants({ variant: "secondary", size: "lg" }), "w-full")}
        >
          Ir a ingresar
        </Link>
      </div>
    );
  }

  return (
    <form
      action={(formData) => {
        // Sin el código (se recargó la página o se abrió la dirección sin el «#») no se envía NADA al servidor y no se dice nada
        // del enlace: solo se pide abrir otra vez el botón del correo.
        if (!token) {
          setMissingCode(true);
          return;
        }
        setMissingCode(false);
        formAction(formData);
      }}
      className="flex flex-col gap-4"
      noValidate
    >
      <OfflineNotice />
      {missingCode ? <FormAlert tone="warning">{MFA_ANNUL_MISSING_CODE_MESSAGE}</FormAlert> : null}
      {state.message ? <FormAlert>{state.message}</FormAlert> : null}
      <div className="flex flex-col gap-3 text-fg-muted">
        <p>
          Si no fuiste tú, anula la activación. Cerraremos todas las sesiones de tu cuenta,
          quitaremos la verificación en dos pasos y dejaremos tu contraseña actual sin uso.
        </p>
        <p>Después te enviaremos un correo para elegir una contraseña nueva.</p>
        <p>Abrir esta página no cambia nada: solo se anula si aprietas el botón.</p>
      </div>
      <input type="hidden" name="token" value={token} />
      <SubmitButton pendingLabel="Anulando…" className={DANGER_SOLID} data-testid="annul-submit">
        Anular la activación
      </SubmitButton>
      <Link
        href={HOME_PATH}
        className="inline-flex min-h-11 items-center justify-center rounded-sm font-semibold text-accent underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
      >
        Fui yo: no hacer nada
      </Link>
    </form>
  );
}
