import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { create as createTar } from 'tar';
import { ensurePackagedHarnessRuntime, internals, resolveHarnessRoot } from '../src/harness.js';

test('the Harness readiness line exposes only the loopback URL', () => {
  assert.equal(
    internals.parseReadyUrl('booting\ndsh web: http://127.0.0.1:43123\n'),
    'http://127.0.0.1:43123',
  );
  assert.equal(internals.parseReadyUrl('dsh web: http://192.168.1.2:43123'), undefined);
});

test('an explicit Harness root takes precedence over packaged locations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deepseek-house-root-'));
  await mkdir(path.join(root, 'apps', 'cli', 'lib'), { recursive: true });
  await mkdir(path.join(root, 'apps', 'web', 'dist'), { recursive: true });
  await writeFile(path.join(root, 'apps', 'cli', 'lib', 'bin.js'), '');
  await writeFile(path.join(root, 'apps', 'web', 'dist', 'index.html'), '');

  assert.equal(
    await resolveHarnessRoot('C:\\missing-app', 'C:\\missing-resources', {
      DEEPSEEK_HARNESS_ROOT: root,
    }),
    root,
  );
});

test('a deployed Harness root is accepted without the source web workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deepseek-house-deploy-'));
  const frontend = path.join(
    root,
    'apps',
    'cli',
    'node_modules',
    '.pnpm',
    'node_modules',
    '@deepseek-ai',
    'dsh-web-frontend',
    'dist',
  );
  await mkdir(path.join(root, 'apps', 'cli', 'lib'), { recursive: true });
  await mkdir(frontend, { recursive: true });
  await writeFile(path.join(root, 'apps', 'cli', 'lib', 'bin.js'), '');
  await writeFile(path.join(frontend, 'index.html'), '');

  assert.equal(
    await resolveHarnessRoot('C:\\missing-app', 'C:\\missing-resources', {
      DEEPSEEK_HARNESS_ROOT: root,
    }),
    root,
  );
});

test('a packaged Harness archive is extracted and reused', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'deepseek-house-archive-'));
  const source = path.join(fixture, 'source');
  const frontend = path.join(
    source,
    'apps',
    'cli',
    'node_modules',
    '.pnpm',
    'node_modules',
    '@deepseek-ai',
    'dsh-web-frontend',
    'dist',
  );
  await mkdir(path.join(source, 'apps', 'cli', 'lib'), { recursive: true });
  await mkdir(frontend, { recursive: true });
  await writeFile(path.join(source, 'apps', 'cli', 'lib', 'bin.js'), '');
  await writeFile(path.join(frontend, 'index.html'), '<!doctype html>');
  const archive = path.join(fixture, 'runtime.tar.gz');
  const links = path.join(fixture, 'runtime.links.json');
  const target = path.join(fixture, 'runtime', '1.1.0');
  await createTar({ cwd: source, file: archive, gzip: true }, ['.']);
  await writeFile(links, '[]\n');

  assert.equal(await ensurePackagedHarnessRuntime(archive, links, target), target);
  assert.equal(await ensurePackagedHarnessRuntime(archive, links, target), target);
});
