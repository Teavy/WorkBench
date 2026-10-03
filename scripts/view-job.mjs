import { copyFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jobsRoot = path.join(projectRoot, '.view-jobs');

const isId = (value) => /^[a-f0-9-]{36}$/.test(value || '');

const latest = async () => {
  const entries = await readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isId(entry.name)) continue;
    try {
      const request = JSON.parse(await readFile(path.join(jobsRoot, entry.name, 'request.json'), 'utf8'));
      const complete = await stat(path.join(jobsRoot, entry.name, 'result.json')).then(() => true).catch(() => false);
      if (!complete) jobs.push(request);
    } catch { /* Ignore incomplete job folders. */ }
  }
  jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!jobs.length) throw new Error('No queued view jobs were found. Create one in the web UI first.');
  const job = jobs[0];
  console.log(JSON.stringify({
    ...job,
    inputPath: path.join(jobsRoot, job.id, job.input),
    jobDirectory: path.join(jobsRoot, job.id),
  }, null, 2));
};

const complete = async (id, source) => {
  if (!isId(id)) throw new Error('Invalid job ID.');
  const directory = path.join(jobsRoot, id);
  const request = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8'));
  if (request.id !== id) throw new Error('Job ID does not match request.json.');
  const sourcePath = path.resolve(source || '');
  if (sourcePath.toLowerCase() === path.join(directory, request.input).toLowerCase()) {
    throw new Error('The output cannot be the unchanged input image.');
  }
  if (await stat(path.join(directory, 'result.json')).then(() => true).catch(() => false)) {
    throw new Error('This job is already complete.');
  }
  const data = await readFile(sourcePath);
  let extension;
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) extension = 'png';
  else if (data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) extension = 'jpg';
  else if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') extension = 'webp';
  else throw new Error('Output must be a PNG, JPEG, or WebP image.');
  const output = `output.${extension}`;
  await copyFile(sourcePath, path.join(directory, output));
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ output, completedAt: new Date().toISOString() }, null, 2));
  console.log(path.join(directory, output));
};

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'latest') await latest();
  else if (command === 'complete') await complete(args[0], args[1]);
  else throw new Error('Usage: node scripts/view-job.mjs latest | complete <job-id> <image-path>');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
