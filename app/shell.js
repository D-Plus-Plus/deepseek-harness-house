const statusElement = document.querySelector('#launch-status');
const errorElement = document.querySelector('#launch-error');
const retryButton = document.querySelector('#retry');
const progressBar = document.querySelector('#progress-bar');
const versionElement = document.querySelector('#version-info');

function renderVersion(info) {
  const appVersion = info?.app?.version ? `v${info.app.version}` : null;
  const harnessVersion = info?.harness?.packageVersion
    ? `Harness ${info.harness.packageVersion}`
    : null;
  const parts = [appVersion, harnessVersion].filter(Boolean);
  if (parts.length > 0) versionElement.textContent = parts.join(' · ');
  else versionElement.hidden = true;
}

async function loadVersion() {
  try {
    const response = await fetch('build-info.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderVersion(await response.json());
  } catch {
    versionElement.hidden = true;
  }
}

function render(state) {
  const isError = state.phase === 'error';
  const isReady = state.phase === 'ready';
  statusElement.textContent = isError
    ? (state.notice || 'Harness 启动失败')
    : isReady
      ? '正在载入工作区'
      : (state.notice || '正在启动本地工作区');
  errorElement.textContent = state.error || '';
  errorElement.hidden = !isError || !state.error;
  retryButton.hidden = !isError;
  progressBar.classList.toggle('complete', isReady);
  progressBar.classList.toggle('failed', isError);
}

retryButton.addEventListener('click', () => {
  retryButton.disabled = true;
  window.shellApi.retry().finally(() => { retryButton.disabled = false; });
});

window.shellApi.onStateChanged(render);
window.shellApi.getState().then(render).catch((error) => {
  render({ phase: 'error', error: `无法读取启动状态：${error.message}`, notice: '请重新启动应用。' });
});
void loadVersion();
