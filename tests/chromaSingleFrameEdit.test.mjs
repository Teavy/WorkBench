import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);

test('single-frame transform and fixed canvas mask affect only the edited slot and survive a copy', async t => {
  try { await run('ffmpeg', ['-version']); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'EPERM') { t.skip('FFmpeg cannot run here'); return; } throw error; }
  const sandbox = await mkdtemp(path.join(tmpdir(), 'chroma-single-frame-'));
  const priorRoot = process.env.CHROMA_PROJECT_DIR;
  try {
    const root = path.join(sandbox, 'projects');
    const output = path.join(sandbox, 'output');
    const id = randomUUID();
    const directory = path.join(root, id);
    const frames = path.join(directory, 'frames');
    await mkdir(frames, { recursive: true });
    await mkdir(output);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=16x16,format=rgba', '-frames:v', '1', path.join(frames, '000001.png')]);
    const maskFile = path.join(sandbox, 'mask.png');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=16x16,format=rgba,drawbox=x=6:y=6:w=4:h=4:color=black@0:t=fill:replace=1', '-frames:v', '1', maskFile]);
    await writeFile(path.join(directory, 'project.json'), JSON.stringify({ version: 1, id, name: 'clip.mp4', status: 'ready', frameCount: 1, width: 16, height: 16, slots: [{ frame: 1 }, { frame: 1 }], config: { fps: 20 }, updatedAt: new Date().toISOString() }));
    process.env.CHROMA_PROJECT_DIR = root;
    const { uploadFrameMask, updateProject, readProject, exportProject, blendBetween, readFrame } = await import(`../chroma/frameProjects.mjs?test=${id}`);
    if (priorRoot === undefined) delete process.env.CHROMA_PROJECT_DIR;
    else process.env.CHROMA_PROJECT_DIR = priorRoot;

    const { maskId } = await uploadFrameMask(id, Readable.from([await readFile(maskFile)]));
    const edit = { x: .25, y: 0, zoom: 1, maskId };
    const saved = await updateProject(id, [{ frame: 1, edit }, { frame: 1 }]);
    assert.deepEqual(saved.slots[0].edit, edit);
    assert.equal(saved.slots[1].edit, undefined);
    assert.deepEqual((await readProject(id)).slots, saved.slots);
    const edited = await exportProject(id, 'png', 1, output, 'edited');
    const original = await exportProject(id, 'png', 1, output, 'original');
    const pixels = async file => (await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })).stdout;
    const editedFirst = await pixels(path.join(edited.path, '000001.png'));
    const editedSecond = await pixels(path.join(edited.path, '000002.png'));
    const originalFirst = await pixels(path.join(original.path, '000001.png'));
    const alpha = (buffer, x, y) => buffer[(y * 16 + x) * 4 + 3];
    assert.equal(alpha(editedFirst, 1, 8), 0, 'Moving right leaves the left canvas edge transparent.');
    assert.equal(alpha(editedFirst, 7, 8), 0, 'The fixed center mask erases the moved image at the canvas center.');
    assert.equal(alpha(editedFirst, 12, 8), 255);
    assert.equal(alpha(editedSecond, 7, 8), 255, 'A second slot using the same PNG is independent.');
    assert.equal(alpha(originalFirst, 7, 8), 255, 'Original export remains untouched.');
    const webp = await exportProject(id, 'webp', 1, output, 'edited');
    const atlas = await exportProject(id, 'atlas', 1, output, 'edited');
    assert.equal(webp.frameCount, 2);
    assert.equal(atlas.columns, 2);
    const atlasPixels = await pixels(atlas.path);
    assert.equal(atlasPixels[(8 * 32 + 7) * 4 + 3], 0, 'Atlas includes the first slot mask.');
    assert.equal(atlasPixels[(8 * 32 + 23) * 4 + 3], 255, 'Atlas keeps the other slot untouched.');
    const copied = await updateProject(id, [...saved.slots, { ...saved.slots[0], edit: { ...edit } }]);
    assert.deepEqual(copied.slots[2].edit, edit);
    const changedCopy = await updateProject(id, [...copied.slots.slice(0, 2), { frame: 1, edit: { x: 0, y: 0, zoom: .5, maskId: null } }]);
    assert.equal(changedCopy.slots[0].edit.x, .25);
    assert.equal(changedCopy.slots[2].edit.x, 0);
    const zoomed = await exportProject(id, 'png', 1, output, 'edited');
    const zoomedCopy = await pixels(path.join(zoomed.path, '000003.png'));
    assert.equal(alpha(zoomedCopy, 1, 8), 0, 'Zooming out reveals transparent canvas around the image.');
    assert.equal(alpha(zoomedCopy, 8, 8), 255);
    const blended = await blendBetween(id, 0, 1, 1);
    assert.equal(blended.slots[1].frame, 2);
    assert.ok((await readFrame(id, 2)).readable);
    const blendPixels = await pixels(path.join(frames, 'derived', '000001.png'));
    assert.ok(alpha(blendPixels, 1, 8) > 90 && alpha(blendPixels, 1, 8) < 170, 'Blend uses the edited endpoint rather than its untouched PNG.');
  } finally {
    if (priorRoot === undefined) delete process.env.CHROMA_PROJECT_DIR;
    else process.env.CHROMA_PROJECT_DIR = priorRoot;
    if (path.dirname(path.resolve(sandbox)) === path.resolve(tmpdir())) await rm(sandbox, { recursive: true, force: true });
  }
});
