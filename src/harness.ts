import { spawn, type ChildProcess } from 'node:child_process';
import { access, copyFile, mkdir, readFile, rename, rm, symlink } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import path from 'node:path';
import { extract as extractTar } from 'tar';

const STARTUP_TIMEOUT_MS = 90_000;

interface RuntimeLink {
  readonly path: string;
  readonly target: string;
  readonly type: 'directory' | 'file';
}

export interface HarnessRuntime {
  readonly root: string;
  readonly url: string;
  readonly process: ChildProcess;
}

export interface HarnessStartOptions {
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly executable?: string;
  readonly execArgs?: readonly string[];
  readonly timeoutMs?: number;
  readonly port?: number;
  readonly onSpawn?: (child: ChildProcess) => void;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function validateHarnessRoot(root: string): Promise<void> {
  await access(path.join(root, 'apps', 'cli', 'lib', 'bin.js'));
  try {
    await access(path.join(root, 'apps', 'web', 'dist', 'index.html'));
  } catch {
    await access(path.join(
      root,
      'apps',
      'cli',
      'node_modules',
      '.pnpm',
      'node_modules',
      '@deepseek-ai',
      'dsh-web-frontend',
      'dist',
      'index.html',
    ));
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function restoreRuntimeLinks(root: string, manifestPath: string): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('DeepSeek Harness 运行时链接清单无效。');
  const pending = parsed.map((value): RuntimeLink => {
    const record = value as Record<string, unknown> | null;
    if (
      record === null
      || typeof record !== 'object'
      || typeof record.path !== 'string'
      || typeof record.target !== 'string'
      || (record.type !== 'directory' && record.type !== 'file')
    ) {
      throw new Error('DeepSeek Harness 运行时链接清单包含无效条目。');
    }
    return { path: record.path, target: record.target, type: record.type };
  });

  while (pending.length > 0) {
    const ready: RuntimeLink[] = [];
    for (let offset = 0; offset < pending.length; offset += 256) {
      const batch = pending.slice(offset, offset + 256);
      const checks = await Promise.all(batch.map(async (entry) => {
        const link = path.resolve(root, entry.path);
        const target = path.resolve(path.dirname(link), entry.target);
        try {
          await access(target);
          return entry;
        } catch {
          return undefined;
        }
      }));
      ready.push(...checks.filter((entry): entry is RuntimeLink => entry !== undefined));
    }
    if (ready.length === 0) throw new Error('DeepSeek Harness 运行时链接目标不完整。');

    for (let offset = 0; offset < ready.length; offset += 64) {
      await Promise.all(ready.slice(offset, offset + 64).map(async (entry) => {
      const link = path.resolve(root, entry.path);
      const target = path.resolve(path.dirname(link), entry.target);
      if (!isWithin(root, link) || !isWithin(root, target)) {
        throw new Error('DeepSeek Harness 运行时链接越过了解包目录。');
      }
      await mkdir(path.dirname(link), { recursive: true });
      if (entry.type === 'file') await copyFile(target, link);
      else await symlink(process.platform === 'win32' ? target : entry.target, link, process.platform === 'win32' ? 'junction' : 'dir');
      }));
    }
    const restored = new Set(ready);
    pending.splice(0, pending.length, ...pending.filter((entry) => !restored.has(entry)));
  }
}

async function extractWith7Zip(executable: string, archivePath: string, destination: string): Promise<void> {
  const gunzip = spawn(executable, ['x', archivePath, '-so', '-y'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const untar = spawn(executable, ['x', '-si', '-ttar', `-o${destination}`, '-y'], {
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  });
  gunzip.stdout?.pipe(untar.stdin!);

  const waitFor = (child: ChildProcess, name: string): Promise<void> => new Promise((resolve, reject) => {
    let errors = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { errors = `${errors}${chunk}`.slice(-8_000); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} 解包失败（${signal ?? `退出码 ${String(code)}`}）。${errors.trim()}`));
    });
  });
  try {
    await Promise.all([waitFor(gunzip, '7-Zip gzip'), waitFor(untar, '7-Zip tar')]);
  } catch (error) {
    if (gunzip.exitCode === null) gunzip.kill();
    if (untar.exitCode === null) untar.kill();
    throw error;
  }
}

/** Extract and validate the immutable runtime shipped with a packaged app. */
export async function ensurePackagedHarnessRuntime(
  archivePath: string,
  linkManifestPath: string,
  targetRoot: string,
  extractorPath?: string,
): Promise<string> {
  try {
    await validateHarnessRoot(targetRoot);
    return targetRoot;
  } catch {
    await rm(targetRoot, { recursive: true, force: true });
  }

  await access(archivePath);
  await access(linkManifestPath);
  const temporaryRoot = `${targetRoot}.extracting-${String(process.pid)}`;
  await rm(temporaryRoot, { recursive: true, force: true });
  await mkdir(temporaryRoot, { recursive: true });
  try {
    if (extractorPath === undefined) await extractTar({ cwd: temporaryRoot, file: archivePath, strict: true });
    else await extractWith7Zip(extractorPath, archivePath, temporaryRoot);
    await mkdir(path.dirname(targetRoot), { recursive: true });
    await rename(temporaryRoot, targetRoot);
    try {
      await restoreRuntimeLinks(targetRoot, linkManifestPath);
      await validateHarnessRoot(targetRoot);
      return targetRoot;
    } catch (error) {
      await rm(targetRoot, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/** Resolve the source checkout or extracted packaged runtime containing Harness. */
export async function resolveHarnessRoot(
  appPath: string,
  resourcesPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const candidates = [
    env.DEEPSEEK_HARNESS_ROOT,
    path.resolve(appPath, '..', 'deepseek-harness'),
    path.join(resourcesPath, 'deepseek-harness'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      await validateHarnessRoot(candidate);
      return candidate;
    } catch {
      // Try the next development or packaged location.
    }
  }

  throw new Error(
    '找不到 DeepSeek Harness。请先在 deepseek-harness 目录运行 pnpm run build，或设置 DEEPSEEK_HARNESS_ROOT。',
  );
}

function parseReadyUrl(output: string): string | undefined {
  const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/u);
  return match?.[1];
}

/** Start the built Harness web profile and resolve when its HTTP server is ready. */
export async function startHarness(options: HarnessStartOptions): Promise<HarnessRuntime> {
  const root = await resolveHarnessRoot(options.appPath, options.resourcesPath, options.env);
  // Electron's embedded Node mode has a different package-resolution root,
  // which breaks pnpm workspace links. Prefer the user's normal Node runtime;
  // callers can provide a bundled path through `executable` for packaged use.
  const executable = options.executable
    ?? (process.versions.electron === undefined ? process.execPath : 'node');
  const cliPath = path.join(root, 'apps', 'cli', 'lib', 'bin.js');
  const port = options.port ?? await reserveLoopbackPort();
  const expectedUrl = `http://127.0.0.1:${String(port)}`;
  const child = spawn(executable, [
    ...(options.execArgs ?? []),
    cliPath,
    'web',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ], {
    cwd: root,
    env: {
      ...process.env,
      ...options.env,
      // Electron's executable can run the bundled Node runtime for the child.
      ELECTRON_RUN_AS_NODE: '1',
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  options.onSpawn?.(child);

  return new Promise<HarnessRuntime>((resolve, reject) => {
    let output = '';
    let settled = false;
    let probeTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('DeepSeek Harness 启动超时，请检查依赖和构建产物。'));
    }, options.timeoutMs ?? STARTUP_TIMEOUT_MS);

    const succeed = (url: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (probeTimer !== undefined) clearTimeout(probeTimer);
      resolve({ root, url, process: child });
    };

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (probeTimer !== undefined) clearTimeout(probeTimer);
      reject(new Error(message));
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output = `${output}${chunk}`.slice(-12_000);
      const url = parseReadyUrl(output);
      if (url !== undefined) succeed(url);
    });
    child.stderr?.on('data', (chunk: string) => {
      output = `${output}${chunk}`.slice(-12_000);
    });
    child.once('error', (error) => fail(`DeepSeek Harness 无法启动：${error.message}`));
    child.once('exit', (code, signal) => {
      if (settled) return;
      const reason = signal ? `信号 ${signal}` : `退出码 ${String(code)}`;
      fail(`DeepSeek Harness 启动失败（${reason}）。${output.trim()}`);
    });

    const probeApi = async (): Promise<void> => {
      if (settled) return;
      try {
        const response = await fetch(`${expectedUrl}/api/session.list`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        // The API route owns POST and rejects this incomplete RPC envelope.
        // Before it mounts, the static fallback returns 405 for every POST.
        if (response.status !== 405) {
          succeed(expectedUrl);
          return;
        }
      } catch {
        // The loopback listener is not ready yet.
      }
      probeTimer = setTimeout(() => { void probeApi(); }, 250);
    };
    void probeApi();
  });
}

/** Ask the managed Harness process to stop and wait briefly for it to exit. */
export async function stopHarness(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return;
  if (!child.killed) child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 8_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null) child.kill('SIGKILL');
}

export const internals = { parseReadyUrl, reserveLoopbackPort };
