/**
 * Secreto FICTICIO con que las pruebas de punta a punta firman los avisos de entrega del correo
 * (`EMAIL_WEBHOOK_SECRET` del servidor de la prueba). Solo existe en pruebas: nunca es un secreto real.
 */
export const E2E_WEBHOOK_SECRET =
  "whsec_" + Buffer.from("secreto-ficticio-de-pruebas-e2e").toString("base64");
