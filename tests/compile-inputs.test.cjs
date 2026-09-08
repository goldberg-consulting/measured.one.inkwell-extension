const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const Module = require('node:module');
let state;

const uri = fsPath => ({ fsPath, toString: () => `file://${fsPath}` });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class Event {
  listeners = new Set();
  subscribe = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
}
const vscode = {
  Uri: { file: uri },
  RelativePattern: class { constructor(baseUri, pattern) { Object.assign(this, { baseUri, pattern }); } },
  workspace: { createFileSystemWatcher(pattern) {
    const events = { change: new Event(), create: new Event(), delete: new Event() };
    const watcher = { pattern, events, disposed: false,
      onDidChange: events.change.subscribe, onDidCreate: events.create.subscribe, onDidDelete: events.delete.subscribe,
      dispose() { this.disposed = true; } };
    state.watchers.push(watcher); return watcher;
  } },
};
const originalLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (parent?.filename === require.resolve('../out/compile-inputs')) {
    if (request === 'vscode') return vscode;
    if (request === './config') return { getInkwellProjectRoot: () => state.root,
      getDocumentConfig: () => ({ fingerprint: state.configFingerprint }), getResolvedReferences: () => ({}) };
    if (request === './templates') return { getTemplateForDocument: () => state.template };
    if (request === './bibliography-service') return { bibliographyService: { snapshot: async () => {
      await state.referencesWait?.(); return { fingerprint: state.referencesFingerprint };
    } } };
  }
  return originalLoad.call(this, request, parent, ...rest);
};
const { CompileInputs } = require('../out/compile-inputs');
Module._load = originalLoad;

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-compile-inputs-'));
  const root = path.join(base, 'project'); const templateRoot = path.join(base, 'bundled-template');
  fs.mkdirSync(root); fs.mkdirSync(templateRoot);
  const templateFile = path.join(templateRoot, 'template.tex'); const supporting = path.join(templateRoot, 'support.sty');
  fs.writeFileSync(templateFile, '$body$\n'); fs.writeFileSync(supporting, '% style one\n');
  const document = { uri: uri(path.join(root, 'document.md')), version: 1, text: '# Document', getText() { return this.text; } };
  const environment = state = { root, watchers: [], changes: 0, configFingerprint: 'config-one', referencesFingerprint: 'references-one',
    template: { dir: templateRoot, pandocTemplate: templateFile, supportingFiles: [supporting], manifest: { id: 'fixture', engine: 'xelatex' } } };
  const tracker = new CompileInputs(() => environment.changes++);
  const emit = (file, kind = 'change') => {
    for (const watcher of environment.watchers) {
      const root = watcher.pattern.baseUri.fsPath;
      if (!watcher.disposed && (file === root || file.startsWith(root + path.sep))) watcher.events[kind].fire(uri(file));
    }
  };
  t.after(() => { tracker.dispose(); fs.rmSync(base, { recursive: true, force: true }); });
  return { environment, root, templateRoot, templateFile, supporting, document, tracker, emit };
}

test('construction is passive; stable fingerprints reuse project/template watchers and start no tools', async t => {
  const { environment, tracker, document } = fixture(t);
  assert.equal(environment.watchers.length, 0);
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const originals = names.map(name => childProcess[name]); let probes = 0;
  for (const name of names) childProcess[name] = () => { probes++; throw new Error('No executable probes belong in compile input tracking.'); };
  try {
    const first = await tracker.fingerprint(document);
    assert.match(first, /^[a-f0-9]{64}$/); assert.equal(await tracker.fingerprint(document), first);
    assert.equal(environment.watchers.length, 2); assert.equal(probes, 0);
    assert.deepEqual(environment.watchers.map(value => value.pattern.pattern), ['**/*', '**/*']);
  } finally { names.forEach((name, index) => { childProcess[name] = originals[index]; }); }
});

test('known published PDF and its exact atomic temporary are ignored, while other PDFs remain inputs', async t => {
  const { root, tracker, document, emit, environment } = fixture(t);
  const first = await tracker.fingerprint(document);
  const temporary = '.document.pdf.00000000-0000-4000-8000-000000000001.tmp';
  for (const relative of ['document.pdf', temporary, '.git/index', '.inkwell/compiled/document.tex', '.inkwell/mermaid/chart.svg', '.inkwell/.cache/preview-cites/test.json']) {
    for (const kind of ['change', 'create', 'delete']) emit(path.join(root, relative), kind);
  }
  assert.equal(environment.changes, 0); assert.equal(await tracker.fingerprint(document), first);
  for (const relative of ['figure.pdf', '.figure.pdf.00000000-0000-4000-8000-000000000001.tmp', '.document.pdf.not-a-run-id.tmp']) {
    const before = await tracker.fingerprint(document);
    emit(path.join(root, relative));
    assert.notEqual(await tracker.fingerprint(document), before, `Must track ${relative}`);
  }
  assert.equal(environment.changes, 3);
});

test('create/change/delete of run inputs, scripts, config and bibliography invalidate cached identity', async t => {
  const { root, tracker, document, emit, environment } = fixture(t);
  for (const [relative, kind] of [['data/new.csv', 'create'], ['.inkwell/scripts/analysis.py', 'change'],
    ['.inkwell/manifest.json', 'change'], ['references/source.bib', 'delete'], ['defaults.yaml', 'create'],
    ['requirements.txt', 'change'], ['.inkwell/runs/document/block/current.json', 'change']]) {
    const before = await tracker.fingerprint(document);
    emit(path.join(root, relative), kind);
    assert.notEqual(await tracker.fingerprint(document), before, `${kind}: ${relative}`);
  }
  assert.equal(environment.changes, 7);
});

test('source, version, resolved metadata and template bytes independently change the content fingerprint', async t => {
  const { tracker, document, environment, templateFile, supporting } = fixture(t);
  let last = await tracker.fingerprint(document);
  const changed = async () => { const current = await tracker.fingerprint(document); assert.notEqual(current, last); last = current; };
  document.text = '# Revised document'; await changed();
  document.version++; await changed();
  environment.configFingerprint = 'config-two'; await changed();
  environment.referencesFingerprint = 'references-two'; await changed();
  const originalTimes = fs.statSync(templateFile);
  fs.writeFileSync(templateFile, '$else$\n'); fs.utimesSync(templateFile, originalTimes.atime, originalTimes.mtime); await changed();
  fs.writeFileSync(supporting, '% style two\n'); await changed();
  environment.template.manifest = { ...environment.template.manifest, engine: 'pdflatex' }; await changed();
  assert.equal(environment.changes, 0, 'Content identities work without relying on watcher delivery.');
});

test('project input change during bibliography resolution rejects a mixed fingerprint', async t => {
  const { tracker, document, environment, root, emit } = fixture(t);
  const started = deferred(); const held = deferred();
  environment.referencesWait = () => { started.resolve(); return held.promise; };
  const pending = tracker.fingerprint(document); const rejection = assert.rejects(pending, /Project inputs changed/);
  await started.promise; emit(path.join(root, 'data/input.csv')); held.resolve(); await rejection;
  environment.referencesWait = undefined;
  assert.match(await tracker.fingerprint(document), /^[a-f0-9]{64}$/);
});

test('disposal during bibliography resolution cannot recreate template watchers after the await', async t => {
  const { tracker, document, environment } = fixture(t);
  const started = deferred(); const held = deferred();
  environment.referencesWait = () => { started.resolve(); return held.promise; };
  const pending = tracker.fingerprint(document); const rejection = assert.rejects(pending, /tracking has stopped/);
  await started.promise; assert.equal(environment.watchers.length, 1);
  tracker.dispose(); held.resolve(); await rejection;
  assert.equal(environment.watchers.length, 1); assert.ok(environment.watchers[0].disposed);
  for (const event of Object.values(environment.watchers[0].events)) assert.equal(event.listeners.size, 0);
  const changes = environment.changes; tracker.dispose(); assert.equal(environment.changes, changes);
  await assert.rejects(tracker.fingerprint(document), /tracking has stopped/);
  assert.equal(environment.watchers.length, 1);
});

async function holdTemplateRead(t, action, expectedError) {
  const context = fixture(t);
  const { tracker, document, templateFile } = context;
  // Establish both watchers before the next read is suspended.
  await tracker.fingerprint(document);
  const original = fs.createReadStream; const started = deferred(); const held = deferred();
  fs.createReadStream = function (file, ...args) {
    if (file !== templateFile) return original.call(this, file, ...args);
    return { async *[Symbol.asyncIterator]() { started.resolve(); await held.promise; yield fs.readFileSync(file); } };
  };
  try {
    const pending = tracker.fingerprint(document); const rejection = assert.rejects(pending, expectedError);
    await started.promise; action(context); held.resolve(); await rejection;
  } finally { held.resolve(); fs.createReadStream = original; }
  return context;
}

test('disposal during template streaming removes all subscriptions and does not recreate them', async t => {
  const { environment } = await holdTemplateRead(t, ({ tracker }) => tracker.dispose(), /tracking has stopped/);
  assert.equal(environment.watchers.length, 2);
  for (const watcher of environment.watchers) {
    assert.ok(watcher.disposed);
    for (const event of Object.values(watcher.events)) assert.equal(event.listeners.size, 0);
  }
});

test('template directory watcher generation prevents a mixed template fingerprint', async t => {
  const { environment } = await holdTemplateRead(t, ({ emit, templateRoot }) => emit(path.join(templateRoot, 'new.sty'), 'create'), /Project inputs changed/);
  assert.equal(environment.changes, 1);
});

test('template modification during the content read is rejected even without a watcher event', async t => {
  await holdTemplateRead(t, ({ templateFile }) => fs.writeFileSync(templateFile, '$body$ and a concurrent change\n'), /Template changed while checking compile inputs/);
});

test('explicit invalidation during an awaited read prevents an old configuration signature', async t => {
  await holdTemplateRead(t, ({ tracker }) => tracker.invalidate(), /Project inputs changed/);
});
