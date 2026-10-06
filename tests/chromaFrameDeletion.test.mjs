import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);

test('deleting edited frames shortens exports while original frames remain available', async t => {
  try { await run('ffmpeg', ['-version']); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EPERM') { t.skip('FFmpeg cannot run in this environment'); return; }
    throw error;
  }
  const sandbox = await mkdtemp(path.join(tmpdir(), 'chroma-frame-delete-'));
  const priorRoot = process.env.CHROMA_PROJECT_DIR;
  try {
    const projects = path.join(sandbox, 'projects');
    const output = path.join(sandbox, 'output');
    const id = randomUUID();
    const projectDir = path.join(projects, id);
    const framesDir = path.join(projectDir, 'frames');
    await mkdir(framesDir, { recursive: true });
    await mkdir(output);
    for (const [index, color] of ['red', 'green', 'blue'].entries()) {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=16x16`, '-frames:v', '1', path.join(framesDir, `${String(index + 1).padStart(6, '0')}.png`)]);
    }
    await writeFile(path.join(projectDir, 'project.json'), JSON.stringify({ version: 1, id, name: 'clip.mp4', status: 'ready', frameCount: 3, width: 16, height: 16, slots: [{ frame: 1 }, { frame: 2 }, { frame: 3 }], config: { fps: 20 }, updatedAt: new Date().toISOString() }));
    process.env.CHROMA_PROJECT_DIR = projects;
    const { updateProject, readProject, exportProject } = await import(`../chroma/frameProjects.mjs?test=${id}`);
    if (priorRoot === undefined) delete process.env.CHROMA_PROJECT_DIR;
    else process.env.CHROMA_PROJECT_DIR = priorRoot;

    await assert.rejects(updateProject(id, []), /between 1 and 10003 frames/);
    const edited = await updateProject(id, [{ frame: 3 }, { frame: 1 }]);
    assert.equal(edited.frameCount, 3);
    assert.equal(edited.slots.length, 2);
    assert.equal((await readProject(id)).slots.length, 2);

    const editedPng = await exportProject(id, 'png', 1, output, 'edited');
    const originalPng = await exportProject(id, 'png', 1, output, 'original');
    assert.equal(editedPng.frameCount, 2);
    assert.equal(originalPng.frameCount, 3);
    assert.deepEqual(await readdir(editedPng.path), ['000001.png', '000002.png']);
    assert.deepEqual(await readdir(originalPng.path), ['000001.png', '000002.png', '000003.png']);
    assert.deepEqual(await readFile(path.join(editedPng.path, '000001.png')), await readFile(path.join(framesDir, '000003.png')));

    const atlas = await exportProject(id, 'atlas', 1, output, 'edited');
    const atlasPng = await readFile(atlas.path);
    assert.equal(atlas.frameCount, 2);
    assert.equal(atlas.columns, 2);
    assert.equal(atlasPng.readUInt32BE(16), 32);
    assert.equal(atlasPng.readUInt32BE(20), 16);

    const webp = await exportProject(id, 'webp', 1, output, 'edited');
    const { stdout } = await run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'default=noprint_wrappers=1:nokey=1', webp.path]);
    assert.equal(webp.frameCount, 2);
    assert.equal(Number(stdout.trim()), 2);
    const packetProbe = await run('ffprobe', ['-v', 'error', '-show_packets', '-show_entries', 'packet=duration_time', '-of', 'json', webp.path]);
    const packets = JSON.parse(packetProbe.stdout).packets;
    const duration = packets.reduce((total, packet) => total + Number(packet.duration_time), 0);
    assert.ok(Math.abs(duration - 2 / 20) < .01, `Expected 0.10 seconds of edited playback, got ${duration}.`);

    const restored = await updateProject(id, [{ frame: 3 }, { frame: 2 }, { frame: 1 }]);
    assert.equal(restored.slots.length, 3, 'Undo can restore a removed time slot without regenerating source frames.');
  } finally {
    if (priorRoot === undefined) delete process.env.CHROMA_PROJECT_DIR;
    else process.env.CHROMA_PROJECT_DIR = priorRoot;
    if (path.dirname(path.resolve(sandbox)) === path.resolve(tmpdir())) await rm(sandbox, { recursive: true, force: true });
  }
});
