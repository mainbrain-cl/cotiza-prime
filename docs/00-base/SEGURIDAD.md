---
document_id: BASE-SEG
title: Base de Seguridad — cualquier proyecto
version: 1.0
status: ACTIVE
aplica_a: todo proyecto de la agencia
last_updated: 2026-08-13
language: es-CL
---

# Base de Seguridad

**Qué es este documento.** Los controles de seguridad que aplican a cualquier proyecto, sin importar el rubro ni el tamaño. Se copia tal cual a cada proyecto nuevo.

**El principio.** La seguridad se construye desde el inicio o no se construye. Agregarla después siempre sale más caro, y casi siempre queda incompleta.

---

## 1. Identidad y acceso

- **Autenticación centralizada, autorización distribuida.** La identidad la emite un solo punto; qué puede hacer cada quien lo decide cada aplicación con sus propios roles.
- **Pase liviano.** El token lleva identidad y a lo sumo roles gruesos. El permiso fino lo resuelve la aplicación, no el token.
- **Pases de vida corta y revocables**, que se renuevan solos. Un pase robado no debe dar acceso indefinido.
- **Verificación en dos pasos obligatoria** en todas las cuentas administrativas y de proveedores.
- **Cierre de sesión efectivo:** invalidar el pase, no solo borrarlo del navegador.
- **Límite de intentos** en el ingreso, contra fuerza bruta.

---

## 2. Datos

- **Aislamiento entre clientes.** Si el sistema es multi-cliente, RLS activo en toda tabla con datos de clientes. Es la primera línea de defensa: funciona aunque el código tenga un error.
- **Cifrado en tránsito.** HTTPS siempre, con HSTS.
- **Cifrado en reposo** de columnas con datos personales, y obligatorio para sensibles y financieros.
- **Respaldos automáticos con restauración probada.** Probar la restauración al menos una vez y anotar cuánto tardó.
- **Sin datos reales en entornos de prueba.** Nunca, bajo ninguna justificación.

---

## 3. Entrada y salida

- **Validación de entrada.** Todo dato externo se valida en el borde con esquemas. Nunca confiar en el cliente.
- **Consultas parametrizadas** siempre. Concatenar texto para armar consultas es inyección esperando ocurrir.
- **Escape de salida** para prevenir ejecución de código en el navegador.
- **Límite de tasa** en endpoints públicos.
- **Límite de tamaño** en cargas de archivos, con validación de tipo real y no solo de extensión.

---

## 4. OWASP Top 10 — mínimo exigible

| Riesgo | Control mínimo |
|---|---|
| Control de acceso roto | Verificar permisos en el servidor, en cada petición. Nunca confiar en que la interfaz ocultó el botón |
| Fallas criptográficas | HTTPS, cifrado en reposo, sin algoritmos obsoletos |
| Inyección | Consultas parametrizadas, validación de entrada |
| Diseño inseguro | Modelar las amenazas antes de construir |
| Configuración incorrecta | Sin valores por defecto, sin páginas de error con detalle técnico |
| Componentes vulnerables | Escaneo de dependencias en cada integración |
| Fallas de identificación | Pases de vida corta, verificación en dos pasos, límite de intentos |
| Fallas de integridad | Dependencias fijadas por versión, sin fuentes no verificadas |
| Fallas de registro | Auditoría de acciones sensibles, con alertas |
| Falsificación de petición del servidor | Lista blanca de destinos en peticiones salientes |

---

## 5. Cabeceras y configuración

| Cabecera | Para qué |
|---|---|
| `Strict-Transport-Security` | Obliga HTTPS en visitas siguientes |
| `Content-Security-Policy` | Limita de dónde se puede cargar código |
| `X-Content-Type-Options: nosniff` | Impide que el navegador adivine tipos |
| `X-Frame-Options` o CSP `frame-ancestors` | Evita que el sitio se incruste en otro |
| `Referrer-Policy` | Controla qué información se filtra al navegar |

Cookies de sesión: `HttpOnly`, `Secure` y `SameSite`.

---

## 6. Secretos

- **Nunca en el código ni en el repositorio.** Bajo ninguna circunstancia.
- **Nunca por chat, correo ni mensajería.** Viven en las variables de entorno del proveedor de despliegue.
- **Rotación periódica**, y **rotación inmediata** cuando alguien deja el equipo.
- **Un secreto por entorno.** Los de pruebas no sirven en producción y viceversa.
- **Escaneo del repositorio** para detectar secretos filtrados por accidente.

---

## 7. Personas y accesos

- **Las cuentas son de la agencia, no de las personas.** Cada uno entra invitado con su propia cuenta.
- **Nadie comparte credenciales.** Si alguien necesita acceso, se le da el suyo.
- **Menos manos en producción.** Quien desarrolla no necesita acceso a la base de producción por defecto.
- **Al salir alguien, el mismo día:** quitar accesos, **rotar todo secreto que haya podido ver**, y revisar el correo maestro si lo tenía.
- **Inventario de accesos** actualizado, revisado cada tres meses.
- **El correo maestro** del que cuelgan las cuentas necesita verificación en dos pasos y acceso de al menos dos socios. Es el punto único de falla de todo el montaje.

---

## 8. Dependencias

- **Escaneo automático en cada integración.**
- **No se integra con vulnerabilidades de severidad alta o crítica abiertas.**
- **Versiones fijadas**, no rangos abiertos que puedan traer código distinto sin aviso.
- **Actualización periódica** programada, no reactiva.
- **Licencia verificada** de cada dependencia (ver documento legal).

---

## 9. Auditoría

Registrar toda acción sensible, con estos campos:

| Campo | Qué guarda |
|---|---|
| Actor | Quién lo hizo, y de qué tipo (persona, servicio) |
| Acción | Qué hizo |
| Recurso | Sobre qué |
| Cliente | A qué cliente pertenece, si aplica |
| Origen | Desde dónde |
| Resultado | Si tuvo éxito o falló |
| Correlación | Identificador para seguir el rastro |
| Momento | Cuándo |

**Es también requisito legal** para poder responder ante un incidente o una solicitud de un titular.

---

## 10. Incidentes

**Si hay sospecha de acceso indebido o filtración:**

1. **Contener** — revocar pases, rotar secretos, cerrar el acceso.
2. **Registrar** — hora, qué se detectó, qué datos pudieron verse afectados.
3. **No borrar evidencia.** Ni logs, ni registros, ni nada.
4. **Evaluar si hay datos personales involucrados.** Si los hay, se activa la obligación de notificar a la autoridad y a los afectados dentro del plazo legal.
5. **Notificar** según corresponda.
6. **Corregir** la causa, no solo el síntoma.

**Definido de antemano, no durante el incidente:** quién responde, en qué horario, y quién habla con el cliente.

---

## 11. Lista de verificación antes de salir a producción

- [ ] HTTPS con HSTS en todo el sitio
- [ ] Cabeceras de seguridad configuradas
- [ ] Cookies con `HttpOnly`, `Secure` y `SameSite`
- [ ] Validación de entrada en todos los endpoints
- [ ] Consultas parametrizadas, sin concatenación
- [ ] RLS activo si hay varios clientes
- [ ] Cifrado en reposo de datos personales
- [ ] Ningún secreto en el repositorio
- [ ] Verificación en dos pasos en todas las cuentas administrativas
- [ ] Escaneo de dependencias sin hallazgos altos o críticos
- [ ] Límite de tasa en endpoints públicos
- [ ] Registro de auditoría funcionando
- [ ] Respaldos automáticos con restauración probada
- [ ] Páginas de error sin detalle técnico
- [ ] Inventario de accesos al día
- [ ] Protocolo de incidentes con responsables definidos
