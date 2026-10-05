/** Nombre del archivo que se descarga: `COT-2026-0043.pdf`, y `COT-2026-0043-v2.pdf` desde la versión 2. */
export function quotePdfFileName(numberDisplay: string, version: number): string {
  const safe = numberDisplay.replace(/[^A-Za-z0-9_-]/g, "-");
  return `${safe}${version > 1 ? `-v${version}` : ""}.pdf`;
}
