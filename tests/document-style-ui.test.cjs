const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { resolveDocumentConfig } = require('../out/document-config');
const { planManifestStyleEdit } = require('../out/document-style');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-document-style-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'doc.md'), manifest = path.join(root, '.inkwell/manifest.json');
  let text = options.text || '# Existing document\n';
  fs.writeFileSync(source, text);
  if (options.manifest !== false) {
    fs.mkdirSync(path.dirname(manifest));
    fs.writeFileSync(manifest, options.manifest || '{"schemaVersion":4,"template":"default","future":{"keep":true},"managedFiles":{"guide.md":{"hash":"old"}}}\n');
  }
  const answers = [], picks = [], messages = [], edits = [], commands = new Map();
  let saves = 0, readinessCalls = 0;
  const uri = file => ({ scheme: 'file', fsPath: file, toString: () => `file://${file}` });
  const document = { uri: uri(source), version: 1, languageId: 'markdown', isUntitled: false, isClosed: false, isDirty: false,
    getText: () => text, save: async () => { saves++; }, positionAt: offset => ({ offset }) };
  const editor = { document, editResult: true, edit: async (callback, settings) => {
    const changes = []; callback({ replace: (range, replacement) => changes.push({ range, replacement }) });
    edits.push({ changes, settings });
    if (!editor.editResult) return false;
    for (const change of changes) text = text.slice(0, change.range.start.offset) + change.replacement + text.slice(change.range.end.offset);
    document.version++; document.isDirty = true;
    return true;
  } };
  const choose = async (items, details) => {
    picks.push({ items, details });
    const answer = answers.shift();
    if (typeof answer === 'function') return answer(items, details);
    if (answer === undefined) return undefined;
    return items.find(item => item.target === answer || item.control?.key === answer || item.label === answer);
  };
  const vscode = {
    Uri: { file: uri }, Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    workspace: { isTrusted: true, textDocuments: [document], getWorkspaceFolder: () => ({ uri: uri(root) }), getConfiguration: () => ({ get: () => undefined }) },
    window: { activeTextEditor: editor, showQuickPick: choose,
      showInputBox: async details => { picks.push({ details }); const next = answers.shift(); return typeof next === 'function' ? next(details) : next; },
      showInformationMessage: async message => { messages.push({ level: 'info', message }); },
      showErrorMessage: async message => { messages.push({ level: 'error', message }); },
    },
    commands: { registerCommand: (id, handler) => { commands.set(id, handler); return { dispose() {} }; } },
  };
  const original = Module._load;
  Module._load = function(request, ...rest) { if (request === 'vscode') return vscode; return original.call(this, request, ...rest); };
  let api;
  try { delete require.cache[require.resolve('../out/document-style-ui')]; api = require('../out/document-style-ui'); }
  finally { Module._load = original; }
  const dependencies = {
    getConfig: value => resolveDocumentConfig({ text: value, sourcePath: source, manifest: fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : undefined }),
    ensureReady: async () => { readinessCalls++; return true; },
  };
  const context = { extensionPath: root, subscriptions: [] };
  return { root, source, manifest, document, editor, vscode, api, context, dependencies, answers, picks, messages, edits, commands,
    run: refresh => api.configureDocumentStyle(context, refresh, dependencies), setText: value => { text = value; document.version++; },
    counts: () => ({ saves, readinessCalls }), text: () => text };
}

test('document style is one undoable editor change with no save or scaffold side effects', async t => {
  const h = fixture(t, { manifest: false });
  h.answers.push('document', 'typography.bodySize', '12pt');
  let refreshed = 0;
  assert.equal(await h.run(() => { refreshed++; }), true);
  assert.equal(h.edits.length, 1); assert.equal(h.edits[0].changes.length, 1);
  assert.deepEqual(h.edits[0].settings, { undoStopBefore: true, undoStopAfter: true });
  assert.equal(h.document.isDirty, true); assert.equal(h.counts().saves, 0); assert.equal(h.counts().readinessCalls, 0);
  assert.equal(fs.existsSync(path.dirname(h.manifest)), false);
  assert.equal(fs.readFileSync(h.source, 'utf8'), '# Existing document\n');
  assert.match(h.text(), /bodySize: 12pt/); assert.equal(refreshed, 1);
});

for (const answers of [[undefined], ['document', undefined], ['document', 'typography.bodySize', undefined]]) {
  test(`cancelling style pickers ${JSON.stringify(answers)} changes nothing`, async t => {
    const h = fixture(t, { manifest: false }); h.answers.push(...answers);
    assert.equal(await h.run(), false); assert.equal(h.edits.length, 0);
    assert.deepEqual(h.counts(), { saves: 0, readinessCalls: 0 });
    assert.equal(fs.existsSync(path.dirname(h.manifest)), false);
  });
}

for (const change of ['version', 'uri', 'active-editor', 'trust']) {
  test(`a stale ${change} after a picker prevents the document edit`, async t => {
    const h = fixture(t); h.answers.push('document', 'typography.bodySize', items => {
      if (change === 'version') h.setText('# User changed text\n');
      if (change === 'uri') h.document.uri = { ...h.document.uri, toString: () => 'file:///different.md' };
      if (change === 'active-editor') h.vscode.window.activeTextEditor = undefined;
      if (change === 'trust') h.vscode.workspace.isTrusted = false;
      return items.find(item => item.label === '12pt');
    });
    assert.equal(await h.run(), false); assert.equal(h.edits.length, 0);
    assert.match(h.messages.at(-1).message, /changed|cancelled/i);
  });
}

test('a newer cancelled command invalidates an earlier pending picker generation', async t => {
  const h = fixture(t); let release;
  h.answers.push(items => new Promise(resolve => { release = () => resolve(items[0]); }), undefined);
  const first = h.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await h.run(), false);
  release(); assert.equal(await first, false); assert.equal(h.edits.length, 0);
});

test('locked template options show the effective value without opening a value control', async t => {
  const h = fixture(t, { text: '---\ntemplate: rho\n---\nBody\n' });
  h.answers.push('document', 'typography.bodySize');
  assert.equal(await h.run(), false);
  assert.equal(h.picks.length, 2); assert.equal(h.edits.length, 0);
  assert.match(h.messages.at(-1).message, /9pt.*Locked by Rho/);
  const item = h.picks[1].items.find(item => item.control.key === 'typography.bodySize');
  assert.match(item.label, /lock/); assert.ok(item.detail.length);
});

test('invalid input cannot bypass shared capability validation', async t => {
  const h = fixture(t); h.answers.push('document', 'typography.bodySize', () => ({ label: '99pt', value: '99pt' }));
  assert.equal(await h.run(), false); assert.equal(h.edits.length, 0); assert.equal(h.messages.at(-1).level, 'error');
});

test('project defaults wait for scope choice/readiness and preserve document overrides', async t => {
  const h = fixture(t, { text: '---\nfontsize: 10pt\n---\nBody\n' });
  h.answers.push(items => { assert.equal(h.counts().readinessCalls, 0); return items[1]; }, 'typography.bodySize', '12pt');
  const original = JSON.parse(fs.readFileSync(h.manifest, 'utf8'));
  assert.equal(await h.run(), true); assert.equal(h.counts().readinessCalls, 1); assert.equal(h.edits.length, 0);
  assert.equal(h.text(), '---\nfontsize: 10pt\n---\nBody\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(h.manifest, 'utf8')), { ...original, defaults: { typography: { bodySize: '12pt' } } });
  assert.match(h.messages.at(-1).message, /keeps its frontmatter override/);
});

test('failed editor edit is reported and never refreshes or saves', async t => {
  const h = fixture(t); h.answers.push('document', 'typography.bodySize', '12pt'); h.editor.editResult = false;
  let refresh = 0;
  assert.equal(await h.run(() => { refresh++; }), false);
  assert.equal(refresh, 0); assert.equal(h.counts().saves, 0); assert.match(h.messages.at(-1).message, /could not apply/);
});

test('project updates reject a manifest changed during a picker', async t => {
  const h = fixture(t); h.answers.push('project', 'typography.bodySize', items => {
    fs.writeFileSync(h.manifest, '{"schemaVersion":4,"future":"written concurrently"}');
    return items.find(item => item.label === '12pt');
  });
  assert.equal(await h.run(), false);
  assert.equal(fs.readFileSync(h.manifest, 'utf8'), '{"schemaVersion":4,"future":"written concurrently"}');
  assert.equal(fs.readdirSync(path.dirname(h.manifest)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('malformed project manifests are backed up unchanged and stop before readiness', async t => {
  const h = fixture(t, { manifest: '{broken manifest' }); h.answers.push('project');
  assert.equal(await h.run(), false); assert.equal(h.counts().readinessCalls, 0);
  assert.equal(fs.readFileSync(h.manifest, 'utf8'), '{broken manifest');
  const backups = fs.readdirSync(path.dirname(h.manifest)).filter(name => name.endsWith('.bak'));
  assert.equal(backups.length, 1); assert.equal(fs.readFileSync(path.join(path.dirname(h.manifest), backups[0]), 'utf8'), '{broken manifest');
  h.answers.push('project'); assert.equal(await h.run(), false);
  assert.equal(fs.readdirSync(path.dirname(h.manifest)).filter(name => name.endsWith('.bak')).length, 1);
});

test('atomic project write failure retains original bytes and cleans staging', t => {
  const h = fixture(t), snapshot = h.api.readProjectStyleManifest(h.root);
  const plan = planManifestStyleEdit(snapshot.text, [{ key: 'typography.bodySize', value: '12pt' }], h.dependencies.getConfig(h.text()));
  const rename = fs.renameSync;
  fs.renameSync = function(_from, to) { if (to === h.manifest) throw new Error('simulated rename failure'); return rename.apply(this, arguments); };
  try { assert.throws(() => h.api.commitProjectStyleEdit(snapshot, plan, true), /simulated rename failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(h.manifest, 'utf8'), snapshot.text);
  assert.deepEqual(fs.readdirSync(path.dirname(h.manifest)), ['manifest.json']);
});

test('atomic publication checks expected bytes again after staging', t => {
  const h = fixture(t), snapshot = h.api.readProjectStyleManifest(h.root);
  const plan = planManifestStyleEdit(snapshot.text, [{ key: 'typography.bodySize', value: '12pt' }], h.dependencies.getConfig(h.text()));
  const sync = fs.fsyncSync;
  fs.fsyncSync = function() { fs.writeFileSync(h.manifest, '{"concurrent":true}'); return sync.apply(this, arguments); };
  try { assert.throws(() => h.api.commitProjectStyleEdit(snapshot, plan, true), /defaults changed/i); }
  finally { fs.fsyncSync = sync; }
  assert.equal(fs.readFileSync(h.manifest, 'utf8'), '{"concurrent":true}');
  assert.deepEqual(fs.readdirSync(path.dirname(h.manifest)), ['manifest.json']);
});

test('trust, dirty manifests and paths escaping the project prevent project mutations', async t => {
  const h = fixture(t); h.vscode.workspace.isTrusted = false;
  assert.equal(await h.run(), false); assert.equal(h.picks.length, 0);
  const snapshot = h.api.readProjectStyleManifest(h.root);
  const plan = planManifestStyleEdit(snapshot.text, [{ key: 'typography.bodySize', value: '12pt' }], h.dependencies.getConfig(h.text()));
  assert.throws(() => h.api.commitProjectStyleEdit(snapshot, plan, false), /Trust/);
  h.vscode.workspace.isTrusted = true;
  h.vscode.workspace.textDocuments.push({ uri: { scheme: 'file', fsPath: h.manifest }, isDirty: true });
  h.answers.push('project'); assert.equal(await h.run(), false); assert.match(h.messages.at(-1).message, /unsaved editor/);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-style-outside-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.writeFileSync(path.join(other, 'manifest.json'), '{}');
  fs.unlinkSync(h.manifest); fs.symlinkSync(path.join(other, 'manifest.json'), h.manifest);
  assert.throws(() => h.api.readProjectStyleManifest(h.root), /escapes|symbolic link/);
  assert.equal(fs.readFileSync(path.join(other, 'manifest.json'), 'utf8'), '{}');
});

test('registered style command returns its pending picker promise', async t => {
  const h = fixture(t); h.api.registerDocumentStyleCommand(h.context);
  let release;
  h.answers.push(() => new Promise(resolve => { release = resolve; }));
  let complete = false;
  const work = h.commands.get('inkwell.configureDocumentStyle')().then(() => { complete = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(complete, false);
  release(undefined); await work; assert.equal(complete, true); assert.equal(h.context.subscriptions.length, 1);
});
