const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
let state;

class EventEmitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
class Range { constructor(start, end) { this.start = start; this.end = end; } }
const uri = file => ({ fsPath: file, scheme: 'file', toString: () => 'file://' + encodeURI(file) });

class Document {
  constructor(file, text, language = 'markdown') { this.uri = uri(file); this.text = text; this.languageId = language; this.version = 1; this.isDirty = false; this.isClosed = false; this.isUntitled = false; }
  getText() { return this.text; }
  positionAt(offset) { const lines = this.text.slice(0, offset).split('\n'); return { line: lines.length - 1, character: lines.at(-1).length }; }
  offsetAt(position) { return this.text.split('\n').slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character; }
  lineAt(line) { const text = this.text.split('\n')[line].replace(/\r$/, ''); return { text, range: new Range({ line, character: 0 }, { line, character: text.length }) }; }
  async save() {
    state.saves++;
    if (state.beforeSave) await state.beforeSave(this);
    if (state.failSave) return false;
    if (!state.skipDiskSave) fs.writeFileSync(this.uri.fsPath, this.text);
    this.isDirty = false;
    if (state.afterSave) await state.afterSave(this);
    return true;
  }
}
function editText(document, text) { document.text = text; document.version++; document.isDirty = true; state.change.fire({ document }); }
function editorFor(document) {
  return { document, selection: { active: { line: 1, character: 0 } }, async edit(callback) {
    const version = document.version; const edits = [];
    callback({ replace: (range, replacement) => edits.push({ start: document.offsetAt(range.start), end: document.offsetAt(range.end), replacement }) });
    if (state.beforeApply) await state.beforeApply(document);
    if (state.failApply || document.version !== version) return false;
    let text = document.getText();
    for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
    editText(document, text); return true;
  } };
}
const vscode = {
  Uri: { file: uri, parse: value => uri(decodeURI(value.replace(/^file:\/\//, ''))) },
  EventEmitter, Range,
  FilePermission: { Readonly: 1 }, DiagnosticSeverity: { Error: 0 },
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
  CodeLens: class { constructor(range, command) { Object.assign(this, { range, command }); } },
  commands: { registerCommand: (name, handler) => { state.commands.set(name, handler); return { dispose: () => state.commands.delete(name) }; } },
  languages: {
    createDiagnosticCollection: () => ({ set: (key, values) => state.diagnostics.set(key.toString(), values), delete: key => state.diagnostics.delete(key.toString()), dispose() {} }),
    registerCodeLensProvider: (_selector, provider) => { state.provider = provider; return { dispose() {} }; },
  },
  workspace: {
    get isTrusted() { return state.trusted; },
    get textDocuments() { return [...state.documents.values()]; },
    getWorkspaceFolder: () => undefined,
    fs: { stat: async () => { if (state.beforeStat) await state.beforeStat(); return { permissions: state.readonly ? 1 : undefined }; } },
    onDidOpenTextDocument: listener => state.open.event(listener),
    onDidChangeTextDocument: listener => state.change.event(listener),
    onDidCloseTextDocument: listener => state.close.event(listener),
    async openTextDocument(target) {
      if (target.content !== undefined) { state.views.push(target); return new Document(path.join(state.root, 'details.json'), target.content, target.language); }
      const file = target.fsPath;
      let document = state.documents.get(file);
      if (!document) { document = new Document(file, fs.readFileSync(file, 'utf8'), file.endsWith('.md') ? 'markdown' : 'shellscript'); state.documents.set(file, document); state.open.fire(document); }
      return document;
    },
  },
  window: {
    get activeTextEditor() { return state.editor; },
    get visibleTextEditors() { return state.visible; },
    showInformationMessage: async message => { state.info.push(message); },
    showErrorMessage: async message => { state.errors.push(message); },
    showWarningMessage: async message => { state.warnings.push(message); },
    createOutputChannel: () => ({ appendLine() {} }),
    async showTextDocument(target) {
      const document = target.getText ? target : await vscode.workspace.openTextDocument(target);
      state.shown.push(document.uri.fsPath);
      const editor = state.visible.find(candidate => candidate.document === document) || editorFor(document);
      if (!state.visible.includes(editor)) state.visible.push(editor);
      state.editor = editor;
      return editor;
    },
  },
};
const originalLoad = Module._load;
Module._load = function(request, ...args) { if (request === 'vscode') return vscode; return originalLoad.call(this, request, ...args); };
const { registerRunAuthoring, RUN_AUTHORING_COMMANDS: commands } = require('../out/run-authoring-ui');
const runner = require('../out/runner');
Module._load = originalLoad;

const fence = (source = 'echo example', attrs = '') => '```{shell ' + attrs + '}\n' + source + '\n```';
function fixture(t, text = fence(), execute) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-run-ui-'));
  fs.mkdirSync(path.join(root, '.inkwell', 'scripts'), { recursive: true });
  state = { root, trusted: true, readonly: false, commands: new Map(), documents: new Map(), diagnostics: new Map(), executions: [], views: [], shown: [], errors: [], warnings: [], info: [], saves: 0, ready: 0, change: new EventEmitter(), open: new EventEmitter(), close: new EventEmitter() };
  const source = path.join(root, 'document.md'); fs.writeFileSync(source, text);
  const document = new Document(source, text); state.documents.set(source, document);
  state.editor = editorFor(document); state.visible = [state.editor];
  const context = { subscriptions: [] };
  const api = registerRunAuthoring(context, {
    ensureReady: async () => { state.ready++; if (state.beforeReady) await state.beforeReady(); return true; },
    execute: async request => { state.executions.push(request); if (execute) await execute(request); },
  });
  const environment = state;
  t.after(() => { for (const subscription of context.subscriptions) subscription.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, source, document, api, environment, target: (index = 0) => ({ uri: document.uri.toString(), version: document.version, index }) };
}

test('five commands and CodeLens share stable targets and identities are saved before run-all', async t => {
  const { document, source, api, environment } = fixture(t, fence() + '\n\n' + fence());
  assert.deepEqual([...environment.commands.keys()].sort(), Object.values(commands).sort());
  const lenses = environment.provider.provideCodeLenses(document);
  assert.equal(lenses.length, 7);
  assert.ok(lenses.every(lens => lens.command.arguments[0].version === document.version));
  assert.equal(await api.run(document), true);
  const request = environment.executions[0];
  const ids = runner.parseCodeBlocks(request.text).map(block => block.id);
  assert.equal(new Set(ids).size, 2);
  assert.equal(request.text, fs.readFileSync(source, 'utf8'));
  assert.equal(request.sourceVersion, document.version);
  assert.equal(request.mode, 'all'); assert.equal(request.selectedIndices, undefined);
});

test('selected block command saves IDs on every fence and passes only the requested index', async t => {
  const { document, source, environment, target } = fixture(t, fence('echo first') + '\n\n' + fence('echo second'));
  assert.equal(await environment.commands.get(commands.runBlock)(target(1)), true);
  assert.deepEqual(environment.executions[0].selectedIndices, [1]);
  assert.ok(runner.parseCodeBlocks(fs.readFileSync(source, 'utf8')).every(block => block.id));
  assert.equal(environment.executions[0].sourceVersion, document.version);
});

test('stale CodeLens and editor-version races never execute or attach a new identity to changed text', async t => {
  const { document, api, environment, target } = fixture(t);
  const old = target(); editText(document, 'Intro\n' + document.getText());
  assert.equal(await environment.commands.get(commands.runBlock)(old), false);
  environment.beforeApply = async doc => { editText(doc, 'User edit\n' + doc.getText()); };
  assert.equal(await api.run(document), false);
  assert.equal(environment.executions.length, 0);
  assert.doesNotMatch(document.getText(), /id="run-/);
  assert.ok(environment.errors.every(message => /changed/.test(message)));
});

for (const reason of ['untrusted', 'read-only', 'untitled', 'save-failed', 'disk-mismatch', 'edit-during-save']) {
  test(reason + ' blocks execution before an interpreter is requested', async t => {
    const { document, api, environment } = fixture(t);
    if (reason === 'untrusted') environment.trusted = false;
    if (reason === 'read-only') environment.readonly = true;
    if (reason === 'untitled') document.isUntitled = true;
    if (reason === 'save-failed') environment.failSave = true;
    if (reason === 'disk-mismatch') environment.skipDiskSave = true;
    if (reason === 'edit-during-save') environment.afterSave = async doc => editText(doc, doc.getText() + '\nUser edit');
    assert.equal(await api.run(document), false);
    assert.equal(environment.executions.length, 0);
    assert.equal(environment.errors.length, 1);
  });
}

test('every duplicate and invalid fence receives a diagnostic and diagnostics follow edits/close', async t => {
  const { document, api, environment } = fixture(t, fence('echo a', 'id=same') + '\n\n' + fence('echo b', 'id=same') + '\n\n' + fence('echo c', 'id="../bad"'));
  const locations = environment.diagnostics.get(document.uri.toString()).map(item => item.range.start.line).sort((a, b) => a - b);
  assert.deepEqual(locations, [0, 4, 8]);
  assert.equal(await api.run(document), false);
  assert.equal(environment.executions.length, 0);
  editText(document, fence('echo valid', 'id=valid'));
  assert.equal(environment.diagnostics.get(document.uri.toString()).length, 0);
  environment.close.fire(document);
  assert.equal(environment.diagnostics.has(document.uri.toString()), false);
});

test('extraction updates the editor in one transaction and open-script selects the created source', async t => {
  const initial = fence('echo source', 'id=analysis display="both" output="summary"');
  const { document, root, environment, target } = fixture(t, initial);
  assert.equal(await environment.commands.get(commands.extract)(target()), true);
  const script = path.join(root, '.inkwell', 'scripts', 'analysis.sh');
  assert.equal(fs.readFileSync(script, 'utf8'), 'echo source\n');
  assert.match(document.getText(), /display="both" output="summary" file=".inkwell\/scripts\/analysis.sh"/);
  assert.equal(environment.executions.length, 0);
  assert.equal(await environment.commands.get(commands.open)(target()), true);
  assert.equal(environment.shown.at(-1), script);
  const lenses = environment.provider.provideCodeLenses(document);
  assert.ok(lenses.some(lens => lens.command.command === commands.open));
  assert.ok(!lenses.some(lens => lens.command.command === commands.extract));
});

test('rejected extraction preserves the document and rolls back exclusively created script', async t => {
  const initial = fence('echo original', 'id=analysis');
  const { document, root, environment, target } = fixture(t, initial);
  environment.failApply = true;
  assert.equal(await environment.commands.get(commands.extract)(target()), false);
  assert.equal(document.getText(), initial);
  assert.equal(fs.existsSync(path.join(root, '.inkwell', 'scripts', 'analysis.sh')), false);
});

test('changed-block execution skips current blocks and details label last-successful results stale', async t => {
  const initial = fence('echo original', 'id=analysis');
  const { document, environment, target } = fixture(t, initial, request => runner.runAllBlocks(request.text, request.document.uri.fsPath, undefined, undefined, request.selectedIndices));
  assert.equal(await environment.commands.get(commands.runChanged)(target()), true);
  assert.deepEqual(environment.executions[0].selectedIndices, [0]);
  assert.equal(await environment.commands.get(commands.runChanged)(target()), true);
  assert.equal(environment.executions.length, 1);
  assert.ok(environment.info.includes('All code blocks are current.'));
  assert.equal(await environment.commands.get(commands.details)(target()), true);
  assert.equal(JSON.parse(environment.views.at(-1).content).state, 'Current successful output');
  editText(document, fence('echo changed', 'id=analysis'));
  assert.equal(await environment.commands.get(commands.details)(target()), true);
  assert.match(JSON.parse(environment.views.at(-1).content).state, /Last successful output.*stale/);
});

test('malformed supplied command targets never fall back to running the active document', async t => {
  const { environment } = fixture(t, fence('echo active', 'id=analysis'));
  for (const target of [null, {}, { uri: 'file:///other.md', version: 'wrong-type', index: 0 },
    { uri: 'file:///other.md', version: -1, index: 0 }, { uri: 'file:///other.md', version: 1, index: -1 }]) {
    assert.equal(await environment.commands.get(commands.runBlock)(target), false);
  }
  assert.equal(environment.executions.length, 0);
  assert.equal(environment.ready, 0);
  assert.ok(environment.errors.every(message => /target is invalid/.test(message)));
});

for (const change of ['version', 'trust', 'closed', 'readonly']) {
  test('run-all revalidates ' + change + ' after asynchronous readiness', async t => {
    const { document, api, environment } = fixture(t);
    environment.beforeReady = async () => {
      if (change === 'version') editText(document, fence('echo changed'));
      if (change === 'trust') environment.trusted = false;
      if (change === 'closed') document.isClosed = true;
      if (change === 'readonly') environment.readonly = true;
    };
    assert.equal(await api.run(document), false);
    assert.equal(environment.executions.length, 0);
    assert.equal(environment.saves, 0);
  });
}

test('trust lost while assigning identities prevents saving or executing the document', async t => {
  const { document, api, environment } = fixture(t);
  environment.beforeApply = async () => { environment.trusted = false; };
  assert.equal(await api.run(document), false);
  assert.equal(environment.saves, 0);
  assert.equal(environment.executions.length, 0);
});

function dirtyScript(environment, file, source = 'echo unsaved\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'echo saved\n');
  const document = new Document(file, source, 'shellscript');
  document.isDirty = true;
  environment.documents.set(file, document);
  return document;
}

test('a selected dirty external script blocks execution without silently using its disk contents', async t => {
  const { root, document, environment, target } = fixture(t, fence('', 'id=analysis file=".inkwell/scripts/analysis.sh"'));
  dirtyScript(environment, path.join(root, '.inkwell', 'scripts', 'analysis.sh'));
  assert.equal(await environment.commands.get(commands.runBlock)(target()), false);
  assert.equal(environment.executions.length, 0);
  assert.equal(environment.saves, 0);
  assert.equal(document.isDirty, false);
  assert.match(environment.errors.at(-1), /Save the edited run script/);
});

test('dirty external dependencies are checked recursively but unrelated dirty scripts do not block selection', async t => {
  const initial = fence('echo selected', 'id=selected depends-on=middle') + '\n\n'
    + fence('echo middle', 'id=middle depends-on=upstream') + '\n\n'
    + fence('', 'id=upstream file=".inkwell/scripts/upstream.sh"') + '\n\n'
    + fence('', 'id=unrelated file=".inkwell/scripts/unrelated.sh"');
  const { root, environment, target } = fixture(t, initial);
  const upstream = dirtyScript(environment, path.join(root, '.inkwell', 'scripts', 'upstream.sh'));
  dirtyScript(environment, path.join(root, '.inkwell', 'scripts', 'unrelated.sh'));
  assert.equal(await environment.commands.get(commands.runBlock)(target(0)), false);
  assert.match(environment.errors.at(-1), /upstream.sh/);
  upstream.isDirty = false;
  assert.equal(await environment.commands.get(commands.runBlock)(target(0)), true);
  assert.deepEqual(environment.executions[0].selectedIndices, [0]);
});

test('a script dirtied while Markdown saves is detected before execution', async t => {
  const { root, environment, target } = fixture(t, fence('', 'id=analysis file=".inkwell/scripts/analysis.sh"'));
  const script = dirtyScript(environment, path.join(root, '.inkwell', 'scripts', 'analysis.sh'));
  script.isDirty = false;
  environment.afterSave = async () => { script.isDirty = true; };
  assert.equal(await environment.commands.get(commands.runBlock)(target()), false);
  assert.equal(environment.executions.length, 0);
  assert.match(environment.errors.at(-1), /Save the edited run script/);
});

test('dirty canonical script aliases and document-default sources are also blocked', async t => {
  const source = '---\ninkwell:\n  runs:\n    file: .inkwell/scripts/analysis.sh\n---\n' + fence('', 'id=analysis');
  const { root, environment, target } = fixture(t, source);
  const real = path.join(root, 'actual.sh');
  dirtyScript(environment, real);
  fs.symlinkSync(real, path.join(root, '.inkwell', 'scripts', 'analysis.sh'));
  assert.equal(await environment.commands.get(commands.runBlock)(target()), false);
  assert.equal(environment.executions.length, 0);
  assert.match(environment.errors.at(-1), /analysis.sh/);
});

test('run-changed and current details recognize an unsaved script edit even when disk output is current', async t => {
  const initial = fence('', 'id=analysis file=".inkwell/scripts/analysis.sh"');
  const { root, environment, target } = fixture(t, initial,
    request => runner.runAllBlocks(request.text, request.document.uri.fsPath, undefined, undefined, request.selectedIndices));
  const script = dirtyScript(environment, path.join(root, '.inkwell', 'scripts', 'analysis.sh'));
  script.isDirty = false;
  assert.equal(await environment.commands.get(commands.runChanged)(target()), true);
  script.isDirty = true;
  assert.equal(await environment.commands.get(commands.runChanged)(target()), false);
  assert.equal(environment.executions.length, 1);
  assert.equal(await environment.commands.get(commands.details)(target()), true);
  const details = JSON.parse(environment.views.at(-1).content);
  assert.match(details.state, /stale/);
  assert.match(details.reason, /Save the edited run script/);
});

test('failure opening an extracted script reports committed extraction without claiming rollback', async t => {
  const { document, root, environment, target } = fixture(t, fence('echo source', 'id=analysis'));
  const original = vscode.window.showTextDocument;
  vscode.window.showTextDocument = async (document, ...options) => {
    if (document.fsPath?.endsWith('analysis.sh')) throw new Error('editor unavailable');
    return original(document, ...options);
  };
  try { assert.equal(await environment.commands.get(commands.extract)(target()), true); }
  finally { vscode.window.showTextDocument = original; }
  assert.match(document.getText(), /file=".inkwell\/scripts\/analysis.sh"/);
  assert.equal(fs.readFileSync(path.join(root, '.inkwell', 'scripts', 'analysis.sh'), 'utf8'), 'echo source\n');
  assert.equal(environment.errors.length, 0);
  assert.match(environment.warnings[0], /script was extracted.*editor could not be opened/);
});
