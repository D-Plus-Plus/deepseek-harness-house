const statusElement = document.querySelector('#launch-status');
const errorElement = document.querySelector('#launch-error');
const retryButton = document.querySelector('#retry');
const progressBar = document.querySelector('#progress-bar');

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
