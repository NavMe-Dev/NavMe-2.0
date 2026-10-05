import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(appRoot, '..');

export default defineConfig({
  // Root deploy on Render / custom domain. If you use a subpath, set VITE_BASE=/subpath/
  root: appRoot,
  base: process.env.VITE_BASE || '/3d-view/',
  publicDir: path.join(workspaceRoot, 'public'),
  envDir: workspaceRoot,
  resolve: {
    alias: {
      '@zcomponent/core': path.resolve(appRoot, 'src/mocks/zcomponent-core.ts'),
      '@zcomponent/three/lib/components/Group': path.resolve(appRoot, 'src/mocks/zcomponent-group.ts'),
      '@zcomponent/three/lib/components/Point': path.resolve(appRoot, 'src/mocks/zcomponent-point.ts'),
      '@zcomponent/three-navigation/lib/components/NavigationRoute': path.resolve(
        appRoot,
        'src/mocks/zcomponent-navigation-route.ts',
      ),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    open: true,
  },
  preview: {
    // Render / container-friendly bind
    host: '0.0.0.0',
    port: Number(process.env.PORT) || 4173,
    strictPort: true,
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: path.join(workspaceRoot, 'dist/3d-view'),
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    cssCodeSplit: true,
    chunkSizeWarningLimit: 800,
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        // Stable hashed names for long-cache /assets/* on Render
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
