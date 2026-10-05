import type { IncomingMessage } from 'node:http';
import type { Plugin } from 'vite';

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function routeApiPlugin(): Plugin {
  return {
    name: 'navme-route-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (!url.startsWith('/api/route')) return next();

        if (url === '/api/route/health' && req.method === 'GET') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ status: 'ok', service: 'navme-route-api' }));
          return;
        }

        if (url !== '/api/route/compute' || req.method !== 'POST') {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        try {
          const body = await readJsonBody(req);
          const mod = await server.ssrLoadModule('/src/routeApi/handler.ts');
          const result = await mod.handleRouteCompute(body);
          res.statusCode = result.ok ? 200 : 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      });
    },
  };
}
