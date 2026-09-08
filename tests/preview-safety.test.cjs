const { clientProgram } = require('./preview-client-helper.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const extensionRoot = path.resolve(__dirname, '..');
const uri = (file) => ({ fsPath: file, toString: () => `file://${file}` });
const emptyCitations = (body) => ({ body, engine: 'none', referencesHtml: '', resolvedKeys: new Set(), missingKeys: new Set() });

function host(t, renderCitations = async (body) => emptyCitations(body), compile = async () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-preview-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const messages = [];
  const vscode = { Uri: { file: uri }, window: {},
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  };
  const webview = { postMessage: async (message) => { messages.push(message); return true; }, asWebviewUri: (u) => u, cspSource: 'test:', options: {} };
  const original = Module._load;
  Module._load = function(request, parent, ...args) {
    if (request === 'vscode') return vscode;
    if (parent?.filename === path.join(extensionRoot, 'out/preview.js')) {
      if (request === './compiler') return { compile, readLastSuccessfulOutput: () => undefined, detectMode: () => 'pandoc', isCompilable: () => true };
      if (request === './runner') return { parseCodeBlocks: () => [] };
      if (request === './inject') return { prepareForPreview: (text) => text };
      if (request === './inkwell-output') return { getInkwellOutputChannel: () => ({ clear() {}, appendLine() {} }) };
      if (request === './config') return {
        getInkwellProjectRoot: () => root, getInkwellOutputsDir: () => root,
        getDocumentConfig: (text, sourcePath) => require('../out/document-config').resolveDocumentConfig({ text, sourcePath }),
        getResolvedReferences: config => ({ bibliography: config.references.bibliography, scope: config.references.scope, linkCitations: config.references.links, diagnostics: [] }),
      };
      if (request === './citations') return { renderCitations };
    }
    return original.call(this, request, parent, ...args);
  };
  let Provider;
  try {
    delete require.cache[require.resolve('../out/preview.js')];
    Provider = require('../out/preview.js').InkwellPreviewProvider;
  } finally { Module._load = original; }
  const provider = new Provider({ extensionPath: extensionRoot });
  provider.panel = { webview, title: '' };
  provider.initialized = true;
  const document = (name, text, version = 1) => ({ uri: uri(path.join(root, name)), version, getText: () => text });
  return { provider, messages, webview, root, document, vscode };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('generated table cells cannot collide with math restoration or become math markup', async t => {
  const h = host(t);
  const payload = { schemaVersion: 1, headers: ['Literal'], rows: [
    ['INKWELLMATHPLACEHOLDER0ENDMATH'], ['$x$ <b>literal</b>'],
  ], attributes: {} };
  const document = h.document('table-math.md', '$a < b$\n\n```inkwell-table-data\n' + JSON.stringify(payload) + '\n```');
  h.provider.currentDocument = document;
  await h.provider.sendContentUpdate(document);
  const html = h.messages.find(message => message.type === 'updateContent').html;
  assert.match(html, /data-inkwell-math="0">\$a &lt; b\$<\/span>/);
  assert.match(html, /class="inkwell-table-literal"[^>]*>INKWELLMATHPLACEHOLDER0ENDMATH<\/td>/);
  assert.match(html, /class="inkwell-table-literal"[^>]*>\$x\$ &lt;b&gt;literal&lt;\/b&gt;<\/td>/);
});

// A small DOM adapter runs the actual shipped webview program. No repository
// project data, browser process, PDF engine, or external resource is loaded.
function client(provider, webview, globals = {}) {
  const elements = new Map();
  class Element {
    constructor() { this.style = {}; this.children = []; this.className = ''; this.textContent = ''; this._html = ''; this.attributes = {}; this.listeners = {}; }
    get innerHTML() { return this._html; }
    set innerHTML(value) { this._html = value; this.children = []; }
    get classList() {
      const self = this;
      return {
        contains: (c) => self.className.split(' ').includes(c),
        add: (c) => { if (!self.className.split(' ').includes(c)) self.className += ` ${c}`; },
        remove: (c) => { self.className = self.className.split(' ').filter((v) => v !== c).join(' '); },
        toggle: (c, enabled) => { if (enabled) self.classList.add(c); else self.classList.remove(c); },
      };
    }
    appendChild(child) { child.parentNode = this; this.children.push(child); if (child.id) elements.set(child.id, child); return child; }
    insertBefore(child, before) { child.parentNode = this; const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, child); if (child.id) elements.set(child.id, child); return child; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) { return this.children.filter((c) => selector.startsWith('.') && c.classList.contains(selector.slice(1))); }
    addEventListener(event, fn) { this.listeners[event] = fn; }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
  }
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement: () => new Element(), querySelectorAll: () => [], body: new Element(), head: new Element(),
  };
  const listeners = {};
  const context = {
    document, window: { addEventListener: (event, fn) => { listeners[event] = fn; } },
    acquireVsCodeApi: () => ({ postMessage() {} }), setTimeout() {}, clearTimeout() {},
    atob: (data) => Buffer.from(data, 'base64').toString('binary'), Uint8Array, ...globals,
  };
  const shell = provider.buildShell(webview, true);
  const program = clientProgram(shell);
  vm.runInNewContext(program, context);
  let identity = { revision: 1, documentUri: 'file:///test.md', sourceVersion: 1 };
  return { element: document.getElementById, send: (data) => {
    const message = { ...identity, ...data };
    identity = { revision: message.revision, documentUri: message.documentUri, sourceVersion: message.sourceVersion };
    listeners.message({ data: message });
  }, context };
}

test('a delayed old citation render cannot replace the newest document revision', async (t) => {
  const slow = deferred();
  const h = host(t, async (body) => body.includes('old') ? slow.promise : emptyCitations(body));
  const old = h.document('a.md', 'old', 1);
  const fresh = h.document('a.md', 'new', 2);
  h.provider.currentDocument = old;
  const oldRender = h.provider.sendContentUpdate(old);
  h.provider.currentDocument = fresh;
  await h.provider.sendContentUpdate(fresh);
  slow.resolve(emptyCitations('old'));
  await oldRender;
  const updates = h.messages.filter((m) => m.type === 'updateContent');
  assert.match(updates.at(-1).html, /new/);
  assert.equal(updates.some((m) => m.html.includes('old')), false);
});

test('blocked readiness clears a switched preview without rendering or compiling its content', async t => {
  let renders = 0, compiles = 0;
  const h = host(t, async body => { renders++; return emptyCitations(body); }, async () => { compiles++; });
  const document = h.document('plain.md', 'private unconfigured content');
  h.provider.currentDocument = document;
  h.provider.ensureReady = async () => false;
  await h.provider.sendContentUpdate(document);
  await h.provider.handleCompile();
  assert.equal(renders, 0);
  assert.equal(compiles, 0);
  const update = h.messages.find(message => message.type === 'updateContent');
  assert.equal(update.pdfUri, null);
  assert.doesNotMatch(update.html, /private unconfigured/);
});

test('a delayed readiness result cannot republish a previous document', async t => {
  const wait = deferred();
  const h = host(t);
  const a = h.document('a.md', 'old document');
  const b = h.document('b.md', 'current document');
  h.provider.ensureReady = document => document === a ? wait.promise : Promise.resolve(true);
  h.provider.currentDocument = a;
  const old = h.provider.sendContentUpdate(a);
  h.provider.currentDocument = b;
  await h.provider.sendContentUpdate(b);
  wait.resolve(false);
  await old;
  assert.equal(h.messages.filter(message => message.type === 'updateContent').length, 1);
  assert.match(h.messages.at(-1).html, /current document/);
});

test('a delayed Open Preview setup prompt cannot switch back to the previously active document', async t => {
  const pending = deferred();
  const h = host(t);
  const a = h.document('a.md', 'previous document');
  const b = h.document('b.md', 'current document');
  h.provider.currentDocument = a;
  h.vscode.window.activeTextEditor = { document: a };
  h.provider.ensureReady = async document => document === a ? pending.promise : true;
  const opening = h.provider.show();
  h.vscode.window.activeTextEditor = { document: b };
  h.provider.currentDocument = b;
  await h.provider.sendContentUpdate(b);
  pending.resolve(true);
  await opening;
  assert.equal(h.provider.getDocument(), b);
  assert.equal(h.messages.filter(message => message.type === 'updateContent').length, 1);
  assert.match(h.messages.at(-1).html, /current document/);
});

test('switching documents clears PDF, citations, and run output before a slow new render completes', async (t) => {
  const slow = deferred();
  const h = host(t, async (body) => body.includes('document B') ? slow.promise : emptyCitations(body));
  const a = h.document('a.md', 'document A citations');
  const b = h.document('b.md', 'document B');
  h.provider.currentDocument = a;
  await h.provider.sendContentUpdate(a);
  const c = client(h.provider, h.webview);
  for (const message of h.messages) c.send(message);
  c.send({ type: 'runStarted', blockCount: 1 });
  c.element('pane-pdf').appendChild(Object.assign(c.context.document.createElement('div'), { className: 'pdf-canvas-container' }));
  h.messages.length = 0;
  h.provider.currentDocument = b;
  const render = h.provider.sendContentUpdate(b);
  for (const message of h.messages) c.send(message);
  assert.equal(c.element('article-content').innerHTML, '');
  assert.equal(c.element('pane-pdf').querySelector('.pdf-canvas-container'), null);
  assert.equal(c.element('run-block-list').children.length, 0);
  assert.equal(c.element('run-panel').classList.contains('visible'), false);
  slow.resolve(emptyCitations('document B'));
  await render;
});

test('a null PDF content update clears the viewer and restores its placeholder', (t) => {
  const h = host(t);
  const c = client(h.provider, h.webview);
  c.send({ type: 'updateContent', html: '<p>A</p>', pdfData: 'b2xk', title: 'A' });
  c.element('pane-pdf').appendChild(Object.assign(c.context.document.createElement('div'), { className: 'pdf-canvas-container' }));
  c.element('pdf-placeholder').style.display = 'none';
  c.send({ type: 'updateContent', html: '<p>B</p>', pdfData: null, title: 'B' });
  assert.equal(c.element('pane-pdf').querySelector('.pdf-canvas-container'), null);
  assert.equal(c.element('pdf-placeholder').style.display, 'block');
});

test('an edit invalidates the previous render immediately, before the debounce fires', async (t) => {
  const slow = deferred();
  const h = host(t, async () => slow.promise);
  const document = h.document('a.md', 'old');
  h.provider.currentDocument = document;
  const oldRender = h.provider.sendContentUpdate(document);
  document.version = 2;
  h.provider.scheduleUpdate(document);
  t.after(() => clearTimeout(h.provider.throttle));
  slow.resolve(emptyCitations('old'));
  await oldRender;
  assert.equal(h.messages.filter((m) => m.type === 'updateContent').length, 0);
});

test('a delayed compile from A cannot send PDF or errors to document B', async (t) => {
  const slow = deferred();
  const h = host(t, undefined, () => slow.promise);
  const a = h.document('a.md', 'A');
  const b = h.document('b.md', 'B');
  h.provider.currentDocument = a;
  await h.provider.sendContentUpdate(a);
  const compiling = h.provider.handleCompile();
  h.provider.currentDocument = b;
  await h.provider.sendContentUpdate(b);
  h.messages.length = 0;
  slow.resolve({ success: false, errors: [{ severity: 'error', message: 'A failed' }], duration: 1, log: 'A private log' });
  await compiling;
  assert.equal(h.messages.length, 0);
});

test('an obsolete compile cannot publish diagnostics after its document changes', async t => {
  const slow = deferred(); const h = host(t, undefined, () => slow.promise); const diagnostics = [];
  h.provider.setDiagnostics({ report: (...arguments_) => diagnostics.push(arguments_) });
  const document = h.document('changing.md', 'old', 1);
  h.provider.currentDocument = document; await h.provider.sendContentUpdate(document);
  const compiling = h.provider.handleCompile();
  document.version = 2; document.getText = () => 'new';
  slow.resolve({ success: false, errors: [{ severity: 'error', message: 'obsolete' }], duration: 1, log: 'old' });
  await compiling;
  assert.deepEqual(diagnostics, []);
});

test('preview routes every captured document through its compile coordinator adapter', async t => {
  const slow = deferred(), calls = [];
  const h = host(t, undefined, async () => { throw new Error('Shared adapter was bypassed'); });
  h.provider.onCompile = async document => {
    calls.push(path.basename(document.uri.fsPath));
    if (calls.length === 1) await slow.promise;
    return { success: false, errors: [], duration: 0, log: '' };
  };
  const promises = [];
  for (const name of ['a.md', 'b.md', 'c.md']) {
    const document = h.document(name, name);
    h.provider.currentDocument = document;
    await h.provider.sendContentUpdate(document);
    promises.push(h.provider.handleCompile());
  }
  slow.resolve(); await Promise.all(promises);
  assert.deepEqual(calls, ['a.md', 'b.md', 'c.md']);
  assert.ok(h.messages.filter(message => message.type === 'compileDone').every(message => message.documentUri.endsWith('/c.md')));
});

test('run events retain their source identity across document switches and newer runs', async (t) => {
  const h = host(t);
  const a = h.document('a.md', 'A');
  const b = h.document('b.md', 'B');
  h.provider.currentDocument = a;
  await h.provider.sendContentUpdate(a);
  const aRun = h.provider.sendRunStarted(1, a);
  h.provider.currentDocument = b;
  await h.provider.sendContentUpdate(b);
  const bRun = h.provider.sendRunStarted(1, b);
  h.messages.length = 0;
  h.provider.sendBlockProgress({ index: 0, status: 'done' }, aRun);
  h.provider.sendRunComplete('failed', 0, 0, 0, 1, aRun);
  h.provider.sendLogEntry('error', 'A error', '', aRun);
  h.provider.sendLogEntry('error', 'untracked run', '', null);
  await h.provider.notifyBlocksRan(a, aRun);
  assert.equal(h.messages.length, 0);
  h.provider.sendBlockProgress({ index: 0, status: 'done' }, bRun);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].documentUri, b.uri.toString());
});

test('a null PDF invalidates an in-flight PDF.js load', async (t) => {
  const h = host(t);
  const load = deferred();
  let destroyed = 0;
  const c = client(h.provider, h.webview, { pdfjsLib: { GlobalWorkerOptions: {}, getDocument: () => ({ promise: load.promise }) } });
  c.send({ type: 'updateContent', html: 'A', pdfData: 'b2xk' });
  await Promise.resolve();
  await Promise.resolve();
  c.send({ type: 'updateContent', html: 'B', pdfData: null });
  load.resolve({ destroy() { destroyed++; }, numPages: 1, getPage() { throw new Error('stale PDF page must not load'); } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(destroyed, 1);
  assert.equal(c.element('pane-pdf').querySelector('.pdf-canvas-container'), null);
  assert.equal(c.element('pdf-placeholder').style.display, 'block');
});

test('a superseded run cannot update a newer run of the same source revision', async (t) => {
  const h = host(t);
  const document = h.document('a.md', 'A');
  h.provider.currentDocument = document;
  await h.provider.sendContentUpdate(document);
  const first = h.provider.sendRunStarted(1, document);
  const second = h.provider.sendRunStarted(1, document);
  h.messages.length = 0;
  h.provider.sendRunComplete('failed', 0, 0, 0, 1, first);
  h.provider.sendLogEntry('error', 'old attempt failed', '', first);
  assert.equal(h.messages.length, 0);
  h.provider.sendRunComplete('done', 1, 0, 0, 0, second);
  assert.equal(h.messages.length, 1);
});

test('the webview discards out-of-order content and run messages', (t) => {
  const h = host(t);
  const c = client(h.provider, h.webview);
  c.send({ type: 'updateContent', revision: 2, documentUri: 'file:///b.md', html: 'B', pdfData: null });
  c.send({ type: 'updateContent', revision: 1, documentUri: 'file:///a.md', html: 'A', pdfData: 'b2xk' });
  c.send({ type: 'runStarted', revision: 1, documentUri: 'file:///a.md', blockCount: 1 });
  assert.equal(c.element('article-content').innerHTML, 'B');
  assert.equal(c.element('run-panel').classList.contains('visible'), false);
});

test('a failed same-document compile retains and labels its last successful PDF', async (t) => {
  let result;
  const h = host(t, undefined, async () => result);
  const document = h.document('a.md', 'changed source', 2);
  const pdfPath = path.join(h.root, 'a.pdf');
  fs.writeFileSync(pdfPath, 'last good PDF');
  result = {
    success: false, duration: 1, errors: [{ severity: 'error', message: 'Invalid LaTeX' }], log: 'compile failed',
    lastSuccessfulOutput: { pdfPath, sourceVersion: 1, publishedAt: '2026-09-07T10:00:00.000Z', sourceHash: 'previous' },
  };
  h.provider.currentDocument = document;
  await h.provider.sendContentUpdate(document);
  const c = client(h.provider, h.webview);
  for (const message of h.messages) c.send(message);
  h.messages.length = 0;
  await h.provider.handleCompile();
  for (const message of h.messages) c.send(message);
  const done = h.messages.find((m) => m.type === 'compileDone');
  assert.equal(done.success, false);
  assert.match(done.pdfUri, /a\.pdf\?inkwellPdf=/);
  assert.equal(done.pdfData, undefined);
  assert.match(c.element('pdf-output-status').textContent, /Last successful output.*source version 1/);
  assert.match(c.element('pdf-output-status').textContent, /2026/);
});

test('a citation failure is observed and reported without an unhandled preview rejection', async (t) => {
  const h = host(t, async () => { throw new Error('citation process failed'); });
  const document = h.document('a.md', 'A');
  h.provider.currentDocument = document;
  await assert.doesNotReject(h.provider.sendContentUpdate(document));
  const failure = h.messages.find((m) => m.type === 'logEntry' && m.tag === 'error');
  assert.match(failure.details, /citation process failed/);
  assert.equal(failure.documentUri, document.uri.toString());
});

test('a failed compile preserves an existing PDF when its provenance metadata is unavailable', async (t) => {
  const h = host(t, undefined, async () => ({ success: false, duration: 1, errors: [], log: 'failed' }));
  const document = h.document('a.md', 'changed source', 2);
  fs.writeFileSync(path.join(h.root, 'a.pdf'), 'existing PDF');
  h.provider.currentDocument = document;
  await h.provider.sendContentUpdate(document);
  const c = client(h.provider, h.webview);
  for (const message of h.messages) c.send(message);
  h.messages.length = 0;
  await h.provider.handleCompile();
  for (const message of h.messages) c.send(message);
  const done = h.messages.find(m => m.type === 'compileDone');
  assert.match(done.pdfUri, /a\.pdf\?inkwellPdf=/);
  assert.equal(done.pdfData, undefined);
  assert.match(c.element('pdf-output-status').textContent, /Existing PDF.*unavailable/);
});

test('PDF updates use stable asynchronous local resources without reading or sending PDF bytes', async t => {
  const h = host(t);
  const document = h.document('resource.md', 'Draft text');
  const pdfPath = path.join(h.root, 'resource.pdf');
  fs.writeFileSync(pdfPath, 'last good PDF');
  const originalRead = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (String(file) === pdfPath) throw new Error('Preview must never synchronously read PDF bytes');
    return originalRead.call(this, file, ...args);
  };
  try {
    h.provider.currentDocument = document;
    await h.provider.sendContentUpdate(document);
    await h.provider.sendContentUpdate(document);
    const updates = h.messages.filter(message => message.type === 'updateContent');
    assert.match(updates[0].pdfUri, /resource\.pdf\?inkwellPdf=/);
    assert.equal(updates[0].pdfUri, updates[1].pdfUri);
    assert.equal(Object.hasOwn(updates[0], 'pdfData'), false);
    fs.writeFileSync(pdfPath, 'replacement PDF with changed size');
    await h.provider.sendContentUpdate(document);
    assert.notEqual(h.messages.filter(message => message.type === 'updateContent').at(-1).pdfUri, updates[0].pdfUri);
  } finally { fs.readFileSync = originalRead; }
});

test('a PDF symlink outside the document directory is never exposed as a webview resource', async t => {
  const h = host(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-outside-pdf-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'private.pdf'), 'private');
  fs.symlinkSync(path.join(outside, 'private.pdf'), path.join(h.root, 'escape.pdf'));
  const document = h.document('escape.md', 'Safe document');
  h.provider.currentDocument = document;
  await h.provider.sendContentUpdate(document);
  assert.equal(h.messages.find(message => message.type === 'updateContent').pdfUri, null);
});

test('rapid edit bursts perform one final render and publish only the newest revision', async t => {
  let renders = 0;
  const h = host(t, async body => { renders++; return emptyCitations(body); });
  const document = h.document('typing.md', 'draft');
  let text = '';
  document.getText = () => text;
  h.provider.currentDocument = document;
  for (let version = 1; version <= 30; version++) {
    document.version = version; text = `Latest draft ${version}`;
    h.provider.scheduleUpdate(document);
  }
  t.after(() => clearTimeout(h.provider.throttle));
  await new Promise(resolve => setTimeout(resolve, 220));
  const updates = h.messages.filter(message => message.type === 'updateContent');
  assert.equal(renders, 1); assert.equal(updates.length, 1);
  assert.equal(updates[0].sourceVersion, 30);
  assert.match(updates[0].html, /Latest draft 30/);
});

test('ordinary draft text appears before optional citations finish and cannot outlive its source', async t => {
  const pending = deferred();
  const h = host(t, () => pending.promise);
  const document = h.document('cited.md', 'Immediate prose with @smith2024.');
  h.provider.currentDocument = document;
  const rendering = h.provider.sendContentUpdate(document);
  await Promise.resolve();
  const draft = h.messages.find(message => message.type === 'draftContent');
  assert.match(draft.html, /Immediate prose/);
  assert.match(draft.featureStatus, /Resolving references/);
  assert.equal(h.messages.some(message => message.type === 'updateContent'), false);
  pending.resolve(emptyCitations('Immediate prose with resolved citation.'));
  await rendering;
  assert.match(h.messages.find(message => message.type === 'updateContent').html, /resolved citation/);
});

test('the actual sanitized preview pipeline restores math and retains the approximate citation notice', async t => {
  const h = host(t, async body => ({ ...emptyCitations(body), approximate: true }));
  const document = h.document('safe-math.md', '$a < b$\n\n$$c^2 = a^2 + b^2$$\n\nSee @smith2024.\n\n<script>privateScript()</script>\n');
  h.provider.currentDocument = document;
  await h.provider.sendContentUpdate(document);
  const final = h.messages.find(message => message.type === 'updateContent').html;
  assert.match(final, /<span data-inkwell-math="0">\$\$c\^2 = a\^2 \+ b\^2\$\$<\/span>|<div class="math-display" data-inkwell-math="0">\$\$c\^2 = a\^2 \+ b\^2\$\$<\/div>/);
  assert.match(final, /<span data-inkwell-math="1">\$a &lt; b\$<\/span>/);
  assert.match(final, /<aside class="citation-preview-notice">Approximate citation preview:/);
  assert.doesNotMatch(final, /INKWELLMATHPLACEHOLDER|privateScript|<script/);
  const early = h.messages.find(message => message.type === 'draftContent').html;
  assert.doesNotMatch(early, /INKWELLMATHPLACEHOLDER|privateScript|<script/);
});

test('a stopped watcher cannot publish its delayed refresh, while a later manual render remains current', async t => {
  const pending = deferred();
  let first = true;
  const h = host(t, async body => { if (first) { first = false; return pending.promise; } return emptyCitations(body); });
  const document = h.document('watched.md', 'Current author text');
  h.provider.currentDocument = document;
  let watcherActive = true;
  const refreshing = h.provider.refresh(document, () => watcherActive);
  watcherActive = false;
  pending.resolve(emptyCitations('Obsolete watcher result'));
  await refreshing;
  assert.equal(h.messages.some(message => message.type === 'updateContent'), false);
  await h.provider.sendContentUpdate(document);
  const updates = h.messages.filter(message => message.type === 'updateContent');
  assert.equal(updates.length, 1);
  assert.match(updates[0].html, /Current author text/);
  assert.doesNotMatch(updates[0].html, /Obsolete/);
});


test('selected run progress uses real block indices and adds only executed dependency rows', async t => {
  const h = host(t), document = h.document('selected.md', 'Selection');
  h.provider.currentDocument = document;
  await h.provider.sendContentUpdate(document);
  const request = h.provider.sendRunStarted(1, document, [2]);
  const started = h.messages.find(message => message.type === 'runStarted');
  assert.deepEqual(started.blockIndices, [2]);
  const c = client(h.provider, h.webview);
  for (const message of h.messages) c.send(message);
  assert.deepEqual(c.element('run-block-list').children.map(row => row.id), ['run-block-2']);
  c.send({ ...request, type: 'blockProgress', index: 0, status: 'done', total: 3, label: 'Dependency' });
  assert.deepEqual(c.element('run-block-list').children.map(row => row.id), ['run-block-0', 'run-block-2']);
  assert.equal(c.element('run-summary').textContent, '1/2 blocks');
  c.send({ ...request, type: 'blockProgress', index: 2, status: 'done', total: 3, label: 'Selected' });
  assert.equal(c.element('run-summary').textContent, '2/2 blocks');
  c.send({ ...request, type: 'runComplete', outcome: 'done', ran: 2, cached: 0 });
  assert.equal(c.element('run-block-list').children.some(row => row.id === 'run-block-1'), false);
  assert.equal(c.element('run-block-list').children.some(row => row.classList.contains('status-pending')), false);
});

test('dependency refresh checks its source guard again before asynchronous publication', async t => {
  const work = deferred(), h = host(t, () => work.promise);
  const document = h.document('guarded.md', 'Cite [@key].'); h.provider.currentDocument = document;
  let current = true; const pending = h.provider.refresh(document, () => current);
  await new Promise(resolve => setImmediate(resolve)); current = false;
  work.resolve(emptyCitations('Old dependency result')); await pending;
  assert.equal(h.messages.some(message => message.type === 'updateContent'), false);
});


test('same-source dependency refresh releases obsolete run controls and rejects old completion', async t => {
  const h = host(t), document = h.document('active-run.md', 'Current source', 1);
  h.provider.currentDocument = document;
  await h.provider.sendContentUpdate(document);
  const run = h.provider.sendRunStarted(1, document);
  h.provider.sendBlockProgress({ index: 0, status: 'running' }, run);
  const c = client(h.provider, h.webview);
  for (const message of h.messages) c.send(message);
  assert.equal(c.element('run-btn').disabled, true);
  assert.equal(c.element('run-block-list').children[0].classList.contains('status-running'), true);
  h.messages.length = 0;
  await h.provider.refresh(document);
  assert.equal(h.messages.find(message => message.type === 'renderStarted').sourceVersion, run.sourceVersion);
  for (const message of h.messages) c.send(message);
  assert.equal(c.element('run-btn').disabled, false);
  assert.equal(c.element('run-cancel-btn').style.display, 'none');
  assert.equal(c.element('run-block-list').children.length, 0);
  h.messages.length = 0;
  h.provider.sendRunComplete('failed', 0, 0, 0, 1, run);
  assert.equal(h.messages.length, 0);
  c.send({ ...run, type: 'runComplete', outcome: 'failed', failed: 1 });
  assert.equal(c.element('run-btn').disabled, false);
  assert.equal(c.element('run-block-list').children.length, 0);
});
