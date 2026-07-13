// GET /api/content/list — piezas de contenido para la galería de aprobación (/admin/content.html).
// Estado en Vercel Postgres (Neon); imágenes en Vercel Blob. Protegido por Basic Auth (middleware).
export default async function handler(req, res) {
  if (!process.env.POSTGRES_URL && process.env.DATABASE_URL) process.env.POSTGRES_URL = process.env.DATABASE_URL;
  const { sql } = await import("@vercel/postgres");
  try {
    const { rows } = await sql`
      SELECT id, data, estado_visual, slot_fecha, slot_hora, archivos, caption, orden
      FROM contenido_posts ORDER BY orden ASC`;
    res.status(200).json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
