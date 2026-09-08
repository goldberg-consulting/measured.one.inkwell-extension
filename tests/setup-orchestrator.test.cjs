const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSetupOrchestrator, createFileSetupStore, hashInstallPlan } = require('../out/setup-orchestrator');

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const plan = (id = 'pandoc') => ({ id, title: `Install ${id}`, steps: [{ id, label: id,
  command: '/opt/homebrew/bin/brew', args: ['install', id], verificationIds: [`tool:${id}`] }] });
const report = (ids = []) => ({ mode: 'full', fingerprint: ids.join(','), ready: false, status: 'warning',
  checks: [...ids.map(id => ({ id: `tool:${id}`, required: true, status: 'ok', message: 'Present' })),
    { id: 'smoke-compile', required: true, status: 'skipped', message: 'Pending' },
    { id: 'workspace', required: true, status: 'error', message: 'Not scaffolded' }] });
function harness(overrides = {}) {
  let saved;
  const writes = [], calls = [];
  const deps = {
    store: { load: async () => clone(saved), save: async state => { saved = clone(state); writes.push(clone(state)); } },
    doctor: async () => { calls.push('doctor'); return report(['pandoc']); },
    plan: async () => ({ id: 'ready', title: 'Tools ready', steps: [] }),
    consent: async () => { calls.push('consent'); return true; },
    install: async () => { calls.push('install'); return { exitCode: 0, rawExitCode: 0 }; },
    readiness: async () => { calls.push('readiness'); return { ready: true }; },
    smoke: async () => { calls.push('smoke'); return { success: true, verified: true }; },
    ...overrides,
  };
  return { deps, calls, writes, run: options => createSetupOrchestrator(deps).run({ projectRoot: '/tmp/isolated-project', ...options }), get state() { return clone(saved); } };
}

test('setup requires fresh probes, scaffold readiness and verified smoke before completing', async () => {
  const h = harness();
  const state = await h.run();
  assert.equal(state.status, 'complete');
  assert.deepEqual(h.calls, ['doctor', 'doctor', 'readiness', 'smoke']);
  assert.equal(state.stages['smoke-compile'].status, 'succeeded');
  assert.equal(state.stages.complete.status, 'succeeded');
  assert.equal(h.writes.some(s => s.status === 'complete' && s.stages['smoke-compile'].status !== 'succeeded'), false);
});

test('declined consent performs no installation or scaffold writes', async () => {
  const h = harness({ plan: async () => plan(), consent: async () => false });
  const state = await h.run();
  assert.equal(state.status, 'awaiting-consent');
  assert.equal(state.consent, undefined);
  assert.equal(h.calls.includes('install'), false);
  assert.equal(h.calls.includes('readiness'), false);
});

test('consent sees an immutable exact plan and process completion waits for fresh verification', async () => {
  let probes = 0;
  const mutablePlan = plan();
  const h = harness({ doctor: async () => { probes++; return report(['pandoc']); }, plan: async () => probes === 1 ? mutablePlan : { id: 'ready', title: 'Ready', steps: [] },
    consent: async (approved, hash) => { assert.equal(hash, hashInstallPlan(approved)); assert.ok(Object.isFrozen(approved.steps[0].args)); mutablePlan.steps[0].args.push('unapproved'); return true; },
    install: async approved => { assert.deepEqual(approved.steps[0].args, ['install', 'pandoc']); assert.equal(h.state.stages.install.status, 'running'); return { exitCode: 0 }; },
  });
  assert.equal((await h.run()).status, 'complete');
  assert.equal(probes, 2);
});

test('successful installation exit with missing verified tool fails and retains diagnostics', async () => {
  const h = harness({ doctor: async () => report(), plan: async () => plan(), install: async (_plan, ctx) => { ctx.onLog('installer detail'); return { exitCode: 0, stdout: 'process finished' }; } });
  const state = await h.run();
  assert.equal(state.status, 'failed');
  assert.equal(state.stages.install.status, 'failed');
  assert.ok(state.logs.some(entry => entry.message.includes('installer detail')));
  assert.equal(h.calls.includes('smoke'), false);
});

for (const outcome of [{ exitCode: 1 }, { exitCode: 0, rawExitCode: null }, { exitCode: 0, signal: 'SIGTERM' }, { exitCode: 0, timedOut: true }, { exitCode: 0, maxBufferExceeded: true }]) {
  test(`failed process outcome cannot become successful: ${JSON.stringify(outcome)}`, async () => {
    const h = harness({ plan: async () => plan(), install: async () => outcome });
    const state = await h.run();
    assert.equal(state.status, 'failed');
    assert.equal(state.stages.install.status, 'failed');
    assert.equal(h.calls.includes('readiness'), false);
  });
}

test('cancelled setup persists logs and resumes with unchanged authorization', async () => {
  let installs = 0, consents = 0;
  const h = harness({ plan: async () => plan(), consent: async () => { consents++; return true; },
    install: async (_plan, ctx) => { installs++; ctx.onLog(`attempt ${installs}`); return installs === 1 ? { exitCode: null, cancelled: true } : { exitCode: 0 }; } });
  assert.equal((await h.run()).status, 'cancelled');
  assert.equal((await h.run()).status, 'complete');
  assert.equal(consents, 1);
  assert.equal(h.state.stages.install.attempts, 2);
  assert.ok(h.state.logs.some(entry => entry.message === 'attempt 1'));
});

test('changed installation plans require new consent on resume', async () => {
  let selected = plan(), consents = 0;
  const h = harness({ plan: async () => selected, consent: async () => { consents++; return consents === 1; },
    install: async () => ({ exitCode: 1 }) });
  await h.run();
  selected = plan('tex');
  const second = await h.run();
  assert.equal(second.status, 'awaiting-consent');
  assert.equal(consents, 2);
  assert.equal(second.consent, undefined);
});

test('an interrupted persisted install is re-probed and resumed without fabricated success', async () => {
  let saved, consents = 0, installs = 0;
  const store = { load: async () => clone(saved), save: async state => { saved = clone(state); } };
  const first = harness({ store, plan: async () => plan(), consent: async () => { consents++; return true; },
    install: async () => { installs++; return { exitCode: 1 }; } });
  await first.run();
  saved.status = 'running'; saved.stages.install.status = 'running';
  const resumed = harness({ store, plan: async () => plan(), consent: async () => { consents++; return true; },
    install: async () => { installs++; return { exitCode: 0 }; } });
  const state = await resumed.run();
  assert.equal(state.status, 'complete');
  assert.equal(consents, 1); assert.equal(installs, 2);
  assert.ok(state.logs.some(entry => /Interrupted install/.test(entry.message)));
  assert.deepEqual(resumed.calls, ['doctor', 'doctor', 'readiness', 'smoke']);
});

test('failed durable consent storage prevents the authorized process from starting', async () => {
  let installs = 0;
  const h = harness({ store: { load: async () => undefined, save: async state => { if (state.consent) throw new Error('Disk full'); } },
    plan: async () => plan(), install: async () => { installs++; return { exitCode: 0 }; } });
  await assert.rejects(() => h.run(), /Disk full/);
  assert.equal(installs, 0);
});

test('a previously complete setup requires a new smoke verification on resume', async () => {
  let smokes = 0;
  const h = harness({ smoke: async () => ({ success: ++smokes === 1, verified: smokes === 1 }) });
  assert.equal((await h.run()).status, 'complete');
  assert.equal((await h.run()).status, 'failed');
  assert.equal(smokes, 2);
  assert.equal(h.state.stages.complete.status, 'pending');
});

test('a different concurrent request cannot inherit success without executing its requested plan', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const first = harness({ smoke: async () => pending });
  const active = first.run();
  await new Promise(resolve => setImmediate(resolve));
  const packageRequest = harness({ plan: async () => plan('booktabs') });
  await assert.rejects(() => packageRequest.run(), /already running/);
  assert.deepEqual(packageRequest.calls, []);
  release({ success: true, verified: true });
  assert.equal((await active).status, 'complete');
});

test('newly discovered installation requirements receive their own exact consent', async () => {
  let probes = 0;
  const approved = [], installed = [];
  const h = harness({ doctor: async () => report(++probes === 1 ? [] : probes === 2 ? ['pandoc'] : ['pandoc', 'tex']),
    plan: async r => r.checks.some(c => c.id === 'tool:tex') ? { id: 'ready', title: 'Ready', steps: [] } : plan(r.checks.some(c => c.id === 'tool:pandoc') ? 'tex' : 'pandoc'),
    consent: async p => { approved.push(p.id); return true; }, install: async p => { installed.push(p.id); return { exitCode: 0 }; } });
  assert.equal((await h.run()).status, 'complete');
  assert.deepEqual(approved, ['pandoc', 'tex']); assert.deepEqual(installed, approved);
});

test('unverified smoke or failed scaffold cannot complete setup', async () => {
  const smoke = harness({ smoke: async () => ({ success: true, verified: false, logs: ['No new PDF'] }) });
  assert.equal((await smoke.run()).status, 'failed');
  const scaffold = harness({ readiness: async () => ({ ready: false, diagnostics: [{ message: 'Conflict', severity: 'error' }], actions: [{ id: 'compare', label: 'Compare files' }] }) });
  assert.equal((await scaffold.run()).status, 'failed');
  assert.equal(scaffold.calls.includes('smoke'), false);
  assert.equal(scaffold.state.actions[0].id, 'compare');
});

test('shell wrapper plans are rejected before consent', async () => {
  const p = plan(); p.steps[0].command = '/bin/sh'; p.steps[0].args = ['-c', 'brew install pandoc'];
  const h = harness({ plan: async () => p });
  assert.equal((await h.run()).status, 'failed');
  assert.equal(h.calls.includes('consent'), false);
});

test('file state persists atomically and malformed existing data remains unchanged', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-setup-state-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const file = path.join(dir, 'state.json');
  const store = createFileSetupStore(file);
  const h = harness({ store });
  assert.equal((await h.run()).status, 'complete');
  assert.equal((await store.load()).status, 'complete');
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  fs.writeFileSync(file, '{broken');
  await assert.rejects(() => store.load(), /state|JSON|parse/i);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('failed atomic setup-state replacement preserves the prior file and removes temporary files', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-setup-rename-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const file = path.join(dir, 'state.json');
  const store = createFileSetupStore(file);
  await harness({ store }).run();
  const bytes = fs.readFileSync(file);
  const state = await store.load(); state.status = 'running';
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === file) throw new Error('Rename refused'); return originalRename(from, to); };
  try { await assert.rejects(() => store.save(state), /Rename refused/); } finally { fs.renameSync = originalRename; }
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});
