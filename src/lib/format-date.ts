const CHILE_TIME_ZONE = "America/Santiago";

const formatter = new Intl.DateTimeFormat("es-CL", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: CHILE_TIME_ZONE,
});

const dateTimeFormatter = new Intl.DateTimeFormat("es-CL", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: CHILE_TIME_ZONE,
});

/** Fecha y hora de Chile: `dd-mm-aaaa hh:mm`. */
export function formatDateTime(value: string | Date): string {
  return dateTimeFormatter.format(new Date(value)).replace(/\//g, "-").replace(",", "");
}

/** Fecha en formato chileno `dd-mm-aaaa`. */
export function formatDate(value: string | Date): string {
  return formatter.format(new Date(value)).replace(/\//g, "-");
}
