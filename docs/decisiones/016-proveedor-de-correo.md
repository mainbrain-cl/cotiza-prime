# 016 · Proveedor de correo transaccional

**Estado:** **propuesta, pendiente de Aarón** · **Fecha:** 2026-10-06 · No relaja ninguna regla de la base.

## Contexto

El sprint 3 envía la cotización por correo (H-029) y recibe avisos de entrega y rebote (H-033). Hace
falta un proveedor de correo transaccional con dominio propio verificado (SPF, DKIM, DMARC). Hoy no
hay proveedor ni dominio: en desarrollo se usa Mailpit local, que no sale a internet.

Todo proveedor **procesa datos personales** (correo y nombre del cliente final, contenido del
mensaje) y suele alojarlos fuera de Chile. Por `LEGAL.md` §1.3 queda declarado como **encargado de
tratamiento**, con su acuerdo de tratamiento, y figura en la política de privacidad.

## Propuesta

**Resend**: API simple, clave anti-duplicado, avisos de rebote firmados y verificación del dominio
incluida. Alternativas: Postmark (la mejor entrega de correo transaccional) y Amazon SES (el más
barato; con región en São Paulo).

## Cómo se construye sin esperar la decisión

La capa de correo es **intercambiable** (`src/lib/email/`): un contrato común y un adaptador por
proveedor, elegido por la variable `EMAIL_PROVIDER` (`mailpit`, `memory`, `resend`, `smtp`).
Cambiar de proveedor es cambiar un adaptador y variables de entorno. En producción la aplicación se
niega a arrancar con `mailpit` o `memory`.

## Pendiente de Aarón

1. Elegir proveedor y dominio de envío (depende de la decisión pendiente §16.2 nº 1).
2. Firmar el acuerdo de tratamiento con el proveedor y declararlo en la política de privacidad.
3. Verificar la licencia de cualquier librería que se agregue (no se usará la de Resend: se llama
   por `fetch`).

**Hasta que esto se resuelva, el sprint 3 se prueba solo con Mailpit y no se cierra con clientes
reales.**
