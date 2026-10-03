import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromaHandler } from '../chroma/server.mjs';
import { cropGeometry } from '../chroma/config.mjs';

function command(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
}

function commandBytes(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const output = [];
    let stderr = '';
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error(stderr)));
  });
}

const root = await mkdtemp(path.join(tmpdir(), 'chroma-smoke-'));
const mp4 = path.join(root, 'green.mp4');
const png = path.join(root, 'green.png');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
let server;
try {
  await command(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=160x96:r=10:d=1', '-f', 'lavfi', '-i', 'color=c=red:s=16x16:r=10:d=1', '-filter_complex', '[0:v][1:v]overlay=x=70+10*t:y=40', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', mp4]);
  await command(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', mp4, '-frames:v', '1', '-y', png]);
  server = createServer((req, res) => chromaHandler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = { color: '#008000', similarity: 0.27, blend: 0.08, fps: 10, size: 'original' };
  const preview = await fetch(`${base}/preview?config=${encodeURIComponent(JSON.stringify(config))}`, { method: 'POST', body: await readFile(png) });
  assert.equal(preview.status, 200);
  const previewPng = path.join(root, 'preview.png');
  await writeFile(previewPng, Buffer.from(await preview.arrayBuffer()));
  const previewInfo = JSON.parse(await command(ffprobe, ['-v', 'error', '-show_entries', 'stream=pix_fmt', '-of', 'json', previewPng]));
  assert.match(previewInfo.streams[0].pix_fmt, /a/);
  const cropConfig = { ...config, size: '256', squareMode: 'crop', cropScale: 1, cropX: 0.5, cropY: 0.5 };
  assert.deepEqual(cropGeometry(cropConfig, 160, 96), { width: 96, height: 96, x: 32, y: 0 });
  for (const mode of ['crop', 'pad']) {
    const setting = { ...cropConfig, squareMode: mode };
    const response = await fetch(`${base}/preview?config=${encodeURIComponent(JSON.stringify(setting))}`, { method: 'POST', body: await readFile(png) });
    assert.equal(response.status, 200);
    const file = path.join(root, `${mode}.png`);
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    const details = JSON.parse(await command(ffprobe, ['-v', 'error', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json', file]));
    assert.equal(details.streams[0].width, 256);
    assert.equal(details.streams[0].height, 256);
    assert.match(details.streams[0].pix_fmt, /a/);
    const raw = await commandBytes(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
    if (mode === 'pad') assert.equal(raw[(0 * 256 + 128) * 4 + 3], 0, 'pad margin is not transparent');
    const red = [];
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const p = (y * 256 + x) * 4;
      if (raw[p] > 150 && raw[p + 1] < 100 && raw[p + 2] < 100 && raw[p + 3] > 200) red.push([x, y]);
    }
    assert.ok(red.length > 0, `${mode} lost red subject`);
    const bounds = { width: Math.max(...red.map(p => p[0])) - Math.min(...red.map(p => p[0])) + 1, height: Math.max(...red.map(p => p[1])) - Math.min(...red.map(p => p[1])) + 1 };
    assert.ok(Math.abs(bounds.width - bounds.height) <= 4, `${mode} stretched a square subject: ${JSON.stringify(bounds)}`);
  }
  const movedConfig = { ...cropConfig, foregroundZoom: 0.5, foregroundX: 0.25, foregroundY: 0 };
  const movedPreview = await fetch(`${base}/preview?config=${encodeURIComponent(JSON.stringify(movedConfig))}`, { method: 'POST', body: await readFile(png) });
  assert.equal(movedPreview.status, 200);
  const movedPng = path.join(root, 'moved.png');
  await writeFile(movedPng, Buffer.from(await movedPreview.arrayBuffer()));
  const movedRaw = await commandBytes(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', movedPng, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
  const movedRed = [];
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const p = (y * 256 + x) * 4;
    if (movedRaw[p] > 150 && movedRaw[p + 1] < 100 && movedRaw[p + 2] < 100 && movedRaw[p + 3] > 200) movedRed.push(x);
  }
  assert.ok(movedRed.length > 0, 'foreground transform lost the subject');
  assert.ok(Math.min(...movedRed) > 170 && Math.max(...movedRed) < 220, 'foreground transform did not move and shrink the subject');
  assert.equal(movedRaw[(128 * 256 + 0) * 4 + 3], 0, 'foreground transform lost transparency');
  const enlargedConfig = { ...cropConfig, foregroundZoom: 1.5, foregroundX: -0.1, foregroundY: 0.1 };
  const enlargedPreview = await fetch(`${base}/preview?config=${encodeURIComponent(JSON.stringify(enlargedConfig))}`, { method: 'POST', body: await readFile(png) });
  assert.equal(enlargedPreview.status, 200);
  const enlargedPng = path.join(root, 'enlarged.png');
  await writeFile(enlargedPng, Buffer.from(await enlargedPreview.arrayBuffer()));
  const enlargedRaw = await commandBytes(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', enlargedPng, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
  const enlargedRed = [];
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const p = (y * 256 + x) * 4;
    if (enlargedRaw[p] > 150 && enlargedRaw[p + 1] < 100 && enlargedRaw[p + 2] < 100 && enlargedRaw[p + 3] > 200) enlargedRed.push(x);
  }
  assert.ok(enlargedRed.length > 0 && Math.max(...enlargedRed) - Math.min(...enlargedRed) > 20, 'foreground enlargement failed');
  const customConfig = { ...cropConfig, size: 'custom', width: 320, height: 160 };
  assert.deepEqual(cropGeometry(customConfig, 160, 96), { width: 160, height: 80, x: 0, y: 8 });
  const customResponse = await fetch(`${base}/preview?config=${encodeURIComponent(JSON.stringify(customConfig))}`, { method: 'POST', body: await readFile(png) });
  assert.equal(customResponse.status, 200);
  const customPng = path.join(root, 'custom.png');
  await writeFile(customPng, Buffer.from(await customResponse.arrayBuffer()));
  const customInfo = JSON.parse(await command(ffprobe, ['-v', 'error', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json', customPng]));
  assert.equal(customInfo.streams[0].width, 320);
  assert.equal(customInfo.streams[0].height, 160);
  assert.match(customInfo.streams[0].pix_fmt, /a/);
  const priorJobs = new Set((await readdir(tmpdir())).filter(name => name.startsWith('codex-chroma-')));
  const created = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'green.mp4', config: movedConfig }) });
  assert.equal(created.status, 201);
  const { id, name } = await created.json();
  assert.equal(name, 'green.webp');
  const jobDirName = (await readdir(tmpdir())).find(item => item.startsWith('codex-chroma-') && !priorJobs.has(item));
  assert.ok(jobDirName);
  const jobDir = path.join(tmpdir(), jobDirName);
  const upload = await fetch(`${base}/jobs/${id}/source`, { method: 'PUT', body: await readFile(mp4) });
  assert.equal(upload.status, 202);
  let state;
  for (let i = 0; i < 100; i++) {
    state = await (await fetch(`${base}/jobs/${id}`)).json();
    if (state.status === 'done' || state.status === 'error') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(state.status, 'done', state.error);
  assert.equal(await stat(path.join(jobDir, 'source.mp4')).catch(() => null), null, 'temporary source was not deleted');
  const output = await fetch(`${base}/jobs/${id}/output`);
  assert.equal(output.status, 200);
  const webp = path.join(root, 'green.webp');
  await writeFile(webp, Buffer.from(await output.arrayBuffer()));
  const info = JSON.parse(await command(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt,width,height,nb_frames', '-of', 'json', webp]));
  assert.equal(info.streams[0].codec_name, 'webp_anim');
  assert.match(info.streams[0].pix_fmt, /a/);
  assert.equal(info.streams[0].width, 256);
  assert.equal(info.streams[0].height, 256);
  const bytes = await readFile(webp);
  assert.ok(bytes.includes(Buffer.from('ANIM')), 'animated WebP ANIM chunk missing');
  assert.ok(bytes.includes(Buffer.from('ANMF')), 'animated WebP frame missing');
  const anim = bytes.indexOf(Buffer.from('ANIM'));
  assert.equal(bytes.readUInt32LE(anim + 4), 6);
  assert.equal(bytes.readUInt16LE(anim + 12), 0, 'loop count is not zero');
  const trimmed = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'trimmed.mp4', config: { ...cropConfig, startFrame: 3, endFrame: 6, sourceFps: 10 } }) });
  assert.equal(trimmed.status, 201);
  const trimmedJob = await trimmed.json();
  assert.equal((await fetch(`${base}/jobs/${trimmedJob.id}/source`, { method: 'PUT', body: await readFile(mp4) })).status, 202);
  let trimmedState;
  for (let i = 0; i < 100; i++) {
    trimmedState = await (await fetch(`${base}/jobs/${trimmedJob.id}`)).json();
    if (trimmedState.status === 'done' || trimmedState.status === 'error') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(trimmedState.status, 'done', trimmedState.error);
  const trimmedOutput = await fetch(`${base}/jobs/${trimmedJob.id}/output`);
  assert.equal(trimmedOutput.status, 200);
  const trimmedBytes = Buffer.from(await trimmedOutput.arrayBuffer());
  assert.equal(trimmedBytes.toString('ascii').match(/ANMF/g)?.length, 4, 'frame interval should include frames 3 through 6');
  await fetch(`${base}/jobs/${trimmedJob.id}`, { method: 'DELETE' });
  process.env.CHROMA_OUTPUT_DIR = path.join(root, 'Downloads');
  const saveRequest = () => fetch(`${base}/save?name=green.webp`, { method: 'POST', headers: { 'Content-Type': 'image/webp', 'X-Chroma-Save': '1' }, body: bytes });
  const firstSave = await saveRequest();
  assert.equal(firstSave.status, 201);
  const firstSaved = await firstSave.json();
  assert.equal(firstSaved.name, 'green.webp');
  assert.deepEqual(await readFile(firstSaved.path), bytes);
  const secondSave = await saveRequest();
  assert.equal(secondSave.status, 201);
  assert.equal((await secondSave.json()).name, 'green (2).webp');
  const chosen = path.join(root, 'Selected');
  await mkdir(chosen);
  const directoryResponse = await fetch(`${base}/output-directory`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chroma-Save': '1' }, body: JSON.stringify({ path: chosen }) });
  assert.equal(directoryResponse.status, 200);
  assert.equal((await directoryResponse.json()).path, chosen);
  const customSave = await fetch(`${base}/save?name=green.webp&directory=${encodeURIComponent(chosen)}`, { method: 'POST', headers: { 'Content-Type': 'image/webp', 'X-Chroma-Save': '1' }, body: bytes });
  assert.equal(customSave.status, 201);
  assert.equal((await customSave.json()).path, path.join(chosen, 'green.webp'));
  await fetch(`${base}/jobs/${id}`, { method: 'DELETE' });
  assert.equal(await stat(jobDir).catch(() => null), null, 'temporary output folder was not deleted');
  console.log('Chroma preview, custom size, frame trim, animation alpha/loop, local save, and temp cleanup: OK');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
