import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bodyStr = Buffer.concat(chunks).toString();
  return JSON.parse(bodyStr);
}

function proxyRemoteFilePlugin(routePath, pluginName) {
  return {
    name: pluginName,
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const urlPath = req.url?.split('?')[0] ?? '';
        if (urlPath !== routePath || req.method !== 'POST') {
          return next();
        }
        let parsed;
        try {
          parsed = await readJsonBody(req);
        } catch {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Invalid JSON');
          return;
        }
        const targetUrl = parsed?.url;
        if (typeof targetUrl !== 'string' || !/^https?:\/\//i.test(targetUrl)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Expected { "url": "https://..." }');
          return;
        }
        try {
          const r = await fetch(targetUrl, { headers: { 'User-Agent': 'vite-media-fetch/1.0' } });
          const buf = Buffer.from(await r.arrayBuffer());
          const ct = r.headers.get('content-type') || 'application/octet-stream';
          res.statusCode = r.status;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', ct);
          res.setHeader('Content-Length', String(buf.length));
          res.end(buf);
        } catch (e) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(e instanceof Error ? e.message : String(e));
        }
      });
    },
  };
}

/** POST /api/mp-floorplan { "url": "https://..." } — fetch floorplan image server-side (CORS bypass). */
function mpFloorplanProxyPlugin() {
  return proxyRemoteFilePlugin('/api/mp-floorplan', 'mp-floorplan-proxy');
}

/** POST /api/media-fetch { "url": "https://..." } — fetch media bytes for PNG download (CORS bypass). */
function mediaFetchProxyPlugin() {
  return proxyRemoteFilePlugin('/api/media-fetch', 'media-fetch-proxy');
}

/** GET /api/translate-google?... — proxy Google gtx to reduce browser IP rate-limits. */
function googleTranslateProxyPlugin() {
  return {
    name: 'google-translate-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url || '';
        const urlPath = rawUrl.split('?')[0] ?? '';
        if (urlPath !== '/api/translate-google' || req.method !== 'GET') {
          return next();
        }
        const qs = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';
        const params = new URLSearchParams(qs);
        const q = params.get('q');
        const sl = params.get('sl') || 'en';
        const tl = params.get('tl');
        if (!q || !tl) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Expected q and tl query params');
          return;
        }
        try {
          const target = new URL('https://translate.googleapis.com/translate_a/single');
          target.searchParams.set('client', 'gtx');
          target.searchParams.set('sl', sl);
          target.searchParams.set('tl', tl);
          target.searchParams.set('dt', 't');
          target.searchParams.set('q', q);
          const r = await fetch(target.toString(), {
            headers: { 'User-Agent': 'navme-vite-translate/1.0' },
          });
          const body = await r.text();
          res.statusCode = r.status;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
          res.end(body);
        } catch (e) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(e instanceof Error ? e.message : String(e));
        }
      });
    },
  };
}

/** GET /api/matterport/tags?modelId=… — list Matterport Mattertags (Model API; server secrets). */
/**
 * Mints short-lived signed mesh URLs for a Matterport model.
 * The token pair stays here; the browser only ever sees the signed CDN link.
 */
function matterportMeshesProxyPlugin() {
  return {
    name: 'matterport-meshes-proxy',
    async configureServer(server) {
      try {
        const { loadEnv } = await import('vite');
        const env = loadEnv(server.config.mode, __dirname, '');
        for (const key of ['MATTERPORT_TOKEN_ID', 'MATTERPORT_TOKEN_SECRET']) {
          if (env[key] && !process.env[key]) process.env[key] = env[key];
        }
      } catch {
        /* */
      }

      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url || '';
        const urlPath = rawUrl.split('?')[0] ?? '';
        const isList = urlPath === '/api/matterport/matterpak-models';
        const isMeshes = urlPath === '/api/matterport/meshes';
        if ((!isList && !isMeshes) || req.method !== 'GET') {
          return next();
        }
        const qs = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';
        const modelId = new URLSearchParams(qs).get('modelId') || '';
        try {
          const api = await import(
            pathToFileURL(path.join(__dirname, 'server/matterport-model-api.js')).href
          );
          const body = isList
            ? { models: await api.fetchMatterpakModels() }
            : await api.fetchModelMeshAssets(modelId);
          res.statusCode = 200;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', 'application/json');
          // Signed links expire — never let a proxy hand back a stale one.
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(body));
        } catch (e) {
          res.statusCode = 502;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
    },
  };
}

function matterportTagsProxyPlugin() {
  return {
    name: 'matterport-tags-proxy',
    async configureServer(server) {
      // Load MATTERPORT_* from app .env into process.env for the helper.
      try {
        const { loadEnv } = await import('vite');
        const env = loadEnv(server.config.mode, __dirname, '');
        for (const key of ['MATTERPORT_TOKEN_ID', 'MATTERPORT_TOKEN_SECRET']) {
          if (env[key] && !process.env[key]) process.env[key] = env[key];
        }
      } catch {
        /* */
      }

      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url || '';
        const urlPath = rawUrl.split('?')[0] ?? '';
        if (urlPath !== '/api/matterport/tags' || req.method !== 'GET') {
          return next();
        }
        const qs = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';
        const modelId = new URLSearchParams(qs).get('modelId') || '';
        try {
          const { fetchModelWithMattertags, normalizeMattertag } = await import(
            pathToFileURL(path.join(__dirname, 'server/matterport-model-api.js')).href
          );
          const model = await fetchModelWithMattertags(modelId);
          const tags = model.mattertags.map(normalizeMattertag).filter((t) => t.id);
          res.statusCode = 200;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              modelId: model.id,
              modelName: model.name,
              tags,
            }),
          );
        } catch (e) {
          res.statusCode = 502;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [
    mpFloorplanProxyPlugin(),
    mediaFetchProxyPlugin(),
    googleTranslateProxyPlugin(),
    matterportTagsProxyPlugin(),
    matterportMeshesProxyPlugin(),
    {
      name: 'spa-production-fallbacks',
      closeBundle() {
        const distDir = path.join(__dirname, 'dist');
        const indexHtml = path.join(distDir, 'index.html');
        if (!fs.existsSync(indexHtml)) return;
        // Render/Cloudflare: missing SPA paths should still serve the app shell.
        fs.copyFileSync(indexHtml, path.join(distDir, '404.html'));
        // Explicit copies help hosts that do not apply render.yaml rewrites for /access.
        for (const dir of ['access', 'media']) {
          const targetDir = path.join(distDir, dir);
          fs.mkdirSync(targetDir, { recursive: true });
          fs.copyFileSync(indexHtml, path.join(targetDir, 'index.html'));
        }
        const logo = path.join(__dirname, 'public', 'NavMe_wb.png');
        if (fs.existsSync(logo)) {
          fs.copyFileSync(logo, path.join(distDir, 'favicon.ico'));
        }
      },
    },
  ],
  resolve: {
    dedupe: ['three'],
  },
  optimizeDeps: {
    exclude: ['recast-navigation', '@recast-navigation/core', '@recast-navigation/generators', '@recast-navigation/three'],
    include: ['@mkkellogg/gaussian-splats-3d'],
  },
  /** Always load `.env` from this app folder, even if the shell cwd is elsewhere. */
  envDir: __dirname,
  server: {
    port: 3001,
    /** If 3001 is taken, exit instead of hopping ports — avoids "failed to fetch" when the app/proxy origin doesn't match. */
    strictPort: true,
    https: false,
    proxy: {
      '/2d': {
        target: 'http://127.0.0.1:5173',
        changeOrigin: true,
      },
      '/3d-view': {
        target: 'http://127.0.0.1:5174',
        changeOrigin: true,
      },
      '/api/multiset': {
        target: 'https://api.multiset.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/multiset/, ''),
        secure: true,
      },
      // Proxy to bypass S3 CORS for mesh downloads
      '/s3-proxy': {
        target: 'https://prod-multiset.s3-accelerate.amazonaws.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/s3-proxy/, ''),
        secure: true,
      },
    },
  },
  build: {
    target: 'esnext',
  },
});
