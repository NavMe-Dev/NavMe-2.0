/**
 * Isolated Vite config for Matterpak twin lab only.
 * Does not load the NavMe dashboard, login, or Multiset proxies.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const nm = path.join(root, 'node_modules');

export default defineConfig({
  root: __dirname,
  publicDir: path.join(root, 'public'),
  envDir: root,
  resolve: {
    dedupe: ['three'],
    alias: {
      three: path.join(nm, 'three'),
      fflate: path.join(nm, 'fflate'),
      'recast-navigation': path.join(nm, 'recast-navigation'),
      '@recast-navigation/generators': path.join(nm, '@recast-navigation/generators'),
      '@recast-navigation/core': path.join(nm, '@recast-navigation/core'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 3010,
    strictPort: true,
    fs: {
      allow: [root, __dirname],
    },
  },
  optimizeDeps: {
    include: ['three', 'fflate'],
    exclude: [
      'recast-navigation',
      '@recast-navigation/core',
      '@recast-navigation/generators',
      '@recast-navigation/three',
    ],
  },
  build: {
    outDir: path.join(root, 'dist-matterpak-twin'),
    emptyOutDir: true,
    target: 'esnext',
  },
});
