import { spawn } from 'node:child_process';
import path from 'node:path';

export async function pickOutputDirectory(initialDirectory) {
  if (process.platform !== 'win32') throw new Error('Enter the output folder path manually on this system.');
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose an Animated WebP output folder'
$dialog.ShowNewFolderButton = $true
if (Test-Path -LiteralPath $env:CHROMA_PICK_DIRECTORY -PathType Container) { $dialog.SelectedPath = $env:CHROMA_PICK_DIRECTORY }
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
try {
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }
} finally { $owner.Dispose(); $dialog.Dispose() }
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
      windowsHide: true,
      env: { ...process.env, CHROMA_PICK_DIRECTORY: initialDirectory || '' },
    });
    let output = '';
    let errors = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim() || null) : reject(new Error(errors.trim() || 'Could not open the local folder picker.')));
  });
}

export function openDirectory(directory) {
  if (process.platform !== 'win32') throw new Error('Opening a folder is not supported on this system.');
  if (!path.isAbsolute(directory)) throw new Error('Folder path must be absolute.');
  return new Promise((resolve, reject) => {
    const child = spawn('explorer.exe', [path.resolve(directory)], { windowsHide: false, detached: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('spawn', () => { child.unref(); resolve(); });
  });
}

export function revealFile(filePath) {
  if (!path.isAbsolute(filePath)) throw new Error('File path must be absolute.');
  return openDirectory(path.dirname(filePath));
}
