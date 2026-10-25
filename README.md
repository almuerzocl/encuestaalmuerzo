# tuopinion.almuerzo.cl

Encuesta aprobada por Esteban el 25-oct-2026 12:26 (8 preguntas, 1 rama, texto/audio opcionales y casilla de novedades). La version se guarda en cada respuesta ("2026-10-25-v1"). Una pregunta vacia se guarda vacia (no "ninguna"); la frecuencia mensual solo se guarda si respondio "Si" en la 8.
La casilla "Quiero que me cuenten que hicieron con mi aporte" es aparte del consentimiento: solo sirve para contarle que se hizo con su aporte, no es publicidad. Hoy no se envia ningun correo. Si ya corriste setup() con una version anterior: pega el Code.gs nuevo y vuelve a correr setup(). No borra nada: si las columnas cambiaron, deja la hoja vieja intacta como "Respuestas_anterior_<fecha>" y crea una "Respuestas" nueva; carpeta y audios se reutilizan. Mientras no corras setup(), el receptor rechaza envios (no guarda filas mal alineadas) y la pagina avisa que no se pudo guardar.


Pagina de opinion (texto, audio grabado ahi mismo, 4 preguntas) que guarda en una carpeta PRIVADA de Google Drive.

Flujo: celular -> Worker de Cloudflare (valida) -> Google Apps Script (corre con tu cuenta) -> carpeta nueva en tu Drive + hoja "Respuestas".
La pagina solo muestra "Gracias" si Drive confirmo que guardo. Si algo falla, avisa y conserva lo escrito.

## Archivos
- public/index.html  la pagina (GitHub)
- src/worker.js      API en Cloudflare (sin secretos dentro)
- wrangler.toml      configuracion del Worker
- apps-script/Code.gs receptor en Google

## Puesta en marcha (en este orden)
1. Google Apps Script: sigue los pasos del comentario al inicio de Code.gs. Crea la carpeta nueva "tuopinion-respuestas" (no usa ninguna carpeta existente) y entrega una URL /exec.
2. GitHub: sube esta carpeta a un repositorio (puede ser privado). No hay claves en los archivos.
3. Cloudflare: Workers > Create > conectar el repositorio (o `npx wrangler deploy`). Luego cargar secretos:
   `npx wrangler secret put APPS_SCRIPT_URL` (la URL /exec) y `npx wrangler secret put SHARED_SECRET` (la misma clave de Apps Script).
4. Dominio: en el Worker, Settings > Domains > Custom domain: tuopinion.almuerzo.cl (almuerzo.cl debe estar en Cloudflare para esto; si el DNS esta en otro lado, hay que agregar un CNAME segun lo que indique Cloudflare).
5. Prueba con un token de prueba generado por app2 (ver Identidad): enviar una respuesta con audio y revisar carpeta y hoja. Probar en iPhone y Android.

## Identidad: OBLIGATORIA (falta conectar app2)
Solo se guarda una opinion con identidad verificada. Sin token valido la pagina muestra "Entra desde tu cuenta" y el Worker responde 401 (no hay respuesta anonima).
Lo que falta en app2 (no existe, no lo inventamos): que su backend, con el usuario ya logueado, genere el enlace
`https://tuopinion.almuerzo.cl/#t=TOKEN`  (obligatorio usar # y no ?: el fragmento no se envia al servidor; un ?t= se ignora y se borra),
TOKEN = base64url(JSON {"email":"...","exp":epoch_segundos}) + "." + base64url(HMAC-SHA256(esa primera parte, IDENTITY_SECRET)).
Vencimiento recomendado: 60 minutos (propuesta mia; ajustable en app2). El mismo IDENTITY_SECRET se carga en el Worker (`npx wrangler secret put IDENTITY_SECRET`), nunca en el navegador ni en GitHub.
No se verifico sesion, cookies ni SSO de app2: el token firmado evita depender de ellos.

Privacidad del token: la pagina lo lee una vez y lo borra de la barra de direcciones; vive solo en memoria (sin localStorage ni cookies); se valida por POST (no en la URL); la pagina y la API envian Referrer-Policy: no-referrer y no cargan nada de terceros salvo las fuentes de Google Fonts (sin referrer); el logo va incrustado. Los logs de Cloudflare no estan activados en wrangler.toml; si los activas, el token ya no aparece en rutas ni parametros. Un correo escrito en la URL nunca se acepta.

Vencimiento a mitad de respuesta: la pagina avisa 5 min antes. Si vence al enviar, NO borra lo escrito ni el audio: muestra un cuadro para pegar el enlace nuevo (abierto desde la cuenta en otra pestana) y renovar sin perder nada. Si se recarga o cierra la pagina, se pierde (decision de no guardar nada en el navegador).
Que puede probar el al desplegar: (a) sin #t= -> bloqueo; (b) token de app2 -> correo enmascarado, enviar, fila en la hoja con su correo; (c) token alterado -> bloqueo; (d) token vencido -> aviso, datos conservados, renovar pegando enlace nuevo.

## Proteccion contra abuso
Parametros PROPUESTOS por mi como punto de partida (no vienen de ninguna regla ni cifra oficial; ajustalos):
1. Sin token firmado valido no se llega a Drive (401).
2. Topes en el Worker ANTES de Drive, con un Durable Object (contador unico y consistente): 3 envios por minuto y 5 por dia por correo, 300 por dia en total (hora de Chile). Segun la documentacion de Cloudflare, los Durable Objects con almacenamiento SQLite estan disponibles en el plan Workers Free (limite de 100.000 solicitudes al dia en ese plan). Probado local: el 4o envio del mismo correo da 429 y otro correo sigue pasando. No depende del binding de Rate Limiting ni de Apps Script.
3. Segunda capa en Apps Script: repite los topes diarios (5 por correo, 300 en total).
4. Audio: tope REAL de 2,5 MB por peso, solicitud total maxima 3 MB, solo formatos de audio permitidos. El maximo de 60 s lo aplica la pagina; el servidor no mide la duracion, solo el peso (60 s a ~32 kbps pesa ~250 KB). La hoja dice "segundos declarados por el celular".
5. Campo trampa para bots simples.
Un token valido se puede reusar hasta vencer, dentro de esos topes. La URL del Apps Script es publica por diseno de Google (app web "cualquiera"): sin la clave compartida no guarda nada, pero las llamadas directas con clave incorrecta igual consumen ejecuciones. Cuotas de Google para cuentas gmail.com: 20.000 llamadas URL Fetch/dia y 30 ejecuciones simultaneas por usuario (developers.google.com/apps-script/guides/services/quotas).

## Limites y notas
- Audio: formato segun el celular (webm en Android/Chrome, mp4/m4a en iPhone). Sin probar en celulares reales aun.
- Consentimiento: frase simple, no revisada legalmente; reemplazar por el texto de tu revision de datos.
- Nada de esto fue desplegado ni probado contra Drive real ni con Cloudflare real: las pruebas locales usaron un Apps Script simulado. La primera prueba real la haces tu al desplegar (paso 5).
- No hay seguimiento automatico: la hoja guarda el correo para que tu respondas cuando quieras.
- Encabezado: logo oficial tomado del header de almuerzo.cl (carga desde el CDN del sitio; si falla muestra el texto).
