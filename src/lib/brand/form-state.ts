export type BrandSaveState = {
  status: "idle" | "saved" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
  /** Lo que la persona eligió, para no perderlo tras un error. */
  values?: { primaryColor: string; secondaryColor: string };
};

export const INITIAL_BRAND_STATE: BrandSaveState = { status: "idle" };
