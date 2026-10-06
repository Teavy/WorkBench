import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { parseConfig, filterFor, outputDimensions } from './config.mjs';
import { probeVideo } from './ffmpeg.mjs';
import { safeOutputName, validateOutputDirectory } from './files.mjs';

const defaultRoot = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Codex Workbench', 'Chroma Projects')
  : path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'codex-workbench', 'chroma-projects');
const root = path.resolve(process.env.CHROMA_PROJECT_DIR || defaultRoot);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const maxVideoBytes = 1024 * 1024 * 1024;
const maxExtraEditedSlots = 10000;
const idPattern = /^[a-f0-9-]{36}$/;
const work = new Map();
async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function projectPath(id) {
  if (!idPattern.test(id)) throw new Error('Invalid project ID.');
  return path.join(root, id);
}
function metadataPath(id) { return path.join(projectPath(id), 'project.json'); }
function framePath(id, number) { return path.join(projectPath(id), 'frames', `${String(number).padStart(6, '0')}.png`); }
function derivedFramePath(id, number) { return path.join(projectPath(id), 'frames', 'derived', `${String(number).padStart(6, '0')}.png`); }
function slotPath(project, number) { return number <= project.frameCount ? framePath(project.id, number) : derivedFramePath(project.id, number - project.frameCount); }
function profilePath(id) { return path.join(projectPath(id), 'profile.json'); }
function backgroundPath(id) { return path.join(projectPath(id), 'background'); }
function maskPath(id) { return path.join(projectPath(id), 'output-mask.png'); }
const frameMaskPattern = /^[a-f0-9]{64}$/;
function frameMaskPath(id, maskId) {
  if (!frameMaskPattern.test(maskId)) throw new Error('Invalid frame mask ID.');
  return path.join(projectPath(id), 'frame-masks', `${maskId}.png`);
}
async function writeProject(project) {
  const target = metadataPath(project.id);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify(project, null, 2));
  await rename(temporary, target);
}
export async function readProject(id) {
  const project = JSON.parse(await readFile(metadataPath(id), 'utf8'));
  if (project.id !== id || project.version !== 1) throw new Error('Unsupported project data.');
  return project;
}
export async function listProjects() {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const projects = await Promise.all(entries.filter(entry => entry.isDirectory() && idPattern.test(entry.name)).map(async entry => {
    try {
      const project = await readProject(entry.name);
      if (project.temporary) {
        if (!work.has(project.id) && Date.now() - Date.parse(project.updatedAt) > 60 * 60 * 1000) await deleteTemporaryProject(project.id);
        return null;
      }
      if (['uploaded', 'generating'].includes(project.status) && !work.has(project.id)) {
        await rm(path.join(projectPath(project.id), 'frames'), { recursive: true, force: true });
        await mkdir(path.join(projectPath(project.id), 'frames'));
        work.set(project.id, generate(project));
      }
      const { id, name, status, frameCount, updatedAt } = project;
      const source = await stat(path.join(projectPath(id), 'source.mp4')).catch(() => null);
      if (source?.isFile() && !project.sourceSha256 && !work.has(project.id) && !['uploaded', 'generating'].includes(project.status)) {
        project.sourceSha256 = await fileSha256(path.join(projectPath(id), 'source.mp4'));
        project.sourceBytes = source.size;
        await writeProject(project);
      }
      return { id, name, status, frameCount, sourceBytes: source?.size || project.sourceBytes || 0, sourceMissing: !source?.isFile(), updatedAt };
    }
    catch { return null; }
  }));
  return projects.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function createProject(name, inputConfig, outputDirectory = '', temporary = false, deferGeneration = false) {
  if (typeof name !== 'string' || !/\.mp4$/i.test(name) || name.length > 255) throw new Error('Select an MP4 file.');
  const config = parseConfig(inputConfig);
  const selectedDirectory = outputDirectory ? await validateOutputDirectory(outputDirectory) : '';
  const id = randomUUID();
  await mkdir(path.join(projectPath(id), 'frames'), { recursive: true });
  const now = new Date().toISOString();
  const project = { version: 1, id, name, config, outputDirectory: selectedDirectory, temporary: temporary === true, deferGeneration: deferGeneration === true, status: 'waiting', progress: 0, error: '', frameCount: 0, blendFrameCount: 0, derivedFrameKinds: [], blendUndoCount: 0, sourceSha256: null, sourceBytes: 0, width: 0, height: 0, slots: [], createdAt: now, updatedAt: now };
  await writeProject(project);
  return project;
}
function runFfmpeg(args, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let errorText = '';
    child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).slice(-16000); onProgress(errorText); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(errorText || `FFmpeg exited with code ${code}`)));
  });
}
async function generate(project) {
  try {
    project.status = 'generating';
    await writeProject(project);
    const video = await probeVideo(path.join(projectPath(project.id), 'source.mp4'));
    const dimensions = outputDimensions(project.config, video);
    project.width = dimensions.width;
    project.height = dimensions.height;
    await runFfmpeg(['-i', path.join(projectPath(project.id), 'source.mp4'), '-an', '-vf', filterFor(project.config, video), framePath(project.id, 1).replace('000001.png', '%06d.png')]);
    const names = (await readdir(path.join(projectPath(project.id), 'frames'))).filter(name => /^\d{6}\.png$/.test(name)).sort();
    if (!names.length) throw new Error('No frames were generated for the selected interval.');
    project.frameCount = names.length;
    project.slots = names.map((_, index) => ({ frame: index + 1 }));
    project.status = 'ready';
    project.progress = 100;
    project.updatedAt = new Date().toISOString();
  } catch (error) {
    project.status = 'error';
    project.error = error instanceof Error ? error.message : String(error);
  } finally {
    await writeProject(project);
    work.delete(project.id);
  }
}
export async function uploadProjectSource(id, req) {
  const project = await readProject(id);
  if (project.status !== 'waiting') throw new Error('Project source has already been uploaded.');
  let total = 0;
  const limiter = new Transform({ transform(chunk, encoding, callback) {
    total += chunk.length;
    callback(total <= maxVideoBytes ? null : new Error('MP4 exceeds the 1 GB limit.'), chunk);
  } });
  const target = path.join(projectPath(id), 'source.mp4');
  try { await pipeline(req, limiter, createWriteStream(target)); }
  catch (error) { await rm(target, { force: true }); throw error; }
  if (!total) throw new Error('MP4 file is empty.');
  project.sourceSha256 = await fileSha256(target);
  project.sourceBytes = total;
  project.status = project.deferGeneration ? 'source-ready' : 'uploaded';
  await writeProject(project);
  if (!project.deferGeneration) {
    const promise = generate(project);
    work.set(id, promise);
  }
}
export async function replaceProjectSource(id, req, name) {
  if (typeof name !== 'string' || !/\.mp4$/i.test(name) || name.length > 255) throw new Error('Select an MP4 file.');
  const project = await readProject(id);
  if (project.status === 'waiting' || work.has(id)) throw new Error('The current source is not ready to replace.');
  const directory = projectPath(id);
  const source = path.join(directory, 'source.mp4');
  const frames = path.join(directory, 'frames');
  const suffix = randomUUID();
  const upload = path.join(directory, `source.${suffix}.upload`);
  const sourceBackup = path.join(directory, `source.${suffix}.backup`);
  const framesBackup = path.join(directory, `frames.${suffix}.backup`);
  let total = 0;
  const limiter = new Transform({ transform(chunk, encoding, callback) {
    total += chunk.length;
    callback(total <= maxVideoBytes ? null : new Error('MP4 exceeds the 1 GB limit.'), chunk);
  } });
  try {
    await pipeline(req, limiter, createWriteStream(upload));
    if (!total) throw new Error('MP4 file is empty.');
    await probeVideo(upload);
    let sourceBackedUp = false;
    let framesBackedUp = false;
    let sourceInstalled = false;
    let framesCreated = false;
    try {
      await rename(source, sourceBackup);
      sourceBackedUp = true;
      if (await stat(frames).catch(() => null)) {
        await rename(frames, framesBackup);
        framesBackedUp = true;
      }
      await rename(upload, source);
      sourceInstalled = true;
      await mkdir(frames);
      framesCreated = true;
      const updated = { ...project, name, sourceSha256: await fileSha256(source), sourceBytes: total, deferGeneration: true, status: 'source-ready', progress: 0, error: '', frameCount: 0, blendFrameCount: 0, derivedFrameKinds: [], blendUndoCount: 0, loopBlendUndo: null, width: 0, height: 0, slots: [], updatedAt: new Date().toISOString() };
      await writeProject(updated);
      await rm(maskPath(id), { force: true }).catch(() => {});
      await rm(path.join(projectPath(id), 'frame-masks'), { recursive: true, force: true }).catch(() => {});
      await rm(sourceBackup, { force: true }).catch(() => {});
      if (framesBackedUp) await rm(framesBackup, { recursive: true, force: true }).catch(() => {});
      return updated;
    } catch (error) {
      if (sourceInstalled) await rm(source, { force: true }).catch(() => {});
      if (framesCreated) await rm(frames, { recursive: true, force: true }).catch(() => {});
      if (sourceBackedUp) await rename(sourceBackup, source).catch(() => {});
      if (framesBackedUp) await rename(framesBackup, frames).catch(() => {});
      throw error;
    }
  } finally {
    await rm(upload, { force: true }).catch(() => {});
  }
}
export async function relinkProjectSource(id, req) {
  const project = await readProject(id);
  if (work.has(id) || project.status === 'waiting') throw new Error('This project is busy. Try again after it finishes.');
  const target = path.join(projectPath(id), 'source.mp4');
  if ((await stat(target).catch(() => null))?.isFile()) throw new Error('The saved source MP4 is already present.');
  if (!/^[a-f0-9]{64}$/.test(project.sourceSha256 || '')) throw new Error('This project has no saved source fingerprint, so its identity cannot be verified.');
  const upload = path.join(projectPath(id), `source.${randomUUID()}.upload`);
  let total = 0;
  const hash = createHash('sha256');
  const limiter = new Transform({ transform(chunk, encoding, callback) {
    total += chunk.length;
    if (total > maxVideoBytes) return callback(new Error('MP4 exceeds the 1 GB limit.'));
    hash.update(chunk);
    callback(null, chunk);
  } });
  try {
    await pipeline(req, limiter, createWriteStream(upload));
    if (!total || total !== project.sourceBytes || hash.digest('hex') !== project.sourceSha256) throw new Error('This MP4 does not match the saved source. Choose the original file, even if its name has changed.');
    await probeVideo(upload);
    if ((await stat(target).catch(() => null))?.isFile()) throw new Error('The saved source MP4 was restored while checking this file.');
    await rename(upload, target);
    return { ok: true, id, name: project.name, sourceBytes: total };
  } finally {
    await rm(upload, { force: true }).catch(() => {});
  }
}
export async function generateProject(id, inputConfig) {
  const project = await readProject(id);
  if (!['source-ready', 'ready', 'error'].includes(project.status)) throw new Error('Source MP4 is not ready for frame generation.');
  if (work.has(id)) throw new Error('Frame generation is already running.');
  project.config = parseConfig(inputConfig);
  project.error = '';
  project.frameCount = 0;
  project.blendFrameCount = 0;
  project.derivedFrameKinds = [];
  project.blendUndoCount = 0;
  project.loopBlendUndo = null;
  project.slots = [];
  project.status = 'generating';
  await writeProject(project);
  const frames = path.join(projectPath(id), 'frames');
  if (path.dirname(path.resolve(frames)) !== path.resolve(projectPath(id))) throw new Error('Invalid frame path.');
  await rm(frames, { recursive: true, force: true });
  await rm(path.join(projectPath(id), 'frame-masks'), { recursive: true, force: true });
  await mkdir(frames);
  const promise = generate(project);
  work.set(id, promise);
  return project;
}
export async function readProfile(id) {
  await readProject(id);
  return JSON.parse(await readFile(profilePath(id), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return 'null';
    throw error;
  }));
}
export async function saveProfile(id, data) {
  await readProject(id);
  if (!data || typeof data !== 'object' || !data.profile || !data.range) throw new Error('Invalid saved profile.');
  const serialized = JSON.stringify(data);
  if (serialized.length > 64 * 1024) throw new Error('Saved profile is too large.');
  const temporary = `${profilePath(id)}.${randomUUID()}.tmp`;
  await writeFile(temporary, serialized);
  await rename(temporary, profilePath(id));
  return { ok: true };
}
export async function uploadProjectBackground(id, req, name) {
  await readProject(id);
  if (typeof name !== 'string' || name.length > 255) throw new Error('Invalid background name.');
  let total = 0;
  const limiter = new Transform({ transform(chunk, encoding, callback) {
    total += chunk.length;
    callback(total <= 20 * 1024 * 1024 ? null : new Error('Background exceeds the 20 MB limit.'), chunk);
  } });
  const temporary = `${backgroundPath(id)}.${randomUUID()}.tmp`;
  try {
    await pipeline(req, limiter, createWriteStream(temporary));
    if (!total) throw new Error('Background image is empty.');
    await rename(temporary, backgroundPath(id));
  } catch (error) { await rm(temporary, { force: true }); throw error; }
  return { ok: true };
}
export async function readProjectBackground(id) {
  await readProject(id);
  const file = backgroundPath(id);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error('Saved background image is missing.');
  return { stream: createReadStream(file), size: info.size };
}
export async function deleteProjectBackground(id) {
  await readProject(id);
  await rm(backgroundPath(id), { force: true });
  return { ok: true };
}
export async function uploadProjectMask(id, req) {
  await readProject(id);
  let total = 0;
  const limiter = new Transform({ transform(chunk, encoding, callback) {
    total += chunk.length;
    callback(total <= 32 * 1024 * 1024 ? null : new Error('Output mask exceeds the 32 MB limit.'), chunk);
  } });
  const temporary = `${maskPath(id)}.${randomUUID()}.tmp`;
  try {
    await pipeline(req, limiter, createWriteStream(temporary));
    const png = await readFile(temporary);
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Output mask must be a PNG image.');
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (width < 16 || width > 4096 || height < 16 || height > 4096) throw new Error('Output mask dimensions must be 16–4096 pixels.');
    await rename(temporary, maskPath(id));
  } catch (error) { await rm(temporary, { force: true }); throw error; }
  return { ok: true };
}
export async function readProjectMask(id) {
  await readProject(id);
  const file = maskPath(id);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  return { stream: createReadStream(file), size: info.size };
}
export async function deleteProjectMask(id) {
  await readProject(id);
  await rm(maskPath(id), { force: true });
  return { ok: true };
}
export async function uploadFrameMask(id, req) {
  const project = await readProject(id);
  if (project.status !== 'ready') throw new Error('Project frames are not ready.');
  const png = await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => { total += chunk.length; if (total > 32 * 1024 * 1024) { reject(new Error('Frame mask exceeds the 32 MB limit.')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Frame mask must be a PNG image.');
  if (png.readUInt32BE(16) !== project.width || png.readUInt32BE(20) !== project.height) throw new Error('Frame mask dimensions must match the output canvas.');
  const maskId = createHash('sha256').update(png).digest('hex');
  const target = frameMaskPath(id, maskId);
  await mkdir(path.dirname(target), { recursive: true });
  if (!(await stat(target).catch(() => null))) await writeFile(target, png, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  return { maskId };
}
export async function readFrameMask(id, maskId) {
  await readProject(id);
  const file = frameMaskPath(id, maskId);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error('Saved frame mask is missing.');
  return { stream: createReadStream(file), size: info.size };
}
export async function updateProject(id, slots, outputDirectory) {
  const project = await readProject(id);
  if (project.status !== 'ready') throw new Error('Project frames are not ready.');
  if (work.has(id)) throw new Error('Wait for frame processing to finish.');
  const maxEditedSlots = project.frameCount + maxExtraEditedSlots;
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > maxEditedSlots) throw new Error(`Edited sequence must contain between 1 and ${maxEditedSlots} frames.`);
  project.slots = await Promise.all(slots.map(async slot => {
    const frame = slot?.frame;
    if (frame !== null && (!Number.isInteger(frame) || frame < 1 || frame > project.frameCount + (project.blendFrameCount || 0))) throw new Error('Invalid source frame selection.');
    if (slot.edit === undefined || slot.edit === null) return { frame };
    const { x, y, zoom, maskId } = slot.edit;
    if (![x, y, zoom].every(Number.isFinite) || x < -1 || x > 1 || y < -1 || y > 1 || zoom < .5 || zoom > 2 || (maskId !== null && maskId !== undefined && !frameMaskPattern.test(maskId))) throw new Error('Invalid single-frame edit.');
    if (maskId && !(await stat(frameMaskPath(id, maskId)).catch(() => null))?.isFile()) throw new Error('Saved frame mask is missing.');
    return { frame, edit: { x, y, zoom, maskId: maskId || null } };
  }));
  if (outputDirectory !== undefined) project.outputDirectory = await validateOutputDirectory(outputDirectory);
  project.loopBlendUndo = null;
  project.blendUndoCount = 0;
  project.updatedAt = new Date().toISOString();
  await writeProject(project);
  return project;
}
export async function readFrame(id, number) {
  const project = await readProject(id);
  if (project.status !== 'ready' || !Number.isInteger(number) || number < 1 || number > project.frameCount + (project.blendFrameCount || 0)) throw new Error('Frame does not exist.');
  const file = slotPath(project, number);
  if (!(await stat(file).catch(() => null))?.isFile()) throw new Error('Saved frame is missing from this project.');
  return createReadStream(file);
}
export async function readProjectSource(id) {
  const project = await readProject(id);
  const file = path.join(projectPath(id), 'source.mp4');
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error('Saved source MP4 is missing from this project.');
  return { stream: createReadStream(file), size: info.size, name: project.name };
}
export async function readProjectSourceInfo(id) {
  await readProject(id);
  const video = await probeVideo(path.join(projectPath(id), 'source.mp4'));
  const [numerator, denominator] = String(video.frameRate || '').split('/').map(Number);
  const fps = numerator > 0 && denominator > 0 ? numerator / denominator : null;
  return { ...video, fps };
}
export async function deleteProject(id, allowPersistent = false) {
  const project = await readProject(id);
  if (!project.temporary && !allowPersistent) throw new Error('Only temporary projects can be deleted through this endpoint.');
  if (work.has(id)) await work.get(id);
  const target = path.resolve(projectPath(id));
  if (path.dirname(target) !== root) throw new Error('Invalid project path.');
  await rm(target, { recursive: true, force: true });
}
export async function deleteTemporaryProject(id) { return deleteProject(id, false); }
async function availablePath(directory, stem, extension, isDirectory = false) {
  for (let index = 0; index < 1000; index++) {
    const name = `${stem}${index ? ` (${index + 1})` : ''}${extension}`;
    const target = path.join(directory, name);
    if (!(await stat(target).catch(() => null))) return { name, path: target };
  }
  throw new Error(`Too many existing ${isDirectory ? 'folders' : 'files'} with this name.`);
}
async function renderSlot(project, slot, target) {
  const { width, height } = project;
  if (slot.frame === null) {
    await runFfmpeg(['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height},format=rgba,colorchannelmixer=aa=0`, '-frames:v', '1', target]);
    return;
  }
  const source = slotPath(project, slot.frame);
  const edit = slot.edit;
  if (!edit || (edit.x === 0 && edit.y === 0 && edit.zoom === 1 && !edit.maskId)) return copyFile(source, target);
  const transformed = edit.maskId ? `${target}.transformed.png` : target;
  try {
    if (edit.x !== 0 || edit.y !== 0 || edit.zoom !== 1) {
      const scaledWidth = Math.max(1, Math.round(width * edit.zoom));
      const scaledHeight = Math.max(1, Math.round(height * edit.zoom));
      const x = Math.round(edit.x * width);
      const y = Math.round(edit.y * height);
      const filter = `[1:v]format=rgba,scale=${scaledWidth}:${scaledHeight}:flags=lanczos[fg];[0:v][fg]overlay=x=(W-w)/2+${x}:y=(H-h)/2+${y}:shortest=1:format=auto,format=rgba[out]`;
      await runFfmpeg(['-f', 'lavfi', '-i', `color=c=black@0:s=${width}x${height}:r=1,format=rgba`, '-i', source, '-filter_complex', filter, '-map', '[out]', '-frames:v', '1', transformed]);
    } else await copyFile(source, transformed);
    if (edit.maskId) await applyAlphaMask(transformed, frameMaskPath(project.id, edit.maskId), width, height, target);
  } finally {
    if (edit.maskId) await rm(transformed, { force: true }).catch(() => {});
  }
}
async function applyAlphaMask(source, mask, width, height, target) {
  const filter = `[0:v]format=rgba,split[color][sourcealpha];[sourcealpha]alphaextract[a];[1:v]scale=${width}:${height},format=rgba,alphaextract[m];[a][m]blend=all_expr='A*B/255'[combined];[color][combined]alphamerge,format=rgba[out]`;
  await runFfmpeg(['-i', source, '-i', mask, '-filter_complex', filter, '-map', '[out]', '-frames:v', '1', target]);
}
async function applyBlend(id, project, pairs, makeSlots, kind) {
  if (work.has(id)) throw new Error('Frame processing is already running.');
  if (project.status !== 'ready') throw new Error('Project frames are not ready.');
  if ((project.blendFrameCount || 0) + pairs.length > 10000) throw new Error('Too many generated blend frames in this project. Regenerate PNG frames to start a new copy.');
  const task = (async () => {
    const start = (project.blendFrameCount || 0) + 1;
    const temporary = path.join(projectPath(id), `blend-${randomUUID()}`);
    const derived = path.join(projectPath(id), 'frames', 'derived');
    const installed = [];
    await mkdir(temporary);
    try {
      for (let index = 0; index < pairs.length; index++) {
        const { from: tail, to: head, weight } = pairs[index];
        const tailPath = tail.frame === null || tail.edit ? path.join(temporary, `tail-${index}.png`) : slotPath(project, tail.frame);
        const headPath = head.frame === null || head.edit ? path.join(temporary, `head-${index}.png`) : slotPath(project, head.frame);
        if (tail.frame === null || tail.edit) await renderSlot(project, tail, tailPath);
        if (head.frame === null || head.edit) await renderSlot(project, head, headPath);
        const output = path.join(temporary, `${String(start + index).padStart(6, '0')}.png`);
        const filter = `[0:v]format=gbrap,premultiply=inplace=1[tail];[1:v]format=gbrap,premultiply=inplace=1[head];[tail][head]blend=all_expr='A*${(1 - weight).toFixed(8)}+B*${weight.toFixed(8)}',unpremultiply=inplace=1,format=rgba[out]`;
        await runFfmpeg(['-i', tailPath, '-i', headPath, '-filter_complex', filter, '-map', '[out]', '-frames:v', '1', output]);
      }
      await mkdir(derived, { recursive: true });
      for (let index = 0; index < pairs.length; index++) {
        const target = derivedFramePath(id, start + index);
        await rename(path.join(temporary, `${String(start + index).padStart(6, '0')}.png`), target);
        installed.push(target);
      }
      const previous = project.slots.map(slot => ({ ...slot }));
      const blended = Array.from({ length: pairs.length }, (_, index) => ({ frame: project.frameCount + start + index }));
      project.slots = makeSlots(previous, blended);
      project.blendFrameCount = start + pairs.length - 1;
      project.derivedFrameKinds = [...Array.from({ length: start - 1 }, (_, index) => project.derivedFrameKinds?.[index] || 'blend'), ...Array(pairs.length).fill(kind)];
      project.blendUndoCount = pairs.length;
      project.loopBlendUndo = previous;
      project.updatedAt = new Date().toISOString();
      await writeProject(project);
      return project;
    } catch (error) {
      await Promise.all(installed.map(file => rm(file, { force: true }).catch(() => {})));
      throw error;
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  })();
  work.set(id, task);
  try { return await task; } finally { work.delete(id); }
}
export async function blendLoop(id, overlap) {
  const project = await readProject(id);
  const count = project.slots.length;
  const maxOverlap = Math.min(60, Math.floor((count - 1) / 2));
  if (!Number.isInteger(overlap) || overlap < 1 || overlap > maxOverlap) throw new Error(`Choose 1–${maxOverlap} overlap frames.`);
  const pairs = Array.from({ length: overlap }, (_, index) => ({
    from: project.slots[count - overlap + index],
    to: project.slots[index],
    weight: (index + 1) / (overlap + 1),
  }));
  return applyBlend(id, project, pairs, (previous, blended) => [...previous.slice(overlap, count - overlap), ...blended], 'loop');
}
export async function blendBetween(id, firstIndex, secondIndex, steps) {
  const project = await readProject(id);
  const count = project.slots.length;
  if (!Number.isInteger(firstIndex) || !Number.isInteger(secondIndex) || firstIndex < 0 || secondIndex <= firstIndex || secondIndex >= count) throw new Error('Select two different frame slots in timeline order.');
  if (!Number.isInteger(steps) || steps < 1 || steps > 60) throw new Error('Choose 1–60 inserted transition frames.');
  if (count + steps > project.frameCount + maxExtraEditedSlots) throw new Error('The edited sequence is too long to insert more frames.');
  const pairs = Array.from({ length: steps }, (_, index) => ({
    from: project.slots[firstIndex],
    to: project.slots[secondIndex],
    weight: (index + 1) / (steps + 1),
  }));
  return applyBlend(id, project, pairs, (previous, blended) => [...previous.slice(0, firstIndex + 1), ...blended, ...previous.slice(firstIndex + 1)], 'pair');
}
export async function undoLoopBlend(id) {
  if (work.has(id)) throw new Error('Frame processing is already running.');
  const project = await readProject(id);
  if (project.status !== 'ready' || !Array.isArray(project.loopBlendUndo)) throw new Error('The blend can no longer be undone.');
  const lastDerived = project.blendFrameCount || 0;
  const generatedCount = project.blendUndoCount ?? (project.loopBlendUndo.length - project.slots.length);
  const newDerived = lastDerived - generatedCount;
  project.slots = project.loopBlendUndo;
  project.loopBlendUndo = null;
  project.blendUndoCount = 0;
  project.blendFrameCount = newDerived;
  project.derivedFrameKinds = (project.derivedFrameKinds || []).slice(0, newDerived);
  project.updatedAt = new Date().toISOString();
  await writeProject(project);
  await Promise.all(Array.from({ length: lastDerived - newDerived }, (_, index) => rm(derivedFramePath(id, newDerived + index + 1), { force: true }).catch(() => {})));
  return project;
}
export async function exportProject(id, format, rows, directory, order = 'edited', maskProjectId = id) {
  const project = await readProject(id);
  if (project.status !== 'ready') throw new Error('Project frames are not ready.');
  if (work.has(id)) throw new Error('Wait for frame processing to finish.');
  if (!['webp', 'png', 'atlas'].includes(format)) throw new Error('Unsupported export format.');
  if (!['original', 'edited'].includes(order)) throw new Error('Invalid frame order.');
  const outputDirectory = await validateOutputDirectory(directory);
  const base = safeOutputName(project.name).slice(0, -5);
  const slots = order === 'original' ? Array.from({ length: project.frameCount }, (_, index) => ({ frame: index + 1 })) : project.slots;
  if (!slots.length) throw new Error('The selected frame sequence is empty.');
  const exportDir = path.join(projectPath(id), `export-${randomUUID()}`);
  await mkdir(exportDir);
  try {
    for (let index = 0; index < slots.length; index++) {
      await renderSlot(project, slots[index], path.join(exportDir, `${String(index + 1).padStart(6, '0')}.png`));
    }
    if (maskProjectId !== id) await readProject(maskProjectId);
    const savedMask = maskPath(maskProjectId);
    const hasMask = (await stat(savedMask).catch(() => null))?.isFile();
    let sequenceDir = exportDir;
    if (hasMask) {
      sequenceDir = path.join(exportDir, 'masked');
      await mkdir(sequenceDir);
      const fps = String(project.config.fps);
      const filter = `[0:v]format=rgba,split[color][sourcealpha];[sourcealpha]alphaextract[a];[1:v]scale=${project.width}:${project.height},format=rgba,alphaextract[m];[a][m]blend=all_expr='A*B/255'[combined];[color][combined]alphamerge,format=rgba[out]`;
      await runFfmpeg(['-framerate', fps, '-i', path.join(exportDir, '%06d.png'), '-loop', '1', '-framerate', fps, '-i', savedMask, '-filter_complex', filter, '-map', '[out]', '-frames:v', String(slots.length), path.join(sequenceDir, '%06d.png')]);
    }
    if (format === 'png') {
      const result = await availablePath(outputDirectory, `${base}-frames`, '', true);
      await mkdir(result.path);
      try {
        for (let index = 0; index < slots.length; index++) {
          const name = `${String(index + 1).padStart(6, '0')}.png`;
          await copyFile(path.join(sequenceDir, name), path.join(result.path, name));
        }
      } catch (error) { await rm(result.path, { recursive: true, force: true }); throw error; }
      return { ...result, format, frameCount: slots.length };
    }
    if (format === 'webp') {
      const result = await availablePath(outputDirectory, base, '.webp');
      await runFfmpeg(['-framerate', String(project.config.fps), '-i', path.join(sequenceDir, '%06d.png'), '-c:v', 'libwebp_anim', '-lossless', '1', '-loop', '0', result.path]);
      return { ...result, format, frameCount: slots.length };
    }
    if (!Number.isInteger(rows) || rows < 1 || rows > slots.length) throw new Error('Invalid atlas row count.');
    const columns = Math.ceil(slots.length / rows);
    if (columns * project.width > 16384 || rows * project.height > 16384) throw new Error('Atlas exceeds 16384 pixels on one side; choose more rows or smaller frames.');
    const result = await availablePath(outputDirectory, `${base}-atlas-${rows}x${columns}`, '.png');
    await runFfmpeg(['-framerate', '1', '-i', path.join(sequenceDir, '%06d.png'), '-vf', `format=rgba,tile=${columns}x${rows}:nb_frames=${slots.length}:color=black@0,format=rgba`, '-frames:v', '1', result.path]);
    return { ...result, format, rows, columns, frameCount: slots.length };
  } finally {
    await rm(exportDir, { recursive: true, force: true });
  }
}
