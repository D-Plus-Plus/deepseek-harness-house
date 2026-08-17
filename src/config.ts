/** Allow only HTTP navigation within the one managed Harness origin. */
export function isNavigationAllowed(targetUrl: string, harnessUrl: string): boolean {
  if (targetUrl === 'about:blank') return true;
  try {
    const target = new URL(targetUrl);
    const harness = new URL(harnessUrl);
    return target.protocol === 'http:'
      && target.hostname === '127.0.0.1'
      && target.origin === harness.origin;
  } catch {
    return false;
  }
}
