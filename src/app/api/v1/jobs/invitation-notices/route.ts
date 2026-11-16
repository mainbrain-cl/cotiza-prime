import { verifyCronRequest } from "@/lib/jobs/cron-auth";
import { serverLog } from "@/lib/log/server-log";
import { publicJson, publicText } from "@/lib/share/public-request";
import { runSendInvitationNotices } from "@/server/jobs/send-invitation-notices";

export const runtime = "nodejs";
/** Nunca se guarda en caché: cada llamada del programador tiene que ejecutar la tarea de verdad. */
export const dynamic = "force-dynamic";
/** Segundos que la plataforma deja correr la tarea (lote de 20 avisos; ver `NOTICE_JOB_BATCH_SIZE`). */
export const maxDuration = 60;

const JOB_NAME = "invitation-notices";

/**
 * Tarea de los avisos al Dueño por invitaciones (H-008, decisión #17), llamada por el programador de tareas
 * del hosting (Vercel Cron, que hace un GET con `Authorization: Bearer <CRON_SECRET>`).
 *
 * Es una ruta pública protegida por SECRETO, no por sesión. Orden: (1) el secreto, en tiempo constante y sin
 * tocar la base ni la red: sin `CRON_SECRET` válido (32+ caracteres) la ruta no existe (404); con un secreto
 * ausente o incorrecto responde 401 con un cuerpo genérico; (2) recién entonces corre la tarea.
 *
 * Es seguro que dos ejecuciones coincidan (el programador puede repetir una llamada): la base reserva cada
 * aviso con `for update skip locked` y gasta el intento al reservarlo, así que cada aviso lo toma una sola
 * ejecución. Sin límite de tasa propio a propósito: el único trabajo antes de autenticar es una comparación
 * de huellas, y repetir la llamada con el secreto correcto no envía nada de más (el intervalo mínimo entre
 * reintentos lo fija la base). La respuesta solo trae conteos: nunca correos ni nombres.
 */
export async function GET(request: Request) {
  const auth = verifyCronRequest(request.headers.get("authorization"));
  if (auth === "disabled") return publicText("No encontrado.", 404);
  if (auth === "unauthorized") {
    await serverLog("warn", "cron_job_unauthorized", { job: JOB_NAME });
    return publicText("No autorizado.", 401);
  }

  const result = await runSendInvitationNotices();
  if (result.failed) {
    await serverLog("error", "cron_job_failed", { job: JOB_NAME });
    return publicJson({ job: JOB_NAME, failed: true }, 500);
  }
  await serverLog("info", "cron_job_done", {
    job: JOB_NAME,
    attended: result.attended,
    exhausted: result.exhausted,
  });
  return publicJson({ job: JOB_NAME, ...result });
}
