import { prepareReportRuntime } from './scripts/build/report-runtime.mjs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

prepareReportRuntime();

export default defineConfig(({ command }) => ({
  main: {
    define: { __DATA_AGENT_DEV_ROOT__: JSON.stringify(command === 'serve' ? resolve('.') : '') },
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
}));
