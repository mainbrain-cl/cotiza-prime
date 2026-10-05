"use client";

import { useEffect } from "react";
import { toast } from "sonner";

/** Una sola identidad por tipo: un aviso nuevo reemplaza al anterior en vez de apilarse. */
const SUCCESS_TOAST_ID = "form-success";
const ERROR_TOAST_ID = "form-error";

type ResultState = { status: string; message?: string };

/**
 * Muestra un aviso animado cuando una acción de formulario termina bien (`sent` o `saved`).
 * `successMessage` reemplaza el mensaje del servidor si la acción no devuelve uno.
 * Con `errors: true` el error general también sale como aviso (para botones sin campos).
 */
export function useResultToast(
  state: ResultState,
  options: { successMessage?: string; errors?: boolean } = {},
) {
  const { successMessage, errors = false } = options;
  useEffect(() => {
    const isSuccess = state.status === "sent" || state.status === "saved";
    const text = successMessage ?? state.message;
    if (isSuccess && text) toast.success(text, { id: SUCCESS_TOAST_ID });
    else if (errors && state.status === "error" && state.message)
      toast.error(state.message, { id: ERROR_TOAST_ID });
  }, [state, successMessage, errors]);
}

/** Aviso que llega con la pantalla (por ejemplo, tras guardar y volver a la ficha). */
export function FlashToast({ message }: { message: string }) {
  useEffect(() => {
    toast.success(message, { id: SUCCESS_TOAST_ID });
  }, [message]);
  return null;
}
