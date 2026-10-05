"use client";

import { useId, type ComponentProps, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const CONTROL_CLASS =
  "h-11 w-full rounded-sm border border-border-strong bg-surface px-3 text-fg shadow-1 outline-none transition-[border-color,box-shadow] duration-(--dur-fast) ease-ios placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50 aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20 md:h-10";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(CONTROL_CLASS, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(CONTROL_CLASS, "h-auto min-h-28 py-2 md:h-auto", className)}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select className={cn(CONTROL_CLASS, "appearance-auto", className)} {...props}>
      {children}
    </select>
  );
}

type FieldProps = {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  className?: string;
  /** Recibe el `id` y los atributos de accesibilidad que debe llevar el control. */
  children: (control: {
    id: string;
    "aria-invalid": boolean;
    "aria-describedby"?: string;
  }) => ReactNode;
};

/** Etiqueta + control + mensaje de ayuda o error, conectados para lectores de pantalla. */
export function Field({ label, error, hint, required, className, children }: FieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const hasMessage = Boolean(error ?? hint);
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-semibold text-fg">
        {label}
        {required ? (
          <span aria-hidden className="text-danger">
            {" "}
            *
          </span>
        ) : null}
      </label>
      {children({
        id,
        "aria-invalid": Boolean(error),
        "aria-describedby": hasMessage ? messageId : undefined,
      })}
      {hasMessage ? (
        <p
          id={messageId}
          role={error ? "alert" : undefined}
          className={cn("text-sm", error ? "text-danger" : "text-fg-muted")}
        >
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}

export function FormAlert({
  tone = "danger",
  silent = false,
  children,
}: {
  tone?: "danger" | "success" | "warning";
  /** Sin anuncio para lectores de pantalla: cuando el mismo mensaje ya sale como aviso. */
  silent?: boolean;
  children: ReactNode;
}) {
  const tones = {
    danger: "bg-danger-soft text-danger",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
  } as const;
  return (
    <div
      role={silent ? undefined : tone === "danger" ? "alert" : "status"}
      className={cn("animate-alert rounded-sm px-3 py-2.5 text-sm font-medium", tones[tone])}
    >
      {children}
    </div>
  );
}

/** Botón de envío que se desactiva mientras el formulario se está enviando. */
export function SubmitButton({
  children,
  pendingLabel,
  ...props
}: ComponentProps<typeof Button> & { pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} aria-disabled={pending} {...props}>
      {pending ? (
        <>
          <Loader2 aria-hidden className="animate-spin" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
