# Seguridad pendiente antes del primer cliente real

> Criterio de Aarón (2026-11-17): en esta etapa Cotiza Prime lleva **la seguridad básica** que toda plataforma debe tener
> (ingreso, permisos por organización, segundo paso, nada de datos expuestos). Lo específico o avanzado se anota aquí y **no se
> construye ahora**, para avanzar y pulir el producto. **No se empiezan historias de seguridad nuevas** (H-117, H-004c u otras)
> hasta que el producto esté pulido.
>
> **Esta lista se revisa y se cierra antes del primer cliente real con datos reales**, no recién en el lanzamiento público.
> Lo básico no se recorta: una organización nunca ve datos de otra, los permisos por rol, la contraseña y el segundo paso, y no
> exponer datos personales.

Origen: revisión de Aarón al PR #56 (H-004b), 2026-11-17. Los números (I-1, M-1…) son los de esa revisión.

## Riesgos aceptados hasta H-117

| # | Qué | Estado |
|---|---|---|
| D7 | Con una sesión completa robada se puede quitar el segundo paso hablando directo con Supabase (responde 200), sin contraseña ni aviso. Aceptado hasta H-117 (decisión 021, opción B antes del lanzamiento) | Aceptado |
| I-1 | Con `secure_password_change = true` (`supabase/config.toml:232`), una sesión completa robada de menos de 24 h podría cambiar la contraseña directo en GoTrue, quitar el factor (D7) y activar su propio teléfono pasando la contraseña pedida de nuevo. La dueña recibe los avisos y puede anular con el enlace de H-118. **Sin probar.** Variante más grave de D7 | Se cierra con H-117 |
| I-2 | Tras entrar con un código de respaldo la cuenta queda solo con contraseña hasta reactivar (D2 = A). Opción futura: pedir una contraseña nueva en ese paso (+0,5 día) | Pendiente |

## Pendientes menores

- **M-1:** «cerrar las otras sesiones» no corta la base al instante: un pase ya emitido sigue valiendo hasta 15 min (`jwt_expiry = 900`). (La frase del diseño de H-004b ya lo dice.)
- **M-2:** pedir la contraseña de nuevo gasta el cupo de ingresos por IP de Supabase (la IP del servidor). Falta un límite propio por cuenta en `confirmPassword`; medir el cupo en producción.
- **M-6:** las huellas de los códigos de respaldo usan la misma llave de búsqueda que el resto (`CP_SEARCH_KEY_V1`), con 60 bits por código.
- **Aviso propio de Supabase** `mfa_factor_unenrolled`: podría mitigar D7. Sin verificar en la CLI 2.119 ni en el alojado.
- `recovery-code-actions.ts` (rama de `removeAllFactors` + `hasVerifiedFactor` fallando seguidos): el factor pudo quitarse sin aviso. Mandar el aviso igual en esa rama.
- `mfa_recovery_code_release` no revisa `claimed_until` ni toma el candado por cuenta. Hoy no se puede alcanzar.
- La limpieza de juegos huérfanos puede hacer que `complete` responda `invalid` a mitad de un ingreso con código. No hace daño; tenerlo presente al leer `mfa_recovery_complete_not_applied`.

## Antes del piloto (de H-004b, sin trabajo ahora)

- Medir el cupo de Resend (plan gratuito: 100 correos al día; con el día agotado nadie puede activar ni desactivar, D4 = A).
- Medir el cupo de ingresos por IP de Supabase en producción (`sign_in_sign_ups`).
- Proveedor de correo de producción listo (sin el aviso nadie puede desactivar).
- Las demás listas «Antes del piloto» de `CLAUDE.md` (H-004a, H-118, plantilla de recuperación, `CRON_SECRET`) siguen vigentes.
