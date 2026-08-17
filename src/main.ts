import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  WebContentsView,
  type DownloadItem,
  type Event as ElectronEvent,
  type FileSystemAccessRestrictedDetails,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type Streams,
  type WebContents,
} from 'electron';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isNavigationAllowed } from './config.js';
import { ensurePackagedHarnessRuntime, startHarness, stopHarness, type HarnessRuntime } from './harness.js';
import { isPrimaryPageOrigin, isWebPermissionAllowed } from './security.js';
import type { ShellState } from './types.js';

const APP_SCHEME = 'app';
const APP_HOST = 'shell';
const PAGE_PARTITION = 'persist:deepseek-harness';

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.enableSandbox();
app.commandLine.appendSwitch('disable-hid-blocklist');
app.commandLine.appendSwitch('disable-serial-blocklist');
app.commandLine.appendSwitch('disable-usb-blocklist');

let mainWindow: BrowserWindow | null = null;
let pageView: WebContentsView | null = null;
let harnessRuntime: HarnessRuntime | undefined;
let harnessProcess: ChildProcess | undefined;
let harnessUrl = 'http://127.0.0.1/';
let launchGeneration = 0;
let quitting = false;
let navigationState: ShellState = {
  currentUrl: '',
  homeUrl: '',
  title: 'DeepSeek Harness',
  loading: true,
  canGoBack: false,
  canGoForward: false,
  error: null,
  notice: '正在启动 DeepSeek Harness…',
  phase: 'starting',
};

function registerAppProtocol(): void {
  const staticDirectory = path.join(app.getAppPath(), 'app');
  const files = new Map([
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/shell.js', 'shell.js'],
    ['/styles.css', 'styles.css'],
  ]);
  protocol.handle(APP_SCHEME, (request) => {
    const requested = new URL(request.url);
    if (requested.host !== APP_HOST) return new Response('Not found', { status: 404 });
    const fileName = files.get(requested.pathname);
    if (fileName === undefined) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(staticDirectory, fileName)).toString());
  });
}

function isTrustedShellEvent(event: IpcMainInvokeEvent): boolean {
  try {
    const frame = new URL(event.senderFrame?.url ?? '');
    return frame.protocol === `${APP_SCHEME}:` && frame.host === APP_HOST;
  } catch {
    return false;
  }
}

function requireTrustedShellEvent(event: IpcMainInvokeEvent): void {
  if (!isTrustedShellEvent(event)) throw new Error('拒绝来自非壳页面的 IPC 请求。');
}

function publishState(patch: Partial<ShellState> = {}): void {
  navigationState = { ...navigationState, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shell:state-changed', navigationState);
  }
}

function updateNavigationCapabilities(): void {
  const contents = pageView?.webContents;
  if (contents === undefined || contents.isDestroyed()) return;
  publishState({
    currentUrl: contents.getURL(),
    title: contents.getTitle() || 'DeepSeek Harness',
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  });
}

function reportBlockedNavigation(targetUrl: string): void {
  let origin = targetUrl;
  try {
    origin = new URL(targetUrl).origin;
  } catch {
    // Keep the original value for an invalid URL.
  }
  publishState({ error: `已阻止跳转到 ${origin}。`, notice: null });
}

function configurePageSecurity(view: WebContentsView): void {
  const contents = view.webContents;
  const pageSession = contents.session;
  contents.on('will-navigate', (event, targetUrl) => {
    if (!isNavigationAllowed(targetUrl, harnessUrl)) {
      event.preventDefault();
      reportBlockedNavigation(targetUrl);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isNavigationAllowed(url, harnessUrl)) void contents.loadURL(url);
    else reportBlockedNavigation(url);
    return { action: 'deny' };
  });
  contents.on('did-start-loading', () => publishState({ loading: true, error: null }));
  contents.on('did-stop-loading', () => {
    publishState({ loading: false });
    updateNavigationCapabilities();
  });
  contents.on('did-navigate', updateNavigationCapabilities);
  contents.on('did-navigate-in-page', updateNavigationCapabilities);
  contents.on('page-title-updated', (_event, title) => publishState({ title }));
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) {
      publishState({ loading: false, currentUrl: validatedUrl, error: `页面加载失败：${errorDescription} (${errorCode})` });
    }
  });
  contents.on('render-process-gone', (_event, details) => {
    publishState({ loading: false, error: `页面进程已退出：${details.reason}` });
  });

  pageSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) =>
    isWebPermissionAllowed(permission, details.requestingUrl || requestingOrigin, harnessUrl));
  pageSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(isWebPermissionAllowed(permission, details.requestingUrl || webContents.getURL(), harnessUrl));
  });
  pageSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!isPrimaryPageOrigin(request.securityOrigin, harnessUrl)) {
      callback({});
      return;
    }
    void desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      const streams: Streams = {};
      if (request.videoRequested && sources[0]) streams.video = sources[0];
      if (request.audioRequested && process.platform === 'win32') streams.audio = 'loopback';
      callback(streams);
    }).catch(() => callback({}));
  });
  const handleRestrictedFileSystemAccess = (
    event: ElectronEvent,
    details: FileSystemAccessRestrictedDetails,
    callback: (action: 'allow' | 'deny' | 'tryAgain') => void,
  ): void => {
    event.preventDefault();
    if (!isPrimaryPageOrigin(details.origin, harnessUrl)) {
      callback('deny');
      return;
    }
    const options: MessageBoxOptions = {
      type: 'warning',
      title: '此位置受保护',
      message: '网页不能直接写入这个系统位置。',
      detail: details.path,
      buttons: ['选择其他位置', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const response = mainWindow
      ? dialog.showMessageBox(mainWindow, options)
      : dialog.showMessageBox(options);
    void response.then(({ response: selected }) => callback(selected === 0 ? 'tryAgain' : 'deny'));
  };
  const handleDownload = (event: ElectronEvent, item: DownloadItem, source: WebContents): void => {
    if (source !== contents || !isNavigationAllowed(contents.getURL(), harnessUrl)) {
      event.preventDefault();
      publishState({ error: '已阻止未授权页面的下载。', notice: null });
      return;
    }
    const filename = path.basename(item.getFilename()) || 'download';
    item.setSaveDialogOptions({ title: '保存文件', buttonLabel: '保存', defaultPath: path.join(app.getPath('downloads'), filename) });
    item.once('done', (_event, state) => {
      publishState(state === 'completed' ? { notice: `文件已保存：${filename}` } : { notice: '已取消保存文件。' });
    });
  };
  pageSession.on('file-system-access-restricted', handleRestrictedFileSystemAccess);
  pageSession.on('will-download', handleDownload);
  contents.once('destroyed', () => {
    pageSession.removeListener('file-system-access-restricted', handleRestrictedFileSystemAccess);
    pageSession.removeListener('will-download', handleDownload);
    pageSession.setPermissionRequestHandler(null);
    pageSession.setPermissionCheckHandler(null);
    pageSession.setDisplayMediaRequestHandler(null);
  });
}

function resizePageView(): void {
  if (!mainWindow || !pageView || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getContentBounds();
  pageView.setBounds({ x: 0, y: 0, width: Math.max(0, bounds.width), height: Math.max(0, bounds.height) });
}

function disposePageView(): void {
  const view = pageView;
  pageView = null;
  if (view === null) return;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
}

async function launchHarness(): Promise<void> {
  const generation = ++launchGeneration;
  disposePageView();
  if (harnessProcess !== undefined) {
    const previous = harnessProcess;
    harnessProcess = undefined;
    harnessRuntime = undefined;
    await stopHarness(previous);
  }
  publishState({ phase: 'starting', loading: true, error: null, notice: '正在启动 DeepSeek Harness…', currentUrl: '' });
  try {
    const configuredNode = process.env.DEEPSEEK_NODE_PATH;
    const configuredHarnessRoot = process.env.DEEPSEEK_HARNESS_ROOT;
    const packagedHarnessRoot = app.isPackaged && configuredHarnessRoot === undefined
      ? await ensurePackagedHarnessRuntime(
        path.join(process.resourcesPath, 'deepseek-harness.tar.gz'),
        path.join(process.resourcesPath, 'deepseek-harness.links.json'),
        path.join(app.getPath('userData'), 'runtime', app.getVersion()),
        process.platform === 'win32' ? path.join(process.resourcesPath, 'runtime-tools', '7za.exe') : undefined,
      )
      : undefined;
    const runtime = await startHarness({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      ...(packagedHarnessRoot === undefined ? {} : { env: { DEEPSEEK_HARNESS_ROOT: packagedHarnessRoot } }),
      ...(configuredNode !== undefined
          ? { executable: configuredNode }
          : app.isPackaged
          ? { executable: process.execPath, execArgs: ['--expose-internals'] }
          : {}),
      onSpawn: (child) => { harnessProcess = child; },
    });
    if (generation !== launchGeneration || quitting) {
      await stopHarness(runtime.process);
      return;
    }
    harnessRuntime = runtime;
    harnessProcess = runtime.process;
    harnessUrl = runtime.url;
    const view = new WebContentsView({ webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
      partition: PAGE_PARTITION,
    } });
    pageView = view;
    configurePageSecurity(view);
    await view.webContents.loadURL(runtime.url);
    if (generation !== launchGeneration || quitting) return;
    mainWindow?.contentView.addChildView(view);
    resizePageView();
    publishState({ phase: 'ready', loading: false, error: null, notice: null, homeUrl: runtime.url, currentUrl: runtime.url });
    runtime.process.once('exit', (_code, signal) => {
      if (!quitting && harnessRuntime?.process === runtime.process) {
        publishState({ phase: 'error', loading: false, error: `Harness 服务已停止${signal ? `（${signal}）` : ''}。`, notice: '请点击重试重新启动。' });
        disposePageView();
        harnessRuntime = undefined;
        harnessProcess = undefined;
      }
    });
  } catch (error) {
    if (generation !== launchGeneration || quitting) return;
    const failed = harnessProcess;
    harnessRuntime = undefined;
    harnessProcess = undefined;
    disposePageView();
    await stopHarness(failed);
    publishState({ phase: 'error', loading: false, error: error instanceof Error ? error.message : String(error), notice: '请确认 Harness 已构建后重试。' });
  }
}

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f7f8fa',
    title: 'DeepSeek Harness',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = window;
  window.setMenuBarVisibility(false);
  window.on('resize', resizePageView);
  window.on('maximize', resizePageView);
  window.on('unmaximize', resizePageView);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    disposePageView();
    mainWindow = null;
  });
  void window.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
  void launchHarness();
}

function registerIpcHandlers(): void {
  ipcMain.handle('shell:get-state', (event) => {
    requireTrustedShellEvent(event);
    return navigationState;
  });
  ipcMain.handle('shell:retry', (event) => {
    requireTrustedShellEvent(event);
    void launchHarness();
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerAppProtocol();
  registerIpcHandlers();
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('before-quit', (event) => {
  if (quitting || harnessProcess === undefined) return;
  event.preventDefault();
  quitting = true;
  ++launchGeneration;
  const child = harnessProcess;
  harnessRuntime = undefined;
  harnessProcess = undefined;
  void stopHarness(child).finally(() => {
    disposePageView();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    app.exit(0);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  const pageSession = session.fromPartition(PAGE_PARTITION);
  pageSession.setPermissionRequestHandler(null);
  pageSession.setPermissionCheckHandler(null);
  pageSession.setDisplayMediaRequestHandler(null);
});
