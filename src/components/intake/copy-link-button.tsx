"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

const COPIED_RESET_MS = 2_000;
const COPY_TOAST_ID = "intake-link-copied";

/** Copia el enlace público al portapapeles y lo avisa. Si el navegador no deja, pide copiarlo a mano. */
export function CopyLinkButton({
  url,
  label = "Copiar enlace",
  successMessage = "Copiamos el enlace.",
  failMessage = "No pudimos copiar solo. Selecciona el enlace y cópialo a mano.",
  testId,
}: {
  /** El texto que se copia (el enlace, o el código para pegar en la web). */
  url: string;
  label?: string;
  successMessage?: string;
  failMessage?: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(successMessage, { id: COPY_TOAST_ID });
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      toast.error(failMessage, { id: COPY_TOAST_ID });
    }
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={() => void copy()}
      data-testid={testId}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? "Copiado" : label}
    </Button>
  );
}
