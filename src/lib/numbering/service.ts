import "server-only";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import {
  DEFAULT_PAD_WIDTH,
  businessYear,
  formatQuoteNumber,
  minimumNextNumber,
  numberingScope,
  type NumberingMode,
} from "./format";

export type NumberingSettings = {
  prefix: string;
  mode: NumberingMode;
  padWidth: number;
};

export type NumberingState = {
  settings: NumberingSettings;
  /** Último número usado en cada alcance (`continuous`, `Y2026`...). */
  lastByScope: Record<string, number>;
  year: number;
};

type SettingsRow = { prefix: string; mode: NumberingMode; pad_width: number };
type SequenceRow = { scope: string; last_number: number | string };

/** Lee la configuración y los contadores de la organización activa (las políticas de la base la acotan). */
export async function loadNumberingState(active: ActiveTenant): Promise<NumberingState | null> {
  const [settingsResult, sequencesResult] = await Promise.all([
    active.supabase
      .from("numbering_settings")
      .select("prefix, mode, pad_width")
      .eq("tenant_id", active.tenantId)
      .maybeSingle(),
    active.supabase
      .from("numbering_sequences")
      .select("scope, last_number")
      .eq("tenant_id", active.tenantId),
  ]);
  const row = settingsResult.data as SettingsRow | null;
  if (settingsResult.error || !row || sequencesResult.error) return null;

  const lastByScope: Record<string, number> = {};
  for (const sequence of (sequencesResult.data ?? []) as SequenceRow[]) {
    lastByScope[sequence.scope] = Number(sequence.last_number);
  }
  return {
    settings: {
      prefix: row.prefix,
      mode: row.mode,
      padWidth: row.pad_width ?? DEFAULT_PAD_WIDTH,
    },
    lastByScope,
    year: businessYear(),
  };
}

/** El menor próximo número permitido si se cambia al formato `newMode`. */
export function minimumFor(state: NumberingState, newMode: NumberingMode): number {
  const lastCurrent = state.lastByScope[numberingScope(state.settings.mode, state.year)] ?? 0;
  const lastNew = state.lastByScope[numberingScope(newMode, state.year)] ?? 0;
  return minimumNextNumber(lastCurrent, lastNew);
}

/** Cómo se vería el número `sequence` con el prefijo y formato pedidos. */
export function previewFor(
  state: NumberingState,
  input: { prefix: string; mode: NumberingMode; sequence: number },
): string {
  return formatQuoteNumber({
    prefix: input.prefix,
    mode: input.mode,
    padWidth: state.settings.padWidth,
    year: state.year,
    sequence: input.sequence,
  });
}
