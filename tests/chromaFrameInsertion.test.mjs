import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

test('edited sequence can insert blank slots beyond the source frame count', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'chroma-frame-insert-'));
  const priorRoot = process.env.CHROMA_PROJECT_DIR;
  try {
    const id = randomUUID();
    const projects = path.join(sandbox, 'projects');
    const projectDir = path.join(projects, id);
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'project.json'), JSON.stringify({ version: 1, id, name: 'clip.mp4', status: 'ready', frameCount: 2, width: 16, height: 16, slots: [{ frame: 1 }, { frame: 2 }], config: { fps: 20 } }));
    process.env.CHROMA_PROJECT_DIR = projects;
    const { updateProject, readProject } = await import(`../chroma/frameProjects.mjs?test=${id}`);
    if (priorRoot === undefined) delete process.env.CHROMA_PROJECT_DIR;
    else process.env.CHROMA_PROJECT_DIR = priorRoot;

    const slots = [{ frame: null }, { frame: 1 }, { frame: null }, { frame: 2 }];
    const updated = await updateProject(id, slots);
    assert.equal(updated.frameCount, 2);
    assert.deepEqual(updated.slots, slots);
    assert.deepEqual((await readProject(id)).slots, slots);
    await assert.rejects(updateProject(id, [{ frame: 3 }]), /Invalid source frame selection/);
    await assert.rejects(updateProject(id, Array.from({ length: 10003 }, () => ({ frame: null }))), /between 1 and 10002 frames/);
  } finally {
    if (priorRoot === undefined) delete process.env.CHROMA_PROJECT_DIR;
    else process.env.CHROMA_PROJECT_DIR = priorRoot;
    if (path.dirname(path.resolve(sandbox)) === path.resolve(tmpdir())) await rm(sandbox, { recursive: true, force: true });
  }
});
