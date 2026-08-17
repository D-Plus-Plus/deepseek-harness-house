import assert from 'node:assert/strict';
import test from 'node:test';
import { isNavigationAllowed } from '../src/config.js';

const harnessUrl = 'http://127.0.0.1:3080';

test('navigation stays within the managed Harness origin', () => {
  assert.equal(isNavigationAllowed('http://127.0.0.1:3080/session/1', harnessUrl), true);
  assert.equal(isNavigationAllowed('http://127.0.0.1:3081', harnessUrl), false);
  assert.equal(isNavigationAllowed('http://localhost:3080', harnessUrl), false);
  assert.equal(isNavigationAllowed('https://127.0.0.1:3080', harnessUrl), false);
  assert.equal(isNavigationAllowed('javascript:alert(1)', harnessUrl), false);
});

test('about:blank is available to Chromium during view initialization', () => {
  assert.equal(isNavigationAllowed('about:blank', harnessUrl), true);
});
