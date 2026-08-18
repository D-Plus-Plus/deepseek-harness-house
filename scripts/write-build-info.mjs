import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const houseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harnessRoot = path.resolve(
  process.env.DEEPSEEK_HARNESS_ROOT || path.join(houseRoot, '..', 'deepseek-harness'),
);

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function git(args) {
  try {
    return execFileSync('git', ['-C', harnessRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const housePackage = await readJson(path.join(houseRoot, 'package.json')) ?? {};
const harnessPackage = await readJson(path.join(harnessRoot, 'package.json')) ?? {};
const gitCommit = git(['rev-parse', 'HEAD']);
const gitStatus = git(['status', '--porcelain']);
const buildInfo = {
  formatVersion: 1,
  app: {
    name: housePackage.build?.productName || 'DeepSeek Harness',
    version: housePackage.version || 'unknown',
  },
  harness: {
    name: 'DeepSeek Harness',
    packageVersion: harnessPackage.version || 'unknown',
    repository: 'https://github.com/deepseek-ai/deepseek-harness',
    gitCommit,
    gitShortCommit: gitCommit ? gitCommit.slice(0, 7) : null,
    gitDate: git(['show', '-s', '--format=%cI', 'HEAD']),
    gitDirty: gitStatus === null ? null : gitStatus.length > 0,
  },
};

const outputPath = path.join(houseRoot, 'app', 'build-info.json');
await writeFile(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');
console.log(`write-build-info: ${buildInfo.app.version} / Harness ${buildInfo.harness.packageVersion} / ${buildInfo.harness.gitShortCommit ?? 'unknown'}`);
