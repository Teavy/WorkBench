import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfig } from './config.mjs';
import { convertVideo, previewFrame, probeVideo } from './ffmpeg.mjs';
import { createJobDirectory, defaultOutputDirectory, removeJobDirectory, safeOutputName, saveWebpToDownloads, validateOutputDirectory } from './files.mjs';
import { openDirectory, pickOutputDirectory, revealFile } from './shell.mjs';

const jobs = new Map();
const savedFiles = new Set();
const maxVideoBytes = 1024 * 1024 * 1024;
const maxPreviewBytes = 20 * 1024 * 1024;
const ttlMs = 60 * 60 * 1000;

// Recover temporary folders left by an interrupted process on a later launch.
void readdir(tmpdir(), { withFileTypes: true }).then(async entries => {
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('codex-chroma-')) continue;
    const directory = path.join(tmpdir(), entry.name);
    const info = await stat(directory).catch(() => null);
    if (info && Date.now() - info.mtimeMs > ttlMs) await removeJobDirectory(directory).catch(() => {});
  }
}).catch(() => {});

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function body(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function cleanup(job) {
  if (!job || job.cleaning) return;
  job.cleaning = true;
  job.controller.abort();
  jobs.delete(job.id);
  await removeJobDirectory(job.directory);
}

const expiry = setInterval(() => {
  for (const job of jobs.values()) {
    if (Date.now() - job.createdAt > ttlMs) cleanup(job).catch(() => {});
  }
}, 60_000);
expiry.unref();

async function processJob(job) {
  let converted = false;
  try {
    job.status = 'probing';
    const video = await probeVideo(job.source, job.controller.signal);
    job.duration = video.duration;
    job.status = 'converting';
    await convertVideo(job.source, job.output, job.config, video, value => { job.progress = value; }, job.controller.signal, job.preview);
    job.progress = 100;
    converted = true;
  } catch (error) {
    if (job.status !== 'cancelled') {
      job.status = 'error';
      job.error = error instanceof Error ? error.message : String(error);
    }
  } finally {
    await rm(job.source, { force: true }).catch(() => {});
    if (converted && job.status !== 'cancelled') job.status = 'done';
  }
}

export async function chromaHandler(req, res, next = () => json(res, 404, { error: 'Endpoint not found.' })) {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  try {
    if (pathname === '/preview' && req.method === 'POST') {
      const url = new URL(req.url, 'http://localhost');
      const config = parseConfig(JSON.parse(url.searchParams.get('config') || '{}'));
      const png = await body(req, maxPreviewBytes);
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Preview requires a PNG frame.');
      const result = await previewFrame(png, config);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': result.length, 'Cache-Control': 'no-store' });
      return res.end(result);
    }
    if (pathname === '/output-directory' && req.method === 'GET') return json(res, 200, { path: defaultOutputDirectory() });
    if (pathname === '/output-directory' && req.method === 'POST') {
      if (req.headers['x-chroma-save'] !== '1') return json(res, 403, { error: 'Missing local folder request header.' });
      const request = JSON.parse((await body(req, 16 * 1024)).toString());
      return json(res, 200, { path: await validateOutputDirectory(request.path) });
    }
    if (pathname === '/open-directory' && req.method === 'POST') {
      if (req.headers['x-chroma-save'] !== '1') return json(res, 403, { error: 'Missing local folder request header.' });
      const request = JSON.parse((await body(req, 16 * 1024)).toString());
      const directory = await validateOutputDirectory(request.path);
      await openDirectory(directory);
      return json(res, 200, { path: directory });
    }
    if (pathname === '/pick-directory' && req.method === 'POST') {
      if (req.headers['x-chroma-save'] !== '1') return json(res, 403, { error: 'Missing local folder request header.' });
      const request = JSON.parse((await body(req, 16 * 1024)).toString());
      const selected = await pickOutputDirectory(request.path);
      return json(res, 200, { path: selected ? await validateOutputDirectory(selected) : null });
    }
    if (pathname === '/save' && req.method === 'POST') {
      if (req.headers['x-chroma-save'] !== '1') return json(res, 403, { error: 'Missing local save request header.' });
      const url = new URL(req.url, 'http://localhost');
      const saved = await saveWebpToDownloads(req, url.searchParams.get('name'), url.searchParams.get('directory'));
      savedFiles.add(saved.path);
      return json(res, 201, saved);
    }
    if (pathname === '/reveal' && req.method === 'POST') {
      if (req.headers['x-chroma-save'] !== '1') return json(res, 403, { error: 'Missing local file request header.' });
      const request = JSON.parse((await body(req, 16 * 1024)).toString());
      if (typeof request.path !== 'string' || !savedFiles.has(request.path)) return json(res, 404, { error: 'This file has not been saved in the current session.' });
      const info = await stat(request.path).catch(() => null);
      if (!info?.isFile()) return json(res, 404, { error: 'The output file was moved or deleted.' });
      await revealFile(request.path);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/jobs' && req.method === 'POST') {
      const input = JSON.parse((await body(req, 64 * 1024)).toString());
      const config = parseConfig(input.config);
      if (typeof input.name !== 'string' || !/\.mp4$/i.test(input.name) || input.name.length > 255) throw new Error('Select an MP4 file.');
      const id = randomUUID();
      const directory = await createJobDirectory();
      const preview = input.preview === true;
      const job = { id, directory, source: path.join(directory, 'source.mp4'), output: path.join(directory, preview ? 'preview.webm' : 'output.webp'), name: safeOutputName(input.name), config, preview, controller: new AbortController(), status: 'waiting', progress: 0, error: '', createdAt: Date.now() };
      jobs.set(id, job);
      return json(res, 201, { id, name: job.name });
    }
    const match = /^\/jobs\/([a-f0-9-]{36})(?:\/(source|output))?$/.exec(pathname);
    if (!match) return next();
    const job = jobs.get(match[1]);
    if (!job) return json(res, 404, { error: 'Job expired or does not exist.' });
    const asset = match[2];
    if (!asset && req.method === 'GET') return json(res, 200, { status: job.status, progress: job.progress, name: job.name, error: job.error });
    if (!asset && req.method === 'DELETE') {
      job.status = 'cancelled';
      await cleanup(job);
      return json(res, 200, { ok: true });
    }
    if (asset === 'source' && req.method === 'PUT') {
      if (job.status !== 'waiting') return json(res, 409, { error: 'Job has already started.' });
      job.status = 'uploading';
      let total = 0;
      const limiter = new Transform({ transform(chunk, encoding, callback) {
        total += chunk.length;
        callback(total <= maxVideoBytes ? null : new Error('MP4 exceeds the 1 GB limit.'), chunk);
      } });
      try {
        await pipeline(req, limiter, createWriteStream(job.source));
      } catch (error) {
        job.status = 'error';
        job.error = error instanceof Error ? error.message : String(error);
        await rm(job.source, { force: true });
        throw error;
      }
      if (total === 0) throw new Error('MP4 file is empty.');
      void processJob(job);
      return json(res, 202, { ok: true });
    }
    if (asset === 'output' && req.method === 'GET') {
      if (job.status !== 'done') return json(res, 409, { error: 'Conversion has not finished.' });
      const { size } = await stat(job.output);
      res.writeHead(200, { 'Content-Type': job.preview ? 'video/webm' : 'image/webp', 'Content-Length': size, 'Content-Disposition': `attachment; filename="${job.preview ? 'preview.webm' : job.name}"`, 'Cache-Control': 'no-store' });
      return createReadStream(job.output).pipe(res);
    }
    return next();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) json(res, /must|select|exceed|empty|unsupported|requires|invalid|not a WebP|incomplete|folder|absolute path|cannot precede/i.test(message) ? 400 : 500, { error: message });
  }
}
