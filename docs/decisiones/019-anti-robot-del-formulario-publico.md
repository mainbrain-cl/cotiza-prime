# 019 · Protección anti-robot del formulario público

**Estado:** **propuesta, pendiente de Aarón** · **Fecha:** 2026-10-07 · No relaja ninguna regla de la base.

## Contexto

El formulario público (sprint 4) deja que un desconocido escriba datos personales en la base. `PROYECTO.md`
§12 y §13.5 piden protección anti-robot («Turnstile o equivalente»), límite de tasa y tope de solicitudes.

## Propuesta

**Cloudflare Turnstile.** Gratis, sin librería que instalar (se carga su script en la página del formulario y
se verifica del lado del servidor consultando su dirección `siteverify`). El servidor comprueba además que el
`hostname` sea el de la aplicación y que la acción sea la del formulario. **Si Cloudflare no responde, el envío
se bloquea.**

**Costo legal:** Cloudflare recibe la IP y datos del navegador de quien llena el formulario, con transferencia a
EE. UU. Queda declarado como **subencargado de tratamiento** (`LEGAL.md` §1.3), con su acuerdo, y se menciona en
el aviso de privacidad del formulario.

**Alternativa:** ALTCHA (MIT, corre en nuestro propio servidor, sin terceros): sin transferencia de datos, pero
protege menos contra robots que resuelven pruebas de trabajo.

## Cómo se construye sin esperar la decisión

El verificador es **intercambiable** (`src/lib/antibot/`: contrato común y un adaptador por proveedor, elegido
por variable de entorno). El adaptador `memory` sirve para las pruebas y la aplicación se niega a arrancar con
él en producción. Cambiar de proveedor es cambiar un adaptador y variables de entorno.

## Pendiente de Aarón

1. Elegir Turnstile o ALTCHA.
2. Si es Turnstile: abrir la cuenta de Cloudflare de la agencia y aceptar su acuerdo de tratamiento.
3. Confirmar que se declara en la política de privacidad.

**Hasta que esto se resuelva, el sprint 4 se prueba solo con el adaptador de pruebas y no se publica.**
