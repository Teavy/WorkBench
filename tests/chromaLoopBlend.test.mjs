import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);

test('loop blend overlaps the edited head and tail, preserves original frames, and exports the shorter sequence', async t => {
  try { await run('ffmpeg', ['-version']); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EPERM') { t.skip('FFmpeg cannot run in this environment'); return; }
    throw error;
  }
  const sandbox = await mkdtemp(path.join(tmpdir(), 'chroma-loop-blend-'));
  const priorRoot = process.env.CHROMA_PROJECT_DIR;
  try {
    const projects = path.join(sandbox, 'projects');
    const output = path.join(sandbox, 'output');
    const id = randomUUID();
    const projectDir = path.join(projects, id);
    const framesDir = path.join(projectDir, 'frames');
    await mkdir(framesDir, { recursive: true });
    await mkdir(output);
    const colors = ['red@0.5', 'red@0.5', 'green', 'green', 'green', 'green', 'blue', 'blue'];
    for (const [index, color] of colors.entries()) {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=16x16,format=rgba`, '-frames:v', '1', path.join(framesDir, `${String(index + 1).padStart(6, '0')}.png`)]);
    }
    const original = Array.from({ length: colors.length }, (_, index) => ({ frame: index + 1 }));
    await writeFile(path.join(projectDir, 'project.json'), JSON.stringify({ version: 1, id, name: 'clip.mp4', status: 'ready', frameCount: 8, width: 16, height: 16, slots: original, config: { fps: 20 }, updatedAt: new Date().toISOString() }));
    process.env.CHROMA_PROJECT_DIR = projects;
    const { blendBetween, blendLoop, undoLoopBlend, updateProject, readProject, readFrame, exportProject } = await import(`../chroma/frameProjects.mjs?test=${id}`);
    if (priorRoot === undefined) delete process.env.CHROMA_PROJECT_DIR;
    else process.env.CHROMA_PROJECT_DIR = priorRoot;

    await assert.rejects(blendLoop(id, 4), /Choose 1–3 overlap frames/);
    const blended = await blendLoop(id, 2);
    assert.equal(blended.frameCount, 8);
    assert.equal(blended.blendFrameCount, 2);
    assert.deepEqual(blended.derivedFrameKinds, ['loop', 'loop']);
    assert.deepEqual(blended.slots, [{ frame: 3 }, { frame: 4 }, { frame: 5 }, { frame: 6 }, { frame: 9 }, { frame: 10 }]);
    assert.deepEqual(blended.loopBlendUndo, original);
    assert.deepEqual((await readProject(id)).slots, blended.slots);
    assert.ok((await readFrame(id, 9)).readable);
    const derived = path.join(framesDir, 'derived', '000001.png');
    const pixels = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', derived, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
    const [red, , blue, alpha] = pixels.stdout.subarray(0, 4);
    assert.ok(alpha > 195 && alpha < 225, `Expected semi-transparent blend, got alpha ${alpha}`);
    assert.ok(red > 35 && red < 70 && blue > 185, `Expected premultiplied-alpha color without a dark fringe, got RGBA ${[red, pixels.stdout[1], blue, alpha]}`);

    const editedPng = await exportProject(id, 'png', 1, output, 'edited');
    const originalPng = await exportProject(id, 'png', 1, output, 'original');
    assert.equal(editedPng.frameCount, 6);
    assert.equal(originalPng.frameCount, 8);
    assert.equal((await readdir(editedPng.path)).length, 6);
    assert.deepEqual(await readFile(path.join(editedPng.path, '000005.png')), await readFile(derived));
    assert.deepEqual(await readFile(path.join(originalPng.path, '000001.png')), await readFile(path.join(framesDir, '000001.png')));
    const atlas = await exportProject(id, 'atlas', 2, output, 'edited');
    assert.equal(atlas.frameCount, 6);
    assert.equal(atlas.columns, 3);
    const webp = await exportProject(id, 'webp', 1, output, 'edited');
    assert.equal(webp.frameCount, 6);

    const restored = await undoLoopBlend(id);
    assert.deepEqual(restored.slots, original);
    assert.equal(restored.loopBlendUndo, null);
    assert.equal(restored.blendFrameCount, 0);
    assert.deepEqual(restored.derivedFrameKinds, []);
    assert.deepEqual(await readdir(path.join(framesDir, 'derived')), []);
    await assert.rejects(undoLoopBlend(id), /can no longer be undone/);
    const second = await blendLoop(id, 1);
    assert.equal(second.slots.length, 7);
    assert.deepEqual(second.derivedFrameKinds, ['loop']);
    const changed = await updateProject(id, second.slots);
    assert.equal(changed.loopBlendUndo, null);
    await assert.rejects(blendBetween(id, 2, 2, 2), /Select two different/);
    await assert.rejects(blendBetween(id, 1, 4, 61), /Choose 1–60/);
    const beforePair = changed.slots.map(slot => ({ ...slot }));
    const pair = await blendBetween(id, 1, 4, 2);
    assert.equal(pair.slots.length, beforePair.length + 2);
    assert.deepEqual(pair.slots.slice(0, 2), beforePair.slice(0, 2));
    assert.deepEqual(pair.slots.slice(2, 4), [{ frame: 10 }, { frame: 11 }]);
    assert.deepEqual(pair.slots.slice(4), beforePair.slice(2), 'Nonadjacent original slots remain in their order.');
    assert.equal(pair.blendUndoCount, 2);
    assert.deepEqual(pair.derivedFrameKinds, ['loop', 'pair', 'pair']);
    assert.deepEqual((await readProject(id)).derivedFrameKinds, ['loop', 'pair', 'pair']);
    assert.deepEqual((await readProject(id)).slots, pair.slots, 'Inserted blends persist after reload.');
    assert.equal((await exportProject(id, 'png', 1, output, 'edited')).frameCount, 9);
    assert.equal((await exportProject(id, 'webp', 1, output, 'edited')).frameCount, 9);
    assert.equal((await exportProject(id, 'atlas', 3, output, 'edited')).columns, 3);
    assert.equal((await exportProject(id, 'png', 1, output, 'original')).frameCount, 8);
    const pairRestored = await undoLoopBlend(id);
    assert.deepEqual(pairRestored.slots, beforePair);
    assert.equal(pairRestored.blendFrameCount, 1, 'Undo removes only the newly inserted derived images.');
    assert.deepEqual(pairRestored.derivedFrameKinds, ['loop']);
    assert.deepEqual(await readdir(path.join(framesDir, 'derived')), ['000001.png']);
    const adjacent = await blendBetween(id, 2, 3, 1);
    assert.equal(adjacent.slots.length, beforePair.length + 1);
    assert.deepEqual(adjacent.derivedFrameKinds, ['loop', 'pair']);
    assert.deepEqual(adjacent.slots.slice(2, 5), [beforePair[2], { frame: 10 }, beforePair[3]]);
  } finally {
    if (priorRoot === undefined) delete process.env.CHROMA_PROJECT_DIR;
    else process.env.CHROMA_PROJECT_DIR = priorRoot;
    if (path.dirname(path.resolve(sandbox)) === path.resolve(tmpdir())) await rm(sandbox, { recursive: true, force: true });
  }
});
