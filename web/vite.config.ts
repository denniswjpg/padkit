import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2021',
    rollupOptions: {
      input: {
        main: 'index.html',
        flash: 'flash.html',
        config: 'config.html',
      },
    },
  },
});
