const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const cp = require('node:child_process');

// Only the editor boundary is mocked. Every fixture lives outside the repository.
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'vscode') return {
    Uri: { file: fsPath => ({ fsPath }) },
    workspace: { getWorkspaceFolder: () => undefined },
    window: { createOutputChannel: () => ({ appendLine() {} }) },
  };
  return originalLoad.call(this, request, ...args);
};
const runner = require('../out/runner');
const { gatherCachedResults, prepareForPreview } = require('../out/inject');
const { clearCache } = require('../out/cache');
const { getInkwellOutputsDir } = require('../out/config');
Module._load = originalLoad;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-run-test-'));
  fs.mkdirSync(path.join(root, '.inkwell', 'scripts'), { recursive: true });
  const source = path.join(root, 'document.md');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, source };
}
const fence = (body, attrs = '') => '```{shell ' + attrs + '}\n' + body + '\n```';

test('stale source cannot inject stdout from the last successful run', async t => {
  const { source } = fixture(t);
  await runner.runAllBlocks(fence('echo OLD_VALUE'), source);
  const changed = fence('echo NEW_VALUE');
  assert.equal(gatherCachedResults(changed, source)[0].cacheStatus, 'miss');
  assert.doesNotMatch(prepareForPreview(changed, source), /OLD_VALUE/);
});

test('failed attempts cannot fabricate success or publish their partial files', async t => {
  const { source } = fixture(t);
  const markdown = fence('echo partial > "$INKWELL_OUTPUT_DIR/partial.txt"\necho BAD_VALUE\nexit 7');
  const [result] = await runner.runAllBlocks(markdown, source);
  assert.equal(result.exitCode, 7);
  assert.equal(result.artifacts.size, 0);
  assert.equal(gatherCachedResults(markdown, source)[0].cacheStatus, 'miss');
});

test('insertion and reordering never attach the output of another block', async t => {
  const { source } = fixture(t);
  const a = fence('echo ALPHA');
  const b = fence('echo BETA');
  const original = await runner.runAllBlocks(a + '\n\n' + b, source);
  const results = gatherCachedResults(fence('echo NEW') + '\n\n' + b + '\n\n' + a, source);
  assert.equal(results[0].cacheStatus, 'miss');
  assert.equal(results[1].stdout.trim(), 'BETA');
  assert.equal(results[2].cacheStatus, 'miss'); // Its legacy INKWELL_BLOCK_INDEX changed.
  const rerun = await runner.runAllBlocks(fence('echo NEW') + '\n\n' + b + '\n\n' + a, source);
  assert.equal(rerun[2].blockId, original[0].blockId);
  assert.equal(rerun[2].stdout.trim(), 'ALPHA');
});

test('clearing removes every injectable generated output and preserves user scripts', async t => {
  const { root, source } = fixture(t);
  const script = path.join(root, '.inkwell', 'scripts', 'owned.sh');
  fs.writeFileSync(script, 'echo owned\n');
  const markdown = fence('echo CACHED_VALUE');
  await runner.runAllBlocks(markdown, source);
  clearCache(getInkwellOutputsDir(source));
  assert.equal(gatherCachedResults(markdown, source)[0].cacheStatus, 'miss');
  assert.equal(fs.readFileSync(script, 'utf8'), 'echo owned\n');
});

for (const reason of ['timeout', 'maxBuffer', 'signal', 'cancelled']) {
  test(reason + ' cannot be recorded as a clean process exit', async t => {
    const { root } = fixture(t);
    const originalExec = cp.execFile;
    const originalSpawn = cp.spawn;
    const cancellation = new runner.RunCancellation();
    const mockProcess = callback => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => true;
      queueMicrotask(() => {
        if (reason === 'cancelled') cancellation.cancel();
        const error = Object.assign(new Error(reason), {
          code: reason === 'maxBuffer' ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : null,
          signal: 'SIGTERM', killed: true,
        });
        if (callback) callback(error, '', reason);
        else proc.emit('error', error);
        proc.emit('close', reason === 'maxBuffer' ? 0 : null, 'SIGTERM');
      });
      return proc;
    };
    cp.execFile = (_cmd, _args, _options, callback) => mockProcess(callback);
    cp.spawn = () => mockProcess();
    t.after(() => { cp.execFile = originalExec; cp.spawn = originalSpawn; });
    const [block] = runner.parseCodeBlocks(fence('echo hello'));
    const result = await runner.runBlock(block, root, root, path.join(root, 'attempt'), cancellation);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.artifacts.size, 0);
  });
}

test('current provenance covers external scripts, declared inputs, lockfiles, and environment', async t => {
  const { root, source } = fixture(t);
  const script = path.join(root, '.inkwell', 'scripts', 'run.sh');
  const input = path.join(root, 'input.txt');
  const lock = path.join(root, 'requirements.txt');
  fs.writeFileSync(script, 'echo SCRIPT_ONE\n');
  fs.writeFileSync(input, 'one');
  const markdown = fence('', 'id=script file=".inkwell/scripts/run.sh" inputs="input.txt"');
  await runner.runAllBlocks(markdown, source);
  assert.equal(gatherCachedResults(markdown, source)[0].cacheStatus, 'hit');
  fs.writeFileSync(script, 'echo SCRIPT_TWO\n');
  assert.equal(gatherCachedResults(markdown, source)[0].cacheStatus, 'miss');
  await runner.runAllBlocks(markdown, source);
  fs.writeFileSync(input, 'two');
  assert.equal(gatherCachedResults(markdown, source)[0].cacheStatus, 'miss');
  await runner.runAllBlocks(markdown, source);
  fs.writeFileSync(lock, 'some-package==1.0\n');
  assert.equal(gatherCachedResults(markdown, source)[0].cacheStatus, 'miss');
  await runner.runAllBlocks(markdown, source);
  process.env.INKWELL_TEST_RUNTIME = 'one';
  t.after(() => { delete process.env.INKWELL_TEST_RUNTIME; });
  // Relevant user environment must not be exempted just because its name starts with INKWELL.
  assert.equal(gatherCachedResults(markdown, source)[0].cacheStatus, 'miss');
});

test('only current manifest-listed, hash-validated artifacts can be injected', async t => {
  const { root, source } = fixture(t);
  const markdown = fence('echo listed > "$INKWELL_OUTPUT_DIR/result.txt"', 'id=artifacts');
  const [first] = await runner.runAllBlocks(markdown, source);
  const artifact = first.artifacts.get('result');
  assert.ok(artifact);
  fs.writeFileSync(path.join(path.dirname(artifact), 'unlisted.txt'), 'never published');
  assert.equal(gatherCachedResults(markdown, source)[0].artifacts.has('unlisted'), false);
  fs.writeFileSync(artifact, 'tampered');
  assert.equal(gatherCachedResults(markdown, source)[0].cacheStatus, 'miss');
  fs.mkdirSync(path.join(root, '.inkwell', 'outputs', 'document', 'block_0'), { recursive: true });
  fs.writeFileSync(path.join(root, '.inkwell', 'outputs', 'document', 'block_0', 'stdout.txt'), 'legacy forged success');
  assert.doesNotMatch(prepareForPreview(markdown, source), /legacy forged success/);
});

test('new successes remove old artifact names and failures preserve the current pointer and history', async t => {
  const { source } = fixture(t);
  const firstMarkdown = fence('echo old > "$INKWELL_OUTPUT_DIR/old.txt"', 'id=stable');
  const [first] = await runner.runAllBlocks(firstMarkdown, source);
  const historyDir = path.dirname(path.dirname(first.artifacts.get('old')));
  const blockDir = path.dirname(path.dirname(historyDir));
  const firstManifest = fs.readFileSync(path.join(historyDir, 'run.json'));
  const secondMarkdown = fence('echo new > "$INKWELL_OUTPUT_DIR/new.txt"', 'id=stable');
  const [second] = await runner.runAllBlocks(secondMarkdown, source);
  assert.equal(second.blockId, first.blockId);
  assert.equal(second.artifacts.has('old'), false);
  assert.ok(second.artifacts.has('new'));
  const before = fs.readFileSync(path.join(blockDir, 'current.json'));
  await runner.runAllBlocks(fence('echo partial > "$INKWELL_OUTPUT_DIR/new.txt"\nexit 2', 'id=stable'), source);
  assert.deepEqual(fs.readFileSync(path.join(blockDir, 'current.json')), before);
  assert.deepEqual(fs.readFileSync(path.join(historyDir, 'run.json')), firstManifest);
  const attempts = fs.readdirSync(path.join(blockDir, 'history')).map(id => JSON.parse(fs.readFileSync(path.join(blockDir, 'history', id, 'run.json'))));
  assert.equal(attempts.length, 3);
  assert.equal(attempts.filter(attempt => attempt.status === 'failed').length, 1);
});

test('upstream edits make dependent outputs stale, including dependencies appearing later in the document', async t => {
  const { source } = fixture(t);
  const dependent = fence('echo DEPENDENT', 'id=downstream depends-on="upstream"');
  const upstream = fence('echo BEFORE', 'id=upstream');
  await runner.runAllBlocks(dependent + '\n\n' + upstream, source);
  assert.equal(gatherCachedResults(dependent + '\n\n' + upstream, source)[0].cacheStatus, 'hit');
  const changed = dependent + '\n\n' + fence('echo AFTER', 'id=upstream');
  assert.equal(gatherCachedResults(changed, source)[0].cacheStatus, 'miss');
  const results = await runner.runAllBlocks(changed, source);
  assert.equal(results[0].cached, false);
  assert.equal(results[1].cached, false);
  assert.ok(results.every(result => result.exitCode === 0));
});

test('real timeout, max-buffer, signal, and cancellation never return clean status', async t => {
  const { root } = fixture(t);
  const { executeRunProcess, RunCancellation } = require('../out/run-process');
  const options = { cwd: root, env: process.env, timeoutMs: 80, maxBuffer: 128 };
  const timeout = await executeRunProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
  assert.equal(timeout.exitCode, 124); assert.equal(timeout.timedOut, true);
  const buffer = await executeRunProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], { ...options, timeoutMs: 5000 });
  assert.notEqual(buffer.exitCode, 0); assert.equal(buffer.maxBufferExceeded, true);
  const signal = await executeRunProcess(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], options);
  assert.notEqual(signal.exitCode, 0); assert.equal(signal.signal, 'SIGTERM');
  const cancellation = new RunCancellation();
  const pending = executeRunProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options, timeoutMs: 5000 }, cancellation);
  setTimeout(() => cancellation.cancel(), 40);
  const cancelled = await pending;
  assert.equal(cancelled.exitCode, 130); assert.equal(cancelled.cancelled, true);
});

test('timeout kills children in the same process group', { skip: process.platform === 'win32' }, async t => {
  const { root } = fixture(t);
  const { executeRunProcess } = require('../out/run-process');
  const sentinel = path.join(root, 'orphan-wrote.txt');
  const childSource = 'setTimeout(() => require("fs").writeFileSync(' + JSON.stringify(sentinel) + ', "alive"), 500)';
  const source = 'require("child_process").spawn(process.execPath, ["-e", ' + JSON.stringify(childSource) + '], {stdio: "ignore"}); setInterval(() => {}, 1000);';
  const result = await executeRunProcess(process.execPath, ['-e', source], { cwd: root, env: process.env, timeoutMs: 150 });
  assert.equal(result.timedOut, true);
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(fs.existsSync(sentinel), false);
});

test('nested document globs include new inputs and support zero or more globstar directories', async t => {
  const { root } = fixture(t);
  const docDir = path.join(root, 'chapter');
  const dataDir = path.join(docDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'first.csv'), 'a,b\n1,2');
  const source = path.join(docDir, 'notes.md');
  const markdown = fence('echo inputs', 'id=glob inputs="data/**/*.csv"');
  const [result] = await runner.runAllBlocks(markdown, source);
  assert.equal(result.exitCode, 0);
  assert.equal(gatherCachedResults(markdown, source)[0].cacheStatus, 'hit');
  fs.mkdirSync(path.join(dataDir, 'more'));
  fs.writeFileSync(path.join(dataDir, 'more', 'second.csv'), 'a,b\n3,4');
  assert.equal(gatherCachedResults(markdown, source)[0].cacheStatus, 'miss');
});

test('document identities distinguish formerly colliding document keys', async t => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, 'a'));
  const first = path.join(root, 'a', 'b.md');
  const second = path.join(root, 'a--b.md');
  const one = fence('echo FIRST', 'id=stable');
  const two = fence('echo SECOND', 'id=stable');
  await runner.runAllBlocks(one, first);
  await runner.runAllBlocks(two, second);
  assert.equal(gatherCachedResults(one, first)[0].stdout.trim(), 'FIRST');
  assert.equal(gatherCachedResults(two, second)[0].stdout.trim(), 'SECOND');
});

test('missing inputs, dependency cycles and duplicate IDs cannot publish success', async t => {
  const { source } = fixture(t);
  const missing = await runner.runAllBlocks(fence('echo should-not-run', 'id=missing inputs="absent.csv"'), source);
  assert.notEqual(missing[0].exitCode, 0);
  const cyclic = fence('echo A', 'id=a depends-on=b') + '\n\n' + fence('echo B', 'id=b depends-on=a');
  const cycleResults = await runner.runAllBlocks(cyclic, source);
  assert.ok(cycleResults.every(result => result.exitCode !== 0));
  await assert.rejects(runner.runAllBlocks(fence('echo one', 'id=same') + '\n\n' + fence('echo two', 'id=same'), source), /Duplicate/);
});

test('a malformed identity map is preserved and refused', async t => {
  const { root, source } = fixture(t);
  const { RunStore } = require('../out/run-store');
  const store = new RunStore(root, source);
  fs.mkdirSync(store.directory, { recursive: true });
  const mapping = path.join(store.directory, 'document.json');
  fs.writeFileSync(mapping, '{broken');
  const markdown = fence('echo hello');
  await assert.rejects(runner.runAllBlocks(markdown, source));
  assert.equal(gatherCachedResults(markdown, source)[0].cacheStatus, 'miss');
  assert.equal(fs.readFileSync(mapping, 'utf8'), '{broken');
});

test('the selected document-relative external symlink is the source that gets fingerprinted', async t => {
  const { root } = fixture(t);
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'actual.sh'), 'echo BEFORE');
  fs.symlinkSync('actual.sh', path.join(nested, 'run.sh'));
  fs.writeFileSync(path.join(root, 'run.sh'), 'echo WRONG_SCRIPT');
  const source = path.join(nested, 'document.md');
  const markdown = fence('', 'id=symlink file="run.sh"');
  const [first] = await runner.runAllBlocks(markdown, source);
  assert.equal(first.stdout.trim(), 'BEFORE');
  fs.writeFileSync(path.join(nested, 'actual.sh'), 'echo AFTER');
  assert.equal(gatherCachedResults(markdown, source)[0].cacheStatus, 'miss');
});

test('changing the legacy execution index invalidates external scripts even with indirect environment access', async t => {
  const { root, source } = fixture(t);
  fs.writeFileSync(path.join(root, 'ordinal.sh'), 'name=INKWELL_BLOCK_INDEX\nprintenv "$name"\n');
  const markdown = fence('', 'id=ordinal file="ordinal.sh"');
  const [first] = await runner.runAllBlocks(markdown, source);
  assert.equal(first.stdout.trim(), '0');
  const inserted = fence('echo inserted') + '\n\n' + markdown;
  assert.equal(gatherCachedResults(inserted, source)[1].cacheStatus, 'miss');
  const next = await runner.runAllBlocks(inserted, source);
  assert.equal(next[1].blockId, first.blockId);
  assert.equal(next[1].stdout.trim(), '1');
});

test('clearing and starting a fresh run invalidates a still-running old attempt', async t => {
  const { root, source } = fixture(t);
  const marker = path.join(root, 'old-started');
  const old = fence('touch ' + JSON.stringify(marker) + '\nsleep 0.25\nmkdir -p "$INKWELL_OUTPUT_DIR"\necho OLD', 'id=shared') + '\n\n' + fence('echo OLD_SECOND', 'id=second');
  const pending = runner.runAllBlocks(old, source);
  while (!fs.existsSync(marker)) await new Promise(resolve => setTimeout(resolve, 5));
  clearCache(getInkwellOutputsDir(source), source);
  const fresh = fence('echo FRESH', 'id=shared') + '\n\n' + fence('echo FRESH_SECOND', 'id=second');
  const [newResult] = await runner.runAllBlocks(fresh, source);
  assert.equal(newResult.exitCode, 0);
  const [oldResult, oldSecond] = await pending;
  assert.notEqual(oldResult.exitCode, 0);
  assert.notEqual(oldSecond.exitCode, 0);
  assert.equal(oldResult.artifacts.size, 0);
  assert.equal(gatherCachedResults(fresh, source)[0].stdout.trim(), 'FRESH');
  assert.equal(gatherCachedResults(fresh, source)[1].stdout.trim(), 'FRESH_SECOND');
});

test('exact cache clearing isolates colliding document keys and removes malformed metadata', async t => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, 'a'));
  const first = path.join(root, 'a', 'b.md');
  const second = path.join(root, 'a--b.md');
  const markdown = fence('echo intact', 'id=stable');
  await runner.runAllBlocks(markdown, first);
  await runner.runAllBlocks(markdown, second);
  const { RunStore } = require('../out/run-store');
  const firstStore = new RunStore(root, first);
  fs.writeFileSync(path.join(firstStore.directory, 'document.json'), '{bad');
  clearCache(getInkwellOutputsDir(first), first);
  assert.equal(fs.existsSync(firstStore.directory), false);
  assert.equal(gatherCachedResults(markdown, second)[0].cacheStatus, 'hit');
});

test('interpreter and installed virtualenv package metadata invalidate current provenance', async t => {
  const { root, source } = fixture(t);
  const environment = path.join(root, 'venv');
  const binary = path.join(environment, 'bin', 'python3');
  const metadata = path.join(environment, 'lib', 'python3.test', 'site-packages', 'demo.dist-info', 'METADATA');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo FakePython1; else /bin/sh "$2"; fi\n', { mode: 0o755 });
  fs.writeFileSync(metadata, 'Version: 1\n');
  const markdown = '```{python id=environment env="venv"}\necho environment\n```';
  await runner.runAllBlocks(markdown, source);
  assert.equal(gatherCachedResults(markdown, source)[0].cacheStatus, 'hit');
  fs.writeFileSync(metadata, 'Version: 2\n');
  assert.equal(gatherCachedResults(markdown, source)[0].cacheStatus, 'miss');
  await runner.runAllBlocks(markdown, source);
  fs.appendFileSync(binary, '# interpreter changed\n');
  assert.equal(gatherCachedResults(markdown, source)[0].cacheStatus, 'miss');
});

test('inline expression cache invalidates when the selected interpreter environment changes', async t => {
  const { root, source } = fixture(t);
  const binary = path.join(root, 'venv', 'bin', 'python3');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\ncase "$1" in --version) echo FakePython;; -c) echo "[]";; *) echo "::result_0=$INLINE_RUNTIME_TEST";; esac\n', { mode: 0o755 });
  const { evaluateInlineExpressions } = require('../out/inject');
  const evaluate = () => evaluateInlineExpressions('`{python} 1`', new Map(), { pythonEnv: 'venv' }, root, root, getInkwellOutputsDir(source));
  const previous = process.env.INLINE_RUNTIME_TEST;
  t.after(() => { if (previous === undefined) delete process.env.INLINE_RUNTIME_TEST; else process.env.INLINE_RUNTIME_TEST = previous; });
  process.env.INLINE_RUNTIME_TEST = 'before';
  assert.equal(evaluate(), 'before');
  process.env.INLINE_RUNTIME_TEST = 'after';
  assert.equal(evaluate(), 'after');
});

test('inline evaluation fingerprints the exact nested interpreter it executes', async t => {
  const { root } = fixture(t);
  const docDir = path.join(root, 'nested');
  const binary = path.join(docDir, 'venv', 'bin', 'python3');
  fs.mkdirSync(path.join(root, 'venv'), { recursive: true });
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const executable = value => '#!/bin/sh\ncase "$1" in --version) echo FakePython;; -c) echo "[]";; *) echo "::result_0=' + value + '";; esac\n';
  fs.writeFileSync(binary, executable('BEFORE'), { mode: 0o755 });
  const { evaluateInlineExpressions } = require('../out/inject');
  const source = path.join(docDir, 'doc.md');
  const evaluate = () => evaluateInlineExpressions('`{python} 1`', new Map(), { pythonEnv: 'venv' }, docDir, root, getInkwellOutputsDir(source));
  assert.equal(evaluate(), 'BEFORE');
  fs.writeFileSync(binary, executable('AFTER'));
  assert.equal(evaluate(), 'AFTER');
});

test('a clean leader exit cannot leave background writers running after publication', { skip: process.platform === 'win32' }, async t => {
  const { root } = fixture(t);
  const { executeRunProcess } = require('../out/run-process');
  const sentinel = path.join(root, 'late-output');
  const child = 'setTimeout(() => require("fs").writeFileSync(' + JSON.stringify(sentinel) + ', "late"), 250)';
  const leader = 'const p = require("child_process").spawn(process.execPath, ["-e", ' + JSON.stringify(child) + '], {stdio:"ignore"}); p.unref();';
  const result = await executeRunProcess(process.execPath, ['-e', leader], { cwd: root, env: process.env, timeoutMs: 5000 });
  assert.equal(result.exitCode, 0);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(fs.existsSync(sentinel), false);
});
