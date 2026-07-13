// POST /api/content/decide {id, decision} — aprueba/descarta/deshace una pieza desde la galería.
// decision: aprobado | descartado | renderizado (deshacer). Protegido por Basic Auth (middleware).
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  if (!process.env.POSTGRES_URL && process.env.DATABASE_URL) process.env.POSTGRES_URL = process.env.DATABASE_URL;
  const { sql } = await import("@vercel/postgres");
  const { id, decision } = req.body || {};
  if (!id || !["aprobado", "descartado", "renderizado"].includes(decision)) {
    return res.status(400).json({ error: "id o decision inválidos" });
  }
  try {
    await sql`UPDATE contenido_posts SET estado_visual = ${decision}, updated_at = now() WHERE id = ${id}`;
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
