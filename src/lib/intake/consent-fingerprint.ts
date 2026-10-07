/**
 * Huella corta del aviso de privacidad que se le mostró a la persona (texto y enlace a la política).
 * El navegador la calcula con lo que tiene en pantalla y la manda al enviar; el servidor la compara con
 * la del aviso que armaría AHORA. Si no coinciden, el aviso cambió mientras la persona llenaba el
 * formulario y se le muestra el nuevo antes de guardar su aceptación (así lo que se guarda como
 * consentimiento es siempre lo que leyó).
 *
 * No es una huella de seguridad (nadie gana nada falsificándola: el servidor guarda SIEMPRE el texto que
 * armó él), solo detecta cambios. Por eso es un cálculo simple y síncrono (cyrb53), que funciona también
 * en páginas sin contexto seguro, donde `crypto.subtle` no existe. Código puro: sirve en servidor y navegador.
 */
export const CONSENT_FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;

export function consentFingerprint(text: string, privacyPolicyUrl: string | null): string {
  const material = `${text}\n${privacyPolicyUrl ?? ""}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < material.length; i++) {
    const code = material.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const high = (h2 >>> 0).toString(16).padStart(8, "0");
  const low = (h1 >>> 0).toString(16).padStart(8, "0");
  return `${high}${low}`;
}
