import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const houseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const playwrightStore = path.join(houseRoot, '..', 'deepseek-harness', 'node_modules', '.pnpm');
const playwrightPackage = (await readdir(playwrightStore)).find((name) => name.startsWith('playwright@'));
if (playwrightPackage === undefined) throw new Error('smoke-packaged: Playwright is not installed in deepseek-harness');
const playwrightEntry = path.join(playwrightStore, playwrightPackage, 'node_modules', 'playwright', 'index.mjs');
const { _electron: electron } = await import(pathToFileURL(playwrightEntry).toString());
const buildInfo = JSON.parse(await readFile(path.join(houseRoot, 'app', 'build-info.json'), 'utf8'));

const executablePath = path.join(houseRoot, 'release', 'win-unpacked', 'DeepSeek Harness.exe');
const userData = path.join(houseRoot, 'artifacts', 'packaged-app-user-data');
await rm(userData, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const startedAt = Date.now();
const electronApp = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${userData}`],
  env,
  timeout: 30_000,
});
const electronProcess = electronApp.process();

try {
  await electronApp.firstWindow({ timeout: 30_000 });
  const deadline = Date.now() + 240_000;
  let details;
  while (Date.now() < deadline) {
    details = await electronApp.evaluate(async ({ app, webContents }) => {
      const contents = webContents.getAllWebContents().find((item) => item.getURL().startsWith('http://127.0.0.1:'));
      if (contents === undefined) return undefined;
      const shell = webContents.getAllWebContents().find((item) => item.getURL().startsWith('app://shell/'));
      const versionInfo = shell === undefined
        ? ''
        : await shell.executeJavaScript("document.querySelector('#version-info')?.textContent ?? ''");
      const rootChildren = await contents.executeJavaScript("document.querySelector('#root')?.childElementCount ?? 0");
      return { url: contents.getURL(), title: contents.getTitle(), rootChildren, versionInfo, userData: app.getPath('userData') };
    });
    if (details?.rootChildren > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (details === undefined || details.rootChildren <= 0) {
    throw new Error('smoke-packaged: packaged Harness page did not become ready');
  }
  const expectedVersion = `v${buildInfo.app.version}`;
  const expectedHarness = `Harness ${buildInfo.harness.packageVersion}`;
  const expectedVersionInfo = `${expectedVersion} · ${expectedHarness}`;
  if (details.versionInfo !== expectedVersionInfo) {
    throw new Error(`smoke-packaged: version info mismatch: ${details.versionInfo}`);
  }

  const readyMs = Date.now() - startedAt;
  const exited = new Promise((resolve) => electronProcess.once('exit', (code, signal) => resolve({ code, signal })));
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  const exitResult = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('smoke-packaged: app did not exit after close')), 20_000)),
  ]);
  console.log(JSON.stringify({ ...details, readyMs, closeMs: Date.now() - startedAt - readyMs, exitResult }));
} finally {
  if (electronProcess.exitCode === null) await electronApp.close();
}
