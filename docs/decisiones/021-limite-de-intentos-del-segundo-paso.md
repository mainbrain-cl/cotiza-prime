# 021 · Cómo frenar la fuerza bruta contra el código del segundo paso

**Estado:** **decidida por Aarón el 2026-11-12: opción C para el piloto privado y opción B antes del lanzamiento público.** No se
paga el plan Team de Supabase (opción A). La opción A fue elegida por José el 2026-11-11 de forma provisional y **Aarón la
reemplazó** al ratificar · **Fecha:** 2026-11-11 (propuesta), 2026-11-12 (decisión) · **Relacionada con:** H-004a (PR #44), H-117,
H-118, H-004c, decisión 020, `docs/00-base/SEGURIDAD.md` §1 y §10

## Contexto

H-004a (verificación en dos pasos) deja a la base de datos exigir el segundo paso (D1 = B de Aarón): quien entra solo con la
contraseña no ve ni cambia nada. Al construirla se comprobó en local que Supabase Auth **no limita los códigos incorrectos**
(40 seguidos de una misma cuenta, ninguno bloqueado). El límite propio de la aplicación solo protege cuando el intento pasa por
nuestra pantalla; quien conoce la contraseña puede hablar directo con Supabase y probar códigos sin freno. Opus estimó (sin
medirlo) que, sin ningún tope, un código de 6 números se adivina en unas 2 horas.

El diseño de Opus (2026-11-11) evaluó cinco caminos. El único que cuenta por cuenta dentro de Supabase es el **hook**
`mfa_verification_attempt`: una función nuestra en la base de datos que Supabase llama en cada intento y que puede negarlo. Se cree
que solo viene en los planes Team o Enterprise de Supabase (del orden de US$599 al mes; **no confirmado**).

## Opciones consideradas

| | Qué es | Costo |
|---|---|---|
| **A** | Hook `mfa_verification_attempt` (cuenta fallos por cuenta: 5 cada 15 min, 15 al día) | 1 a 1,25 días, más un plan de Supabase que lo incluya |
| **B** | Verificación en dos pasos propia, sin el factor de Supabase | 2,5 a 3,5 días y una revisión adversarial |
| **C** | Aceptar el riesgo hasta el lanzamiento | 0 días |

## Decisión (Aarón, 2026-11-12)

1. **No se paga el plan Team** (opción A descartada).
2. **Piloto privado: opción C, con el riesgo aceptado por escrito por Aarón el 2026-11-12.** Con la contraseña de una cuenta,
   alguien puede probar códigos directo contra Supabase y saltarse nuestro límite. Se acepta porque el atacante necesita la
   contraseña de un usuario y, además, muchísimos intentos. Queda anotado como riesgo aceptado en H-117, con esta fecha.
3. **Antes del lanzamiento público: opción B** (verificación propia, 2,5 a 3,5 días), junto con la espera creciente en lugar del
   bloqueo de 24 horas. Historia **H-117**. La opción B también cierra el reuso de un código ya visto mandado directo a Supabase
   (menor 1 de la revisión de Aarón al #44): con el hook habría quedado abierto igual.
4. **Sin lanzamiento público sin B.** No se lanza con la opción C, y H-004c no puede prometer «aunque conozcan tu contraseña»
   mientras B no esté.

## Condiciones para el lanzamiento público

1. Construir la opción B según el diseño que haga el `planificador` (historia H-117, delicada, con revisión adversarial).
2. **Producción:** al crear el proyecto de Supabase de producción, en la misma lista que Confirm email y Secure email change de
   H-009: **apagar los factores por teléfono y WebAuthn** (la base cuenta cualquier factor verificado y la aplicación solo maneja
   TOTP), **medir el cupo de verificaciones** de Supabase Auth (todas salen de la IP del servidor). El aviso por correo al activar ya
   no es el de Supabase: lo enviamos nosotros con el enlace para anular (H-118, `docs/arquitectura/h-118-anular-activacion.md`; el aviso
   de Supabase se apaga allí), así que lo que hay que dejar listo en producción es el proveedor de correo (decisión 016, Resend).
3. Probar el bloqueo en producción con una cuenta de prueba.

## Procedimiento de soporte para quitar un segundo factor (Aarón, 2026-11-12)

Quitar el segundo paso sin cuidado es la puerta de atrás de todo lo demás, por eso:
1. La solicitud tiene que **llegar desde el correo registrado de la cuenta**.
2. La tiene que **confirmar el Dueño de la organización**. Si quien pide es el Dueño, basta su correo.
3. **24 horas de espera, con aviso al correo de la cuenta,** antes de quitar el factor.
4. **Durante el piloto lo hace solo Aarón.**

**Quién responde un incidente** (decisión pendiente 8 de `PROYECTO.md` §16.2, resuelta el mismo día): Aarón (Main Brain), en días
hábiles de 9 a 19 h; fuera de ese horario, al siguiente día hábil.

## Seguimientos, en este orden (Aarón, 2026-11-12)

0. **Prioritario antes del piloto:** enlace de un solo uso en el correo de aviso al activar, para **anular la activación**
   (historia **H-118**; diseño en `docs/arquitectura/h-118-anular-activacion.md`, decidido por José el 2026-11-12). Cierra el caso de quien tiene la contraseña de una cuenta sin segundo paso, activa el suyo y deja fuera al
   dueño. Mientras no exista, vale el procedimiento de soporte de arriba.
1. Pedir la contraseña de nuevo antes de activar (H-004b). No cierra el caso anterior (el atacante ya la sabe), pero se mantiene
   por otras razones.
2. «Cambiar contraseña» dentro de una sesión completa.
3. Leer `auth.sessions.aal` para decidir el nivel de la sesión.
4. Espera creciente en lugar del bloqueo de 24 horas (junto con la opción B).
5. Correo de aviso cuando la contraseña es correcta y el código falla (decisión 016), cuando exista el proveedor de correo.
