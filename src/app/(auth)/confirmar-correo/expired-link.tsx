import Link from "next/link";
import { Link2Off } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import {
  CONFIRM_EXPIRED_TEXT,
  CONFIRM_EXPIRED_TITLE,
  VERIFIED_NOT_FINISHED_HELP,
} from "@/lib/auth/account-setup";
import { FORGOT_PASSWORD_PATH, LOGIN_PATH, SIGNUP_PATH } from "@/lib/auth/paths";

/**
 * «Este enlace ya se usó o venció» (H-116): se muestra cuando falta algo en la dirección o cuando el enlace ya no sirve. No
 * dice cuál fue el motivo. Ofrece pedir otro enlace; quien ya tenía cuenta puede ingresar.
 */
export function ExpiredLink({ heading }: { heading?: boolean }) {
  return (
    <div className="flex flex-col gap-4" data-testid="confirm-email-expired">
      <div className="flex size-12 items-center justify-center rounded-md bg-warning-soft text-warning">
        <Link2Off aria-hidden strokeWidth={1.75} className="size-6" />
      </div>
      {heading ? <h2 className="text-lg">{CONFIRM_EXPIRED_TITLE}</h2> : null}
      <p className="text-fg-muted">{CONFIRM_EXPIRED_TEXT}</p>
      <Link href={SIGNUP_PATH} className={buttonVariants({ size: "lg" })}>
        Pedir un enlace nuevo
      </Link>
      <p className="border-t border-border pt-4 text-sm text-fg-muted">
        {VERIFIED_NOT_FINISHED_HELP}
      </p>
      <div className="flex flex-col sm:flex-row sm:gap-x-5">
        <Link
          href={FORGOT_PASSWORD_PATH}
          className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline-offset-4 hover:underline"
        >
          ¿Olvidaste tu contraseña?
        </Link>
        <Link
          href={LOGIN_PATH}
          className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline-offset-4 hover:underline"
        >
          Ya tengo cuenta: ingresar
        </Link>
      </div>
    </div>
  );
}
