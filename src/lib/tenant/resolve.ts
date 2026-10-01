/**
 * ÚNICO punto donde se resuelve la organización activa, es decir, el `tenant_id`
 * (STACK.md §5b, punto 4; PROYECTO.md §13.1).
 *
 * Una persona puede pertenecer a varias organizaciones, así que el `tenant_id` NO sale
 * del pase de sesión: sale de la organización activa elegida, y aquí se verifica en cada
 * petición que el usuario sea miembro de ella. Nadie más decide de dónde sale el tenant.
 *
 * Pendiente: se implementa en el sprint 1, junto con el modelo de datos.
 */
export {};
