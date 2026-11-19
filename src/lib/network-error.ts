/**
 * ¿El error es de red? (el navegador no pudo llegar al servidor). `fetch` lanza un `TypeError` con un texto que
 * cambia según el navegador: Chrome «Failed to fetch» (o «network error» si se corta la respuesta), Safari
 * «Load failed» (los más antiguos, «The Internet connection appears to be offline.»), Firefox «NetworkError when attempting
 * to fetch resource.». Los errores que vienen del servidor llegan como `Error` con un mensaje genérico, así que no calzan.
 * Límite conocido: un `fetch` bloqueado por CORS o por un bloqueador de anuncios da el mismo texto que una falla de red; solo
 * cambia el mensaje que se muestra («revisa tu conexión»), nada más.
 */
const NETWORK_ERROR_PATTERN =
  /^(failed to fetch|load failed|network error|network request failed|networkerror when attempting to fetch resource\.?|the network connection was lost\.?|the internet connection appears to be offline\.?)$/i;

export function isNetworkError(error: unknown): boolean {
  // Next no pudo descargar un trozo de código de la aplicación (por ejemplo, al perder la red al cambiar de pantalla).
  if (error instanceof Error && error.name === "ChunkLoadError") return true;
  if (!(error instanceof TypeError)) return false;
  return NETWORK_ERROR_PATTERN.test(error.message.trim());
}
