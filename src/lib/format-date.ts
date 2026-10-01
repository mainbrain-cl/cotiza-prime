const CHILE_TIME_ZONE = "America/Santiago";

const formatter = new Intl.DateTimeFormat("es-CL", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: CHILE_TIME_ZONE,
});

/** Fecha en formato chileno `dd-mm-aaaa`. */
export function formatDate(value: string | Date): string {
  return formatter.format(new Date(value)).replace(/\//g, "-");
}
