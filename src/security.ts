function sameOrigin(firstUrl: string, secondUrl: string): boolean {
  try {
    return new URL(firstUrl).origin === new URL(secondUrl).origin;
  } catch {
    return false;
  }
}

export function isWebPermissionAllowed(
  permission: string,
  requestingUrl: string,
  harnessUrl: string,
): boolean {
  return permission.length > 0 && sameOrigin(requestingUrl, harnessUrl);
}

export function isPrimaryPageOrigin(requestingUrl: string, harnessUrl: string): boolean {
  return sameOrigin(requestingUrl, harnessUrl);
}
