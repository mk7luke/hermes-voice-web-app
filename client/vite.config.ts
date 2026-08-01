import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  base: '/',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    // `npm run dev:client` proxies API calls to the Fastify server so the
    // browser sees one origin and cookies behave as they do in production.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
});
