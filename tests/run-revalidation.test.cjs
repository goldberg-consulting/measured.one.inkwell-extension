const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const workspace = { isTrusted: true, getWorkspaceFolder: () => undefined };
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'vscode') return { Uri: { file: fsPath => ({ fsPath }) }, workspace,
    window: { createOutputChannel: () => ({ appendLine() {} }) } };
  return originalLoad.call(this, request, ...args);
};
const { runAllBlocks, readCurrentRunResults } = require('../out/runner');
const { RunStore } = require('../out/run-store');
Module._load = originalLoad;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-run-revalidation-'));
  fs.mkdirSync(path.join(root, '.inkwell'));
  t.after(() => { workspace.isTrusted = true; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, source: path.join(root, 'doc.md') };
}
const fence = (lang, id, body, attrs = '') => '```{' + lang + ' id="' + id + '" ' + attrs + '}\n' + body + '\n```';

test('untrusted cached-result reads start no document-selected interpreter probes', t => {
  const { root, source } = fixture(t);
  const fake = path.join(root, 'untrusted-node');
  fs.writeFileSync(fake, '#!/bin/sh\ntouch "' + root + '/executed"\necho FakeVersion\n', { mode: 0o755 });
  workspace.isTrusted = false;
  const [result] = readCurrentRunResults(fence('node', 'safe', 'console.log(1)', 'env="untrusted-node"'), source);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Trust/);
  assert.equal(fs.existsSync(path.join(root, 'executed')), false);
  assert.deepEqual(fs.readdirSync(path.join(root, '.inkwell')), []);
});

test('changed interpreter selection before spawn cannot execute under old provenance', async t => {
  const { root, source } = fixture(t);
  const fake = path.join(root, 'env-node');
  const text = fence('node', 'runtime', 'console.log("REAL")', 'env="env-node"');
  const [result] = await runAllBlocks(text, source, undefined, progress => {
    if (progress.status === 'running') fs.writeFileSync(fake,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo FakeVersion; else touch "' + root + '/executed"; echo FAKE; fi\n', { mode: 0o755 });
  });
  assert.notEqual(result.exitCode, 0);
  assert.equal(fs.existsSync(path.join(root, 'executed')), false);
  assert.match(result.stderr, /interpreter selection changed/);
  assert.equal(new RunStore(root, source).currentDetails('runtime'), undefined);
});

test('project-selected interpreters cannot escape through absolute paths, traversal, or symlinks', async t => {
  const { root, source } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-external-interpreter-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const fake = path.join(outside, 'node');
  fs.writeFileSync(fake, '#!/bin/sh\ntouch "' + root + '/executed"\necho Fake\n', { mode: 0o755 });
  fs.symlinkSync(fake, path.join(root, 'escape-node'));
  for (const env of [fake, '../' + path.basename(outside) + '/node', 'escape-node']) {
    const [result] = await runAllBlocks(fence('node', 'unsafe', 'console.log(1)', `env="${env}"`), source);
    assert.notEqual(result.exitCode, 0, env);
    assert.equal(fs.existsSync(path.join(root, 'executed')), false, env);
  }
});

test('upstream input mutation during downstream execution cannot publish downstream success', async t => {
  const { root, source } = fixture(t);
  const input = path.join(root, 'input.txt'); fs.writeFileSync(input, 'old');
  const text = fence('shell', 'prepare', 'cat input.txt', 'inputs="input.txt"') + '\n\n' +
    fence('shell', 'analysis', 'echo result', 'depends-on="prepare"');
  const results = await runAllBlocks(text, source, undefined, progress => {
    if (progress.index === 1 && progress.status === 'running') fs.writeFileSync(input, 'new');
  });
  assert.equal(results[0].exitCode, 0);
  assert.notEqual(results[1].exitCode, 0);
  assert.match(results[1].stderr, /Upstream dependency changed/);
  assert.equal(new RunStore(root, source).currentDetails('analysis'), undefined);
});

test('failure to verify a completed result never emits done and restores last successful pointer', async t => {
  const { root, source } = fixture(t);
  const text = fence('shell', 'result', 'echo old > "$INKWELL_OUTPUT_DIR/value.txt"');
  const [first] = await runAllBlocks(text, source); assert.equal(first.exitCode, 0);
  const originalFinish = RunStore.prototype.finish;
  RunStore.prototype.finish = function (...args) {
    const manifest = originalFinish.apply(this, args);
    if (manifest.status === 'success') {
      fs.appendFileSync(path.join(this.directory, manifest.blockId, 'history', manifest.runId, manifest.artifacts[0].path), 'tampered');
    }
    return manifest;
  };
  t.after(() => { RunStore.prototype.finish = originalFinish; });
  const statuses = [];
  const [failed] = await runAllBlocks(text.replace('echo old', 'echo new'), source, undefined, progress => statuses.push(progress.status));
  assert.notEqual(failed.exitCode, 0);
  assert.equal(failed.artifacts.size, 0);
  assert.equal(statuses.includes('done'), false);
  assert.equal(new RunStore(root, source).currentDetails('result').manifest.runId, first.runId);
});
