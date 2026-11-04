---
document_id: CP-SPRINT-005
title: Sprint 5 — Equipo y permisos
version: 1.0 (confirmado)
status: CONFIRMADO por José el 2026-10-28 (Compuerta 3 cruzada). Aarón queda avisado y puede objetar
basado_en: PROYECTO.md §5 · HISTORIAS.md · sprint 1 (orden de los 12 sprints) · docs/arquitectura/sprint-5-equipo-y-permisos.md
language: es-CL
---

# Sprint 5 — Equipo y permisos

## Objetivo

Que Aarón **invite a Juan como Comercial**, que Juan cotice con **precios bloqueados** y que **no vea
la configuración**. Es el sprint que convierte a Cotiza Prime de herramienta de una persona en
herramienta de un equipo, y habilita la aprobación (sprint 6) y el cobro (sprint 7), que dependen de
los roles.

## Qué entra

| Historia | Tamaño | Notas |
|---|---|---|
| H-004a · Activar la verificación en dos pasos | mediano | Escanear el código QR y pedir el código de la aplicación al ingresar |
| H-004b · Códigos de respaldo y desactivar la verificación | mediano | Códigos de un solo uso; desactivar exige un código válido |
| 🔒 H-004c · Dos pasos obligatorios para Dueño y Administrador | mediano | Obligatoria antes de usar las funciones de su rol (PROYECTO §13.2); va sola y al final |
| H-008 · Invitar a un miembro con su rol | mediano | Correo del invitado = dato personal: cifrado + huella. Enlace que caduca; reenviar y cancelar |
| H-009 · Aceptar una invitación | chico | Solo con el mismo correo al que se envió; con o sin cuenta previa |
| H-010 · Cambiar el rol de un miembro o quitarlo | mediano | Acceso se pierde al instante; nadie toca al Dueño; todo va a auditoría |
| 🔒 H-011 · Que cada rol haga solo lo que le corresponde | grande | **La diseña Opus antes** (`planificador`). Matriz de §5.2 en un solo punto, verificada en el servidor y en la base. Aplica a **todas** las pantallas ya construidas |
| H-040 · Configurar cuándo se exige aprobación | mediano | Solo la **configuración** de la regla; el flujo de aprobar llega en el sprint 6 |
| H-041 · Bloquear precios y poner topes de descuento | mediano | El servidor rechaza el cambio aunque no pase por la pantalla |
| H-042 · Limitar qué servicios cotiza cada comercial | chico | |
| H-048a · Administrar los textos listos para usar | grande | Correo base, condiciones, exclusiones y notas al pie; solo Dueño y Administrador. Diseño listo (`sprint-5-h-048-textos.md`), unos 4 días |
| 🔒 H-048b · Usar los textos al cotizar, con exclusiones y notas al pie propias | grande | Va después de H-041 y nunca en paralelo con ella; cambia lo que ve el cliente final. Unos 4,5 días |

**Total estimado:** el plan de sprints decía **9 días**, pero el diseño del `planificador`
(`docs/arquitectura/sprint-5-equipo-y-permisos.md` §7) suma **unos 16 días solo para H-011, H-008, H-009,
H-010, H-004 (a, b y c) y H-041**, sin contar H-040, H-042 ni H-048. **El sprint es bastante más grande de lo
estimado.** Antes de confirmarlo conviene decidir si se parte (por ejemplo, equipo y roles primero, y dos
pasos y precios bloqueados después).

## Orden de construcción

Según el diseño del `planificador` (detalle en `docs/arquitectura/sprint-5-equipo-y-permisos.md` §7). Las
migraciones las hace un solo agente, de a una y en orden.

1. **H-011a, matriz única de permisos** (2 días, migración `role_matrix`): un módulo, funciones en la base,
   pantalla «No tienes permiso», menú por rol y cambio de los ~20 lugares donde hoy se copian los roles.
2. **H-008, invitar** (2 días, migración `invitations`).
3. **H-009, aceptar una invitación** (1,5 días, migración `invitation_accept`).
4. **H-010, cambiar el rol o quitar a un miembro** (1,5 días, migración `member_management`).
5. **H-011b, pruebas por rol y revisión de Opus** de H-011 y de H-008 a H-010 (1,5 días).
6. **H-004a, activar los dos pasos** (2 días); puede ir en paralelo con el paso 4 una vez integrada su
   migración. **H-004b**, códigos de respaldo (1,5 días, `mfa_recovery_codes`).
7. **H-041, precios bloqueados y tope de descuento** (2 días, migración `price_locks`).
8. **H-004c, dos pasos obligatorios** para Dueño y Administrador (1,5 días, `mfa_required_roles`): va solo y
   al final, porque cambia el pase de las cuentas de prueba en todas las pruebas.
9. **Con diseño, sin construir:** H-040 (`sprint-5-h-040-aprobaciones.md`; bloqueada por la decisión 15 y D1, D3 y D4)
   y H-048 (`sprint-5-h-048-textos.md`): **H-048a** después de H-011b, y **H-048b** después de H-041. **Sin diseño aún:**
   H-042 (chica), que se engancha en la función de H-041. H-040 usa la matriz de H-011.
10. Cierre con la batería completa (unitarias, base de datos, aislamiento y punta a punta).

H-004 se partió en **tres historias** (a, b y c) y H-048 en **dos** (a y b) en `HISTORIAS.md` el 2026-11-02 (el supuesto de la pregunta 15 y la decisión de José sobre H-048).

## Lo que hay que decidir antes de construir

| # | Qué | Quién | Supuesto actual |
|---|---|---|---|
| 1 | **Confirmar este sprint** (Compuerta 3) | Aarón | ✅ Confirmado por José el 2026-10-28, con el orden de construcción de arriba y los supuestos de esta tabla. No se partió el sprint: el orden ya deja cortes naturales (después del paso 5 y después del paso 7) por si hay que cerrar antes |
| 2 | **¿Una o varias cuentas bancarias por organización?** (decisión pendiente 6). La tabla de preparación la ubica antes del sprint 5, pero **ninguna historia de este sprint toca cuentas bancarias**: la necesita el sprint 6 (H-050 en adelante). Se propone pedirla igual ahora | Aarón | Una sola |
| 3 | **Quién puede enviar directo, sin aprobación** (decisión pendiente 15): define cómo se guarda la regla de H-040 (por organización, por rol o por persona) | Aarón | Por organización, con excepción por persona |
| 3b | **Canal de los avisos internos** (decisión pendiente 5: dentro de la app, por correo o ambos). **No bloquea este sprint**: lo necesita el sprint 6, cuando el aprobador recibe el aviso | Aarón | Ambos |
| 4 | **Proveedor y dominio de correo** (decisión 016): las invitaciones salen por correo real | Aarón | En local se usa Mailpit; no bloquea el desarrollo, sí cerrar con clientes reales |
| 5 | **21 preguntas abiertas del diseño** (`docs/arquitectura/sprint-5-equipo-y-permisos.md` §8), cada una con su supuesto. Las que más pesan: ¿un Dueño o Administrador sin los dos pasos queda como Observador? (1), ¿un Administrador puede manejar a otros Administradores? (4), ¿basta con perder el acceso «en el siguiente clic»? (11), ¿puede el Comercial poner líneas libres con precio a mano, saltándose el bloqueo? (18) | Aarón / José | Los supuestos del diseño |

## Qué se podrá mostrar

> Aarón entra a Negocio 1 y activa la verificación en dos pasos. Invita por correo a Juan como
> Comercial; Juan abre el enlace, crea su cuenta y entra. Juan ve las cotizaciones de todos pero solo edita
> las suyas, cotiza con un precio bloqueado (con candado) y un descuento con tope, y no ve ni el menú de
> configuración ni los datos bancarios; si escribe a mano la dirección de una pantalla de configuración,
> ve «No tienes permiso para esto». Aarón cambia a Juan a Observador, y Juan, con la sesión abierta,
> pierde el acceso al instante. La prueba automática de aislamiento sigue en verde.

## Fuera

Aprobar o rechazar cotizaciones y el correo que sale solo (sprint 6); datos de transferencia y cobro
(sprints 6 y 7); regla de aprobación por margen (sprint 10).

## Riesgos

- **Aplicar la matriz a pantallas ya hechas** es donde más fácil se olvida una: cada acción de servidor
  existente se revisa una por una y lleva su prueba por rol.
- **Quitar a un miembro «al instante»** exige no confiar solo en el pase de sesión: se verifica la
  membresía en cada petición.
- **Las invitaciones son una puerta nueva a internet** (enlace con token): límite de tasa, caducidad y que
  no revelen si un correo ya tiene cuenta.
- **Dos pasos obligatorios** pueden dejar fuera a un Dueño que pierde su teléfono: los códigos de respaldo
  y el plan de recuperación se definen antes de activar la obligación.
