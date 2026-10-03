import type { Plugin } from 'vite';
import { chromaHandler } from './chroma/server.mjs';

export const chromaPlugin = (): Plugin => ({
  name: 'local-chroma',
  configureServer(server) {
    server.middlewares.use('/api/chroma', chromaHandler);
  },
  configurePreviewServer(server) {
    server.middlewares.use('/api/chroma', chromaHandler);
  },
});
