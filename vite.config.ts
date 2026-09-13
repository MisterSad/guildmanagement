import { defineConfig } from 'vite';

export default defineConfig({
  root: './',
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
