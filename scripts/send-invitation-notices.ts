// Tarea de los avisos al Dueño por invitaciones (H-008): envía los pendientes y reintenta los fallidos.
// Uso: npm run job:invitation-notices   (programarla cada pocos minutos).
import { runSendInvitationNotices } from "../src/server/jobs/send-invitation-notices";

async function main(): Promise<void> {
  const result = await runSendInvitationNotices();
  console.log(JSON.stringify({ job: "invitation-notices", ...result }));
}

void main();
