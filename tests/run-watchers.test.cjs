const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const Module = require('node:module');
let state;

class Event {
  listeners = new Set();
  subscribe = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
}
class Disposable {
  constructor(callback) { this.callback = callback; }
  dispose() { const callback = this.callback; this.callback = undefined; callback?.(); }
}
const uri = fsPath => ({ fsPath, scheme: 'file', toString: () => 'file://' + fsPath });
const vscode = {
  Uri: { file: uri }, Disposable,
  RelativePattern: class { constructor(baseUri, pattern) { Object.assign(this, { baseUri, pattern }); } },
  workspace: {
    get isTrusted() { return state.trusted; },
    get textDocuments() { return state.documents; },
    getWorkspaceFolder: target => {
      const root = state.workspaceRoots.find(candidate => target.fsPath === candidate || target.fsPath.startsWith(candidate + path.sep));
      return root ? { uri: uri(root) } : undefined;
    },
    createFileSystemWatcher(glob) {
      state.globs.push(glob);
      const events = state.watchers.length ? { change: new Event(), create: new Event(), delete: new Event() } : { change: state.change, create: state.create, delete: state.delete };
      const watcher = { glob, events, disposed: false, onDidChange: events.change.subscribe, onDidCreate: events.create.subscribe, onDidDelete: events.delete.subscribe, dispose() { if (!this.disposed) state.watcherDisposed++; this.disposed = true; } };
      state.watchers.push(watcher); return watcher;
    },
    onDidOpenTextDocument: listener => state.open.subscribe(listener),
    onDidCloseTextDocument: listener => state.close.subscribe(listener),
  },
  window: { createOutputChannel: () => ({ appendLine() {} }) },
};
const originalLoad = Module._load;
Module._load = function(request, ...args) { if (request === 'vscode') return vscode; return originalLoad.call(this, request, ...args); };
const { registerRunWatchers } = require('../out/run-watchers');
Module._load = originalLoad;

const runnable = '```{shell id=analysis file=".inkwell/scripts/analysis.sh" inputs="data/*.csv"}\n```';
const settle = () => new Promise(resolve => setTimeout(resolve, 35));
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-run-watch-'));
  state = { trusted: true, documents: [], globs: [], watchers: [], workspaceRoots: [], watcherDisposed: 0, callbacks: [], errors: [], change: new Event(), create: new Event(), delete: new Event(), close: new Event(), open: new Event() };
  const context = { subscriptions: [] };
  const project = (name, text = runnable, relative = 'document.md') => {
    const root = path.join(base, name); fs.mkdirSync(path.join(root, '.inkwell'), { recursive: true });
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    const document = { uri: uri(file), version: 1, languageId: 'markdown', isClosed: false, isUntitled: false, getText: () => text };
    state.documents.push(document); return { root, document };
  };
  const start = (refresh = (document, request) => state.callbacks.push({ document, request }), options = {}) => registerRunWatchers(context, refresh, { debounceMs: 8, onError: error => state.errors.push(error), ...options });
  const file = (root, relative, text = 'input') => { const result = path.join(root, relative); fs.mkdirSync(path.dirname(result), { recursive: true }); fs.writeFileSync(result, text); return result; };
  const emit = (file, kind = 'change') => {
    for (const watcher of state.watchers) {
      if (watcher.disposed) continue;
      const roots = typeof watcher.glob === 'string' ? state.workspaceRoots : [watcher.glob.baseUri.fsPath];
      if (roots.some(root => file === root || file.startsWith(root + path.sep))) watcher.events[kind].fire(uri(file));
    }
  };
  t.after(() => { for (const disposable of context.subscriptions) disposable.dispose(); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, project, start, file, emit, environment: state };
}

test('registration performs no filesystem/interpreter probes or document scans', t => {
  const { project, start, environment } = fixture(t);
  const { document } = project('one');
  document.getText = () => { throw new Error('activation must not scan open documents'); };
  const methods = [[fs, 'existsSync'], [fs, 'realpathSync'], [fs, 'statSync'], [fs, 'readFileSync'], [fs, 'writeFileSync'], [cp, 'spawn'], [cp, 'execFileSync']];
  const originals = methods.map(([object, name]) => object[name]);
  let probes = 0;
  methods.forEach(([object, name]) => { object[name] = () => { probes++; throw new Error('unexpected activation probe'); }; });
  try { start(); assert.equal(probes, 0); assert.deepEqual(environment.globs, ['**/*']); }
  finally { methods.forEach(([object, name], index) => { object[name] = originals[index]; }); }
});

test('script/input/lockfile/environment events coalesce into one same-project refresh', async t => {
  const { project, start, file, environment } = fixture(t);
  const first = project('one'); const other = project('two');
  const paths = ['.inkwell/scripts/analysis.sh', 'data/new.csv', 'requirements.txt', '.inkwell/venv/lib/python/site-packages/pkg.dist-info/METADATA'].map(relative => file(first.root, relative));
  start();
  environment.change.fire(uri(paths[0])); environment.create.fire(uri(paths[1])); environment.change.fire(uri(paths[2])); environment.change.fire(uri(paths[3]));
  await settle();
  assert.equal(environment.callbacks.length, 1);
  const { document, request } = environment.callbacks[0];
  assert.equal(document, first.document); assert.notEqual(document, other.document);
  assert.deepEqual(request.changedPaths, paths.sort());
  assert.equal(request.projectRoot, first.root); assert.equal(request.sourceVersion, 1); assert.equal(request.isCurrent(), true);
});

test('deletes refresh through contained surviving parents without reading the deleted input', async t => {
  const { project, start, file, environment } = fixture(t);
  const { root } = project('one'); const input = file(root, 'data/removed.csv'); start();
  fs.unlinkSync(input); environment.delete.fire(uri(input));
  await settle();
  assert.deepEqual(environment.callbacks[0].request.changedPaths, [input]);
});

test('generated outputs and git events never refresh or create a callback feedback loop', async t => {
  const { project, start, file, environment } = fixture(t);
  const { root } = project('one');
  const excluded = ['.git/index', '.inkwell/runs/current.json', '.inkwell/outputs/a.txt', '.inkwell/.cache/a.txt', '.inkwell/compiled/a.pdf', '.inkwell/Mermaid/a.svg'];
  start((document, request) => { environment.callbacks.push({ document, request }); for (const relative of excluded) environment.change.fire(uri(path.join(root, relative))); });
  for (const relative of excluded) environment.change.fire(uri(path.join(root, relative)));
  await settle(); assert.equal(environment.callbacks.length, 0);
  environment.change.fire(uri(file(root, 'requirements.txt')));
  await settle(); await settle(); assert.equal(environment.callbacks.length, 1);
});

test('plain/mermaid/closed/untitled/wrong-language documents are excluded', async t => {
  const { project, start, file, environment } = fixture(t);
  const plain = project('plain', '# Plain writing');
  const mermaid = project('mermaid', '```{mermaid}\ngraph TD; A-->B\n```');
  const closed = project('closed'); closed.document.isClosed = true;
  const untitled = project('untitled'); untitled.document.isUntitled = true;
  const wrong = project('wrong'); wrong.document.languageId = 'plaintext';
  start();
  for (const candidate of [plain, mermaid, closed, untitled, wrong]) environment.change.fire(uri(file(candidate.root, 'input.csv')));
  await settle(); assert.equal(environment.callbacks.length, 0);
});

test('untrusted, closed, disposed, and reassigned-project documents cancel pending refreshes', async t => {
  const { project, start, file, environment } = fixture(t);
  const first = project('first'); const nested = project('second', runnable, 'chapter/document.md');
  const registration = start();
  const input = file(first.root, 'input.csv');
  environment.trusted = false; environment.change.fire(uri(input)); await settle(); assert.equal(environment.callbacks.length, 0);
  environment.trusted = true; environment.change.fire(uri(input)); environment.trusted = false; await settle(); assert.equal(environment.callbacks.length, 0);
  environment.trusted = true; environment.change.fire(uri(input)); first.document.isClosed = true; environment.close.fire(first.document); await settle(); assert.equal(environment.callbacks.length, 0);
  environment.change.fire(uri(file(nested.root, 'input.csv')));
  fs.mkdirSync(path.join(nested.root, 'chapter', '.inkwell')); await settle(); assert.equal(environment.callbacks.length, 0);
  environment.change.fire(uri(file(path.join(nested.root, 'chapter'), 'local.csv')));
  registration.dispose(); await settle(); assert.equal(environment.callbacks.length, 0); assert.equal(environment.watcherDisposed, 1);
});

test('escaping symlinks and paths outside the project are ignored before and after debounce', async t => {
  const { base, project, start, file, environment } = fixture(t);
  const { root } = project('one'); const external = file(base, 'outside.txt');
  const link = path.join(root, 'escape.csv'); fs.symlinkSync(external, link);
  start(); environment.change.fire(uri(external)); environment.change.fire(uri(link)); await settle(); assert.equal(environment.callbacks.length, 0);
  const replaced = file(root, 'data.csv'); environment.change.fire(uri(replaced)); fs.unlinkSync(replaced); fs.symlinkSync(external, replaced);
  await settle(); assert.equal(environment.callbacks.length, 0);
});

test('an async refresh token expires on another event, an editor version change, close, or disposal', async t => {
  const { project, start, file, environment } = fixture(t);
  const { root, document } = project('one'); const input = file(root, 'input.csv');
  const registration = start(); environment.change.fire(uri(input)); await settle();
  const first = environment.callbacks[0].request; assert.equal(first.isCurrent(), true);
  environment.change.fire(uri(input)); assert.equal(first.isCurrent(), false); await settle();
  const second = environment.callbacks[1].request; assert.ok(second.revision > first.revision); assert.equal(second.isCurrent(), true);
  document.version++; assert.equal(second.isCurrent(), false);
  environment.change.fire(uri(input)); await settle(); const third = environment.callbacks[2].request;
  environment.close.fire(document); assert.equal(third.isCurrent(), false);
  environment.change.fire(uri(input)); await settle(); const fourth = environment.callbacks[3].request;
  registration.dispose(); assert.equal(fourth.isCurrent(), false);
});

test('refresh rejections are observed without escaping listeners, including after disposal', async t => {
  const { project, start, file, environment } = fixture(t);
  const { root } = project('one'); const input = file(root, 'input.csv');
  const failure = new Error('refresh failed'); let reject;
  const registration = start(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  environment.change.fire(uri(input)); await settle(); reject(failure); await settle();
  assert.deepEqual(environment.errors, [failure]);
  environment.change.fire(uri(input)); await settle(); registration.dispose(); reject(new Error('disposed refresh')); await settle();
  assert.deepEqual(environment.errors, [failure]);
});

test('watching never launches execution or changes source/run metadata', async t => {
  const { project, start, file, environment } = fixture(t);
  const { root, document } = project('one'); const input = file(root, 'requirements.txt');
  const manifest = file(root, '.inkwell/runs/owned/current.json', '{"untouched":true}');
  const beforeSource = fs.readFileSync(document.uri.fsPath); const beforeManifest = fs.readFileSync(manifest);
  const originals = [cp.spawn, cp.execFileSync]; let calls = 0;
  cp.spawn = cp.execFileSync = () => { calls++; throw new Error('watcher cannot execute a process'); };
  try { start(); environment.change.fire(uri(input)); await settle(); assert.equal(calls, 0); assert.equal(environment.callbacks.length, 1); }
  finally { [cp.spawn, cp.execFileSync] = originals; }
  assert.deepEqual(fs.readFileSync(document.uri.fsPath), beforeSource); assert.deepEqual(fs.readFileSync(manifest), beforeManifest);
});

test('observe lazily watches standalone projects and retains one watcher until the last sibling closes', async t => {
  const { project, start, file, emit, environment } = fixture(t);
  const first = project('standalone'); const second = project('standalone', runnable, 'chapter.md');
  const input = file(first.root, 'data/input.csv'); const registration = start();
  emit(input); await settle(); assert.equal(environment.callbacks.length, 0);
  registration.observe(first.document); registration.observe(first.document);
  assert.equal(environment.watchers.length, 2);
  const relative = environment.watchers[1];
  assert.equal(relative.glob.baseUri.fsPath, first.root); assert.equal(relative.glob.pattern, '**/*');
  emit(input); await settle(); assert.equal(environment.callbacks.length, 2);
  first.document.isClosed = true; environment.documents = environment.documents.filter(document => document !== first.document); environment.close.fire(first.document);
  assert.equal(relative.disposed, false);
  emit(input, 'delete'); await settle(); assert.equal(environment.callbacks.length, 3); assert.equal(environment.callbacks.at(-1).document, second.document);
  second.document.isClosed = true; environment.documents = environment.documents.filter(document => document !== second.document); environment.close.fire(second.document);
  assert.equal(relative.disposed, true);
  emit(input); await settle(); assert.equal(environment.callbacks.length, 3);
});

test('opening an outside-workspace document observes it while trust and containment still apply', async t => {
  const { base, project, start, file, emit, environment } = fixture(t);
  const registration = start(); const outside = project('standalone'); const input = file(outside.root, 'requirements.txt');
  environment.open.fire(outside.document); assert.equal(environment.watchers.length, 2);
  emit(input); await settle(); assert.equal(environment.callbacks.length, 1);
  registration.dispose(); assert.ok(environment.watchers.every(watcher => watcher.disposed));
  const second = start(); const unsafe = project('unsafe'); const external = file(base, 'outside.md', runnable);
  fs.unlinkSync(unsafe.document.uri.fsPath); fs.symlinkSync(external, unsafe.document.uri.fsPath);
  second.observe(unsafe.document); assert.equal(environment.watchers.length, 3);
  const untrusted = project('untrusted'); environment.trusted = false; second.observe(untrusted.document);
  assert.equal(environment.watchers.length, 3);
});

test('workspace coverage is checked at the project root, including a project above an opened nested folder', async t => {
  const { project, start, file, emit, environment } = fixture(t);
  const nested = project('one', runnable, 'chapter/document.md');
  environment.workspaceRoots = [path.join(nested.root, 'chapter')];
  const registration = start(); registration.observe(nested.document);
  assert.equal(environment.watchers.length, 2);
  const input = file(nested.root, '.inkwell/scripts/analysis.sh'); emit(input); await settle(); assert.equal(environment.callbacks.length, 1);
  environment.workspaceRoots = [nested.root]; registration.observe(nested.document);
  assert.equal(environment.watchers[1].disposed, true);
  emit(input); await settle(); assert.equal(environment.callbacks.length, 2);
  registration.observe(nested.document); assert.equal(environment.watchers.length, 2);
});
