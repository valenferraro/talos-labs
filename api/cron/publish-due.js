// GET /api/cron/publish-due — publica en Instagram las piezas aprobadas cuyo slot ya venció.
// Lo dispara Vercel Cron (ver vercel.json). Auth: header "Authorization: Bearer <CRON_SECRET>"
// (Vercel lo agrega solo si existe la env CRON_SECRET). NO usa Basic Auth: el middleware
// deja pasar /api/cron/* y este endpoint valida el secret por su cuenta (fail-closed).
// Publica vía Meta Graph API (Instagram Content Publishing):
//   post     → container {image_url, caption} → publish
//   carrusel → containers hijos {is_carousel_item} → container CAROUSEL {children, caption} → publish
//   story    → container {image_url, media_type: STORIES} SIN caption → publish
// Necesita en Vercel: CRON_SECRET y META_TOKEN (token del dashboard de la app, API de Instagram
// con Instagram Login). IG_USER_ID es opcional: si falta se deriva de /me con el token.
// Sin credenciales Meta responde ok:false y no toca nada (queda "en seco" hasta el setup).

const GRAPH = process.env.META_GRAPH_BASE || "https://graph.instagram.com/v23.0";
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

async function waitContainer(creationId) {
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${GRAPH}/${creationId}?fields=status_code&access_token=${process.env.META_TOKEN}`);
    const json = await res.json();
    if (json.status_code === "FINISHED") return;
    if (json.status_code === "ERROR") throw new Error(`container ${creationId} en ERROR`);
    await new Promise(r => setTimeout(r, 2000));
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
    SELECT id, data, archivos, caption, slot_fecha, slot_hora FROM contenido_posts
    WHERE estado_visual = 'aprobado'
      AND slot_fecha IS NOT NULL
      AND (slot_fecha < ${fecha} OR (slot_fecha = ${fecha} AND coalesce(slot_hora, '00:00') <= ${hora}))
    ORDER BY slot_fecha ASC, slot_hora ASC
    LIMIT ${MAX_POR_CORRIDA}`;

  const resultado = [];
  for (const p of due) {
    try {
      const mediaId = await publicar(p);
      await sql`UPDATE contenido_posts SET estado_visual = 'publicado', published_at = now(),
        publish_result = ${JSON.stringify({ media_id: mediaId })}, updated_at = now() WHERE id = ${p.id}`;
      resultado.push({ id: p.id, ok: true, media_id: mediaId });
    } catch (e) {
      // queda 'aprobado' → se reintenta en la próxima corrida; el error queda registrado
      await sql`UPDATE contenido_posts SET publish_result = ${JSON.stringify({ error: String(e.message || e), fecha })},
        updated_at = now() WHERE id = ${p.id}`;
      resultado.push({ id: p.id, ok: false, error: String(e.message || e) });
    }
  }
  res.status(200).json({ ok: true, ahora: `${fecha} ${hora} AR`, publicadas: resultado });
}
