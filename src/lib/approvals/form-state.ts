export type ApprovalSaveState = {
  status: "idle" | "saved" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
  /** `true` cuando otra persona cambió la regla mientras se editaba: el formulario ofrece recargar. */
  conflict?: boolean;
  /** Versión que quedó vigente al guardar (o la que se guardó antes si no hubo cambios). */
  version?: number;
  values?: { mode: string; amount: string; discount: string };
};

export const INITIAL_APPROVAL_STATE: ApprovalSaveState = { status: "idle" };
