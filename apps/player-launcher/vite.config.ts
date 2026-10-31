import { defineConfig } from 'vite';

export default defineConfig({
    base: './',
    build: { assetsInlineLimit: 4096, sourcemap: false },
});
