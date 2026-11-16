import { cronJobRoute } from "@/lib/jobs/cron-auth";
import { runScheduledInvitationNotices } from "@/server/jobs/send-invitation-notices";

export const runtime = "nodejs";
/** Nunca se guarda en caché: cada llamada del programador tiene que ejecutar la tarea de verdad. */
export const dynamic = "force-dynamic";
/** Segundos que la plataforma deja correr la tarea (ver el tamaño del lote en `runScheduledInvitationNotices`). */
export const maxDuration = 60;

/**
 * Tarea de los avisos al Dueño por invitaciones (H-008, decisión #17), llamada por el programador de tareas
 * del hosting (Vercel Cron, que hace un GET con `Authorization: Bearer <CRON_SECRET>`). Esta ruta exporta SOLO
 * esto: todo lo demás (secreto, 404 si está desactivada, 401, registros, cabeceras y respuesta) lo resuelve
 * `cronJobRoute` (`src/lib/jobs/cron-auth.ts`); una guardia de `tests/isolation` lo vigila.
 *
 * Es una ruta protegida por SECRETO, no por sesión. Antes de ella corre el proxy de sesión, como en todas las
 * rutas (sin cookies no hace nada). Es seguro que dos ejecuciones coincidan (el programador puede repetir una
 * llamada): la base reserva cada aviso con `for update skip locked` y gasta el intento al reservarlo, así que
 * cada aviso lo toma una sola ejecución. Sin límite de tasa propio por ahora (decisión pendiente de Aarón).
 */
export const GET = cronJobRoute("invitation-notices", runScheduledInvitationNotices);
