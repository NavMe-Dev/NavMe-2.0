import type { Connect, Plugin } from 'vite';

const MULTISET_API = 'https://api.multiset.ai';

/** Dev-only: forward /api/multiset/* to api.multiset.ai from Node (avoids CORS + Supabase header clash). */
export function multisetDevProxyPlugin(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const rawUrl = req.url ?? '';
    const pathOnly = rawUrl.split('?')[0];
    if (!pathOnly.startsWith('/api/multiset')) {
      next();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      void (async () => {
        try {
          const sub = pathOnly.replace(/^\/api\/multiset/, '') || '/';
          const qs = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';
          const target = `${MULTISET_API}${sub.startsWith('/') ? sub : `/${sub}`}${qs}`;

          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (!value || key === 'host' || key === 'connection' || key === 'content-length') continue;
            headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
          // Node fetch decompresses gzip/br; do not ask upstream for compressed bodies.
          headers.set('accept-encoding', 'identity');

          const method = req.method ?? 'GET';
          const body =
            method !== 'GET' && method !== 'HEAD' && chunks.length > 0
              ? Buffer.concat(chunks)
              : undefined;

          const upstream = await fetch(target, { method, headers, body });
          const buf = Buffer.from(await upstream.arrayBuffer());
          res.statusCode = upstream.status;
          upstream.headers.forEach((v, k) => {
            const lower = k.toLowerCase();
            if (lower === 'transfer-encoding' || lower === 'content-encoding' || lower === 'content-length') {
              return;
            }
            res.setHeader(k, v);
          });
          res.setHeader('content-length', String(buf.length));
          res.end(buf);
        } catch (err) {
          res.statusCode = 502;
          res.end(err instanceof Error ? err.message : String(err));
        }
      })();
    });
  };

  return {
    name: 'multiset-dev-proxy',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
