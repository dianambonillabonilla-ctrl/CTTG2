/**
 * CTTG Medicina — Auditoría de datos y seguimiento por fase
 * ------------------------------------------------------------------
 * Revisa las hojas Fase1, Fase2, Fase 3, Acta asesoria, Fecha reuniones,
 * Solicitudes_Mod_Radicacion y Usuarios, y escribe cada problema encontrado
 * en la hoja "Alertas de datos", indicando la fase en la que ocurre y la
 * acción recomendada para resolverlo:
 *   - Duplicados e inconsistencias (radicaciones repetidas, filas de prueba,
 *     registros sin número de radicado, filas corridas…).
 *   - Seguimiento de cada fase: trámites detenidos más tiempo del debido
 *     (tutores sin respuesta, actas sin revisar, protocolos sin avalar,
 *     comités realizados sin decisión, sustentaciones sin nota…) y datos
 *     que impiden avanzar (jurados sin cédula válida, Turnitin alto…).
 *
 * NO modifica ningún dato: solo lee y reporta.
 *
 * Cómo usarlo:
 *   1. En la hoja de cálculo: Extensiones → Apps Script → "+" → Script,
 *      llamarlo AuditoriaDatos y pegar este archivo completo.
 *   2. Ejecutar la función `auditarDatosCTTG` (la primera vez pide permisos).
 *   3. (Opcional) Para tener el menú "CTTG" en la hoja, agregar esta línea
 *      dentro de la función onOpen() que ya exista en el proyecto:
 *          agregarMenuAuditoriaCTTG();
 *      Si el proyecto NO tiene onOpen(), crearla así:
 *          function onOpen() { agregarMenuAuditoriaCTTG(); }
 *   4. (Opcional) Ejecutar `programarAuditoriaDiariaCTTG` una vez para que
 *      la revisión corra sola todos los días a las 6 a. m.
 *
 * Si este script está en un proyecto que NO está vinculado a la hoja
 * (por ejemplo, el mismo proyecto del web app), poner el ID de la hoja en
 * AUDITORIA_SPREADSHEET_ID (es la parte larga de la URL de la hoja).
 *
 * Las columnas "Gestión" y "Notas de gestión" de la hoja de alertas se
 * conservan entre ejecuciones: marque ahí "Resuelto", "En proceso" o
 * "Ignorar" y sus notas no se borrarán al volver a correr la revisión.
 */

var AUDITORIA_SPREADSHEET_ID = '';            // vacío = la hoja vinculada
var AUDITORIA_HOJA_SALIDA   = 'Alertas de datos';

// Estados que cierran una radicación (ya no cuenta como "activa").
var ESTADOS_CERRADOS_FASE1 = ['cancelado', 'devuelto', 'reprobado', 'sustentado', 'completado'];
// Estados de Fase1 anteriores al desbloqueo de Fase 2.
var ESTADOS_ANTES_FASE2 = ['radicado', 'revision', 'tutores avalados'];
// Estados de Fase1 conocidos por la plataforma (sin tildes, en minúscula).
var ESTADOS_FASE1_VALIDOS = [
  'radicado', 'revision', 'tutores avalados', 'fase 2 desbloqueada',
  'pendiente comite', 'pendiente comite tecnico', 'aprobado', 'devuelto',
  'sustentado', 'reprobado', 'cancelado', 'completado'
];
// Palabras que delatan correos de prueba.
var PATRONES_PRUEBA = [/prueba/i, /^test@/i, /^estudiante@/i, /^demo/i];

// Plazos del seguimiento por fase (ajustables).
var PLAZOS = {
  respuestaTutoresDiasHabiles: 15,   // Fase 1: aval de tutores desde la radicación
  revisionActaDiasHabiles: 5,        // Actas: revisión por coordinación
  avalProtocoloDiasHabiles: 5,       // Fase 2: protocolo "Cargado" sin avalar
  cargaProtocoloDias: 30,            // Fase 2 desbloqueada sin protocolo
  programarSustentacionDias: 30,     // Fase 3: jurados aprobados sin fecha
  turnitinMaximo: 20                 // Fase 3: % de similitud permitido
};

// ─────────────────────────────────────────────────────────────────────
// Punto de entrada en Apps Script
// ─────────────────────────────────────────────────────────────────────

function auditarDatosCTTG() {
  var ss = AUDITORIA_SPREADSHEET_ID
    ? SpreadsheetApp.openById(AUDITORIA_SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();

  var hojas = {};
  ['Fase1', 'Fase2', 'Fase 3', 'Acta asesoria', 'Fecha reuniones', 'Solicitudes_Mod_Radicacion', 'Usuarios'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    hojas[n] = sh ? sh.getDataRange().getValues() : null;
  });

  var alertas = auditarHojasCTTG_(hojas, new Date());
  escribirAlertas_(ss, alertas);

  var altas = alertas.filter(function (a) { return a.severidad === 'ALTA'; }).length;
  var msg = 'Revisión terminada: ' + alertas.length + ' alertas (' + altas + ' de prioridad ALTA). ' +
            'Ver hoja "' + AUDITORIA_HOJA_SALIDA + '".';
  try { ss.toast(msg, 'CTTG', 10); } catch (e) {}
  Logger.log(msg);
  return msg;
}

function agregarMenuAuditoriaCTTG() {
  SpreadsheetApp.getUi()
    .createMenu('CTTG')
    .addItem('Revisar fases, duplicados e inconsistencias', 'auditarDatosCTTG')
    .addToUi();
}

function programarAuditoriaDiariaCTTG() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'auditarDatosCTTG') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('auditarDatosCTTG').timeBased().everyDays(1).atHour(6).create();
}

// ─────────────────────────────────────────────────────────────────────
// Lógica de revisión (pura: recibe los valores de cada hoja y devuelve
// la lista de alertas; no toca la hoja de cálculo)
// ─────────────────────────────────────────────────────────────────────

function auditarHojasCTTG_(hojas, hoy) {
  hoy = soloFecha_(hoy || new Date());
  var alertas = [];
  function alerta(sev, tipo, hoja, fila, radicado, correo, detalle, accion, fase) {
    alertas.push({
      fase: fase || faseDe_(hoja, tipo),
      severidad: sev, tipo: tipo, hoja: hoja, fila: fila || '',
      radicado: radicado || '', correo: correo || '', detalle: detalle, accion: accion
    });
  }

  var f1 = leerTabla_(hojas['Fase1']);
  var f2 = leerTabla_(hojas['Fase2']);
  var actas = leerTabla_(hojas['Acta asesoria']);
  var mods = leerTabla_(hojas['Solicitudes_Mod_Radicacion']);
  var usuarios = leerTabla_(hojas['Usuarios']);

  // ── Fase1: índice de radicaciones ──────────────────────────────────
  var cRad   = col_(f1, ['numero radicacion']);
  var cQuien = col_(f1, ['email estudiante']);
  var cEst   = col_(f1, ['estado']);
  var cTit   = col_(f1, ['titulo']);
  var cCed   = [1, 2, 3].map(function (i) { return col_(f1, ['cedula ' + i]); });
  var cMail  = [1, 2, 3].map(function (i) { return col_(f1, ['email ' + i]); });
  var cNom   = [1, 2, 3].map(function (i) { return col_(f1, ['nombre ' + i]); });
  var cSem   = [1, 2, 3].map(function (i) { return col_(f1, ['semestre ' + i]); });
  var cFRad  = col_(f1, ['fecha radicacion']);
  var cMod   = col_(f1, ['modalidad']);
  var cT1Mail = col_(f1, ['tutor 1 - email']);

  var rads = [];            // una entrada por fila de Fase1
  var porNumero = {};       // numero -> [rad]
  f1.filas.forEach(function (r) {
    var numero = texto_(r.v[cRad]);
    if (!numero) return;
    var estadoCrudo = r.v[cEst] == null ? '' : String(r.v[cEst]);
    var rad = {
      fila: r.fila, numero: numero, estadoCrudo: estadoCrudo,
      estado: norm_(estadoCrudo), titulo: texto_(r.v[cTit]),
      quien: correo_(r.v[cQuien]),
      fechaRad: fecha_(r.v[cFRad]), modalidad: texto_(r.v[cMod]),
      tutor1Email: correo_(r.v[cT1Mail]), semestre: 0, celdasError: [],
      correos: [], cedulas: [], nombres: []
    };
    if (rad.quien) rad.correos.push(rad.quien);
    for (var i = 0; i < 3; i++) {
      var c = correo_(r.v[cMail[i]]); if (c && rad.correos.indexOf(c) < 0) rad.correos.push(c);
      var d = cedula_(r.v[cCed[i]]);  if (d && rad.cedulas.indexOf(d) < 0) rad.cedulas.push(d);
      var n = texto_(r.v[cNom[i]]);   if (n) rad.nombres.push(n);
      var s = parseInt(r.v[cSem[i]], 10); if (s > rad.semestre) rad.semestre = s;
    }
    r.v.forEach(function (v, j) { if (/^#(ERROR|REF|VALUE|N\/A|NAME)/.test(String(v))) rad.celdasError.push(f1.encabezadoOriginal[j]); });
    rad.activa = ESTADOS_CERRADOS_FASE1.indexOf(rad.estado) < 0;
    rads.push(rad);
    (porNumero[numero] = porNumero[numero] || []).push(rad);
  });

  function radicacionesDeCorreo(correo, soloActivas) {
    return rads.filter(function (x) {
      return x.correos.indexOf(correo) >= 0 && (!soloActivas || x.activa);
    });
  }

  // 1. Número de radicado repetido en Fase1
  Object.keys(porNumero).forEach(function (num) {
    var lista = porNumero[num];
    if (lista.length > 1) {
      alerta('ALTA', 'Número de radicado repetido en Fase1', 'Fase1',
        filas_(lista), num, '',
        'El número ' + num + ' aparece en ' + lista.length + ' filas de Fase1.',
        'Dejar una sola fila con este número. Si son proyectos distintos, asignar un número nuevo al que corresponda y avisar a los estudiantes.');
    }
  });

  // 2. Mismo grupo con más de una radicación activa (radicación duplicada)
  var yaReportado = {};
  for (var a = 0; a < rads.length; a++) {
    for (var b = a + 1; b < rads.length; b++) {
      var x = rads[a], y = rads[b];
      if (!x.activa || !y.activa || x.numero === y.numero) continue;
      var comunesCed = interseccion_(x.cedulas, y.cedulas).length;
      var comunesMail = interseccion_(x.correos, y.correos).length;
      if (Math.max(comunesCed, comunesMail) >= 2) {
        var clave = x.numero + '|' + y.numero;
        if (yaReportado[clave]) continue;
        yaReportado[clave] = true;
        alerta('ALTA', 'Radicación duplicada (mismo grupo)', 'Fase1',
          x.fila + ', ' + y.fila, x.numero + ' y ' + y.numero, '',
          'Los mismos estudiantes tienen dos radicaciones activas: ' +
            x.numero + ' ("' + corto_(x.titulo) + '", ' + x.estadoCrudo.trim() + ') y ' +
            y.numero + ' ("' + corto_(y.titulo) + '", ' + y.estadoCrudo.trim() + ').',
          'Confirmar con el grupo cuál sigue vigente. En la otra, poner Estado = "Cancelado" y en Notas el motivo (no borrar la fila). Resolver o devolver las solicitudes de modificación pendientes de la cancelada.');
      }
    }
  }

  // 3. Estudiante en más de una radicación activa (grupos distintos)
  var visto = {};
  rads.forEach(function (r) {
    if (!r.activa) return;
    r.correos.forEach(function (c) {
      if (visto[c]) return;
      var lista = radicacionesDeCorreo(c, true);
      var numeros = unicos_(lista.map(function (z) { return z.numero; }));
      if (numeros.length > 1) {
        visto[c] = true;
        // Si ya se reportó como "mismo grupo", no repetir
        var yaGrupo = false;
        for (var i = 0; i < numeros.length; i++) for (var j = i + 1; j < numeros.length; j++)
          if (yaReportado[numeros[i] + '|' + numeros[j]] || yaReportado[numeros[j] + '|' + numeros[i]]) yaGrupo = true;
        if (yaGrupo) return;
        alerta('MEDIA', 'Estudiante en varias radicaciones activas', 'Fase1',
          filas_(lista), numeros.join(', '), c,
          'El correo ' + c + ' figura en ' + numeros.length + ' radicaciones activas: ' + numeros.join(', ') + '.',
          'Verificar si el estudiante cambió de grupo. Cancelar la radicación que ya no aplica o retirarlo de ella.');
      }
    });
  });

  // 4. Estados no reconocidos o con espacios de más
  rads.forEach(function (r) {
    if (r.estadoCrudo && r.estadoCrudo !== r.estadoCrudo.trim()) {
      alerta('BAJA', 'Estado con espacios de más', 'Fase1', r.fila, r.numero, '',
        'El estado es "' + r.estadoCrudo + '" (tiene espacios al inicio o al final). La plataforma puede no reconocerlo al filtrar.',
        'Reescribir el estado sin espacios: "' + r.estadoCrudo.trim() + '".');
    }
    if (r.estado && ESTADOS_FASE1_VALIDOS.indexOf(r.estado) < 0) {
      alerta('MEDIA', 'Estado no reconocido', 'Fase1', r.fila, r.numero, '',
        'El estado "' + r.estadoCrudo.trim() + '" no es uno de los estados de la plataforma.',
        'Corregirlo a uno de: Radicado, Revisión, Tutores Avalados, Fase 2 Desbloqueada, Pendiente Comité Técnico, Aprobado, Devuelto, Sustentado, Cancelado.');
    }
  });

  // 5. Correos de prueba mezclados con datos reales (Fase1)
  rads.forEach(function (r) {
    var dePrueba = r.correos.filter(esPrueba_);
    if (dePrueba.length && r.activa) {
      alerta('MEDIA', 'Registro de prueba en Fase1', 'Fase1', r.fila, r.numero, dePrueba.join(', '),
        'La radicación ' + r.numero + ' (' + (r.estadoCrudo.trim() || 'sin estado') + ') usa correos de prueba: ' + dePrueba.join(', ') + '.',
        'Si es una prueba: poner Estado = "Cancelado" y en Notas "Registro de prueba". Si el número lo usa un estudiante real, cambiar el número de la fila de prueba (p. ej. PRUEBA-xxxx).');
    }
  });

  // ── Fase2 (protocolos) ─────────────────────────────────────────────
  var c2Rad = col_(f2, ['numero radicacion']);
  var c2Mail = col_(f2, ['email estudiante']);
  var c2Est = col_(f2, ['estado']);
  var c2Fecha = col_(f2, ['fecha radicacion', 'fecha de solicitud']);
  var c2Eval = col_(f2, ['evaluadores', 'evaluador']);
  var c2FCom = col_(f2, ['fecha comite']);
  var c2Acta = col_(f2, ['numero de acta']);
  var protos = f2.filas.map(function (r) {
    return {
      fila: r.fila, numero: texto_(r.v[c2Rad]), correo: correo_(r.v[c2Mail]),
      estadoCrudo: texto_(r.v[c2Est]), estado: norm_(r.v[c2Est]), fecha: fecha_(r.v[c2Fecha]),
      evaluador: texto_(r.v[c2Eval]), fechaComite: fecha_(r.v[c2FCom]), acta: texto_(r.v[c2Acta])
    };
  }).filter(function (p) { return p.numero || p.correo; });

  var protosPorRad = {};
  protos.forEach(function (p) {
    (protosPorRad[p.numero] = protosPorRad[p.numero] || []).push(p);
    var enF1 = porNumero[p.numero];

    // 6. Radicado inexistente en Fase1
    if (!enF1) {
      alerta('MEDIA', 'Protocolo con radicado inexistente', 'Fase2', p.fila, p.numero, p.correo,
        'El protocolo de la fila ' + p.fila + ' apunta a ' + (p.numero || '(vacío)') + ', que no existe en Fase1.',
        'Buscar la radicación correcta del estudiante y corregir el número en la columna B.');
      return;
    }

    // 7. Quien envió no pertenece a esa radicación (p. ej. filas de prueba)
    var pertenece = enF1.some(function (r) { return r.correos.indexOf(p.correo) >= 0; });
    if (p.correo && !pertenece) {
      var suyas = radicacionesDeCorreo(p.correo, false).map(function (z) { return z.numero; });
      var prueba = esPrueba_(p.correo);
      alerta(prueba || esAprobado_(p.estado) ? 'ALTA' : 'MEDIA',
        prueba ? 'Protocolo de prueba sobre un radicado real' : 'Protocolo de alguien ajeno al radicado',
        'Fase2', p.fila, p.numero, p.correo,
        'La fila ' + p.fila + ' (' + (p.estadoCrudo || 'sin estado') + ') la envió ' + p.correo +
          ', que no es estudiante de ' + p.numero + ' (' + enF1[0].correos.join(', ') + ').' +
          (suyas.length ? ' Sus radicaciones: ' + suyas.join(', ') + '.' : '') +
          (esAprobado_(p.estado) ? ' Como está "Aprobado", puede hacer que la plataforma crea que ese radicado ya fue avalado y lo oculte de la lista de pendientes.' : ''),
        prueba
          ? 'Cambiar el número de radicado de esta fila por "PRUEBA-' + p.numero.replace(/^CTTG-/, '') + '" (no borrar la fila para no correr los números de fila).'
          : (suyas.length === 1
              ? 'Corregir el número de radicado de esta fila a ' + suyas[0] + '.'
              : 'Verificar con el estudiante a qué radicación corresponde y corregir el número.'));
    }
  });

  Object.keys(protosPorRad).forEach(function (num) {
    var lista = protosPorRad[num];
    var enF1 = porNumero[num];
    if (!enF1) return;
    var propios = lista.filter(function (p) {
      return enF1.some(function (r) { return r.correos.indexOf(p.correo) >= 0; });
    });

    // 8. Envíos repetidos sin tramitar (varias filas "Cargado")
    var cargados = propios.filter(function (p) { return p.estado === 'cargado'; });
    if (cargados.length > 1) {
      alerta('MEDIA', 'Protocolo enviado varias veces', 'Fase2',
        filas_(cargados), num, cargados[0].correo,
        'Hay ' + cargados.length + ' envíos "Cargado" del mismo protocolo sin tramitar.',
        'Tramitar solo el más reciente (fila ' + cargados[cargados.length - 1].fila + '). En los demás poner Estado = "Devuelto" y en Observaciones "Envío repetido, se tramita la fila ' + cargados[cargados.length - 1].fila + '" para que no queden como pendientes.');
    }

    // 9. Fase2 y Fase1 no coinciden
    var ultimo = protocoloVigente_(propios);
    var r1 = enF1[0];
    if (ultimo && esAprobado_(ultimo.estado) &&['aprobado', 'sustentado', 'completado', 'reprobado'].indexOf(r1.estado) < 0 && r1.activa) {
      alerta('MEDIA', 'Protocolo aprobado pero Fase1 no actualizada', 'Fase1', r1.fila, num, ultimo.correo,
        'En Fase2 (fila ' + ultimo.fila + ') el protocolo está "Aprobado", pero en Fase1 la radicación sigue en "' + r1.estadoCrudo.trim() + '".',
        'Actualizar el estado de Fase1 a "Aprobado" para que el estudiante pueda avanzar a Fase 3.');
    }
  });

  // ── Actas de asesoría y solicitudes de Fase 2 ──────────────────────
  var caRad = col_(actas, ['numero radicacion']);
  var caMail = col_(actas, ['email estudiante']);
  var caArch = col_(actas, ['nombre archivo']);
  var caEst = col_(actas, ['estado']);
  var caFecha = col_(actas, ['fecha carga']);
  var solicitudesAprobadasSinEfecto = {};
  var listaActas = [];
  actas.filas.forEach(function (r) {
    var numero = texto_(r.v[caRad]);
    var correo = correo_(r.v[caMail]);
    var archivo = texto_(r.v[caArch]);
    var estado = norm_(r.v[caEst]);
    if (!correo && !numero) return;
    listaActas.push({ fila: r.fila, numero: numero, correo: correo, archivo: archivo, estado: estado, fecha: fecha_(r.v[caFecha]) });
    var esSolicitudF2 = /fase 2/i.test(archivo) || estado === 'solicitud fase 2';
    var sinNumero = !numero || numero === '—' || numero === '-' || numero === '–';
    var suyas = correo ? radicacionesDeCorreo(correo, true) : [];

    // 10. Acta / solicitud sin número de radicado
    if (sinNumero) {
      var sugerida = suyas.length === 1 ? suyas[0].numero : '';
      // Solo es urgente si la radicación del estudiante aún no pasó a Fase 2 o si hay
      // ambigüedad; si ya avanzó, falta el número pero no bloquea a nadie.
      var bloquea = suyas.length !== 1 || ESTADOS_ANTES_FASE2.indexOf(suyas[0].estado) >= 0 || estado === 'pendiente revision' || estado === 'solicitud fase 2';
      alerta(esSolicitudF2 && bloquea ? 'ALTA' : (bloquea ? 'MEDIA' : 'BAJA'),
        esSolicitudF2 ? 'Solicitud de Fase 2 sin número de radicado' : 'Acta sin número de radicado',
        'Acta asesoria', r.fila, sugerida, correo,
        'El registro "' + archivo + '" (' + texto_(r.v[caEst]) + ') no tiene número de radicado.' +
          (suyas.length > 1 ? ' El estudiante tiene ' + suyas.length + ' radicaciones activas (' + suyas.map(function (z) { return z.numero; }).join(', ') + '), por eso el sistema no sabe a cuál aplicarlo.' : '') +
          (suyas.length === 0 ? ' El correo no aparece en ninguna radicación activa.' : ''),
        sugerida
          ? 'Escribir ' + sugerida + ' en la columna "Número Radicación" de esta fila.' + (esSolicitudF2 ? ' Si ya estaba aprobada, verificar que Fase1 quedó en "Fase 2 Desbloqueada".' : '')
          : 'Resolver primero la radicación duplicada del estudiante y luego escribir el número correcto en esta fila.');
    } else if (correo && porNumero[numero] && !porNumero[numero].some(function (z) { return z.correos.indexOf(correo) >= 0; })) {
      // 11. Acta con número de otro grupo
      alerta(esPrueba_(correo) ? 'MEDIA' : 'ALTA', 'Acta asociada a un radicado ajeno', 'Acta asesoria', r.fila, numero, correo,
        'El acta de ' + correo + ' está registrada con ' + numero + ', pero ese correo no es estudiante de esa radicación.',
        esPrueba_(correo)
          ? 'Es un registro de prueba: cambiar el número por "PRUEBA-' + numero.replace(/^CTTG-/, '') + '".'
          : 'Corregir el número de radicado de esta fila' + (suyas.length === 1 ? ' a ' + suyas[0].numero : '') + '.');
    } else if (numero && !porNumero[numero]) {
      alerta('MEDIA', 'Acta con radicado inexistente', 'Acta asesoria', r.fila, numero, correo,
        'El número ' + numero + ' no existe en Fase1.',
        'Corregir el número de radicado de esta fila.');
    }

    // 12. Solicitud de Fase 2 aprobada pero Fase1 sigue antes de Fase 2
    if (esSolicitudF2 && estado === 'aprobada') {
      var objetivo = !sinNumero && porNumero[numero] ? porNumero[numero] : suyas;
      objetivo.forEach(function (rad) {
        if (ESTADOS_ANTES_FASE2.indexOf(rad.estado) >= 0 && rad.activa && !solicitudesAprobadasSinEfecto[rad.numero]) {
          solicitudesAprobadasSinEfecto[rad.numero] = true;
          alerta('ALTA', 'Fase 2 aprobada pero no desbloqueada', 'Fase1', rad.fila, rad.numero, correo,
            'La solicitud de Fase 2 (Acta asesoria, fila ' + r.fila + ') está "Aprobada", pero la radicación sigue en "' + rad.estadoCrudo.trim() + '". El estudiante no puede subir el protocolo.',
            'Poner Estado = "Fase 2 Desbloqueada" en Fase1 fila ' + rad.fila + ' (y corregir el número de radicado en la solicitud si está vacío).');
        }
      });
    }
  });

  // ── Solicitudes de modificación de radicación ──────────────────────
  var cmMail = col_(mods, ['emailestudiante']);
  var cmFila = col_(mods, ['rowfase1']);
  var cmRad = col_(mods, ['numerorad']);
  var cmEst = col_(mods, ['estadosolicitud']);
  mods.filas.forEach(function (r) {
    var estado = norm_(r.v[cmEst]);
    if (estado !== 'pendiente') return;
    var numero = texto_(r.v[cmRad]);
    var filaDicha = parseInt(r.v[cmFila], 10);
    var real = porNumero[numero] || [];
    var correo = correo_(r.v[cmMail]);

    // 13. La fila guardada ya no corresponde al radicado (se corrieron las filas)
    if (real.length && !real.some(function (z) { return z.fila === filaDicha; })) {
      var enEsaFila = rads.filter(function (z) { return z.fila === filaDicha; })[0];
      alerta('ALTA', 'Solicitud de modificación apunta a otra fila', 'Solicitudes_Mod_Radicacion', r.fila, numero, correo,
        'La solicitud dice RowFase1 = ' + filaDicha + ', pero ' + numero + ' está en la fila ' + real[0].fila + ' de Fase1.' +
          (enEsaFila ? ' Hoy la fila ' + filaDicha + ' es ' + enEsaFila.numero + ': aprobarla modificaría la radicación de OTRO grupo.' : ''),
        'NO aprobarla desde la plataforma. Cambiar RowFase1 a ' + real[0].fila + ' y luego aprobarla, o aplicar el cambio a mano en Fase1.');
    }
    // 14. Solicitud pendiente sobre una radicación cerrada
    if (real.length && real.every(function (z) { return !z.activa; })) {
      alerta('BAJA', 'Solicitud pendiente sobre radicación cerrada', 'Solicitudes_Mod_Radicacion', r.fila, numero, correo,
        'La radicación ' + numero + ' está en "' + real[0].estadoCrudo.trim() + '" y aún tiene una solicitud de modificación pendiente.',
        'Marcarla como resuelta (Resultado = "devolver") con la observación correspondiente.');
    }
  });

  // ═════════════════════════════════════════════════════════════════
  // SEGUIMIENTO POR FASE: trámites detenidos y datos que impiden avanzar
  // ═════════════════════════════════════════════════════════════════
  function correoDelGrupo(rad, correo) { return rad.correos.indexOf(correo) >= 0; }
  function protosPropios(rad) {
    return (protosPorRad[rad.numero] || []).filter(function (p) { return correoDelGrupo(rad, p.correo); });
  }
  function actasDe(rad) {
    return listaActas.filter(function (a) {
      return correoDelGrupo(rad, a.correo) && (a.numero === rad.numero || !a.numero || /^[—–-]$/.test(a.numero));
    });
  }
  var hoyTxt = fmt_(hoy);

  rads.forEach(function (rad) {
    if (!rad.activa || rad.correos.some(esPrueba_)) return;

    // ── FASE 1: radicación y aval de tutores ─────────────────────────
    if (['radicado', 'revision'].indexOf(rad.estado) >= 0 && rad.fechaRad) {
      var limiteTut = sumarDiasHabiles_(rad.fechaRad, PLAZOS.respuestaTutoresDiasHabiles);
      if (limiteTut < hoy) {
        alerta('ALTA', 'Tutores sin avalar fuera de plazo', 'Fase1', rad.fila, rad.numero, rad.quien,
          'Radicado el ' + fmt_(rad.fechaRad) + ' y sigue en "' + rad.estadoCrudo.trim() + '". El plazo de ' + PLAZOS.respuestaTutoresDiasHabiles +
            ' días hábiles para avalar tutores venció el ' + fmt_(limiteTut) + ' (' + diasEntre_(limiteTut, hoy) + ' días de retraso).',
          'Validar los tutores en "✅ Tutores" o devolver la radicación con el motivo.', '1. Radicación y tutores');
      }
    }
    if (rad.estado !== 'radicado' && rad.estado !== 'revision' && rad.tutor1Email && !/@usc\.edu\.co$/.test(rad.tutor1Email)) {
      alerta('BAJA', 'Tutor principal con correo no institucional', 'Fase1', rad.fila, rad.numero, rad.tutor1Email,
        'El tutor 1 (' + rad.tutor1Email + ') no tiene correo @usc.edu.co. El reglamento exige que el tutor principal tenga vínculo con la USC.',
        'Confirmar el vínculo laboral del tutor con la USC; si no lo tiene, pedir al grupo un tutor principal vinculado.', '1. Radicación y tutores');
    }
    if (!rad.titulo || /^(ninguno|n\/a|na|sin titulo|-)$/i.test(norm_(rad.titulo))) {
      alerta('BAJA', 'Radicación sin título', 'Fase1', rad.fila, rad.numero, rad.quien,
        'La radicación tiene como título "' + (rad.titulo || '(vacío)') + '".',
        'Pedir al grupo el título del proyecto (solicitud de modificación) antes del comité.', '1. Radicación y tutores');
    }
    if (rad.celdasError.length) {
      alerta('MEDIA', 'Celdas con error en la radicación', 'Fase1', rad.fila, rad.numero, rad.quien,
        'Las columnas ' + rad.celdasError.join(', ') + ' muestran "#ERROR!". Suele pasar cuando un dato empieza por "+", "=" o "-" y la hoja lo toma como fórmula (p. ej. un teléfono "+57…").',
        'Reescribir el dato en esas celdas anteponiendo un apóstrofo (\'), y corregir el formulario para guardar esos campos como texto.', '1. Radicación y tutores');
    }

    // ── ACTAS DE ASESORÍA ────────────────────────────────────────────
    var misActas = actasDe(rad);
    if (rad.estado === 'tutores avalados' && rad.fechaRad) {
      var meses = rad.semestre >= 12 ? 3 : (rad.semestre >= 11 ? 6 : 12);
      var limiteActas = sumarMeses_(rad.fechaRad, meses);
      var aprobadas = misActas.filter(function (a) { return a.estado === 'aprobada' && !/fase 2/i.test(a.archivo); }).length;
      if (limiteActas < hoy && !aprobadas) {
        alerta('MEDIA', 'Plazo de actas vencido sin actas aprobadas', 'Fase1', rad.fila, rad.numero, rad.quien,
          'Semestre ' + (rad.semestre || '?') + ': el plazo de ' + meses + ' meses para cargar actas venció el ' + fmt_(limiteActas) + ' y no hay actas aprobadas.',
          'Contactar al grupo y al tutor para saber si continúan; si no, cancelar la radicación.', 'Actas de asesoría');
      }
    }

    // ── FASE 2: protocolo y comité técnico ───────────────────────────
    var propios = protosPropios(rad);
    var ultimo = protocoloVigente_(propios);
    // Envíos "Cargado" que quedaron sobrando después de avalar/aprobar otro envío
    var sobrantes = ultimo ? propios.filter(function (p) { return p.fila > ultimo.fila && p.estado === 'cargado'; }) : [];
    if (ultimo && ultimo.estado !== 'cargado' && sobrantes.length) {
      alerta('BAJA', 'Envío de protocolo sobrante sin tramitar', 'Fase2', filas_(sobrantes), rad.numero, sobrantes[0].correo,
        'El protocolo ya está "' + ultimo.estadoCrudo + '" (fila ' + ultimo.fila + '), pero después quedaron ' + sobrantes.length + ' envío(s) "Cargado" que siguen apareciendo como pendientes.',
        'Si es el mismo documento, poner en esas filas Estado = "Devuelto" y Observación "Envío repetido". Si es una versión corregida, tramitarla.', '2. Protocolo y comité');
    }
    if (rad.estado === 'fase 2 desbloqueada' && !propios.length) {
      var desde = ultimaFecha_(misActas.filter(function (a) { return /fase 2/i.test(a.archivo); }).map(function (a) { return a.fecha; }));
      if (desde && diasEntre_(desde, hoy) > PLAZOS.cargaProtocoloDias) {
        alerta('BAJA', 'Fase 2 desbloqueada sin protocolo', 'Fase1', rad.fila, rad.numero, rad.quien,
          'La Fase 2 se desbloqueó hace ' + diasEntre_(desde, hoy) + ' días y el grupo no ha enviado el protocolo.',
          'Recordar al grupo que debe cargar el protocolo por el formulario.', '2. Protocolo y comité');
      }
    }
    if (ultimo && ultimo.estado === 'cargado') {
      var espera = ultimo.fecha ? diasHabilesEntre_(ultimo.fecha, hoy) : 0;
      if (espera > PLAZOS.avalProtocoloDiasHabiles) {
        alerta('ALTA', 'Protocolo cargado sin avalar', 'Fase2', ultimo.fila, rad.numero, ultimo.correo,
          'El protocolo se cargó el ' + fmt_(ultimo.fecha) + ' (' + espera + ' días hábiles) y no se ha avalado ni devuelto. En Fase1 la radicación está en "' + rad.estadoCrudo.trim() + '".',
          'Avalar el protocolo (asignar evaluador y fecha de comité) o devolverlo. Si no aparece en la plataforma, revisar las alertas de filas de prueba o repetidas de este radicado.', '2. Protocolo y comité');
      }
    }
    if (rad.estado === 'pendiente comite tecnico' && !propios.length) {
      alerta('ALTA', 'Pendiente de comité sin protocolo', 'Fase1', rad.fila, rad.numero, rad.quien,
        'La radicación está en "Pendiente Comité Técnico" pero no hay ningún protocolo del grupo en Fase2.',
        'Verificar si el protocolo llegó con otro número de radicado o desde otro correo, y corregir la fila en Fase2.', '2. Protocolo y comité');
    }
    if (ultimo && ultimo.estado === 'pendiente comite') {
      if (!ultimo.evaluador || !ultimo.fechaComite) {
        alerta('MEDIA', 'Protocolo en comité sin evaluador o fecha', 'Fase2', ultimo.fila, rad.numero, ultimo.correo,
          'El protocolo está "Pendiente Comité" pero le falta ' + [!ultimo.evaluador ? 'evaluador' : '', !ultimo.fechaComite ? 'fecha de comité' : ''].filter(String).join(' y ') + '.',
          'Completar el evaluador y la fecha de comité para que se notifique al evaluador y al estudiante.', '2. Protocolo y comité');
      } else if (ultimo.fechaComite < hoy) {
        alerta('ALTA', 'Comité realizado sin decisión registrada', 'Fase2', ultimo.fila, rad.numero, ultimo.correo,
          'El comité del ' + fmt_(ultimo.fechaComite) + ' ya pasó (' + diasEntre_(ultimo.fechaComite, hoy) + ' días) y el protocolo sigue "Pendiente Comité" (evaluador: ' + ultimo.evaluador + ').',
          'Registrar la decisión del comité (Aprobado / Devuelto) con el número de acta, o reprogramar la fecha de comité.', '2. Protocolo y comité');
      }
    }
    if (ultimo && esAprobado_(ultimo.estado) && !ultimo.acta && ultimo.estado !== 'aprobado directo') {
      alerta('MEDIA', 'Protocolo aprobado sin número de acta', 'Fase2', ultimo.fila, rad.numero, ultimo.correo,
        'El protocolo está "Aprobado" pero no tiene número de acta de comité.',
        'Registrar el número de acta del comité en la fila del protocolo.', '2. Protocolo y comité');
    }
  });

  // ── FASE 3: sustentación ───────────────────────────────────────────
  var f3 = leerTabla_(hojas['Fase 3']);
  if (f3.filas.length) {
    var c3Rad = col_(f3, ['numero radicacion']);
    var c3Mail = col_(f3, ['email estudiante']);
    var c3FSus = col_(f3, ['fecha sustentacion']);
    var c3FAsig = col_(f3, ['fecha asignada sustentacion']);
    var c3Turn = col_(f3, ['% turnitin']);
    var c3Nota = col_(f3, ['nota']);
    var c3Est = col_(f3, ['estado solicitud']);
    var c3Carga = col_(f3, ['fecha carga']);
    var c3J1Ced = col_(f3, ['jurado 1 cedula']);
    var c3J2Ced = col_(f3, ['jurado 2 cedula']);
    var c3J1Nom = col_(f3, ['jurado 1 nombre']);
    var c3J2Nom = col_(f3, ['jurado 2 nombre']);

    // Encabezados repetidos: el código que busca columnas por nombre lee/escribe en la primera
    var repetidos = f3.encabezado.filter(function (h, i) { return h && f3.encabezado.indexOf(h) !== i; });
    if (repetidos.length) {
      alerta('MEDIA', 'Columnas repetidas en la hoja Fase 3', 'Fase 3', 1, '', '',
        'Estas columnas aparecen dos veces: ' + unicos_(repetidos).join(', ') + '. Si el Apps Script busca columnas por nombre, escribe en una y lee de la otra.',
        'Revisar cuál de las dos tiene datos, mover los datos a una sola y borrar la columna sobrante (después de revisar el Apps Script).', '3. Sustentación');
    }

    var ultimaPorRad = {};
    f3.filas.forEach(function (r) {
      var num = texto_(r.v[c3Rad]);
      if (!num) return;
      // Se toma la última solicitud, salvo que una anterior ya tenga nota (trabajo cerrado).
      if (ultimaPorRad[num] && ultimaPorRad[num].nota && !texto_(r.v[c3Nota])) return;
      ultimaPorRad[num] = {
        fila: r.fila, numero: num, correo: correo_(r.v[c3Mail]),
        fechaSus: fecha_(r.v[c3FSus]) || fecha_(r.v[c3FAsig]),
        turnitin: parseFloat(r.v[c3Turn]), nota: texto_(r.v[c3Nota]),
        estadoCrudo: texto_(r.v[c3Est]), estado: norm_(r.v[c3Est]), carga: fecha_(r.v[c3Carga]),
        jurados: [[texto_(r.v[c3J1Nom]), texto_(r.v[c3J1Ced])], [texto_(r.v[c3J2Nom]), texto_(r.v[c3J2Ced])]]
      };
    });

    Object.keys(ultimaPorRad).forEach(function (num) {
      var s = ultimaPorRad[num];
      var rad = (porNumero[num] || [])[0];
      if (!rad) {
        alerta('BAJA', 'Solicitud de sustentación con radicado inexistente', 'Fase 3', s.fila, num, s.correo,
          'La solicitud apunta a ' + num + ', que no existe en Fase1.', 'Si es una prueba, borrarla o marcarla; si no, corregir el número.', '3. Sustentación');
        return;
      }
      if (rad.correos.some(esPrueba_) || !rad.activa && rad.estado !== 'sustentado') return;
      var devuelta = /devuelta/.test(s.estado);

      // Protocolo aprobado antes de pedir sustentación (diplomados no pasan por protocolo)
      var aprobado = protosPropios(rad).some(function (p) { return esAprobado_(p.estado); });
      if (!aprobado && !devuelta && !/diplomado/i.test(rad.modalidad)) {
        alerta('ALTA', 'Sustentación sin protocolo aprobado', 'Fase 3', s.fila, num, s.correo,
          'Hay una solicitud de sustentación ("' + (s.estadoCrudo || 'sin estado') + '") pero no hay protocolo "Aprobado" del grupo en Fase2.',
          'Verificar la aprobación del protocolo antes de programar la sustentación.', '3. Sustentación');
      }
      if (!devuelta && s.turnitin >= PLAZOS.turnitinMaximo) {
        alerta('MEDIA', 'Turnitin por encima del máximo', 'Fase 3', s.fila, num, s.correo,
          'La similitud Turnitin es ' + s.turnitin + '% (máximo ' + PLAZOS.turnitinMaximo + '%) y la solicitud no está devuelta.',
          'Devolver la solicitud para que el grupo reduzca la similitud.', '3. Sustentación');
      }
      if (!devuelta && !s.nota) {
        var malos = s.jurados.filter(function (j) { return j[0] && !cedulaValida_(j[1]); });
        if (malos.length) {
          alerta('MEDIA', 'Jurado sin cédula válida', 'Fase 3', s.fila, num, s.correo,
            malos.map(function (j) { return j[0] + ': "' + (j[1] || 'vacío') + '"'; }).join('; ') +
              '. Son valores de relleno (30000000) o números de celular en la columna de cédula.',
            'Pedir la cédula real de los jurados; revisar el formulario de Fase 3, que parece guardar el teléfono en la columna de cédula.', '3. Sustentación');
        }
      }
      if (s.fechaSus && s.fechaSus < hoy && !s.nota && !devuelta) {
        alerta('ALTA', 'Sustentación realizada sin nota registrada', 'Fase 3', s.fila, num, s.correo,
          'La sustentación era el ' + fmt_(s.fechaSus) + ' (hace ' + diasEntre_(s.fechaSus, hoy) + ' días) y no tiene nota. Fase1 está en "' + rad.estadoCrudo.trim() + '".',
          'Registrar el resultado (nota, acta, producto) en "🎓 Registrar" para cerrar el trabajo.', '3. Sustentación');
      }
      if (!s.fechaSus && /jurados aprobados/.test(s.estado) && s.carga && diasEntre_(s.carga, hoy) > PLAZOS.programarSustentacionDias) {
        alerta('MEDIA', 'Jurados aprobados sin fecha de sustentación', 'Fase 3', s.fila, num, s.correo,
          'Los jurados están aprobados desde hace más de ' + PLAZOS.programarSustentacionDias + ' días (solicitud del ' + fmt_(s.carga) + ') y no hay fecha de sustentación.',
          'Contactar al grupo para que informe la fecha acordada con los jurados, y programarla.', '3. Sustentación');
      }
      if (s.nota && rad.estado !== 'sustentado' && rad.estado !== 'reprobado') {
        alerta('MEDIA', 'Nota registrada pero radicación no cerrada', 'Fase1', rad.fila, num, s.correo,
          'La sustentación tiene nota ' + s.nota + ' (Fase 3, fila ' + s.fila + '), pero Fase1 sigue en "' + rad.estadoCrudo.trim() + '".',
          'Cambiar el estado de Fase1 a "Sustentado" (o "Reprobado").', '3. Sustentación');
      }
    });
  }

  // ── Comités programados ────────────────────────────────────────────
  var reuniones = leerTabla_(hojas['Fecha reuniones']);
  if (reuniones.filas.length) {
    var cr1 = col_(reuniones, ['fecha reunion 1']), cr2 = col_(reuniones, ['fecha reunion 2']);
    var fechasComite = [];
    reuniones.filas.forEach(function (r) {
      [fecha_(r.v[cr1]), fecha_(r.v[cr2])].forEach(function (f) { if (f) fechasComite.push(f.getTime()); });
    });
    if (!fechasComite.some(function (t) { return t >= hoy.getTime(); })) {
      alerta('MEDIA', 'No hay próximos comités programados', 'Fecha reuniones', '', '', '',
        'Todas las fechas de comité de la hoja "Fecha reuniones" ya pasaron (hoy ' + hoyTxt + ').',
        'Agregar las próximas fechas de comité para poder avalar protocolos.', '2. Protocolo y comité');
    }
  }

  // ── Usuarios ───────────────────────────────────────────────────────
  var cuMail = col_(usuarios, ['email']);
  var porCorreo = {};
  usuarios.filas.forEach(function (r) {
    var c = correo_(r.v[cuMail]);
    if (c) (porCorreo[c] = porCorreo[c] || []).push(r.fila);
  });
  Object.keys(porCorreo).forEach(function (c) {
    if (porCorreo[c].length > 1) {
      alerta('MEDIA', 'Usuario repetido', 'Usuarios', porCorreo[c].join(', '), '', c,
        'El correo ' + c + ' está registrado ' + porCorreo[c].length + ' veces (sin distinguir mayúsculas).',
        'Dejar un solo usuario activo y poner "inactivo" en los demás.');
    }
  });

  var orden = { ALTA: 0, MEDIA: 1, BAJA: 2 };
  alertas.sort(function (p, q) {
    return (orden[p.severidad] - orden[q.severidad]) || (p.fase < q.fase ? -1 : p.fase > q.fase ? 1 : 0);
  });
  return alertas;
}

// ─────────────────────────────────────────────────────────────────────
// Escritura de la hoja de alertas (conserva la gestión manual)
// ─────────────────────────────────────────────────────────────────────

function escribirAlertas_(ss, alertas) {
  var sh = ss.getSheetByName(AUDITORIA_HOJA_SALIDA) || ss.insertSheet(AUDITORIA_HOJA_SALIDA);
  var encabezado = ['Clave', 'Prioridad', 'Fase', 'Tipo', 'Hoja', 'Fila(s)', 'Radicado', 'Correo',
                    'Qué pasa', 'Qué hacer', 'Gestión', 'Notas de gestión', 'Detectado el'];
  var iGestion = encabezado.indexOf('Gestión');

  // Conservar lo que la coordinadora haya escrito en Gestión / Notas / fecha.
  // Se lee por nombre de columna para no perderlo si cambia el orden de columnas.
  var previo = {};
  if (sh.getLastRow() > 1) {
    var todo = sh.getRange(1, 1, sh.getLastRow(), Math.max(sh.getLastColumn ? sh.getLastColumn() : encabezado.length, 1)).getValues();
    var h = todo[0].map(String);
    var iC = h.indexOf('Clave'), iG = h.indexOf('Gestión'), iN = h.indexOf('Notas de gestión'), iD = h.indexOf('Detectado el');
    if (iC >= 0) todo.slice(1).forEach(function (v) {
      if (v[iC]) previo[v[iC]] = { gestion: iG >= 0 ? v[iG] : '', notas: iN >= 0 ? v[iN] : '', desde: iD >= 0 ? v[iD] : '' };
    });
  }

  var hoy = new Date();
  var filas = alertas.map(function (a) {
    var clave = claveAlerta_(a);
    var p = previo[clave] || {};
    return [clave, a.severidad, a.fase, a.tipo, a.hoja, String(a.fila), a.radicado, a.correo,
            a.detalle, a.accion, p.gestion || 'Pendiente', p.notas || '', p.desde || hoy];
  });

  sh.clear();
  sh.getRange(1, 1, 1, encabezado.length).setValues([encabezado])
    .setFontWeight('bold').setBackground('#064e3b').setFontColor('#ffffff');
  if (filas.length) {
    sh.getRange(2, 1, filas.length, encabezado.length).setValues(filas);
    var colores = { ALTA: '#fde2e2', MEDIA: '#fef3c7', BAJA: '#e0f2fe' };
    var fondos = filas.map(function (f) {
      return encabezado.map(function () { return colores[f[1]] || '#ffffff'; });
    });
    sh.getRange(2, 1, filas.length, encabezado.length).setBackgrounds(fondos).setWrap(true).setVerticalAlignment('top');
    var regla = SpreadsheetApp.newDataValidation()
      .requireValueInList(['Pendiente', 'En proceso', 'Resuelto', 'Ignorar'], true).build();
    sh.getRange(2, iGestion + 1, filas.length, 1).setDataValidation(regla);
  } else {
    sh.getRange(2, 1).setValue('Sin alertas: no se encontraron duplicados ni inconsistencias.');
  }
  sh.setFrozenRows(1);
  sh.hideColumns(1);
  [110, 70, 150, 230, 110, 70, 150, 220, 420, 420, 100, 220, 100].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
}

/** Fase del proceso a la que pertenece una alerta, según la hoja y el tipo. */
function faseDe_(hoja, tipo) {
  if (/fase 2|protocolo|comite|comité/i.test(tipo)) return '2. Protocolo y comité';
  if (hoja === 'Fase 3' || /sustentaci/i.test(tipo)) return '3. Sustentación';
  if (hoja === 'Acta asesoria') return 'Actas de asesoría';
  if (hoja === 'Fase2') return '2. Protocolo y comité';
  if (hoja === 'Usuarios') return 'General';
  return '1. Radicación y tutores';
}

function claveAlerta_(a) {
  return [a.tipo, a.hoja, a.fila, a.radicado, a.correo].join('|');
}

// ─────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────

/** Convierte los valores de una hoja en { encabezado:[...normalizado], filas:[{fila, v}] } */
function leerTabla_(valores) {
  if (!valores || !valores.length) return { encabezado: [], encabezadoOriginal: [], filas: [] };
  var encabezadoOriginal = valores[0].map(function (h) { return texto_(h); });
  var encabezado = valores[0].map(function (h) { return norm_(h); });
  var filas = [];
  for (var i = 1; i < valores.length; i++) {
    var v = valores[i];
    if (v.every(function (c) { return c === '' || c === null || c === undefined; })) continue;
    filas.push({ fila: i + 1, v: v });
  }
  return { encabezado: encabezado, encabezadoOriginal: encabezadoOriginal, filas: filas };
}

/** Índice de la primera columna cuyo encabezado es (o empieza por) alguno de los nombres */
function col_(tabla, nombres) {
  var h = tabla.encabezado;
  for (var k = 0; k < nombres.length; k++) {
    var i = h.indexOf(nombres[k]);
    if (i >= 0) return i;
  }
  for (var k2 = 0; k2 < nombres.length; k2++) {
    for (var j = 0; j < h.length; j++) if (h[j].indexOf(nombres[k2]) === 0) return j;
  }
  return -1;
}

function norm_(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}
function texto_(s) { return String(s == null ? '' : s).trim(); }
function correo_(s) {
  var c = texto_(s).toLowerCase();
  return /@/.test(c) ? c : '';
}
function cedula_(s) {
  var d = texto_(s).replace(/\.0+$/, '').replace(/\D/g, '');
  return d.length >= 5 ? d : '';
}
function esPrueba_(correo) {
  return PATRONES_PRUEBA.some(function (re) { return re.test(correo); });
}
function interseccion_(a, b) { return a.filter(function (x) { return b.indexOf(x) >= 0; }); }
function unicos_(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
function filas_(lista) { return lista.map(function (x) { return x.fila; }).join(', '); }
function corto_(s) { s = texto_(s); return s.length > 50 ? s.substring(0, 50) + '…' : s; }

/** "Aprobado" y "Aprobado Directo" (la hoja usa ambos). */
function esAprobado_(estadoNorm) { return /^aprobado/.test(estadoNorm); }

/**
 * Protocolo que define el estado real del grupo en Fase 2. Si ya hay uno avalado
 * ("Pendiente Comité") o aprobado y después solo llegaron envíos "Cargado", esos
 * envíos son sobrantes y no cambian el estado. Si después hubo una devolución,
 * manda el último envío.
 */
function protocoloVigente_(lista) {
  if (!lista.length) return null;
  var aprobados = lista.filter(function (p) { return esAprobado_(p.estado); });
  if (aprobados.length) return aprobados[aprobados.length - 1];
  var iAv = -1, iDev = -1;
  lista.forEach(function (p, i) {
    if (p.estado === 'pendiente comite') iAv = i;
    if (/^devuelto/.test(p.estado)) iDev = i;
  });
  return iAv >= 0 && iAv > iDev ? lista[iAv] : lista[lista.length - 1];
}

/** Cédula plausible: 6 a 10 dígitos, que no sea relleno (30000000, 11111111…) ni un celular (3xx xxx xxxx). */
function cedulaValida_(s) {
  var d = texto_(s).replace(/\.0+$/, '').replace(/\D/g, '');
  if (d.length < 6 || d.length > 10) return false;
  if (/^(\d)\1+$/.test(d) || /^[1-9]0{6,}$/.test(d)) return false;
  if (d.length === 10 && d.charAt(0) === '3') return false;
  return true;
}

// ── Fechas (sin hora, en la zona de la hoja) ─────────────────────────
function soloFecha_(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function fecha_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? null : soloFecha_(v);
  var m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}
function fmt_(d) {
  return d ? ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear() : '';
}
function diasEntre_(a, b) { return Math.round((soloFecha_(b) - soloFecha_(a)) / 86400000); }
function sumarDiasHabiles_(d, n) {
  var r = soloFecha_(d), sumados = 0;
  while (sumados < n) { r.setDate(r.getDate() + 1); if (r.getDay() !== 0 && r.getDay() !== 6) sumados++; }
  return r;
}
function diasHabilesEntre_(a, b) {
  var r = soloFecha_(a), fin = soloFecha_(b), n = 0;
  while (r < fin) { r.setDate(r.getDate() + 1); if (r.getDay() !== 0 && r.getDay() !== 6) n++; }
  return n;
}
function sumarMeses_(d, n) { var r = soloFecha_(d); r.setMonth(r.getMonth() + n); return r; }
function ultimaFecha_(lista) {
  return lista.filter(Boolean).sort(function (a, b) { return b - a; })[0] || null;
}

// Permite probar la lógica fuera de Apps Script (Node). No afecta a Apps Script.
if (typeof module !== 'undefined') module.exports = { auditarHojasCTTG_: auditarHojasCTTG_ };
