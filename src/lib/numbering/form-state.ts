export type NumberingSaveState = {
  status: "idle" | "saved" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
  values?: { prefix: string; mode: string; startNumber: string };
  /** Próximo número ya guardado, para mostrarlo en la confirmación. */
  savedPreview?: string;
};

export const INITIAL_NUMBERING_STATE: NumberingSaveState = { status: "idle" };
