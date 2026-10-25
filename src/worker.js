// tuopinion.almuerzo.cl - recibe respuestas y las entrega a una carpeta PRIVADA de Google Drive
// mediante un Google Apps Script. La URL del script y la clave viven solo como secretos del Worker.
// Solo responde ok:true cuando Drive confirmo que guardo la respuesta.

import { DurableObject } from "cloudflare:workers";

// Parametros PROPUESTOS (ajustables): 3 por minuto y 5 por dia por correo; 300 al dia en total (hora de Chile).
const LIM_MIN = 3, LIM_DIA_CORREO = 5, LIM_DIA_TOTAL = 300;

export class Limiter extends DurableObject {
  take(email) {
    const now = Date.now();
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(now);
    let s = this.ctx.storage.kv.get("s");
    if (!s || s.day !== day) s = { day, total: 0, by: {}, recent: {} };
    const key = email.toLowerCase();
    const recent = (s.recent[key] || []).filter((t) => now - t < 60000);
    if (recent.length >= LIM_MIN) return { ok: false, reason: "minuto" };
    if ((s.by[key] || 0) >= LIM_DIA_CORREO || s.total >= LIM_DIA_TOTAL) return { ok: false, reason: "dia" };
    recent.push(now);
    s.recent[key] = recent;
    s.by[key] = (s.by[key] || 0) + 1;
    s.total += 1;
    this.ctx.storage.kv.put("s", s);
    return { ok: true };
  }
}

const SURVEY_VERSION = "2026-10-25-v1";
const MAX_TEXT = 2000;
const MAX_AUDIO_BYTES = 2_500_000; // tope REAL de peso (60 s a ~32 kbps pesa ~250 KB). La duracion que declara el cliente no se verifica en el servidor.
const MAX_REQUEST_BYTES = 3_000_000;
const MAX_AUDIO_SECONDS = 60;
const AUDIO_TYPES = ["audio/webm", "audio/mp4", "audio/ogg", "audio/aac", "audio/mpeg"];

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });

function toBase64(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}
const intIn = (v, lo, hi) => {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};
const oneOf = (v, list) => (list.includes(v) ? v : null);

// Identidad opcional: solo se acepta un token firmado (HMAC-SHA256) emitido por el backend de app2
// con IDENTITY_SECRET. Formato: base64url(JSON{"email":"...","exp":epochSegundos}) + "." + base64url(firma).
// Sin token valido NO se guarda nada (401). Nunca se confia en un correo escrito en la URL.
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function verifyIdentity(token, env) {
  if (!token || !env.IDENTITY_SECRET) return null;
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.IDENTITY_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key, unb64u(parts[1]), new TextEncoder().encode(parts[0]));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(parts[0])));
    if (!p.email || typeof p.email !== "string" || !p.exp) return null;
    if (p.exp < Date.now() / 1000) return { expired: true };
    return { email: p.email.slice(0, 200), exp: p.exp };
  } catch { return null; }
}
const maskEmail = (e) => e.replace(/^(.).*(@.*)$/, (_, a, d) => a + "***" + d);

// El token viaja en el cuerpo (POST), nunca en la URL, para que no quede en logs.
async function handleWho(request, env) {
  let t = null;
  try { t = (await request.json()).t; } catch {}
  if (!env.IDENTITY_SECRET) return json({ ok: false, error: "not_configured" });
  const id = await verifyIdentity(t, env);
  if (id && id.email) return json({ ok: true, email_masked: maskEmail(id.email), exp: id.exp });
  return json({ ok: false, error: id && id.expired ? "token_expired" : "identity_required" });
}

async function handleSubmit(request, env) {
  if (!env.APPS_SCRIPT_URL || !env.SHARED_SECRET)
    return json({ ok: false, error: "Destino de respuestas no configurado" }, 503);

  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ ok: false, error: "Origen no permitido" }, 403);

  const len = Number(request.headers.get("content-length") || 0);
  if (!len || len > MAX_REQUEST_BYTES) return json({ ok: false, error: "Solicitud demasiado grande" }, 413);
  let form;
  try { form = await request.formData(); } catch { return json({ ok: false, error: "Formato invalido" }, 400); }
  // Sin identidad verificada no se guarda nada (evita llamadas directas y respuestas sin dueno).
  const id = await verifyIdentity(form.get("t"), env);
  if (!id || !id.email) return json({ ok: false, error: id && id.expired ? "token_expired" : "identity_required" }, 401);
  const email = id.email;

  if ((form.get("web") || "").toString().trim() !== "") return json({ ok: true }); // trampa para bots
  if (form.get("consent") !== "1") return json({ ok: false, error: "Falta aceptar el aviso" }, 400);

  const payload = {
    secret: env.SHARED_SECRET,
    texto: (form.get("texto") || "").toString().trim().slice(0, MAX_TEXT) || null,
    q_tiempo: oneOf(form.get("q_tiempo"), ["lt30", "30_44", "45_59", "60_89", "90_mas", "depende"]),
    q_perdida: oneOf(form.get("q_perdida"), ["decidir_pedir", "decidir_donde", "espera_pedido", "espera_pago", "ninguna"]),
    q_menu: intIn(form.get("q_menu"), 1, 4),
    q_idea: intIn(form.get("q_idea"), 1, 4),
    q_prepago: intIn(form.get("q_prepago"), 1, 4),
    q_momento_pago: oneOf(form.get("q_momento_pago"), ["antes", "al_llegar", "mesa_despues", "barra_ahora", "da_igual"]),
    q_electronico: intIn(form.get("q_electronico"), 1, 4),
    q_retiro: oneOf(form.get("q_retiro"), ["si", "tal_vez", "no"]),
    q_retiro_veces: null,
    // Opt-in aparte del consentimiento: solo para contarle que se hizo con su aporte. No es publicidad.
    quiere_novedades: form.get("quiere_novedades") === "1",
    version_encuesta: SURVEY_VERSION, // la fija el servidor, no el navegador
    email,
    audio_mime: null, audio_segundos: null, audio_b64: null,
  };

  if (payload.q_retiro === "si") payload.q_retiro_veces = oneOf(form.get("q_retiro_veces"), ["1_2", "3_4", "5_8", "9_mas"]);

  const file = form.get("audio");
  if (file && typeof file === "object" && file.size > 0) {
    const base = (file.type || "").split(";")[0].toLowerCase();
    if (!AUDIO_TYPES.includes(base)) return json({ ok: false, error: "Formato de audio no soportado" }, 415);
    if (file.size > MAX_AUDIO_BYTES) return json({ ok: false, error: "El audio es muy largo" }, 413);
    payload.audio_mime = base;
    payload.audio_segundos = Math.min(intIn(form.get("audio_segundos"), 0, 600) ?? 0, MAX_AUDIO_SECONDS);
    payload.audio_b64 = toBase64(new Uint8Array(await file.arrayBuffer()));
  }

  const answered = ["q_tiempo", "q_perdida", "q_menu", "q_idea", "q_prepago", "q_momento_pago", "q_electronico", "q_retiro"]
    .some((k) => payload[k] != null);
  if (!payload.texto && !payload.audio_b64 && !answered) return json({ ok: false, error: "Respuesta vacia" }, 400);

  // Topes ANTES de llamar a Drive, con un Durable Object (consistente, un solo contador).
  const lim = await env.LIMITER.get(env.LIMITER.idFromName("principal")).take(email);
  if (!lim.ok) return json({ ok: false, error: lim.reason === "minuto" ? "Demasiados envios, prueba en un minuto" : "Llegaste al maximo de respuestas por hoy" }, 429);

  try {
    // Apps Script responde con un redireccion; fetch la sigue.
    const r = await fetch(env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow",
    });
    const data = await r.json();
    if (data && data.ok === true) return json({ ok: true });
  } catch (_) { /* cae al error de abajo */ }
  return json({ ok: false, error: "No se pudo guardar" }, 502);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/respuesta") {
      if (request.method !== "POST") return json({ ok: false, error: "Metodo no permitido" }, 405);
      return handleSubmit(request, env);
    }
    if (url.pathname === "/api/quien" && request.method === "POST") return handleWho(request, env);
    if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "No encontrado" }, 404);
    return env.ASSETS.fetch(request);
  },
};
