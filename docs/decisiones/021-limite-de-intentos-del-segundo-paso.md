# 021 · Cómo frenar la fuerza bruta contra el código del segundo paso

**Estado:** **opción A elegida por José el 2026-11-11, de forma provisional.** Falta que **Aarón la ratifique** (cuesta dinero y
toca a un proveedor: decisión 020) y que se cumplan las condiciones de más abajo **antes del lanzamiento** ·
**Fecha:** 2026-11-11 · **Relacionada con:** H-004a (PR #44), H-004c, decisión 020, `docs/00-base/SEGURIDAD.md` §1

## Contexto

H-004a (verificación en dos pasos) deja a la base de datos exigir el segundo paso (D1 = B de Aarón): quien entra solo con la
contraseña no ve ni cambia nada. Al construirla se comprobó en local que Supabase Auth **no limita los códigos incorrectos**
(40 seguidos de una misma cuenta, ninguno bloqueado). El límite propio de la aplicación solo protege cuando el intento pasa por
nuestra pantalla; quien conoce la contraseña puede hablar directo con Supabase y probar códigos sin freno. Opus estimó (sin
medirlo) que, sin ningún tope, un código de 6 números se adivina en unas 2 horas.

El diseño de Opus (2026-11-11) evaluó cinco caminos. El único que cuenta por cuenta dentro de Supabase es el **hook**
`mfa_verification_attempt`: una función nuestra en la base de datos que Supabase llama en cada intento y que puede negarlo.

## Opciones consideradas

| | Qué es | Costo |
|---|---|---|
| **A** | Hook `mfa_verification_attempt` (cuenta fallos por cuenta: 5 cada 15 min, 15 al día) | 1 a 1,25 días, más un plan de Supabase que lo incluya |
| **B** | Verificación en dos pasos propia, sin el factor de Supabase | 2,5 a 3,5 días y una revisión adversarial |
| **C** | Aceptar el riesgo hasta el lanzamiento | 0 días |

## Decisión

**Se sigue por la opción A**, es decir, el hook. Es una decisión de trabajo de José, tomada el 2026-11-11 mientras se espera a
Aarón. No es todavía una decisión de dinero cerrada: el hook podría exigir un plan de pago de Supabase (se cree que Team o
Enterprise, del orden de US$599 al mes; **no confirmado**).

## Condiciones: lo que se exige **antes del lanzamiento**

Nada de esto se da por hecho; cada punto se confirma por escrito y queda anotado aquí o en `CLAUDE.md`:

1. **Confirmar el plan.** Ver en el panel del proyecto de Supabase de producción (Authentication → Hooks) que «MFA Verification
   Attempt» está disponible en el plan que se va a usar, y **Aarón ratifica el gasto** (o elige B).
2. **Construir el hook** según el diseño de Opus (migración con la guardia 15, función con candado por cuenta, deshacer con
   guardas, configuración `[auth.hook.mfa_verification_attempt]`, pruebas de base y con Supabase Auth real, e2e del límite).
   Historia nueva, por abrir; depende de H-004a.
3. **Activarlo y probarlo en producción** con una cuenta de prueba: seis códigos incorrectos seguidos tienen que dar el bloqueo,
   y el código correcto, ya bloqueada la cuenta, también se rechaza.
4. **Dejar escrito quién desbloquea** una cuenta y cómo (depende de la decisión pendiente 8 de `PROYECTO.md`, quién responde un
   incidente) y cómo se apaga el hook en una emergencia.
5. **Si la respuesta al punto 1 es «no se paga»**, esta decisión se revisa y se elige B antes de lanzar. **No se lanza con la
   opción C sin una decisión de Aarón registrada**, y en ese caso H-004c no puede prometer «aunque conozcan tu contraseña».

## Lo que sigue abierto

- **El piloto privado con empresas reales** no está cubierto por esta decisión. Sin el hook el riesgo sigue; si el piloto parte
  antes que el hook, Aarón tiene que aceptar por escrito ese riesgo.
- Las funciones públicas que solo miran `auth.uid()` (`create_tenant`, `accept_invitation`, `invitation_preview`,
  `accept_current_legal_documents` y la política `profiles_update`) se cierran en H-004c, junto con una prueba que avise si
  aparece otra del mismo tipo.
