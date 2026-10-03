import { constants } from 'node:fs';
import { access, mkdtemp, mkdir, open, rm, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export const createJobDirectory = () => mkdtemp(path.join(tmpdir(), 'codex-chroma-'));
export const removeJobDirectory = directory => rm(directory, { recursive: true, force: true });
export const safeOutputName = name => {
  const base = path.basename(name).replace(/\.mp4$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return `${base || 'animation'}.webp`;
};

export const defaultOutputDirectory = () => process.env.CHROMA_OUTPUT_DIR || path.join(homedir(), 'Downloads');

export async function validateOutputDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Enter the full absolute path to a folder.');
  const directory = path.resolve(value);
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) throw new Error('Output folder does not exist.');
  await access(directory, constants.W_OK).catch(() => { throw new Error('Output folder is not writable.'); });
  return directory;
}

export async function saveWebpToDownloads(input, requestedName, selectedDirectory) {
  if (typeof requestedName !== 'string' || !/^[^<>:"/\\|?*\x00-\x1f]{1,250}\.webp$/i.test(requestedName) || path.basename(requestedName) !== requestedName) {
    throw new Error('Invalid WebP filename.');
  }
  const directory = selectedDirectory ? await validateOutputDirectory(selectedDirectory) : defaultOutputDirectory();
  if (!selectedDirectory) await mkdir(directory, { recursive: true });
  const stem = requestedName.slice(0, -5);
  for (let index = 0; index < 1000; index++) {
    const name = index ? `${stem} (${index + 1}).webp` : requestedName;
    const target = path.join(directory, name);
    let handle;
    try { handle = await open(target, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    let header = Buffer.alloc(0);
    let total = 0;
    const verifier = new Transform({
      transform(chunk, encoding, callback) {
        total += chunk.length;
        if (total > 1024 * 1024 * 1024) return callback(new Error('WebP file exceeds the 1 GB limit.'));
        if (header.length < 12) {
          header = Buffer.concat([header, chunk]).subarray(0, 12);
          if (header.length === 12 && (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WEBP')) return callback(new Error('File is not a WebP.'));
        }
        callback(null, chunk);
      },
      flush(callback) { callback(header.length === 12 ? null : new Error('Incomplete WebP file.')); },
    });
    try {
      await pipeline(input, verifier, handle.createWriteStream());
      return { name, path: target };
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(target, { force: true }).catch(() => {});
      throw error;
    }
  }
  throw new Error('Too many files with the same name in the output folder.');
}
