/**
 * Secreto FICTICIO de las rutas de tareas programadas (`CRON_SECRET` del servidor de la prueba, decisión #17).
 * Solo existe en pruebas: nunca es un secreto real. Las pruebas de aislamiento lo usan para comprobar que la
 * ruta, ACTIVADA, rechaza a quien no lo trae (no corren la tarea con el secreto correcto).
 */
export const E2E_CRON_SECRET = "secreto-ficticio-de-pruebas-e2e-cron-0123456789";
export const E2E_OTHER_CRON_SECRET = "otro-secreto-ficticio-de-pruebas-e2e-9876543210";
