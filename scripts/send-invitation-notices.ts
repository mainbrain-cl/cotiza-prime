// Tarea de los avisos al Dueño por invitaciones (H-008): envía los pendientes y reintenta los fallidos.
// SOLO PARA USO LOCAL O MANUAL: usa `tsx` y `.env.local` (herramientas de desarrollo). En producción hay que
// programarla de otra forma (decisión pendiente; ver docs/PROYECTO.md §16.2 #17).
// Uso: npm run job:invitation-notices. Termina con código 1 si la tarea no pudo correr.
import { runSendInvitationNotices } from "../src/server/jobs/send-invitation-notices";

async function main(): Promise<void> {
  const result = await runSendInvitationNotices();
  console.log(JSON.stringify({ job: "invitation-notices", ...result }));
  if (result.failed) process.exitCode = 1;
}

main().catch(() => {
  console.error(JSON.stringify({ job: "invitation-notices", failed: true }));
  process.exitCode = 1;
});
