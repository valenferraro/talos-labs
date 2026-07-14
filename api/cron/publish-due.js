// GET /api/cron/publish-due — publica en Instagram las piezas aprobadas cuyo slot ya venció.
// Lo dispara Vercel Cron (ver vercel.json). Auth: header "Authorization: Bearer <CRON_SECRET>"
// (Vercel lo agrega solo si existe la env CRON_SECRET). NO usa Basic Auth: el middleware
// deja pasar /api/cron/* y este endpoint valida el secret por su cuenta (fail-closed).
// Publica vía Meta Graph API (Instagram Content Publishing):
//   post     → container {image_url, caption} → publish
//   carrusel → containers hijos {is_carousel_item} → container CAROUSEL {children, caption} → publish
//   story    → container {image_url, media_type: STORIES} SIN caption → publish
//   reel     → container {media_type: REELS, video_url, caption, cover_url} → publish
//              (el video tarda en procesar: espera más larga; archivos = [mp4, portada] en Blob)
// Necesita en Vercel: CRON_SECRET y META_TOKEN (token del dashboard de la app, API de Instagram
// con Instagram Login). IG_USER_ID es opcional: si falta se deriva de /me con el token.
// Sin credenciales Meta responde ok:false y no toca nada (queda "en seco" hasta el setup).
//
// TIKTOK (solo reels): si hay TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET en Vercel Y la cuenta está
// conectada (token en contenido_tokens, se conecta una vez en /api/tiktok/oauth), cada reel se
// publica ADEMÁS en TikTok (Content Posting API, FILE_UPLOAD: se baja el mp4 del Blob y se sube).
// Estado por red en publish_result.redes → si una red falla no se duplica la otra al reintentar.
// OJO: hasta que TikTok audite la app, los posts salen SELF_ONLY (privados). Cuando apruebe,
// setear TIKTOK_PRIVACY=PUBLIC_TO_EVERYONE en Vercel.

const GRAPH = process.env.META_GRAPH_BASE || "https://graph.instagram.com/v23.0";
const TIKTOK = "https://open.tiktokapis.com/v2";
const MAX_POR_CORRIDA = 3; // válvula: nunca más de 3 publicaciones por corrida

async function graph(pathname, params) {
  const res = await fetch(`${GRAPH}/${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...params, access_token: process.env.META_TOKEN }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`${pathname}: ${JSON.stringify(json.error || json)}`);
  return json;
}

async function waitContainer(creationId, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${GRAPH}/${creationId}?fields=status_code&access_token=${process.env.META_TOKEN}`);
    const json = await res.json();
    if (json.status_code === "FINISHED") return;
    if (json.status_code === "ERROR") throw new Error(`container ${creationId} en ERROR`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`container ${creationId} no quedó FINISHED a tiempo`);
}

async function igUserId() {
  if (process.env.IG_USER_ID) return process.env.IG_USER_ID;
  const res = await fetch(`${GRAPH}/me?fields=user_id,username&access_token=${process.env.META_TOKEN}`);
  const json = await res.json();
  if (json.error) throw new Error(`/me: ${JSON.stringify(json.error)}`);
  process.env.IG_USER_ID = String(json.user_id || json.id);
  return process.env.IG_USER_ID;
}

async function publicar(p) {
  const igUser = await igUserId();
  const urls = p.archivos || [];
  if (!urls.length) throw new Error("pieza sin archivos");
  const format = (p.data || {}).format;
  let creationId;
  if (format === "reel") {
    // archivos = [mp4, portada.png]; el procesamiento del video tarda → espera larga (hasta ~2 min)
    const params = { media_type: "REELS", video_url: urls[0], caption: p.caption || "", share_to_feed: true };
    if (urls[1]) params.cover_url = urls[1];
    ({ id: creationId } = await graph(`${igUser}/media`, params));
    await waitContainer(creationId, 40);
    const { id: mediaId } = await graph(`${igUser}/media_publish`, { creation_id: creationId });
    return mediaId;
  }
  if (format === "story") {
    ({ id: creationId } = await graph(`${igUser}/media`, { image_url: urls[0], media_type: "STORIES" }));
  } else if (urls.length > 1) {
    const children = [];
    for (const u of urls) {
      const { id } = await graph(`${igUser}/media`, { image_url: u, is_carousel_item: true });
      children.push(id);
    }
    for (const id of children) await waitContainer(id);
    ({ id: creationId } = await graph(`${igUser}/media`,
      { media_type: "CAROUSEL", children, caption: p.caption || "" }));
  } else {
    ({ id: creationId } = await graph(`${igUser}/media`, { image_url: urls[0], caption: p.caption || "" }));
  }
  await waitContainer(creationId);
  const { id: mediaId } = await graph(`${igUser}/media_publish`, { creation_id: creationId });
  return mediaId;
}

// ——— TikTok (Content Posting API) ———

// fila de token en Postgres; null = TikTok no configurado/conectado → los reels van solo a IG
async function tiktokFila(sql) {
  if (!process.env.TIKTOK_CLIENT_KEY || !process.env.TIKTOK_CLIENT_SECRET) return null;
  try {
    const { rows } = await sql`SELECT access_token, refresh_token, expira_at FROM contenido_tokens WHERE proveedor = 'tiktok'`;
    return rows[0] || null;
  } catch { return null; } // la tabla la crea /api/tiktok/oauth al conectar
}

// el access_token de TikTok dura 24 h → si venció o está por vencer se refresca solo
// (el refresh_token dura ~1 año y va rotando; queda siempre el último en la tabla)
async function tiktokToken(sql) {
  const fila = await tiktokFila(sql);
  if (!fila) throw new Error("TikTok sin conectar (entrar a /api/tiktok/oauth)");
  const vence = fila.expira_at ? new Date(fila.expira_at).getTime() : 0;
  if (vence - Date.now() > 10 * 60 * 1000) return fila.access_token;
  const body = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET,
    grant_type: "refresh_token", refresh_token: fila.refresh_token,
  });
  const r = await fetch(`${TIKTOK}/oauth/token/`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(),
  });
  const json = await r.json();
  if (!r.ok || json.error) throw new Error(`refresh TikTok: ${json.error_description || JSON.stringify(json)}`);
  const expira = new Date(Date.now() + (json.expires_in || 86400) * 1000).toISOString();
  await sql`UPDATE contenido_tokens SET access_token = ${json.access_token},
    refresh_token = ${json.refresh_token || fila.refresh_token}, expira_at = ${expira}, updated_at = now()
    WHERE proveedor = 'tiktok'`;
  return json.access_token;
}

async function publicarTikTok(p, sql) {
  const url = (p.archivos || [])[0];
  if (!url) throw new Error("reel sin mp4");
  const token = await tiktokToken(sql);
  const vid = await fetch(url);
  if (!vid.ok) throw new Error(`no pude bajar el mp4 del Blob (HTTP ${vid.status})`);
  const buf = Buffer.from(await vid.arrayBuffer());
  if (buf.length > 60 * 1024 * 1024) throw new Error("mp4 >60MB: falta subida multi-chunk");
  const init = await fetch(`${TIKTOK}/post/publish/video/init/`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      post_info: {
        title: (p.caption || "").slice(0, 2200),
        privacy_level: process.env.TIKTOK_PRIVACY || "SELF_ONLY",
      },
      source_info: { source: "FILE_UPLOAD", video_size: buf.length, chunk_size: buf.length, total_chunk_count: 1 },
    }),
  });
  const initJson = await init.json();
  if (!init.ok || (initJson.error && initJson.error.code !== "ok")) {
    throw new Error(`init TikTok: ${JSON.stringify(initJson.error || initJson)}`);
  }
  const { publish_id, upload_url } = initJson.data;
  const up = await fetch(upload_url, {
    method: "PUT",
    headers: { "content-type": "video/mp4", "content-range": `bytes 0-${buf.length - 1}/${buf.length}` },
    body: buf,
  });
  if (!up.ok) throw new Error(`upload TikTok: HTTP ${up.status}`);
  // la subida ya está hecha → aunque el procesamiento no termine en la espera, NO se reintenta
  for (let i = 0; i < 20; i++) {
    const st = await fetch(`${TIKTOK}/post/publish/status/fetch/`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ publish_id }),
    });
    const stJson = await st.json();
    const status = stJson.data && stJson.data.status;
    if (status === "PUBLISH_COMPLETE") return publish_id;
    if (status === "FAILED") throw new Error(`TikTok FAILED: ${(stJson.data && stJson.data.fail_reason) || "?"}`);
    await new Promise(r => setTimeout(r, 3000));
  }
  return publish_id; // sigue procesando del lado de TikTok; termina solo
}

// fecha/hora actuales en Argentina (los slots del calendario están en hora AR)
function ahoraAR() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return { fecha: `${get("year")}-${get("month")}-${get("day")}`, hora: `${get("hour")}:${get("minute")}` };
}

export default async function handler(req, res) {
  const auth = req.headers["authorization"] || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "no autorizado" });
  }
  if (!process.env.META_TOKEN) {
    return res.status(200).json({ ok: false, motivo: "falta META_TOKEN — cron en seco" });
  }
  if (!process.env.POSTGRES_URL && process.env.DATABASE_URL) process.env.POSTGRES_URL = process.env.DATABASE_URL;
  const { sql } = await import("@vercel/postgres");
  await sql`ALTER TABLE contenido_posts ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`;
  await sql`ALTER TABLE contenido_posts ADD COLUMN IF NOT EXISTS publish_result JSONB`;

  const { fecha, hora } = ahoraAR();
  const { rows: due } = await sql`
    SELECT id, data, archivos, caption, slot_fecha, slot_hora, publish_result FROM contenido_posts
    WHERE estado_visual = 'aprobado'
      AND slot_fecha IS NOT NULL
      AND (slot_fecha < ${fecha} OR (slot_fecha = ${fecha} AND coalesce(slot_hora, '00:00') <= ${hora}))
    ORDER BY slot_fecha ASC, slot_hora ASC
    LIMIT ${MAX_POR_CORRIDA}`;

  const ttListo = !!(await tiktokFila(sql)); // TikTok conectado → los reels van a IG + TikTok

  const resultado = [];
  for (const p of due) {
    const redes = ["instagram"];
    if ((p.data || {}).format === "reel" && ttListo) redes.push("tiktok");
    // lo ya publicado en corridas anteriores no se repite (estado por red)
    const hecho = (p.publish_result && p.publish_result.redes) || {};
    const errores = {};
    for (const red of redes) {
      if (hecho[red]) continue;
      try {
        if (red === "instagram") hecho.instagram = { media_id: await publicar(p) };
        else hecho.tiktok = { publish_id: await publicarTikTok(p, sql) };
      } catch (e) {
        errores[red] = String(e.message || e);
      }
    }
    const completo = redes.every(r => hecho[r]);
    if (completo) {
      await sql`UPDATE contenido_posts SET estado_visual = 'publicado', published_at = now(),
        publish_result = ${JSON.stringify({ redes: hecho })}, updated_at = now() WHERE id = ${p.id}`;
      resultado.push({ id: p.id, ok: true, redes: hecho });
    } else {
      // queda 'aprobado' → la próxima corrida reintenta SOLO las redes que faltan
      await sql`UPDATE contenido_posts SET publish_result = ${JSON.stringify({ redes: hecho, error: errores, fecha })},
        updated_at = now() WHERE id = ${p.id}`;
      resultado.push({ id: p.id, ok: false, redes: hecho, error: errores });
    }
  }
  res.status(200).json({ ok: true, ahora: `${fecha} ${hora} AR`, publicadas: resultado });
}
