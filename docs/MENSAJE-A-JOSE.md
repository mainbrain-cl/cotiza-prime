# Mensaje de Aarón a José (para enviar tal cual)

> Escrito el 2026-10-27. Es el mensaje corto con que se le entrega el proyecto a José. La guía completa
> es [`TRASPASO.md`](TRASPASO.md).

---

Hola José, te paso Cotiza Prime para que lo avances. Es una plataforma web donde cada empresa chilena
arma sus cotizaciones con su marca y las sigue hasta el pago. Lleva unas 3 semanas de trabajo y está en
un 37 %.

**Para partir**

1. Te invité al repositorio privado `avronygg/cotiza-prime` en GitHub. Acéptalo y clónalo; no uses una
   copia de mi carpeta.
2. Lee primero `docs/TRASPASO.md`: trae cómo levantarlo (Node 24, Docker Desktop y Claude Code), qué
   documentos leer, dónde quedó todo y las trampas. No necesitas ninguna clave secreta, porque todo corre
   en local con datos ficticios.
3. Levántalo, entra a la app con `ana@ejemplo.test` (contraseña `Prueba-Cotiza-2026`) y recórrela
   completa: crea una cotización, envíala y acéptala como cliente. Así entiendes el producto.

**Lo que quiero que veas primero**

- Terminar H-092, que quedó a medias. Es lo último del sprint 4. El borrador está en la rama
  `wip/h-092-bloqueos-y-tope` (sin verificar: puede que no compile).
- Después, el sprint 5: equipo y permisos.
- Antes de subir cualquier cambio, corre todas las pruebas. El CI de GitHub no está funcionando por un
  problema de facturación mío, así que esas pruebas locales son la única red de seguridad.

**Reglas que no se saltan**

- La seguridad, la separación entre organizaciones y los datos personales no se relajan sin dejar una
  decisión escrita.
- Lo que cambie el alcance se escribe en `docs/`.
- Las decisiones de producto, dinero y proveedores son mías: pregúntame antes.

Tengo pendientes que yo debo resolver y que te frenan: aprobar las plantillas de PDF, el proveedor y
dominio de correo, el anti-robot real, y la facturación de GitHub. Están en la tabla de la sección 9 de
la guía.

Cualquier duda me escribes.
