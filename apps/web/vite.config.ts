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
  // @fraudguard/contracts compiles to CommonJS (shared with the NestJS
  // backend, which deliberately stays CommonJS — tsconfig.base.json's own
  // doc comment). Rollup's production build can't statically see named
  // exports through a workspace-linked CJS package's `__exportStar`
  // pattern unless told to interop it explicitly; esbuild (used in dev)
  // already handles this transparently. (Resolving straight to TS source
  // instead was tried and reverted — contracts' Kafka event-id helper
  // imports node:crypto, which Rollup refuses to bind against even for an
  // unreachable branch when it sees real source; dist's compiled
  // `require("crypto")` is lenient about it since it's never called.)
  optimizeDeps: {
    include: ['@fraudguard/contracts'],
  },
  build: {
    commonjsOptions: {
      include: [/contracts/, /node_modules/],
    },
  },
});
