import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MathUtils } from '../vendor/three/build/three.module.js';

test('UUIDs use secure randomness and retain UUID v4 format', () => {
  const original = Math.random;
  Math.random = () => { throw new Error('insecure randomness'); };
  try {
    const first = MathUtils.generateUUID();
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(first, MathUtils.generateUUID());
  } finally { Math.random = original; }
});

test('404 project roots require a github.io domain boundary', () => {
  const html = readFileSync(new URL('../404.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const [hostname, expected] of [['user.github.io', '/reposense/#/owner/repo'], ['evilgithub.io', '/']]) {
    let target;
    vm.runInNewContext(script, { location: { hostname, pathname: '/reposense/owner/repo', hash: '', replace: (value) => { target = value; } } });
    assert.equal(target, expected);
  }
});
