/**
 * tuopinion.almuerzo.cl - receptor en Google Apps Script.
 * Corre con TU cuenta de Google y guarda en una carpeta NUEVA y PRIVADA de TU Drive.
 * Nadie que responda puede leer nada: solo puede enviar a traves del Worker (que conoce la clave).
 *
 * Pasos (una vez; si actualizas este archivo mas adelante, vuelve a correr setup(), no borra nada):
 * 1. script.google.com > Proyecto nuevo > pega este archivo en Code.gs.
 * 2. Ejecuta la funcion setup() y acepta los permisos (Drive y Hojas). Crea (o reutiliza) la carpeta
 *    "tuopinion-respuestas" y una hoja "Respuestas" dentro. En Ver > Registros veras sus links.
 * 3. Configuracion del proyecto > Propiedades del script > agrega SHARED_SECRET con una clave larga
 *    inventada por ti (la misma que cargaras en Cloudflare como secreto).
 * 4. Implementar > Nueva implementacion > Aplicacion web > Ejecutar como: Yo,
 *    Quien tiene acceso: Cualquier persona. Copia la URL /exec (va como secreto en Cloudflare).
 */

var HEADERS_ = [
  'Fecha', 'Version encuesta', 'Correo (cuenta verificada)', 'Quiere que le cuenten que hicimos con su aporte',
  'P1 Tiempo para almorzar', 'P2 Lo que mas tiempo hace perder', 'P3 Importancia del menu (1-4)',
  'P4 Le gusta la idea (1-4)', 'P5 Disposicion a prepagar (1-4)', 'P6 Cuando preferiria pagar',
  'P7 Pago electronico (1-4)', 'P8 Usaria el retiro', 'P8b Veces al mes (solo si Si)',
  'Texto libre', 'Audio (seg declarados por el celular)', 'Audio (link)'
];

/**
 * Idempotente y NO destructivo: se puede correr las veces que haga falta.
 * - Reutiliza la carpeta y la hoja si ya existen (no crea duplicados).
 * - Si la hoja "Respuestas" tiene columnas de una version anterior, NO borra ni toca sus datos:
 *   la renombra a "Respuestas_anterior_<fecha>" y crea una hoja "Respuestas" nueva con las columnas actuales.
 * - Nunca elimina archivos, audios, carpetas ni filas.
 */
// Carpeta y hoja ya creadas (privadas) en el Drive de Esteban. setup() las usa; no crea duplicados.
var FOLDER_ID_INICIAL_ = '10OAw6c9q5YGDXZUcj3Or4rE6Wma1X0E2';
var SHEET_ID_INICIAL_ = '1iQq0wU6aMOgLY5UDTHDuTyKYq3Zv2fhDbCaKzuWSG_w';

function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('FOLDER_ID')) props.setProperty('FOLDER_ID', FOLDER_ID_INICIAL_);
  if (!props.getProperty('SHEET_ID')) props.setProperty('SHEET_ID', SHEET_ID_INICIAL_);
  var folder = null;
  var folderId = props.getProperty('FOLDER_ID');
  if (folderId) { try { folder = DriveApp.getFolderById(folderId); } catch (e) { folder = null; } }
  if (!folder) {
    folder = DriveApp.createFolder('tuopinion-respuestas'); // privada por defecto
    props.setProperty('FOLDER_ID', folder.getId());
  }

  var ss = null;
  var sheetId = props.getProperty('SHEET_ID');
  if (sheetId) { try { ss = SpreadsheetApp.openById(sheetId); } catch (e) { ss = null; } }
  if (!ss) {
    if (sheetId) props.setProperty('OLD_SHEET_IDS', (props.getProperty('OLD_SHEET_IDS') || '') + ' ' + sheetId); // se conserva la referencia
    ss = SpreadsheetApp.create('Respuestas tuopinion');
    var file = DriveApp.getFileById(ss.getId());
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
    props.setProperty('SHEET_ID', ss.getId());
  }
  ensureTab_(ss);

  Logger.log('Carpeta: ' + folder.getUrl());
  Logger.log('Hoja: ' + ss.getUrl());
}

function headersOk_(tab) {
  if (!tab || tab.getLastColumn() < HEADERS_.length) return false;
  var row = tab.getRange(1, 1, 1, HEADERS_.length).getValues()[0];
  for (var i = 0; i < HEADERS_.length; i++) if (String(row[i]) !== HEADERS_[i]) return false;
  return true;
}

function ensureTab_(ss) {
  var tab = ss.getSheetByName('Respuestas');
  if (!tab) {
    var sheets = ss.getSheets();
    if (sheets.length === 1 && sheets[0].getLastRow() === 0) { tab = sheets[0]; tab.setName('Respuestas'); }
    else tab = ss.insertSheet('Respuestas');
    tab.appendRow(HEADERS_);
    return tab;
  }
  if (headersOk_(tab)) return tab;
  if (tab.getLastRow() === 0) { tab.appendRow(HEADERS_); return tab; }
  // Columnas de otra version con datos: se conservan intactos en una hoja aparte.
  var stamp = Utilities.formatDate(new Date(), 'America/Santiago', 'yyyy-MM-dd_HH-mm-ss');
  tab.setName('Respuestas_anterior_' + stamp);
  var fresh = ss.insertSheet('Respuestas');
  fresh.appendRow(HEADERS_);
  return fresh;
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var props = PropertiesService.getScriptProperties();
    var data = JSON.parse(e.postData.contents);
    var secret = props.getProperty('SHARED_SECRET');
    if (!secret || data.secret !== secret) return out_({ ok: false });
    if (!props.getProperty('FOLDER_ID') || !props.getProperty('SHEET_ID')) return out_({ ok: false });

    if (!data.email) return out_({ ok: false });
    var ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID'));
    var tab = ss.getSheetByName('Respuestas');
    // Si las columnas no coinciden (falta correr setup() tras una actualizacion), no se guarda mal alineado.
    if (!headersOk_(tab)) return out_({ ok: false });

    lock.waitLock(20000);
    // Topes diarios (Chile): por correo y global, para que nadie agote la cuota ni llene el Drive.
    var day = Utilities.formatDate(new Date(), 'America/Santiago', 'yyyyMMdd');
    var counts = JSON.parse(props.getProperty('COUNTS') || '{}');
    if (counts.day !== day) counts = { day: day, total: 0, by: {} };
    var key = String(data.email).toLowerCase();
    if (counts.total >= 300 || (counts.by[key] || 0) >= 5) return out_({ ok: false });
    counts.total++; counts.by[key] = (counts.by[key] || 0) + 1;
    props.setProperty('COUNTS', JSON.stringify(counts));

    var folder = DriveApp.getFolderById(props.getProperty('FOLDER_ID'));
    var stamp = Utilities.formatDate(new Date(), 'America/Santiago', 'yyyy-MM-dd_HH-mm-ss');
    var audioUrl = '';
    if (data.audio_b64) {
      var ext = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/aac': 'aac', 'audio/mpeg': 'mp3' }[data.audio_mime] || 'bin';
      var blob = Utilities.newBlob(Utilities.base64Decode(data.audio_b64), data.audio_mime, 'audio_' + stamp + '.' + ext);
      audioUrl = folder.createFile(blob).getUrl();
    }
    var v = function (x) { return x === null || x === undefined ? '' : x; };
    tab.appendRow([
      stamp, safe_(data.version_encuesta), safe_(data.email), data.quiere_novedades === true ? 'Si' : 'No',
      v(data.q_tiempo), v(data.q_perdida), v(data.q_menu), v(data.q_idea), v(data.q_prepago), v(data.q_momento_pago),
      v(data.q_electronico), v(data.q_retiro), v(data.q_retiro_veces),
      safe_(data.texto), v(data.audio_segundos), audioUrl
    ]);
    return out_({ ok: true });
  } catch (err) {
    return out_({ ok: false });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

function safe_(v) { // evita que una celda se interprete como formula
  v = v == null ? '' : String(v);
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}
function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
