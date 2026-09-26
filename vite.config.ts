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
 * by `scripts/build.js` (esbuild), but the Strangler invariant forbids a root
 * `sw.js`, so the root dev server has nothing to serve at `/sw.js`. This plugin
 * compiles `src/sw/service-worker.ts` (bundled, classic IIFE — the same output
 * shape as the build) on demand.
 *
 * Since the PWA was retired that worker is a self-destructing tombstone, so what
 * this keeps working in `vite dev` is the *unregistration* path, not push. Keep
 * it until `src/sw/` itself is deleted.
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

/**
 * Trims the Phosphor icon `@font-face` to the only format any supported browser
 * will ever fetch, and stops hiding the icons while it loads.
 *
 * The package declares four sources — woff2, woff, ttf and svg. Vite resolves
 * every `url()` it finds, so all four were emitted into `dist/assets`: 3.97 MB
 * of woff/ttf/svg (the SVG alone is 2.9 MB) that no browser downloads, since
 * woff2 is first in the list and universally supported. It cost nothing in user
 * bandwidth but bloated every deploy.
 *
 * It also ships `font-display: block`, which means each `.ph` icon renders as
 * *nothing* — not a fallback glyph — until the 147 kB woff2 arrives. `swap` is
 * the right trade for an icon font used in navigation and buttons.
 *
 * Rewriting the stylesheet is preferable to vendoring a copy of it: the 1,530
 * icon rules stay owned by the package and keep updating with it.
 */
function phosphorFontTrimPlugin(): Plugin {
  return {
    name: 'fgf-phosphor-font-trim',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@phosphor-icons/web') || !id.endsWith('.css')) return null;
      if (!code.includes('@font-face')) return null;

      const trimmed = code
        .replace(
          /src:\s*[^;]*;/,
          'src: url("./Phosphor.woff2") format("woff2");'
        )
        .replace(/font-display:\s*block;/, 'font-display: swap;');

      return trimmed === code ? null : { code: trimmed, map: null };
    },
  };
}

export default defineConfig({
  root: './',
  plugins: [serviceWorkerDevPlugin(), phosphorFontTrimPlugin()],
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