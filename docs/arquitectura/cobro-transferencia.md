# Cobro por transferencia (H-050 a H-057)

> Fase 4 · construido el 2026-11-26 bajo la decisión 022 (producto funcional primero): sin diseño previo largo, pruebas mínimas
> (dinero, permisos y aislamiento) y un e2e de humo. Migración `20261126100000_payments_transfer` (deshacer en
> `supabase/rollbacks/`).

## Qué hace

1. **Datos de transferencia (H-050).** Configuración → «Datos de transferencia» (`/o/[tenantId]/configuracion/pagos`). Una cuenta
   por organización: banco (lista cerrada), tipo, número, titular, RUT del titular (validado) y correo. Solo el Dueño y el
   Administrador (`bank_account.manage`) la ven y la cambian: en la pantalla, en la acción y en la base (RLS de `bank_accounts` y
   `set_bank_account`). Todo va cifrado en `details_enc` (sello `bank_accounts.details|organización|id`); en claro solo los últimos
   4 del número. Cada cambio queda en la auditoría (`bank_account.created` / `bank_account.changed`, con quién, cuándo y los últimos
   4 antes y después) y choca si otra persona la cambió entremedio (revisión).
2. **Condición de pago (H-052).** En `/enviar`: «100 % al aceptar» (por defecto) o «50 % al aceptar y 50 % al final», con el monto de
   cada pago. Se guarda en `quotes.payment_terms` al elegirla (`set_quote_payment_terms`, solo el autor, solo en borrador, sin cambiar
   la revisión) para que la vista previa del PDF ya la muestre; el envío la vuelve a fijar. Va en el PDF y en el enlace («Forma de
   pago»), y por eso en el paquete congelado que se aprueba.
3. **Al aceptar (H-053).** Un disparador diferido sobre `quote_responses` (`quote_responses_start_payments`, corre al confirmar la
   aceptación) crea los hitos en `payment_milestones` UNA vez, con enteros (50/50: anticipo `total / 2`, saldo `total − anticipo`:
   el peso sobrante va al saldo y la suma es el total), congela la cuenta en `quote_payment_accounts` (copia del texto cifrado y de
   su revisión) y pasa la cotización a «Pendiente de pago» o «Pendiente de anticipo». Después, el servidor envía el **correo 2** al
   cliente (monto y datos de transferencia congelados, con la marca de la organización) y lo anota en `email_messages`
   (`payment_1`) y en la línea de tiempo. El enlace del cliente, ya aceptado, muestra «Datos para pagar» (`share_link_payment`).
   **Antes de aceptar, la base no entrega nada bancario**: ni el correo 1 ni el enlace los traen.
4. **Marcar un pago (H-054)** y **pedir el saldo (H-056).** En la cotización, el panel «Pagos»: «Marcar como recibido» (fecha, monto y
   nota; si el monto no coincide con el esperado se advierte antes de confirmar) solo para el Dueño y el Administrador
   (`payment.confirm`); el saldo solo después del anticipo. «Solicitar segundo pago» (Comercial en las suyas, Dueño y Administrador en
   todas, `payment.second.request`): pasa a «Pendiente de saldo» y envía el **correo 3** con el saldo y los datos con que se aceptó
   (si la cuenta cambió después, se usan los originales y el aviso de éxito lo dice). Repetirlo reenvía el correo sin cambiar nada.
   Estados según §7: Pendiente de pago / de anticipo → Anticipo pagado → Pendiente de saldo → Pagada; se ven en la lista y en la
   cotización (insignias que ya existían).
5. **Qué falta por cobrar (H-057).** En la cotización («Falta por cobrar $X» / «Todo pagado») y en el Inicio («Falta por cobrar $X en
   N cotizaciones», suma de los hitos sin recibir).
6. **Deshacer un pago (H-055).** «Deshacer» con motivo obligatorio (3 a 200 caracteres), en orden (el anticipo solo si el saldo no
   se pidió ni se pagó). El hito vuelve a «por pagar» (o «pedido»), la cotización al estado anterior, y el pago original y la
   reversión con su motivo quedan en la línea de tiempo y en la auditoría.
7. **Aviso de cambio de cuenta (H-051, parcial).** Al guardar la cuenta, correo al Dueño y a los Administradores con quién, cuándo y
   los últimos 4 antes y después (de mejor esfuerzo, después de responder).

## Cobro — decisiones aplicadas

- **Una sola cuenta por organización** (supuesto de la decisión pendiente 6).
- **Los datos bancarios se congelan al ACEPTAR**, no al enviar (como pide §13.2: «el correo de segundo pago de una cotización
  antigua usa los datos con que se aceptó»). La ficha H-053 decía «al enviarla»; manda §13.2.
- **Sin datos de transferencia, la cotización sale sin condición de pago** (`payment_terms` vacío) y al aceptarla no se crean hitos
  ni sale el correo 2; `/enviar` lo avisa con un enlace a Configuración (o «pide al Dueño o a un Administrador»). Así se cumple «sin
  datos de transferencia no puedo enviar una cotización con condición de pago» sin frenar a quien todavía no cobra por la plataforma,
  y las cotizaciones de antes del cobro siguen funcionando igual.
- **Valor por defecto: 100 %.** No existe todavía una condición por defecto de la organización (onboarding, paso 7): se agrega
  cuando llegue esa pantalla.
- **La verificación en dos pasos NO se exige aún para guardar la cuenta** (criterio de H-050): depende de H-004c (dos pasos
  obligatorio para Dueño y Administrador), que no está construida. **Antes del piloto** conviene exigirla.
- **El correo 3 lo pide el servidor con el pase de quien lo solicita**: `request_second_payment` devuelve los datos bancarios
  CIFRADOS (solo el servidor los abre). Un Comercial que llamara la función directo recibiría solo texto cifrado. No hay vista previa
  del correo con los datos bancarios: el Comercial no puede ver la cuenta (§5.2); ve el monto y un texto de qué se enviará.
- **El motivo de deshacer va en la línea de tiempo** (`quote_events.data.reason`, hasta 200 caracteres), para que «se vean el pago,
  la reversión y el motivo». Es texto del equipo; no se debe escribir ahí datos del cliente.
- **La nota del pago va en claro** (`payment_milestones.paid_note`, hasta 500), visible para todo miembro, como las observaciones.
- **El portero del enlace del cliente pasa de seis a nueve funciones** (`share_link_payment`, `share_payment_notice`,
  `share_payment_notice_record`): la guardia 8 se actualizó con las tres nuevas (sigue exigiendo la lista exacta).
- **La fecha del pago** acepta hasta el día hábil siguiente (zona horaria) y no antes del 2000; el monto, de 0 a un billón.

## Lo que quedó fuera

- H-051 completo: el aviso «cambio reciente en datos bancarios» en el Inicio y el registro de actividad con valor anterior y nuevo en
  pantalla (hoy queda en la auditoría con los últimos 4). Los correos de H-051 no se anotan en `email_messages` (la tabla exige una
  cotización).
- H-056: avisar al Administrador cuando los datos bancarios cambiaron desde que se aceptó (hoy solo lo dice el aviso de éxito a quien
  pide el saldo).
- H-057: una lista propia de cotizaciones por cobrar con días de espera y filtro «Con pago pendiente» en el listado.
- Exigir dos pasos para guardar la cuenta (H-004c) y la condición de pago por defecto de la organización (onboarding).
- El reenvío del correo 2 desde la pantalla (si falló al aceptar, hoy solo queda «No se pudo enviar…» en la línea de tiempo).
- `share_link_record_view` no registra aperturas de una cotización ya en cobro (solo hasta «Aceptada»).
