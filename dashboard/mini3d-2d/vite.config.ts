import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { glbStreamProxyPlugin } from './vite-glb-proxy';
import { multisetDevProxyPlugin } from './vite-multiset-proxy';
import { routeApiPlugin } from './vite-route-api-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/** NavMe 2D/3D map editor — served at /2d/ on the dashboard host. */
export default defineConfig({
  root: __dirname,
  base: '/2d/',
  publicDir: path.join(root, 'public'),
  envDir: root,
  plugins: [multisetDevProxyPlugin(), glbStreamProxyPlugin(), routeApiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api/floor': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/floor/, ''),
      },
    },
  },
  build: {
    outDir: path.join(root, 'dist/2d'),
    emptyOutDir: true,
    target: 'esnext',
  },
});
