import { defineConfig } from 'vite';
// one chunk: three.js's WebGPU build is most of it, and the page needs all of it at once
export default defineConfig({ base: './', build: { chunkSizeWarningLimit: 1200 } });
