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
  const webview = { postMessage: async (message) => { messages.push(message); return true; }, asWebviewUri: (u) => u, cspSource: 'test:', options: {} };
  const original = Module._load;
  Module._load = function(request, parent, ...args) {
    if (request === 'vscode') return { Uri: { file: uri }, window: {} };
    if (parent?.filename === path.join(extensionRoot, 'out/preview.js')) {
      if (request === './compiler') return { compile, readLastSuccessfulOutput: () => undefined, detectMode: () => 'pandoc', isCompilable: () => true };
      if (request === './runner') return { parseCodeBlocks: () => [] };
      if (request === './inject') return { prepareForPreview: (text) => text };
      if (request === './inkwell-output') return { getInkwellOutputChannel: () => ({ clear() {}, appendLine() {} }) };
      if (request === './config') return { getInkwellProjectRoot: () => root, getInkwellOutputsDir: () => root };
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
  return { provider, messages, webview, root, document };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

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
  const program = [...shell.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].at(-1)[1];
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
  assert.equal(Buffer.from(done.pdfData, 'base64').toString(), 'last good PDF');
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
  assert.equal(Buffer.from(done.pdfData, 'base64').toString(), 'existing PDF');
  assert.match(c.element('pdf-output-status').textContent, /Existing PDF.*unavailable/);
});
