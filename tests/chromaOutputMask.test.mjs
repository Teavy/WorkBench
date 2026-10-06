import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const run = promisify(execFile);
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function chunk(type, data) {
  const kind = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([kind, data])) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, kind, data, trailer]);
}
function maskPng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    raw.set([255, 255, 255, x < 6 ? 255 : x < 10 ? 128 : 0], offset);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
async function pixels(file) {
  const result = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
  return result.stdout;
}

test('one saved output mask applies to every frame and export format without modifying the source pool', async t => {
  try { await run('ffmpeg', ['-version']); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EPERM') { t.skip('FFmpeg cannot run in this environment'); return; }
    throw error;
  }
  const sandbox = await mkdtemp(path.join(tmpdir(), 'chroma-output-mask-'));
  const priorRoot = process.env.CHROMA_PROJECT_DIR;
  try {
    const projects = path.join(sandbox, 'projects');
    const output = path.join(sandbox, 'output');
    const id = randomUUID();
    const projectDir = path.join(projects, id);
    const framesDir = path.join(projectDir, 'frames');
    await mkdir(framesDir, { recursive: true });
    await mkdir(output);
    for (let frame = 1; frame <= 2; frame++) await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=16x16,format=rgba', '-frames:v', '1', path.join(framesDir, `${String(frame).padStart(6, '0')}.png`)]);
    await writeFile(path.join(projectDir, 'project.json'), JSON.stringify({ version: 1, id, name: 'clip.mp4', status: 'ready', frameCount: 2, width: 16, height: 16, slots: [{ frame: 1 }, { frame: 2 }], config: { fps: 20 }, updatedAt: new Date().toISOString() }));
    process.env.CHROMA_PROJECT_DIR = projects;
    const { uploadProjectMask, readProjectMask, deleteProjectMask, exportProject } = await import(`../chroma/frameProjects.mjs?mask=${id}`);
    if (priorRoot === undefined) delete process.env.CHROMA_PROJECT_DIR;
    else process.env.CHROMA_PROJECT_DIR = priorRoot;
    const sourceBefore = await readFile(path.join(framesDir, '000001.png'));
    const mask = maskPng(16, 16);
    await uploadProjectMask(id, Readable.from([mask]));
    assert.equal((await readProjectMask(id)).size, mask.length);
    const png = await exportProject(id, 'png', 1, output, 'edited');
    assert.equal(png.frameCount, 2);
    for (const frame of ['000001.png', '000002.png']) {
      const rgba = await pixels(path.join(png.path, frame));
      assert.equal(rgba[(2 * 4) + 3], 255, 'Unpainted pixels remain opaque.');
      assert.ok(Math.abs(rgba[(8 * 4) + 3] - 128) <= 2, 'Soft mask pixels keep partial alpha.');
      assert.equal(rgba[(12 * 4) + 3], 0, 'Erased pixels become transparent.');
    }
    assert.equal((await exportProject(id, 'webp', 1, output, 'edited')).frameCount, 2);
    assert.equal((await exportProject(id, 'atlas', 1, output, 'edited')).columns, 2);
    assert.deepEqual(await readFile(path.join(framesDir, '000001.png')), sourceBefore);
    await deleteProjectMask(id);
    assert.equal(await readProjectMask(id), null);
    const unmasked = await exportProject(id, 'png', 1, output, 'original');
    assert.equal((await pixels(path.join(unmasked.path, '000001.png')))[(12 * 4) + 3], 255);
  } finally {
    if (priorRoot === undefined) delete process.env.CHROMA_PROJECT_DIR;
    else process.env.CHROMA_PROJECT_DIR = priorRoot;
    if (path.dirname(path.resolve(sandbox)) === path.resolve(tmpdir())) await rm(sandbox, { recursive: true, force: true });
  }
});
