const test = require('node:test');
const assert = require('node:assert/strict');
const { CompileCoordinator } = require('../out/compile-coordinator');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const request = (key, version, interval = false, signature = `${key}:${version}`) => ({ key, version, signature, value: version, interval });

test('newest pending version wins per URI while unrelated documents retain their queue slots', async () => {
  const hold = deferred(), runs = [], currents = [];
  const coordinator = new CompileCoordinator(async (item, current) => {
    runs.push([item.key, item.version]); currents.push(current);
    if (runs.length === 1) await hold.promise;
    return true;
  }, Boolean);
  const first = coordinator.request(request('a', 1));
  const old = coordinator.request(request('a', 2));
  const unrelated = coordinator.request(request('b', 1));
  const newest = coordinator.request(request('a', 3));
  assert.equal(await old, undefined);
  assert.equal(currents[0](), false);
  hold.resolve();
  await Promise.all([first, unrelated, newest]);
  assert.deepEqual(runs, [['a', 1], ['a', 3], ['b', 1]]);
});

test('same identity shares work; unchanged interval does zero work; explicit requests still compile', async () => {
  const hold = deferred(); let calls = 0;
  const coordinator = new CompileCoordinator(async () => { calls++; await hold.promise; return true; }, Boolean);
  const one = coordinator.request(request('a', 1));
  assert.equal(coordinator.request(request('a', 1)), one);
  hold.resolve(); await one;
  assert.equal(await coordinator.request(request('a', 1, true)), undefined);
  assert.equal(calls, 1);
  await coordinator.request(request('a', 1));
  assert.equal(calls, 2);
  await coordinator.request(request('a', 1, true, 'changed-reference-template-or-run-input'));
  assert.equal(calls, 3);
});

test('failed builds, missing/tampered PDFs, and invalidation cannot produce an interval cache hit', async () => {
  let calls = 0, success = false, valid = true;
  const coordinator = new CompileCoordinator(async () => { calls++; return success; }, Boolean, () => valid);
  await coordinator.request(request('a', 1));
  await coordinator.request(request('a', 1, true));
  assert.equal(calls, 2);
  success = true; await coordinator.request(request('a', 1));
  valid = false; await coordinator.request(request('a', 1, true));
  assert.equal(calls, 4);
  valid = true; coordinator.invalidate('a');
  await coordinator.request(request('a', 1, true));
  assert.equal(calls, 5);
});

test('errors drain other documents, and disposing resolves pending waiters without starting work', async () => {
  const hold = deferred(); const runs = [];
  const coordinator = new CompileCoordinator(async item => {
    runs.push(item.key); if (item.key === 'a') { await hold.promise; throw new Error('failed'); } return true;
  }, Boolean);
  const first = coordinator.request(request('a', 1));
  const rejection = assert.rejects(first, /failed/);
  const second = coordinator.request(request('b', 1)); hold.resolve();
  await rejection; await second;
  assert.deepEqual(runs, ['a', 'b']);
  coordinator.dispose();
  assert.equal(await coordinator.request(request('c', 1)), undefined);
  assert.equal(runs.length, 2);
});

test('an unchanged interval queued behind another document is skipped when its slot arrives', async () => {
  const hold = deferred(); const runs = [];
  const coordinator = new CompileCoordinator(async item => { runs.push(item.key); if (item.key === 'b') await hold.promise; return true; }, Boolean);
  await coordinator.request(request('a', 1));
  const b = coordinator.request(request('b', 1));
  const a = coordinator.request(request('a', 1, true));
  hold.resolve(); await Promise.all([a, b]);
  assert.deepEqual(runs, ['a', 'b']);
});

test('an explicit request promotes an already queued interval request', async () => {
  const hold = deferred(); const runs = [];
  const coordinator = new CompileCoordinator(async item => { runs.push(item.key); if (item.key === 'b') await hold.promise; return true; }, Boolean);
  await coordinator.request(request('a', 1));
  const b = coordinator.request(request('b', 1));
  const interval = coordinator.request(request('a', 1, true));
  const manual = coordinator.request(request('a', 1));
  assert.equal(interval, manual);
  hold.resolve(); await Promise.all([b, interval, manual]);
  assert.deepEqual(runs, ['a', 'b', 'a']);
});

test('a duplicate active request cannot evict a newer queued source version', async () => {
  const hold = deferred(); const runs = [];
  const coordinator = new CompileCoordinator(async item => { runs.push(item.version); if (item.version === 1) await hold.promise; return true; }, Boolean);
  const first = coordinator.request(request('a', 1));
  const next = coordinator.request(request('a', 2));
  assert.equal(coordinator.request(request('a', 1)), first);
  hold.resolve(); await Promise.all([first, next]);
  assert.deepEqual(runs, [1, 2]);
});

test('interval validation receives the exact successful result, so a different published PDF forces rebuilding', async () => {
  let outputHash = 'first', calls = 0;
  const coordinator = new CompileCoordinator(async () => { calls++; return { success: true, outputHash }; }, result => result.success,
    (_request, result) => result.outputHash === outputHash);
  await coordinator.request(request('a', 1));
  assert.equal(await coordinator.request(request('a', 1, true)), undefined);
  outputHash = 'separate-preview-build';
  await coordinator.request(request('a', 1, true));
  assert.equal(calls, 2);
});
