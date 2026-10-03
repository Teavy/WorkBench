import { spawn } from 'node:child_process';
import { filterFor } from './config.mjs';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';

function run(command, args, input, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], signal, windowsHide: true });
    const out = [];
    let err = '';
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => { err = (err + chunk.toString()).slice(-16000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err || `${command} exited with code ${code}`)));
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

export async function probeVideo(file, signal) {
  const result = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,duration:format=duration', '-of', 'json', file], null, signal);
  const info = JSON.parse(result.toString());
  const stream = info.streams?.[0];
  if (!stream) throw new Error('The file has no video stream.');
  const duration = Number(stream.duration || info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not read video duration.');
  return { duration, width: stream.width, height: stream.height, frameRate: stream.r_frame_rate };
}

export async function previewFrame(png, config, signal) {
  const dimensions = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  return run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'png', '-i', 'pipe:0', '-vf', filterFor(config, dimensions, true), '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], png, signal);
}

export function convertVideo(input, output, config, video, onProgress, signal, preview = false) {
  return new Promise((resolve, reject) => {
    const [numerator, denominator] = String(video.frameRate || '').split('/').map(Number);
    const sourceRate = numerator > 0 && denominator > 0 ? numerator / denominator : config.sourceFps;
    const estimatedDuration = config.endFrame === null
      ? video.duration - (config.startFrame - 1) / sourceRate
      : (config.endFrame - config.startFrame + 1) / sourceRate;
    const progressDuration = Math.max(0.01, estimatedDuration);
    const encoding = preview
      ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '32', '-deadline', 'realtime', '-cpu-used', '5', '-f', 'webm']
      : ['-c:v', 'libwebp_anim', '-lossless', '1', '-loop', '0', '-f', 'webp'];
    const args = ['-hide_banner', '-nostdin', '-y', '-i', input, '-an', '-vf', filterFor(config, video), ...encoding, '-progress', 'pipe:3', output];
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe'], signal, windowsHide: true });
    let err = '';
    let progress = '';
    child.stderr.on('data', chunk => { err = (err + chunk.toString()).slice(-16000); });
    child.stdio[3].on('data', chunk => {
      progress += chunk.toString();
      const lines = progress.split(/\r?\n/);
      progress = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('out_time=')) {
          const parts = line.slice(9).split(':').map(Number);
          const seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
          if (Number.isFinite(seconds)) onProgress(Math.min(99, Math.max(0, Math.round(seconds / progressDuration * 100))));
        }
      }
    });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(err || `FFmpeg exited with code ${code}`)));
  });
}
