# 017 · El enlace del cliente pasa por un portero en el servidor

**Estado:** aceptada por la sesión principal el 2026-10-06 (más exigente que el diseño anterior),
**pendiente de ratificación de Aarón** · **Modifica:** `docs/arquitectura/modelo-datos.md` §4.6.

## Contexto

El cliente final abre su cotización sin cuenta. `modelo-datos.md` §4.6 dejaba esa lectura como
funciones de base de datos que podía llamar quien no tiene sesión.

Eso tiene tres problemas: la llave pública es pública y cualquiera podría llamar las funciones
saltándose el límite de intentos y la validación de la aplicación; quien llama podría **inventar la
IP** del registro de aceptación (el mismo problema de H-114); y habría funciones ejecutables sin
sesión, algo que hoy ninguna prueba permite.

## Decisión

1. El navegador del cliente **nunca habla con la base de datos**. Las pantallas `/c/[token]` y las
   direcciones `/api/v1/public/quote-links/[token]/…` pasan por un **portero** en el servidor
   (`src/lib/share/gateway.ts`).
2. El portero usa la llave maestra solo para llamar **tres funciones angostas** (leer, registrar
   apertura, responder), ejecutables únicamente por el servidor. Una prueba estática vigila que no
   use nada más.
3. La IP y el navegador salen del servidor, nunca del navegador del cliente.
4. El token es aleatorio de 43 caracteres; en la base se guarda solo su sello (`sha256`). Cada correo
   lleva su enlace propio; revocar anula todos los de una cotización.
5. Una petición GET nunca cambia el estado (los antivirus abren los enlaces solos); la apertura se
   registra con un aviso aparte desde la página.

## Consecuencias

Ninguna función de la base queda ejecutable sin sesión; la prueba de estructura sigue válida. La
regla del linter sobre la llave maestra se amplía a tres archivos concretos (portero, subida del PDF
y avisos del proveedor de correo).
