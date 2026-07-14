// /api/content/idea — cola de generación remota (el "chatbot" de la galería).
// POST {tipo: "idea"|"tirada"|"reel", prompt?, assets?} → encola un job en Postgres.
// "reel" con prompt = reel desde esa idea; sin prompt = reel autónomo (flujo H).
// GET → últimos 10 jobs (para la barra de estado de la galería).
// La generación NO corre acá: corre en la PC de Valen (contenido-bulk/watcher.js, claude -p
// headless con la suscripción, $0 API). Protegido por Basic Auth (middleware).
export default async function handler(req, res) {
  if (!process.env.POSTGRES_URL && process.env.DATABASE_URL) process.env.POSTGRES_URL = process.env.DATABASE_URL;
  const { sql } = await import("@vercel/postgres");
  await sql`CREATE TABLE IF NOT EXISTS contenido_jobs (
    id SERIAL PRIMARY KEY,
    tipo TEXT NOT NULL,
    prompt TEXT DEFAULT '',
    assets BOOLEAN DEFAULT false,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    resumen TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`;
  try {
    if (req.method === "GET") {
      const { rows } = await sql`SELECT id, tipo, prompt, assets, estado, resumen, created_at, updated_at
        FROM contenido_jobs ORDER BY id DESC LIMIT 10`;
      return res.status(200).json(rows);
    }
    if (req.method === "POST") {
      const { tipo, prompt, assets } = req.body || {};
      if (!["idea", "tirada", "reel"].includes(tipo)) return res.status(400).json({ error: "tipo inválido" });
      if (tipo === "idea" && !(prompt || "").trim()) return res.status(400).json({ error: "falta la idea" });
      const { rows } = await sql`INSERT INTO contenido_jobs (tipo, prompt, assets)
        VALUES (${tipo}, ${(prompt || "").trim()}, ${!!assets}) RETURNING id`;
      return res.status(200).json({ ok: true, id: rows[0].id });
    }
    res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
