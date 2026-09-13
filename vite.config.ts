import { defineConfig, type Plugin } from 'vite';
import { build as esbuildBuild } from 'esbuild';

interface MinimalRequest {
  url?: string;
}

interface MinimalResponse {
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

/**
 * Dev-only parity for the service worker. In production `dist/sw.js` is emitted
 * by `scripts/build.js` (esbuild), but the Striangler invariant forbids a root
 * `sw.js`, so the root dev server has nothing to serve at `/sw.js`. This plugin
 * compiles `src/sw/service-worker.ts` (bundled, classic IIFE — the same output
 * shape as the build) on demand so push registration works in `vite dev`.
 */
function serviceWorkerDevPlugin(): Plugin {
  return {
    name: 'fgf-service-worker-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const request = req as unknown as MinimalRequest;
        const response = res as unknown as MinimalResponse;
        const url = request.url ? request.url.split('?')[0] : '';
        if (url !== '/sw.js') {
          next();
          return;
        }
        void (async () => {
          try {
            const result = await esbuildBuild({
              entryPoints: [`${server.config.root}/src/sw/service-worker.ts`],
              bundle: true,
              write: false,
              format: 'iife',
              target: 'es2022',
              logLevel: 'silent',
            });
            response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            response.setHeader('Cache-Control', 'no-cache');
            response.end(result.outputFiles?.[0]?.text ?? '');
          } catch (err) {
            next(err instanceof Error ? err : new Error(String(err)));
          }
        })();
      });
    },
  };
}

export default defineConfig({
  root: './',
  plugins: [serviceWorkerDevPlugin()],
  build: {
    outDir: 'dist',
    // Source maps disabled for production: the post-cutover invariant is that
    // no `app.js` reference survives in the shipped bundle (index.html/dist).
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 3000,
    open: true,
  },
});