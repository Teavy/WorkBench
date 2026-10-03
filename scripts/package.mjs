import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = path.join(root, 'release');
const target = path.join(releaseRoot, 'codex-workbench');
if (path.dirname(target) !== releaseRoot || !target.startsWith(root + path.sep)) throw new Error('Invalid package path');

const build = spawnSync(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: root, stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const item of ['dist', 'node_modules', 'chroma', 'vite.config.ts', 'chromaPlugin.ts', 'localJobsPlugin.ts']) {
  await cp(path.join(root, item), path.join(target, item), { recursive: true });
}
await writeFile(path.join(target, 'package.json'), JSON.stringify({
  name: 'codex-workbench-portable', private: true, type: 'module',
  scripts: { start: 'vite preview --host 127.0.0.1 --port 4173' },
}, null, 2));
await writeFile(path.join(target, 'README.txt'), 'Install Node.js 20.19+ and FFmpeg. Run npm run start in this folder, then open http://127.0.0.1:4173/#chroma .\nAll conversion stays on this computer.\n');
console.log(`Portable folder ready: ${target}`);
