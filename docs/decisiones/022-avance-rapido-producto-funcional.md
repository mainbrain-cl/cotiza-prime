# 022 · Avance rápido: primero un producto funcional

- **Fecha:** 2026-11-25
- **Decide:** José (Main Brain), bajo la decisión 020. Se avisa a Aarón (plazo de aviso: 24 h).
- **Estado:** vigente

## Contexto

Al 2026-11-25 el desarrollo avanzaba muy lento para lo que se necesita: cada historia delicada pasaba por diseño de un agente
Opus, dos revisiones (normal y adversarial), correcciones y la batería completa en local (unas 1 a 1,5 horas por corrida, con el
CI apagado). El sprint 5 se estimó en unos 16 días y lleva casi 4 semanas. José pide tener Cotiza Prime **disponible
operativamente en 3 días**: primero un producto funcional con bases sólidas, después se pulen los detalles técnicos y
operacionales.

## Decisión

1. **Prioridad: que funcione de punta a punta en producción** (cotizar, enviar, aceptar y cobrar por transferencia). Lo que no
   sea eso se deja para después.
2. **Decisiones del día a día:** las propone Claude con su recomendación y sigue avanzando sin esperar respuesta; José o Aarón
   corrigen después si no están de acuerdo. Las de producto, dinero, proveedores y lo que ve el cliente final siguen siendo de
   Aarón, pero **no detienen el desarrollo**: se aplica el supuesto recomendado y queda anotado.
3. **Pruebas, reducidas:**
   - Por cada cambio: tipos, lint y las pruebas unitarias de lo tocado.
   - Una vez al día, antes de mezclar el lote del día: `test:db`, `test:isolation` (el aislamiento entre organizaciones sigue
     siendo el riesgo número uno) y unos pocos e2e de humo del recorrido principal.
   - **No** se corre el `chromium` completo en cada PR, ni `test:db:rollbacks` salvo cuando haya migraciones nuevas ese día.
   - Pruebas nuevas solo para cálculos de dinero, permisos y aislamiento. Nada de e2e exhaustivos por pantalla.
4. **Revisiones:** sin diseño previo del `planificador`. Una sola revisión Opus, y solo para lo que toca dinero, permisos o
   aislamiento. Sin revisión adversarial aparte.
5. **Mezclas:** lo delicado lo mezcla José con aviso a Aarón (como ya se hizo con H-040, H-004a y H-118), sin esperar su
   revisión previa. Aarón revisa después, en bloque.

## Lo que NO se relaja

- `tenant_id` y RLS en toda tabla; permisos verificados en el servidor; aislamiento probado a diario.
- Cada migración con su deshacer escrito.
- Nada de datos reales en pruebas; nada de secretos en el repositorio.
- **Riesgo que se declara y no se esconde:** salir con empresas reales antes de la revisión del abogado (decisión pendiente 9) y
  con la Ley 21.719 en plena vigencia desde el 2026-12-01 es decisión de Aarón y José; esta decisión no la toma por ellos.

## Consecuencias

- Habrá más errores pequeños en producción; se corrigen en caliente.
- Lo pospuesto queda en la lista de pendientes (`docs/seguridad-pendiente.md` y `HISTORIAS.md`), no se pierde.
- Precedencia: esta decisión relaja controles de proceso de `PROCESO.md` (ritmo de revisión y pruebas), no los de `SEGURIDAD.md`.
