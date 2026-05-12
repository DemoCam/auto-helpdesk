import { onRequest as casosHandler } from './functions/api/casos';
import { onRequest as adjuntoHandler } from './functions/api/adjunto';

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Enrutar /api/casos
    if (url.pathname.startsWith('/api/casos')) {
      return casosHandler({ request, env });
    }

    // Enrutar /api/adjunto
    if (url.pathname.startsWith('/api/adjunto')) {
      return adjuntoHandler({ request, env });
    }

    // Si no es /api/*, dejamos que Cloudflare Workers sirva los assets estáticos de React
    // (Esto requiere que [assets] esté configurado en wrangler.toml)
    return env.ASSETS.fetch(request);
  },
};
