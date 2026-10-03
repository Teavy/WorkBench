import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const jobsRoot = path.resolve(process.cwd(), '.view-jobs');
const maxBodyBytes = 16 * 1024 * 1024;
const imageTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new Error('Image is too large (maximum request size: 16 MB).');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const isCamera = (value: unknown): value is { azimuth: number; elevation: number; distance: number } => {
  if (!value || typeof value !== 'object') return false;
  const camera = value as Record<string, unknown>;
  return typeof camera.azimuth === 'number' && Number.isFinite(camera.azimuth)
    && camera.azimuth >= -180 && camera.azimuth <= 180
    && typeof camera.elevation === 'number' && Number.isFinite(camera.elevation)
    && camera.elevation >= -90 && camera.elevation <= 90
    && typeof camera.distance === 'number' && Number.isFinite(camera.distance)
    && camera.distance >= 0.5 && camera.distance <= 2;
};

const installJobsMiddleware = (server: { middlewares: { use: (path: string, handler: (...args: any[]) => void) => void } }) => {
    server.middlewares.use('/api/jobs', async (req, res, next) => {
      try {
        const pathname = new URL(req.url || '/', 'http://localhost').pathname;
        if (req.method === 'POST' && pathname === '/') {
          const body = await readBody(req) as Record<string, unknown>;
          const image = typeof body.image === 'string' ? body.image : '';
          const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image);
          const validCategory = ['character', 'object', 'building', 'interior'].includes(String(body.category));
          const mode = body.mode === 'auto' ? 'auto' : body.mode === 'manual' || body.mode === undefined ? 'manual' : null;
          if (!match || !isCamera(body.camera) || !validCategory || !mode || (mode === 'manual' && !isCamera(body.sourceCamera))) {
            return sendJson(res, 400, { error: 'Provide an image, valid view settings, and a content type.' });
          }
          const bytes = Buffer.from(match[2], 'base64');
          if (bytes.length === 0 || bytes.length > 12 * 1024 * 1024) {
            return sendJson(res, 400, { error: 'Image must be between 1 byte and 12 MB.' });
          }
          const id = randomUUID();
          const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
          const directory = path.join(jobsRoot, id);
          await mkdir(directory, { recursive: true });
          await writeFile(path.join(directory, `input.${extension}`), bytes);
          await writeFile(path.join(directory, 'request.json'), JSON.stringify({
            id,
            createdAt: new Date().toISOString(),
            input: `input.${extension}`,
            mode,
            ...(mode === 'manual' ? { sourceCamera: body.sourceCamera } : {}),
            camera: body.camera,
            category: body.category,
            prompt: typeof body.prompt === 'string' ? body.prompt.slice(0, 5000) : '',
          }, null, 2));
          return sendJson(res, 201, { id, status: 'queued' });
        }

        const match = /^\/([a-f0-9-]{36})(?:\/(input|output))?$/.exec(pathname);
        if (req.method !== 'GET' || !match) return next();
        const [, id, asset] = match;
        const directory = path.join(jobsRoot, id);
        const request = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8'));
        const result = await readFile(path.join(directory, 'result.json'), 'utf8')
          .then((value) => JSON.parse(value))
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
        if (!asset) return sendJson(res, 200, { ...request, status: result ? 'complete' : 'queued', result });
        const file = asset === 'input' ? request.input : result?.output;
        if (!file || !/^(input|output)\.(png|jpg|webp)$/.test(file)) {
          return sendJson(res, 404, { error: 'Image is not ready.' });
        }
        const data = await readFile(path.join(directory, file));
        res.writeHead(200, {
          'Content-Type': imageTypes[file.split('.').pop()!],
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
        });
        return res.end(data);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        const status = /ENOENT/.test(String(error)) ? 404 : error instanceof SyntaxError ? 400 : 500;
        return sendJson(res, status, { error: message });
      }
    });
};

export const localJobsPlugin = (): Plugin => ({
  name: 'local-view-jobs',
  configureServer: installJobsMiddleware,
  configurePreviewServer: installJobsMiddleware,
});
