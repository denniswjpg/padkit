import { defineConfig } from 'vite';

// Relative base so the built app works at any path on GitHub Pages
// (e.g. https://<user>.github.io/padkit/web/ or a custom domain root).
export default defineConfig({
  base: './',
  build: {
    target: 'es2021',
    // Multi-page: the main config tool plus the (stub) firmware flasher.
    rollupOptions: {
      input: {
        main: 'index.html',
        flash: 'flash.html',
      },
    },
  },
});
