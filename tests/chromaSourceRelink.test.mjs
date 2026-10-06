import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);

test('a renamed identical MP4 relinks without discarding the saved project', async t => {
  try { await run('ffmpeg', ['-version']); await run('ffprobe', ['-version']); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EPERM') { t.skip('FFmpeg and FFprobe are required'); return; }
    throw error;
  }
  const sandbox = await mkdtemp(path.join(tmpdir(), 'chroma-relink-'));
  const priorRoot = process.env.CHROMA_PROJECT_DIR;
  try {
    const original = path.join(sandbox, 'original.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=16x16:d=0.2', '-c:v', 'mpeg4', original]);
    const bytes = await readFile(original);
    process.env.CHROMA_PROJECT_DIR = path.join(sandbox, 'projects');
    const { createProject, listProjects, readProject, relinkProjectSource, uploadProjectSource } = await import(`../chroma/frameProjects.mjs?test=${randomUUID()}`);
    const project = await createProject('original.mp4', {}, '', false, true);
    await uploadProjectSource(project.id, Readable.from(bytes));
    const projectDir = path.join(process.env.CHROMA_PROJECT_DIR, project.id);
    const metadata = path.join(projectDir, 'project.json');
    const saved = await readProject(project.id);
    saved.status = 'ready';
    saved.frameCount = 2;
    saved.slots = [{ frame: 2 }, { frame: null }, { frame: 1 }];
    saved.sourceSha256 = null;
    await writeFile(metadata, JSON.stringify(saved));
    assert.equal((await listProjects())[0].sourceMissing, false);
    assert.match((await readProject(project.id)).sourceSha256, /^[a-f0-9]{64}$/);
    await rm(path.join(projectDir, 'source.mp4'));
    assert.equal((await listProjects())[0].sourceMissing, true);
    await assert.rejects(relinkProjectSource(project.id, Readable.from(Buffer.from('different video'))), /does not match/);
    assert.equal((await listProjects())[0].sourceMissing, true);
    assert.deepEqual((await readProject(project.id)).slots, saved.slots);
    await relinkProjectSource(project.id, Readable.from(bytes));
    assert.equal((await listProjects())[0].sourceMissing, false);
    assert.deepEqual(await readFile(path.join(projectDir, 'source.mp4')), bytes);
    const restored = await readProject(project.id);
    assert.equal(restored.name, 'original.mp4');
    assert.equal(restored.status, 'ready');
    assert.deepEqual(restored.slots, saved.slots);
    assert.equal((await readdir(projectDir)).some(name => name.endsWith('.upload')), false);
  } finally {
    if (priorRoot === undefined) delete process.env.CHROMA_PROJECT_DIR;
    else process.env.CHROMA_PROJECT_DIR = priorRoot;
    if (path.dirname(path.resolve(sandbox)) === path.resolve(tmpdir())) await rm(sandbox, { recursive: true, force: true });
  }
});
