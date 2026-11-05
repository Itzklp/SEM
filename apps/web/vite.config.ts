import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
  },
  // @fraudguard/contracts compiles to CommonJS (it's shared with the
  // NestJS backend, which deliberately stays CommonJS — tsconfig.base
  // .json's own doc comment). Rollup's production build can't statically
  // see named exports through a workspace-linked CJS package's
  // `__exportStar` pattern unless told to interop it explicitly; esbuild
  // (used in dev) already handles this transparently, which is why only
  // `vite build`, not `vite dev`, needs this.
  optimizeDeps: {
    include: ['@fraudguard/contracts'],
  },
  build: {
    commonjsOptions: {
      include: [/contracts/, /node_modules/],
    },
  },
});
