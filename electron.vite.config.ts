import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts'), agent: resolve('src/agent/index.ts') },
        output: { entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } },
  },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer') } },
    plugins: [react(), tailwindcss()],
  },
});
