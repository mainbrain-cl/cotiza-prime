"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

const COPIED_RESET_MS = 2_000;
const COPY_TOAST_ID = "intake-link-copied";

/** Copia el enlace público al portapapeles y lo avisa. Si el navegador no deja, pide copiarlo a mano. */
export function CopyLinkButton({ url, label = "Copiar enlace" }: { url: string; label?: string }) {
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
      toast.success("Copiamos el enlace.", { id: COPY_TOAST_ID });
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      toast.error("No pudimos copiar solo. Selecciona el enlace y cópialo a mano.", {
        id: COPY_TOAST_ID,
      });
    }
  }

  return (
    <Button type="button" variant="secondary" size="sm" onClick={() => void copy()}>
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? "Copiado" : label}
    </Button>
  );
}
