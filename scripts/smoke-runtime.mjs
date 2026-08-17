import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const houseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let runtimeRoot = path.join(houseRoot, '.harness-runtime');
if (process.argv.includes('--archive')) {
  const { ensurePackagedHarnessRuntime } = await import('../dist/harness.js');
  const extractedRoot = path.join(houseRoot, 'artifacts', 'packaged-runtime', '1.1.0');
  await rm(extractedRoot, { recursive: true, force: true });
  runtimeRoot = await ensurePackagedHarnessRuntime(
    path.join(houseRoot, '.harness-runtime.tar.gz'),
    path.join(houseRoot, '.harness-runtime.links.json'),
    extractedRoot,
    process.platform === 'win32' ? path.join(houseRoot, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe') : undefined,
  );
}
const cliPath = path.join(runtimeRoot, 'apps', 'cli', 'lib', 'bin.js');
const electronPath = path.join(
  houseRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

const port = await reserveLoopbackPort();
const smokeHome = path.join(houseRoot, 'artifacts', 'staged-runtime-home');
await mkdir(smokeHome, { recursive: true });

let output = '';
const child = spawn(electronPath, ['--expose-internals', cliPath, 'web', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: runtimeRoot,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: smokeHome,
    DSH_TELEMETRY_DISABLED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-12_000); });
child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-12_000); });

try {
  const deadline = Date.now() + 90_000;
  let apiStatus;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`staged Harness exited with code ${String(child.exitCode)}\n${output}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/session.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (response.status !== 405) {
        apiStatus = response.status;
        break;
      }
    } catch {
      // The loopback listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (apiStatus === undefined) throw new Error(`staged Harness did not become ready\n${output}`);

  const page = await fetch(`http://127.0.0.1:${String(port)}/`);
  const html = await page.text();
  if (!page.ok || !html.toLowerCase().includes('<!doctype html')) {
    throw new Error(`staged Harness returned an invalid page (${String(page.status)})`);
  }
  console.log(JSON.stringify({ apiStatus, pageStatus: page.status, pageBytes: html.length, port }));
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 8_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
