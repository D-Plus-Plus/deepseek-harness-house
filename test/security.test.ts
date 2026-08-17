import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrimaryPageOrigin, isWebPermissionAllowed } from '../src/security.js';

const harnessUrl = 'http://127.0.0.1:3080';

test('the managed Harness origin receives requested web permissions', () => {
  for (const permission of ['fileSystem', 'media', 'clipboard-read', 'display-capture']) {
    assert.equal(
      isWebPermissionAllowed(permission, 'http://127.0.0.1:3080/editor', harnessUrl),
      true,
      permission,
    );
  }
});

test('every other origin is rejected', () => {
  assert.equal(isWebPermissionAllowed('fileSystem', 'http://127.0.0.1:3081', harnessUrl), false);
  assert.equal(isWebPermissionAllowed('fileSystem', 'https://example.com', harnessUrl), false);
  assert.equal(isPrimaryPageOrigin('https://example.com', harnessUrl), false);
});
