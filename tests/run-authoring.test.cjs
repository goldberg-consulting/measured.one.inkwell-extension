const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const cp = require('node:child_process');
const workspace = { isTrusted: true, getWorkspaceFolder: () => undefined };
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'vscode') return { workspace, Uri: { file: fsPath => ({ fsPath }) }, window: { createOutputChannel: () => ({ appendLine() {} }) } };
  return originalLoad.call(this, request, ...args);
};
const runner = require('../out/runner');
const authoring = require('../out/run-authoring');
const { blockIdentityErrors, parseRunList } = require('../out/run-attributes');
const { RunStore, redactRunArgv } = require('../out/run-store');
const { containedRunPath } = require('../out/run-paths');
Module._load = originalLoad;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-authoring-'));
  fs.mkdirSync(path.join(root, '.inkwell', 'scripts'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, source: path.join(root, 'document.md') };
}
const fence = (source, attrs = 'id="analysis"') => '```{shell ' + attrs + '}\n' + source + '\n```';

test('quoted attributes retain escaped commas and reject malformed or duplicate values', () => {
  const attrs = runner.parseQuotedAttrs('id=analysis file=\'.inkwell/scripts/a.sh\' inputs=" data/a\\,b.csv, src/helper.py " caption="A \\"quoted\\" title"');
  assert.deepEqual(parseRunList(attrs.inputs), ['data/a,b.csv', 'src/helper.py']);
  assert.equal(attrs.caption, 'A "quoted" title');
  for (const invalid of ['id="open', 'id=x id=y', 'id="a"junk', 'id x']) assert.throws(() => runner.parseQuotedAttrs(invalid));
});

test('stable identity edits distinguish identical anonymous fences and preserve CRLF', () => {
  const markdown = 'Intro\r\n' + fence('echo same', '').replaceAll('\n', '\r\n') + '\r\n\r\n' + fence('echo same', '').replaceAll('\n', '\r\n');
  let index = 0;
  const edits = authoring.planBlockIdentities(markdown, () => 'run-' + ++index);
  const updated = authoring.applyRunTextEdits(markdown, edits);
  assert.deepEqual(runner.parseCodeBlocks(updated).map(block => block.id), ['run-1', 'run-2']);
  assert.equal(updated.replaceAll(/ id="run-[12]"/g, ''), markdown);
  assert.equal(authoring.planBlockIdentities(updated).length, 0);
});

test('identity diagnostics cover every conflicting fence and preserve display labels with an explicit ID', () => {
  const errors = blockIdentityErrors([{ id: 'same', startLine: 1 }, { label: 'same', startLine: 5 }, { id: '../bad', startLine: 9 }]);
  assert.deepEqual([...errors.keys()], [9, 1, 5]);
  assert.equal(blockIdentityErrors([{ id: 'figure', label: 'fig:plot', startLine: 1 }]).size, 0);
});

test('extraction preserves source bytes and every presentation/dependency attribute', async t => {
  const { root, source } = fixture(t);
  const markdown = fence('echo extracted  \n\n', 'display="both" output="summary" caption="Title" label="analysis" inputs="data.csv" depends-on="prepare"').replaceAll('\n', '\r\n');
  const plan = authoring.planScriptExtraction(markdown, 0, root);
  let changed = markdown;
  await authoring.extractScriptTransaction(plan, root, async edit => { changed = authoring.applyRunTextEdits(changed, [edit]); return true; });
  assert.equal(fs.readFileSync(plan.sourcePath, 'utf8'), 'echo extracted  \r\n\r\n\r\n');
  const [block] = runner.parseCodeBlocks(changed);
  assert.equal(block.file, '.inkwell/scripts/analysis.sh');
  for (const key of ['display', 'output', 'caption', 'label', 'inputs', 'depends-on']) assert.equal(block.attributes[key], runner.parseCodeBlocks(markdown)[0].attributes[key]);
  const simple = fence('echo same-output', 'id="script"');
  const inline = await runner.runAllBlocks(simple, source);
  const simplePlan = authoring.planScriptExtraction(simple, 0, root);
  let external;
  await authoring.extractScriptTransaction(simplePlan, root, async edit => { external = authoring.applyRunTextEdits(simple, [edit]); return true; });
  assert.equal((await runner.runAllBlocks(external, source))[0].stdout, inline[0].stdout);
});

test('failed extraction leaves the document unchanged and removes only its own script', async t => {
  const { root } = fixture(t);
  const markdown = fence('echo source');
  const plan = authoring.planScriptExtraction(markdown, 0, root);
  await assert.rejects(authoring.extractScriptTransaction(plan, root, async () => false), /cancelled/);
  assert.equal(fs.existsSync(plan.sourcePath), false);
  fs.writeFileSync(plan.sourcePath, 'user owned');
  await assert.rejects(authoring.extractScriptTransaction(plan, root, async () => true), /EEXIST/);
  assert.equal(fs.readFileSync(plan.sourcePath, 'utf8'), 'user owned');
});

test('anonymous runs are visible for the session and never persistently injectable', async t => {
  const { source } = fixture(t);
  const markdown = fence('echo session-result', '');
  const [result] = await runner.runAllBlocks(markdown, source);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'session-result');
  assert.equal(runner.readCurrentRunResults(markdown, source)[0].cacheStatus, 'miss');
});

test('external sources and inputs reject traversal, absolute paths, devices, and escaping symlinks', async t => {
  const { root, source } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'script.sh'), 'echo outside');
  fs.symlinkSync(path.join(outside, 'script.sh'), path.join(root, 'escape.sh'));
  for (const attrs of ['file="../script.sh"', 'file="/dev/null"', 'file="escape.sh"', 'inputs="../input.csv"', 'inputs="escape.sh"']) {
    const [result] = await runner.runAllBlocks(fence('echo must-not-run', 'id="safe" ' + attrs), source);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.stdout, '');
  }
  fs.rmSync(path.join(root, '.inkwell', 'scripts'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, '.inkwell', 'scripts'));
  assert.throws(() => authoring.planScriptExtraction(fence('echo extract'), 0, root), /symlink/);
});

test('artifact symlinks and configured size limits fail without replacing current output', async t => {
  const { source } = fixture(t);
  const good = fence('echo good > "$INKWELL_OUTPUT_DIR/good.txt"');
  const [first] = await runner.runAllBlocks(good, source);
  const current = path.join(path.dirname(path.dirname(path.dirname(path.dirname(first.artifacts.get('good'))))), 'current.json');
  const before = fs.readFileSync(current);
  const bad = '---\ninkwell:\n  runs:\n    max-artifact-bytes: 2\n---\n' + good;
  const [failed] = await runner.runAllBlocks(bad, source);
  assert.notEqual(failed.exitCode, 0);
  assert.deepEqual(fs.readFileSync(current), before);
  const [symlink] = await runner.runAllBlocks(fence('ln -s /dev/null "$INKWELL_OUTPUT_DIR/unsafe.txt"'), source);
  assert.notEqual(symlink.exitCode, 0);
  assert.deepEqual(fs.readFileSync(current), before);
});

test('a replaced artifact root and a self-root symlink never ingest external files', async t => {
  const { root, source } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-artifact-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const external = path.join(outside, 'private.txt');
  fs.writeFileSync(external, 'must not be published');
  const alias = path.join(root, 'root-link');
  fs.symlinkSync(outside, alias);
  assert.throws(() => containedRunPath(alias, alias, false, true), /symlink/);
  const command = 'rmdir "$INKWELL_OUTPUT_DIR"\nln -s ' + JSON.stringify(outside) + ' "$INKWELL_OUTPUT_DIR"';
  const [result] = await runner.runAllBlocks(fence(command), source);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.artifacts.size, 0);
  assert.equal(fs.readFileSync(external, 'utf8'), 'must not be published');
  assert.equal(runner.readCurrentRunResults(fence(command), source)[0].cacheStatus, 'miss');
});

test('input expansion and content enforce configured limits before execution', async t => {
  const { root, source } = fixture(t);
  fs.writeFileSync(path.join(root, 'a.csv'), 'abc'); fs.writeFileSync(path.join(root, 'b.csv'), 'def');
  for (const option of ['max-input-paths: 1', 'max-input-bytes: 2']) {
    const markdown = '---\ninkwell:\n  runs:\n    ' + option + '\n---\n' + fence('echo must-not-run', 'id="limited" inputs="*.csv"');
    const [result] = await runner.runAllBlocks(markdown, source);
    assert.notEqual(result.exitCode, 0); assert.equal(result.stdout, '');
  }
});

test('unchanged blocks launch no execution processes and upstream provenance changes invalidate dependents', async t => {
  const { source } = fixture(t);
  const upstream = fence('echo same', 'id="upstream"');
  const downstream = fence('echo downstream', 'id="downstream" depends-on="upstream"');
  const markdown = upstream + '\n' + downstream;
  await runner.runAllBlocks(markdown, source);
  const spawn = cp.spawn; let calls = 0;
  cp.spawn = (...args) => { calls++; return spawn(...args); };
  try {
    assert.ok((await runner.runAllBlocks(markdown, source)).every(result => result.cached));
    assert.equal(calls, 0);
    const changed = fence('# source changed\necho same', 'id="upstream"') + '\n' + downstream;
    assert.ok((await runner.runAllBlocks(changed, source)).every(result => !result.cached));
    assert.equal(calls, 2);
  } finally { cp.spawn = spawn; }
});

test('retention preserves current success plus recent failed attempts', async t => {
  const { root, source } = fixture(t);
  const prefix = '---\ninkwell:\n  runs:\n    retention-count: 2\n---\n';
  const [first] = await runner.runAllBlocks(prefix + fence('echo current'), source);
  for (let index = 0; index < 4; index++) await runner.runAllBlocks(prefix + fence('echo failed-' + index + '\nexit 3'), source);
  const store = new RunStore(root, source);
  const details = store.currentDetails('analysis');
  assert.equal(details.manifest.runId, first.runId);
  const history = path.join(store.directory, 'analysis', 'history');
  const attempts = fs.readdirSync(history);
  assert.equal(attempts.length, 3);
  assert.ok(attempts.includes(first.runId));
});

test('secret arguments are redacted and untrusted workspaces never execute code', async t => {
  assert.deepEqual(redactRunArgv(['--token', 'secret', '--api-key=hidden', 'https://name:password@example.com/path', 'script.py']), ['--token', '[redacted]', '--api-key=[redacted]', 'https://[redacted]@example.com/path', 'script.py']);
  const { source } = fixture(t);
  workspace.isTrusted = false;
  try { const [result] = await runner.runAllBlocks(fence('echo must-not-run'), source); assert.notEqual(result.exitCode, 0); assert.equal(result.stdout, ''); }
  finally { workspace.isTrusted = true; }
});
