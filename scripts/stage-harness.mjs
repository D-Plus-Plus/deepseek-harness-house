import { spawn } from 'node:child_process';
import { access, cp, lstat, mkdir, readFile, readlink, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { create as createTar } from 'tar';
import { fileURLToPath } from 'node:url';

const houseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harnessRoot = path.resolve(
  process.env.DEEPSEEK_HARNESS_ROOT || path.join(houseRoot, '..', 'deepseek-harness'),
);
const stageRoot = path.join(houseRoot, '.harness-runtime');
const cliStage = path.join(stageRoot, 'apps', 'cli');
const deployRoot = path.join(harnessRoot, 'tmp', 'house-runtime-deploy');
const cliDeploy = path.join(deployRoot, 'apps', 'cli');
const peerDeploy = path.join(deployRoot, '.peer-closure');
const archivePath = path.join(houseRoot, '.harness-runtime.tar.gz');
const linkManifestPath = path.join(houseRoot, '.harness-runtime.links.json');
const archiveRoot = path.join(houseRoot, '.harness-runtime-files');
const vendoredPackages = [
  'cosmokit',
  'schemastery',
];

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: 'true' },
      shell: process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command),
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${String(code)}`));
    });
  });
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function copyVendoredPackage(name) {
  const source = path.join(harnessRoot, 'vendor', name);
  const destination = path.join(stageRoot, 'vendor', name);
  await mkdir(destination, { recursive: true });
  for (const entry of ['lib', 'LICENSE', 'package.json', 'README.md']) {
    const from = path.join(source, entry);
    try {
      await access(from);
      await cp(from, path.join(destination, entry), { recursive: true, verbatimSymlinks: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  const runtimeDependencies = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  for (const dependency of runtimeDependencies) {
    const from = path.join(source, 'node_modules', ...dependency.split('/'));
    if (!await pathExists(from)) continue;
    const to = path.join(destination, 'node_modules', ...dependency.split('/'));
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
  }
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function mergeDirectory(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await mergeDirectory(from, to);
    } else if (!await pathExists(to)) {
      await cp(from, to, { recursive: true, verbatimSymlinks: true });
    }
  }
}

function runtimeDependencies(manifest) {
  const optionalPeers = manifest.peerDependenciesMeta ?? {};
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}).filter(
      (name) => optionalPeers[name]?.optional !== true,
    ),
  ]);
}

async function loadWorkspacePackages() {
  const packages = new Map();
  const scan = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    const manifestEntry = entries.find((entry) => entry.isFile() && entry.name === 'package.json');
    if (manifestEntry !== undefined) {
      const manifest = JSON.parse(await readFile(path.join(directory, manifestEntry.name), 'utf8'));
      if (typeof manifest.name === 'string') packages.set(manifest.name, { directory, manifest });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || ['node_modules', 'lib', 'dist', 'src', 'test', 'tests'].includes(entry.name)) continue;
      await scan(path.join(directory, entry.name));
    }
  };
  for (const root of ['apps', 'packages', 'vendor']) await scan(path.join(harnessRoot, root));
  return packages;
}

async function copyWorkspaceRuntimePackage(packageName, workspacePackage, workspace) {
  const destination = path.join(cliStage, 'node_modules', ...packageName.split('/'));
  await mkdir(destination, { recursive: true });
  const payload = new Set(['package.json', 'LICENSE', 'README.md']);
  for (const pattern of workspacePackage.manifest.files ?? ['lib']) {
    const topLevel = pattern.replace(/^\.\//u, '').split('/')[0];
    if (topLevel && !topLevel.startsWith('!') && !topLevel.includes('*')) payload.add(topLevel);
  }
  for (const entry of payload) {
    const from = path.join(workspacePackage.directory, entry);
    if (!await pathExists(from)) continue;
    await cp(from, path.join(destination, entry), { recursive: true, verbatimSymlinks: true });
  }

  for (const dependency of runtimeDependencies(workspacePackage.manifest)) {
    const link = path.join(destination, 'node_modules', ...dependency.split('/'));
    if (await pathExists(link)) continue;
    await mkdir(path.dirname(link), { recursive: true });
    if (workspace.has(dependency)) {
      const target = path.join(cliStage, 'node_modules', '.pnpm', 'node_modules', ...dependency.split('/'));
      await symlink(path.relative(path.dirname(link), target), link, 'dir');
      continue;
    }
    const sourceDependency = path.join(workspacePackage.directory, 'node_modules', ...dependency.split('/'));
    if (!await pathExists(sourceDependency)) continue;
    const sourceStat = await lstat(sourceDependency);
    if (sourceStat.isSymbolicLink()) {
      const resolved = path.resolve(path.dirname(sourceDependency), await readlink(sourceDependency));
      const sourceModules = path.join(harnessRoot, 'node_modules');
      if (!isWithin(sourceModules, resolved)) {
        throw new Error(`stage-harness: cannot relocate ${packageName} dependency ${dependency}`);
      }
      const target = path.join(cliStage, 'node_modules', path.relative(sourceModules, resolved));
      await symlink(path.relative(path.dirname(link), target), link, 'dir');
    } else {
      await cp(sourceDependency, link, { recursive: true, verbatimSymlinks: true });
    }
  }
}

async function completeWorkspaceClosure() {
  const workspace = await loadWorkspacePackages();
  const cliManifest = JSON.parse(await readFile(path.join(harnessRoot, 'apps', 'cli', 'package.json'), 'utf8'));
  const closure = new Set();
  const queue = [...runtimeDependencies(cliManifest)];
  for (let index = 0; index < queue.length; index += 1) {
    const name = queue[index];
    if (closure.has(name)) continue;
    const workspacePackage = workspace.get(name);
    if (workspacePackage === undefined) continue;
    closure.add(name);
    for (const dependency of runtimeDependencies(workspacePackage.manifest)) queue.push(dependency);
  }

  const missing = [];
  for (const name of closure) {
    const alias = path.join(cliStage, 'node_modules', '.pnpm', 'node_modules', ...name.split('/'));
    try {
      await access(alias);
    } catch {
      missing.push(name);
    }
  }
  for (const name of missing) await copyWorkspaceRuntimePackage(name, workspace.get(name), workspace);
  for (const name of missing) {
    const target = path.join(cliStage, 'node_modules', ...name.split('/'));
    const alias = path.join(cliStage, 'node_modules', '.pnpm', 'node_modules', ...name.split('/'));
    await mkdir(path.dirname(alias), { recursive: true });
    if (!await pathExists(alias)) await symlink(path.relative(path.dirname(alias), target), alias, 'dir');
  }
  for (const name of closure) {
    const target = path.join(cliStage, 'node_modules', '.pnpm', 'node_modules', ...name.split('/'));
    const alias = path.join(cliStage, 'node_modules', ...name.split('/'));
    if (await pathExists(alias)) continue;
    await mkdir(path.dirname(alias), { recursive: true });
    await symlink(path.relative(path.dirname(alias), target), alias, 'dir');
  }

  const patchedPackages = new Set();
  for (const name of closure) {
    const alias = path.join(cliStage, 'node_modules', '.pnpm', 'node_modules', ...name.split('/'));
    let packageDirectory;
    try {
      packageDirectory = await realpath(alias);
    } catch {
      continue;
    }
    if (patchedPackages.has(packageDirectory)) continue;
    patchedPackages.add(packageDirectory);
    const manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
    const optionalPeers = manifest.peerDependenciesMeta ?? {};
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (optionalPeers[peer]?.optional === true || !workspace.has(peer)) continue;
      const target = path.join(cliStage, 'node_modules', '.pnpm', 'node_modules', ...peer.split('/'));
      try {
        await access(target);
      } catch {
        continue;
      }
      const link = path.join(packageDirectory, 'node_modules', ...peer.split('/'));
      if (await pathExists(link)) continue;
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(path.relative(path.dirname(link), target), link, 'dir');
    }
  }
  console.log(`stage-harness: completed workspace closure with ${String(missing.length)} package(s)`);
}

function externalReplacement(resolved) {
  const normalized = resolved.split(path.sep).join('/');
  if (normalized.endsWith('/apps/cli')) return cliStage;
  for (const name of vendoredPackages) {
    if (normalized.endsWith(`/vendor/${name}`)) return path.join(stageRoot, 'vendor', name);
  }
  const stagedNodeModules = `${path.join(stageRoot, 'node_modules').split(path.sep).join('/')}/`;
  if (normalized.startsWith(stagedNodeModules)) {
    return path.join(cliStage, 'node_modules', path.relative(path.join(stageRoot, 'node_modules'), resolved));
  }
  const sourceNodeModules = `${path.join(harnessRoot, 'node_modules').split(path.sep).join('/')}/`;
  if (normalized.startsWith(sourceNodeModules)) {
    return path.join(cliStage, 'node_modules', path.relative(path.join(harnessRoot, 'node_modules'), resolved));
  }
  if (normalized.endsWith('/python/sdk-runtime')) return null;
  if (normalized.includes('/native/landlock-run/packages/linux-')) return null;
  throw new Error(`stage-harness: unexpected external symlink target ${resolved}`);
}

async function rewriteExternalLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const rawTarget = await readlink(entryPath);
      const resolved = path.resolve(directory, rawTarget);
      const stagedNodeModulesRoot = path.join(stageRoot, 'node_modules');
      if (isWithin(stageRoot, resolved) && !isWithin(stagedNodeModulesRoot, resolved)) continue;
      const replacement = externalReplacement(resolved);
      await rm(entryPath, { force: true });
      if (replacement !== null) {
        const portableTarget = path.relative(directory, replacement);
        await symlink(portableTarget, entryPath, 'dir');
      }
      continue;
    }
    if (entry.isDirectory()) await rewriteExternalLinks(entryPath);
  }
}

async function verifyLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const resolved = path.resolve(directory, await readlink(entryPath));
      if (!isWithin(stageRoot, resolved)) {
        throw new Error(`stage-harness: staged link escapes runtime: ${entryPath} -> ${resolved}`);
      }
      await access(resolved);
      continue;
    }
    if (entry.isDirectory()) await verifyLinks(entryPath);
  }
}

async function collectLinks(directory, links = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(entryPath);
      const resolved = path.resolve(directory, target);
      const targetStat = await stat(resolved);
      links.push({
        path: path.relative(stageRoot, entryPath).split(path.sep).join('/'),
        target: target.split(path.sep).join('/'),
        type: targetStat.isDirectory() ? 'directory' : 'file',
      });
    } else if (entry.isDirectory()) {
      await collectLinks(entryPath, links);
    }
  }
  return links;
}

async function copyRegularTree(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyRegularTree(from, to);
    else await cp(from, to, { preserveTimestamps: true });
  }
}

async function pruneDevelopmentFiles(directory) {
  let removed = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      removed += await pruneDevelopmentFiles(entryPath);
    } else if (/\.map$/iu.test(entry.name) || /\.d\.(?:ts|mts|cts)$/iu.test(entry.name)) {
      await rm(entryPath, { force: true });
      removed += 1;
    }
  }
  return removed;
}

let pnpm = process.env.PNPM_EXECUTABLE || (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
let pnpmPrefix = [];
if (process.platform === 'win32' && process.env.PNPM_EXECUTABLE === undefined) {
  const corepack = path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js');
  try {
    await access(corepack);
    pnpm = process.execPath;
    pnpmPrefix = [corepack, 'pnpm'];
  } catch {
    // Fall back to the pnpm.cmd shim when this Node installation has no Corepack.
  }
}
await access(path.join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js'));
await access(path.join(harnessRoot, 'apps', 'web', 'dist', 'index.html'));
if (process.env.STAGE_HARNESS_SKIP_DEPLOY !== '1') {
  await rm(stageRoot, { recursive: true, force: true });
  await rm(deployRoot, { recursive: true, force: true });
  await run(
    pnpm,
    [...pnpmPrefix, '--filter', '@deepseek-ai/dsh', 'deploy', '--prod', '--legacy', cliDeploy],
    harnessRoot,
  );
  await run(
    pnpm,
    [...pnpmPrefix, '--filter', 'dsh-jsonrpc-agent-pkg', 'deploy', '--prod', '--legacy', peerDeploy],
    harnessRoot,
  );
  await mergeDirectory(path.join(peerDeploy, 'node_modules'), path.join(cliDeploy, 'node_modules'));
  await rm(peerDeploy, { recursive: true, force: true });
  await rename(deployRoot, stageRoot);
}
await rm(path.join(stageRoot, 'vendor'), { recursive: true, force: true });
for (const name of vendoredPackages) await copyVendoredPackage(name);
await completeWorkspaceClosure();
await rewriteExternalLinks(stageRoot);
const prunedFiles = await pruneDevelopmentFiles(stageRoot);
await verifyLinks(stageRoot);
await access(path.join(
  cliStage,
  'node_modules',
  '.pnpm',
  'node_modules',
  '@deepseek-ai',
  'dsh-web-frontend',
  'dist',
  'index.html',
));

const links = await collectLinks(stageRoot);
await writeFile(linkManifestPath, `${JSON.stringify(links, null, 2)}\n`);
await rm(archivePath, { force: true });
await rm(archiveRoot, { recursive: true, force: true });
try {
  await copyRegularTree(stageRoot, archiveRoot);
  await createTar({
    cwd: archiveRoot,
    file: archivePath,
    gzip: { level: 6 },
    noMtime: true,
    portable: true,
  }, ['.']);
} finally {
  await rm(archiveRoot, { recursive: true, force: true });
}
await access(archivePath);

console.log(`stage-harness: production runtime ready at ${stageRoot} (${String(prunedFiles)} development files pruned, ${String(links.length)} links archived separately)`);
