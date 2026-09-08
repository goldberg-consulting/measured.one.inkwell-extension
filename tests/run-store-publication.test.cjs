const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RunStore, sha256, resolveRunSource } = require('../out/run-store');
const { runLimits } = require('../out/run-limits');

function fixture(t, limits = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-publication-'));
  fs.mkdirSync(path.join(root, '.inkwell'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceFile = path.join(root, 'document.md');
  const store = new RunStore(root, sourceFile, runLimits(limits));
  const block = { id: 'analysis', index: 0, lang: 'shell', source: 'echo source', startLine: 1, endLine: 3, raw: '' };
  store.assignBlockIds([block], true);
  return { root, sourceFile, store, block };
}

function publish(context, contents = 'first', alter = () => {}) {
  const { store, block } = context;
  const attempt = store.begin(block.id);
  const source = path.join(attempt.directory, 'source.sh');
  fs.writeFileSync(source, block.source);
  fs.writeFileSync(path.join(attempt.artifactsDir, 'result.txt'), contents);
  const fingerprint = {
    hash: sha256('fingerprint:' + contents), sourceHash: sha256(block.source), sourcePath: 'inline',
    inputs: {}, upstream: {}, interpreter: { path: '/bin/sh', version: 'test', identity: sha256('interpreter') },
    environmentHash: sha256('environment'), lockfiles: {},
  };
  const outcome = { stdout: contents, stderr: '', exitCode: 0, rawExitCode: 0, signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false };
  alter({ attempt, fingerprint, outcome });
  const manifest = store.finish(attempt, fingerprint, [source], outcome);
  return { manifest, fingerprint, outcome, directory: path.join(store.directory, block.id, 'history', attempt.runId) };
}

function rewriteCurrent(context, publication, mutate) {
  const manifest = structuredClone(publication.manifest);
  mutate(manifest);
  fs.writeFileSync(path.join(publication.directory, 'run.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(context.store.directory, context.block.id, 'current.json'), JSON.stringify({
    schemaVersion: 1, runId: manifest.runId, manifestHash: sha256(JSON.stringify(manifest)),
  }));
}

test('a complete run exposes verified files and its current generation', t => {
  const context = fixture(t);
  const result = publish(context);
  const current = context.store.currentDetails(context.block.id);
  assert.equal(current.manifest.runId, result.manifest.runId);
  assert.equal(current.manifest.generation, JSON.parse(fs.readFileSync(path.join(context.store.directory, 'document.json'))).generation);
  assert.equal(context.store.resultForManifest(context.block, result.manifest, result.fingerprint).stdout, 'first');
  context.store.confirmPublished(result.manifest);
});

for (const [name, mutate] of [
  ['failed status', value => { value.status = 'failed'; }],
  ['another document', value => { value.documentId = 'another-document'; }],
  ['missing cancellation state', value => { delete value.process.cancelled; }],
  ['null exit status', value => { value.process.rawExitCode = null; }],
  ['wrong source hash', value => { value.source.sha256 = sha256('other'); }],
  ['missing interpreter identity', value => { delete value.fingerprint.interpreter.identity; }],
  ['missing fingerprint', value => { delete value.fingerprint; }],
  ['invalid timestamp', value => { value.startedAt = 'yesterday'; }],
  ['negative file length', value => { value.stdout.bytes = -1; }],
  ['missing artifact list', value => { delete value.artifacts; }],
  ['legacy missing generation', value => { delete value.generation; }],
]) {
  test('current details reject ' + name + ' even with a matching pointer checksum', t => {
    const context = fixture(t);
    const result = publish(context);
    rewriteCurrent(context, result, mutate);
    assert.equal(context.store.currentDetails(context.block.id), undefined);
  });
}

test('invalid successful provenance is stored as failure without replacing last-good', t => {
  const context = fixture(t);
  const good = publish(context);
  context.store.confirmPublished(good.manifest);
  const pointer = path.join(context.store.directory, context.block.id, 'current.json');
  const before = fs.readFileSync(pointer);
  const failed = publish(context, 'bad', ({ fingerprint }) => { fingerprint.environmentHash = 'invalid'; });
  assert.equal(failed.manifest.status, 'failed');
  assert.notEqual(failed.outcome.exitCode, 0);
  assert.deepEqual(fs.readFileSync(pointer), before);
  assert.equal(context.store.currentDetails(context.block.id).manifest.runId, good.manifest.runId);
});

test('history changed during promotion never replaces the last complete current pointer', t => {
  const context = fixture(t);
  const good = publish(context);
  context.store.confirmPublished(good.manifest);
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    originalRename(from, to);
    if (String(from).includes(path.sep + 'staging' + path.sep) && String(to).includes(path.sep + 'history' + path.sep)) fs.appendFileSync(path.join(to, 'artifacts', 'result.txt'), 'changed');
  };
  let changed;
  try { changed = publish(context, 'second'); } finally { fs.renameSync = originalRename; }
  assert.equal(changed.manifest.status, 'failed');
  assert.notEqual(changed.outcome.exitCode, 0);
  assert.equal(context.store.currentDetails(context.block.id).manifest.runId, good.manifest.runId);
});

test('immediate verification failure restores last-good even with retention of one', t => {
  const context = fixture(t, { retentionCount: 1 });
  const good = publish(context);
  context.store.confirmPublished(good.manifest);
  const changed = publish(context, 'second');
  fs.appendFileSync(path.join(changed.directory, 'artifacts', 'result.txt'), 'changed');
  assert.equal(context.store.resultForManifest(context.block, changed.manifest, changed.fingerprint), undefined);
  assert.equal(context.store.discardPublished(changed.manifest), true);
  assert.equal(context.store.currentDetails(context.block.id).manifest.runId, good.manifest.runId);
  assert.equal(context.store.discardPublished(changed.manifest), false);
});

test('rejecting the first publication removes current without deleting its history', t => {
  const context = fixture(t);
  const changed = publish(context);
  fs.unlinkSync(path.join(changed.directory, 'stdout.txt'));
  assert.equal(context.store.discardPublished(changed.manifest), true);
  assert.equal(context.store.currentDetails(context.block.id), undefined);
  assert.equal(fs.existsSync(path.join(changed.directory, 'run.json')), true);
});

test('rejecting an older publication never overwrites a newer current result', t => {
  const context = fixture(t);
  const older = publish(context, 'older');
  const newer = publish(context, 'newer');
  assert.equal(context.store.discardPublished(older.manifest), false);
  assert.equal(context.store.currentDetails(context.block.id).manifest.runId, newer.manifest.runId);
  context.store.confirmPublished(newer.manifest);
});

test('a slower older attempt cannot replace the newer successful run', t => {
  const context = fixture(t);
  const older = context.store.begin(context.block.id);
  const source = path.join(older.directory, 'source.sh');
  fs.writeFileSync(source, context.block.source);
  fs.writeFileSync(path.join(older.artifactsDir, 'result.txt'), 'old');
  const newer = publish(context, 'new');
  context.store.confirmPublished(newer.manifest);
  const outcome = { stdout: 'old', stderr: '', exitCode: 0, rawExitCode: 0, signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false };
  const manifest = context.store.finish(older, newer.fingerprint, [source], outcome);
  assert.equal(manifest.status, 'failed');
  assert.notEqual(outcome.exitCode, 0);
  assert.match(outcome.error, /superseded/);
  assert.equal(context.store.currentDetails(context.block.id).manifest.runId, newer.manifest.runId);
});

test('a pending or failed newer attempt preserves the previous successful pointer', t => {
  const context = fixture(t);
  const good = publish(context);
  context.store.confirmPublished(good.manifest);
  const newer = context.store.begin(context.block.id);
  assert.equal(context.store.currentDetails(context.block.id).manifest.runId, good.manifest.runId);
  const source = path.join(newer.directory, 'source.sh');
  fs.writeFileSync(source, context.block.source);
  const outcome = { stdout: '', stderr: 'failed', exitCode: 7, rawExitCode: 7, signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false };
  context.store.finish(newer, good.fingerprint, [source], outcome);
  assert.equal(context.store.currentDetails(context.block.id).manifest.runId, good.manifest.runId);
});

test('deleted or malformed identity maps cannot inject history or revive it after recreation', t => {
  const context = fixture(t);
  const result = publish(context);
  context.store.confirmPublished(result.manifest);
  const identity = path.join(context.store.directory, 'document.json');
  fs.writeFileSync(identity, '{malformed');
  assert.equal(context.store.currentDetails(context.block.id), undefined);
  fs.unlinkSync(identity);
  assert.equal(context.store.resultForManifest(context.block, result.manifest, result.fingerprint), undefined);
  const recreated = new RunStore(context.root, context.sourceFile);
  recreated.assignBlockIds([context.block], true);
  assert.equal(recreated.currentDetails(context.block.id), undefined);
  assert.equal(recreated.current(context.block, context.block.id, result.fingerprint), undefined);
  assert.equal(fs.existsSync(path.join(result.directory, 'run.json')), true);
});

test('missing archived source and generated-file symlinks cannot be current', t => {
  const context = fixture(t);
  const result = publish(context);
  fs.unlinkSync(path.join(result.directory, 'source.sh'));
  assert.equal(context.store.currentDetails(context.block.id), undefined);
  fs.writeFileSync(path.join(result.directory, 'source.sh'), context.block.source);
  const artifact = path.join(result.directory, 'artifacts', 'result.txt');
  const replacement = path.join(context.root, 'replacement.txt');
  fs.writeFileSync(replacement, 'first');
  fs.unlinkSync(artifact);
  fs.symlinkSync(replacement, artifact);
  assert.equal(context.store.currentDetails(context.block.id), undefined);
});

test('changing captured stdout during validation cannot return unverified text', t => {
  const context = fixture(t);
  const result = publish(context);
  const stdout = path.join(result.directory, 'stdout.txt');
  const inode = fs.statSync(stdout).ino;
  const originalRead = fs.readSync;
  let changed = false;
  fs.readSync = (descriptor, ...args) => {
    const count = originalRead(descriptor, ...args);
    if (!changed && fs.fstatSync(descriptor).ino === inode) { changed = true; fs.writeFileSync(stdout, 'other'); }
    return count;
  };
  try { assert.equal(context.store.resultForManifest(context.block, result.manifest, result.fingerprint), undefined); }
  finally { fs.readSync = originalRead; }
  assert.equal(changed, true);
});

test('canonical extracted scripts ignore nested shadows while ordinary scripts keep legacy precedence', t => {
  const { root } = fixture(t);
  const nested = path.join(root, 'chapter');
  for (const base of [root, nested]) {
    fs.mkdirSync(path.join(base, '.inkwell', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(base, '.inkwell', 'scripts', 'analysis.sh'), base);
    fs.writeFileSync(path.join(base, 'legacy.sh'), base);
  }
  for (const name of ['.inkwell/scripts/analysis.sh', './.inkwell/scripts/analysis.sh']) {
    assert.equal(resolveRunSource(name, nested, root), path.join(root, '.inkwell', 'scripts', 'analysis.sh'));
  }
  assert.equal(resolveRunSource('legacy.sh', nested, root), path.join(nested, 'legacy.sh'));
});
