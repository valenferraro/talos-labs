// GET /api/tiktok/oauth — conecta la cuenta de TikTok de TALOS (una sola vez).
// Protegido por el Basic Auth del middleware (como todo /api/* salvo /api/cron/*).
// Flujo: entrar sin params → redirige a TikTok a autorizar → TikTok vuelve acá con ?code
// → se canjea por access_token + refresh_token y quedan guardados en Postgres
// (tabla contenido_tokens), de donde los lee el cron de publicación.
// Necesita en Vercel: TIKTOK_CLIENT_KEY y TIKTOK_CLIENT_SECRET (de la app en
// developers.tiktok.com, producto "Content Posting API", redirect URI = esta URL exacta).

const TT = "https://open.tiktokapis.com/v2";

export default async function handler(req, res) {
  const key = process.env.TIKTOK_CLIENT_KEY;
  const secret = process.env.TIKTOK_CLIENT_SECRET;
  if (!key || !secret) {
    return res.status(200).json({ ok: false, motivo: "faltan TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET en Vercel" });
  }

  const redirectUri = `https://${req.headers.host}/api/tiktok/oauth`;
  const { code, error, error_description } = req.query;

  if (error) return res.status(400).send(`TikTok devolvió error: ${error} — ${error_description || ""}`);

  // Paso 1: sin code → mandar a autorizar a TikTok
  if (!code) {
    const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
    url.searchParams.set("client_key", key);
    url.searchParams.set("scope", "user.info.basic,video.publish,video.upload");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", "talos");
    return res.redirect(302, url.toString());
  }

  // Paso 2: volvió con code → canjear por tokens y guardarlos
  const body = new URLSearchParams({
    client_key: key, client_secret: secret, code,
    grant_type: "authorization_code", redirect_uri: redirectUri,
  });
  const r = await fetch(`${TT}/oauth/token/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = await r.json();
  if (!r.ok || json.error) {
    return res.status(400).json({ ok: false, error: json.error_description || json.error || json });
  }

  if (!process.env.POSTGRES_URL && process.env.DATABASE_URL) process.env.POSTGRES_URL = process.env.DATABASE_URL;
  const { sql } = await import("@vercel/postgres");
  await sql`CREATE TABLE IF NOT EXISTS contenido_tokens (
    proveedor TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expira_at TIMESTAMPTZ,
    data JSONB,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`;
  const expira = new Date(Date.now() + (json.expires_in || 86400) * 1000).toISOString();
  await sql`INSERT INTO contenido_tokens (proveedor, access_token, refresh_token, expira_at, data, updated_at)
    VALUES ('tiktok', ${json.access_token}, ${json.refresh_token}, ${expira},
            ${JSON.stringify({ open_id: json.open_id, scope: json.scope })}, now())
    ON CONFLICT (proveedor) DO UPDATE SET
      access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
      expira_at = EXCLUDED.expira_at, data = EXCLUDED.data, updated_at = now()`;

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.status(200).send(`<body style="background:#070912;color:#F4F6FF;font-family:system-ui;display:grid;place-items:center;height:100vh">
    <div style="text-align:center"><h1>✅ TikTok conectado</h1>
    <p>Cuenta autorizada (scope: ${json.scope || "?"}). El cron ya puede publicar reels en TikTok.<br>
    Podés cerrar esta pestaña.</p></div></body>`);
}
