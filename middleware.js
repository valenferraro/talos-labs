// Vercel Edge Middleware — protege /admin y /api con Basic Auth.
// La clave vive en variables de entorno de Vercel: ADMIN_USER y ADMIN_PASS.
// El resto del sitio (landing, deck, one-page) queda intacto.
// NOTA: cuando sumemos cron de publicación, ese endpoint va bajo /api/cron/* y se
// autentica con CRON_SECRET (no Basic Auth), así que habrá que excluirlo del matcher.
export const config = { matcher: ['/admin', '/admin/:path*', '/api/:path*'] };

export default function middleware(request) {
  const USER = process.env.ADMIN_USER || 'talos';
  const PASS = process.env.ADMIN_PASS || '';
  const auth = request.headers.get('authorization');

  if (PASS && auth?.startsWith('Basic ')) {
    try {
      const decoded = atob(auth.slice(6));
      const i = decoded.indexOf(':');
      const u = decoded.slice(0, i);
      const p = decoded.slice(i + 1);
      if (u === USER && p === PASS) return; // ok -> continúa
    } catch { /* header inválido -> pide login */ }
  }

  return new Response('Acceso restringido', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="TALOS admin", charset="UTF-8"' },
  });
}
