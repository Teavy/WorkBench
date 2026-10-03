import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { localJobsPlugin } from './localJobsPlugin';
import { chromaPlugin } from './chromaPlugin';

export default defineConfig({
  server: { port: 3000, host: '127.0.0.1' },
  preview: { port: 4173, host: '127.0.0.1' },
  plugins: [react(), localJobsPlugin(), chromaPlugin()],
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
});
