/**
 * ÚNICO lugar donde se valida el pase de sesión (STACK.md §5b, punto 3).
 *
 * Aquí irá la verificación del JWT de Supabase Auth y la obtención del usuario
 * autenticado. Ningún otro archivo debe validar ni decodificar el pase por su cuenta:
 * el día que la identidad venga de un hub, se cambia solo este archivo.
 *
 * Pendiente: se implementa en el sprint 1 (historias de cuentas).
 */
export {};
