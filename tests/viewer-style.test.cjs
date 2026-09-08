const { clientProgram } = require('./preview-client-helper.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { normalizeFontScale, changeFontScale, readViewerState, viewerStateRuntime } = require('../out/viewer-state');
const { resolveDocumentConfig } = require('../out/document-config');
const { generatePreamble, parseInkwellStyle } = require('../out/preamble');

const extensionRoot = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const uri = file => ({ fsPath: file, scheme: 'file', toString: () => `file://${file}` });
const disposable = () => ({ dispose() {} });

function host(t, settings = {}, workspaceValues = new Map()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-viewer-style-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.inkwell'));
  const manifest = JSON.stringify({ schemaVersion: 4, defaults: { typography: { bodySize: '11pt' } }, managedFiles: {} }, null, 2);
  fs.writeFileSync(path.join(root, '.inkwell', 'manifest.json'), manifest);
  const source = '---\ntitle: Viewer independence\nmainfont: TeX Gyre Pagella\ninkwell:\n  code-font-size: small\n---\n\n# Heading\n\nBody text.\n';
  const sourcePath = path.join(root, 'document.md'); fs.writeFileSync(sourcePath, source);
  const document = { uri: uri(sourcePath), languageId: 'markdown', version: 1, isUntitled: false, getText: () => source };
  const messages = [], writes = [], editorWrites = [];
  let receive;
  const webview = { html: '', cspSource: 'test:', options: {}, asWebviewUri: value => value,
    postMessage: async message => { messages.push(plain(message)); return true; },
    onDidReceiveMessage: listener => { receive = listener; return disposable(); },
  };
  const panel = { webview, title: '', reveal() {}, onDidDispose: disposable };
  const vscode = {
    Uri: { file: uri }, ViewColumn: { Beside: 2 }, commands: { executeCommand: async () => {} },
    workspace: { isTrusted: true, getWorkspaceFolder: () => ({ uri: uri(root) }),
      getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback, inspect: () => undefined,
        update: (...args) => { editorWrites.push(args); return Promise.resolve(); } }),
      onDidChangeTextDocument: disposable, onDidChangeConfiguration: disposable,
      applyEdit: async edit => { editorWrites.push(edit); return true; },
    },
    window: { activeTextEditor: { document }, createWebviewPanel: () => panel,
      onDidChangeActiveTextEditor: disposable, showWarningMessage: async () => {},
    },
  };
  const original = Module._load;
  Module._load = function(request, parent, ...args) {
    if (request === 'vscode') return vscode;
    if (parent?.filename.endsWith(`${path.sep}preview.js`)) {
      if (request === './compiler') return { compile: async () => { throw new Error('Viewer zoom must not compile'); },
        readLastSuccessfulOutput: () => undefined, detectMode: () => 'pandoc', isCompilable: () => true };
      if (request === './runner') return { parseCodeBlocks: () => [] };
      if (request === './inject') return { prepareForPreview: text => text };
      if (request === './inkwell-output') return { getInkwellOutputChannel: () => ({ clear() {}, appendLine() {} }) };
      if (request === './config') return { getInkwellProjectRoot: () => root, getInkwellOutputsDir: () => root,
        getDocumentConfig: (text, file) => resolveDocumentConfig({ text, sourcePath: file, manifest: JSON.parse(manifest) }),
        getResolvedReferences: config => ({ bibliography: config.references.bibliography, scope: config.references.scope, linkCitations: config.references.links, diagnostics: [] }),
      };
      if (request === './citations') return { renderCitations: async body => ({ body, engine: 'none', referencesHtml: '', resolvedKeys: new Set(), missingKeys: new Set() }) };
    }
    return original.call(this, request, parent, ...args);
  };
  let Provider, configReader;
  try {
    delete require.cache[require.resolve('../out/config')]; configReader = require('../out/config').getDocumentConfig;
    delete require.cache[require.resolve('../out/preview')]; Provider = require('../out/preview').InkwellPreviewProvider;
  }
  finally { Module._load = original; }
  const context = { extensionPath: extensionRoot, subscriptions: [], workspaceState: {
    get: (key, fallback) => workspaceValues.has(key) ? workspaceValues.get(key) : fallback,
    update: async (key, value) => { writes.push([key, plain(value)]); workspaceValues.set(key, plain(value)); },
  } };
  const provider = new Provider(context);
  const open = async () => { await provider.show(); await receive({ type: 'ready' }); };
  return { provider, webview, messages, writes, editorWrites, workspaceValues, source, sourcePath, root, manifest, document,
    open, readCompileConfig: () => configReader(document.getText(), sourcePath), receive: message => receive(message), shell: () => provider.buildShell(webview, true) };
}

/** Runs the shipped client program without loading external scripts or project files. */
function client(shell, savedState, options = {}) {
  const elements = new Map(), messages = [], states = [], windowListeners = new Map();
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = {};
      this.className = ''; this.textContent = ''; this.disabled = false; this._html = ''; this.clientWidth = 1000; this.clientHeight = 1200;
      this.style = { setProperty(name, value) { this[name] = String(value); }, getPropertyValue(name) { return this[name] || ''; }, removeProperty(name) { delete this[name]; } };
    }
    get innerHTML() { return this._html; }
    set innerHTML(value) { this._html = value; this.children = []; }
    get childNodes() { return this.children; }
    get classList() {
      const self = this;
      return { contains: value => self.className.split(/\s+/).includes(value),
        add: value => { if (!self.classList.contains(value)) self.className += ` ${value}`; },
        remove: value => { self.className = self.className.split(/\s+/).filter(item => item !== value).join(' '); },
        toggle: (value, enabled) => { if (enabled) self.classList.add(value); else self.classList.remove(value); } };
    }
    appendChild(child) { child.parentNode = this; this.children.push(child); if (child.id) elements.set(child.id, child); return child; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key]; }
    addEventListener(event, listener) { this.listeners.set(event, [...(this.listeners.get(event) || []), listener]); }
    click() { if (!this.disabled) for (const listener of this.listeners.get('click') || []) listener({ preventDefault() {} }); }
  }
  function matches(element, selector) {
    return selector.split(',').some(value => { value = value.trim(); return value.startsWith('#') ? element.id === value.slice(1)
      : value.startsWith('.') ? element.classList.contains(value.slice(1)) : element.tagName.toLowerCase() === value; });
  }
  for (const match of shell.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1]); element.id = match[3];
    for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attr[1], attr[2]);
    element.className = element.attributes.class || ''; elements.set(element.id, element);
  }
  const tabs = [...shell.matchAll(/<button class="(inkwell-tab[^"]*)" data-tab="([^"]+)"/g)].map(match => {
    const element = new Element('button'); element.className = match[1]; element.setAttribute('data-tab', match[2]); return element;
  });
  const getElement = id => { if (!elements.has(id)) { const element = new Element(); element.id = id; elements.set(id, element); } return elements.get(id); };
  const document = { body: new Element('body'), head: new Element('head'), documentElement: new Element('html'),
    getElementById: getElement, createElement: tag => new Element(tag),
    querySelectorAll: selector => selector === '.inkwell-tab' ? tabs : [...elements.values()].filter(element => matches(element, selector)),
    querySelector: selector => document.querySelectorAll(selector)[0] || null,
  };
  const state = { value: savedState };
  const context = { document, window: { addEventListener: (event, listener) => windowListeners.set(event, listener), matchMedia: () => ({ matches: false }) },
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(plain(message)), getState: () => state.value,
      setState: value => { state.value = plain(value); states.push(state.value); return state.value; } }),
    setTimeout() {}, clearTimeout() {}, requestAnimationFrame() {}, getComputedStyle: element => element.style,
    atob: value => Buffer.from(value, 'base64').toString('binary'), Uint8Array,
  };
  const program = clientProgram(shell, options);
  vm.runInNewContext(program, context);
  return { element: getElement, document, messages, states, state, tabs,
    send: data => windowListeners.get('message')({ data }), click: id => getElement(id).click() };
}

test('viewer font scale clamps to 50–200 percent and rejects invalid persisted values', () => {
  for (const [input, expected] of [[50, 50], [100, 100], [200, 200], [0, 50], [250, 200], [NaN, 100], [Infinity, 100], [null, 100], [undefined, 100], ['large', 100]]) {
    assert.equal(normalizeFontScale(input), expected, String(input));
  }
  assert.equal(changeFontScale(100, 'increase'), 110); assert.equal(changeFontScale(100, 'decrease'), 90);
  assert.equal(changeFontScale(200, 'increase'), 200); assert.equal(changeFontScale(50, 'decrease'), 50);
  assert.equal(changeFontScale(180, 'reset'), 100);
});

test('viewer state normalizes accessibility scale independently of PDF zoom and author settings', () => {
  const value = readViewerState({ schemaVersion: 1, fontScale: 160, selectedTab: 'pdf', pdfFitMode: 'custom', pdfZoom: 125,
    typography: { bodySize: '20pt' }, source: 'private markdown' });
  assert.deepEqual(value, { schemaVersion: 1, fontScale: 160, selectedTab: 'pdf', pdfFitMode: 'custom', pdfZoom: 125 });
  assert.equal(readViewerState(undefined, 130, 'pdf').fontScale, 130);
  assert.equal(readViewerState(undefined, 130, 'pdf').selectedTab, 'pdf');
});

test('the minified release client includes and executes the shared viewer-state module', t => {
  const h = host(t), shell = h.shell();
  assert.match(shell, /src="[^"]*preview-client\.js"/, 'shell must use the local bundled client');
  assert.ok(!shell.includes(viewerStateRuntime.toString()), 'runtime belongs in the tested client module');
  const c = client(shell, undefined, { minify: true });
  c.click('font-increase'); assert.equal(c.state.value.fontScale, 110);
  assert.equal(c.element('article-content').style.zoom, '1.1');
  c.click('font-reset'); assert.equal(c.state.value.fontScale, 100);
});

test('A-/A+/Reset update only document viewer scale and preserve PDF controls', t => {
  const h = host(t), c = client(h.shell(), readViewerState({ fontScale: 100, selectedTab: 'preview', pdfFitMode: 'custom', pdfZoom: 125 }));
  c.send({ type: 'updateContent', revision: 1, documentUri: h.document.uri.toString(), sourceVersion: 1, html: '<p>Unchanged article</p>', pdfData: null });
  const article = c.element('article-content'), html = article.innerHTML;
  c.click('font-increase'); assert.equal(c.state.value.fontScale, 110);
  assert.equal(article.style.zoom, '1.1'); assert.equal(c.element('print-page-stage').style.zoom, '1.1');
  assert.equal(c.state.value.pdfZoom, 125); assert.equal(c.state.value.pdfFitMode, 'custom');
  c.click('font-decrease'); assert.equal(c.state.value.fontScale, 100);
  c.click('font-decrease'); c.click('font-reset'); assert.equal(c.state.value.fontScale, 100);
  assert.equal(article.style.zoom, '1'); assert.equal(c.element('print-page-stage').style.zoom, '1');
  assert.equal(article.innerHTML, html);
  assert.equal(c.messages.some(message => ['compile', 'run'].includes(message.type)), false);
  assert.ok(c.messages.some(message => message.type === 'viewerStateChanged' && message.state.fontScale === 110));
  for (const element of [c.document.body, c.document.documentElement, c.element('pane-pdf'), c.element('pane-log'), c.element('compile-btn')]) {
    assert.equal(element.style.zoom, undefined); assert.equal(element.style.transform, undefined);
  }
});

test('toolbar repeatedly clamps at each bound and reset remains available', t => {
  const h = host(t), c = client(h.shell());
  for (let count = 0; count < 30; count++) c.click('font-increase');
  assert.equal(c.state.value.fontScale, 200);
  assert.equal(c.element('article-content').style.zoom, '2');
  for (let count = 0; count < 30; count++) c.click('font-decrease');
  assert.equal(c.state.value.fontScale, 50);
  assert.equal(c.element('article-content').style.zoom, '0.5');
  c.click('font-reset'); assert.equal(c.state.value.fontScale, 100);
});

test('webview state restores after recreation without sharing another webview state', t => {
  const h = host(t), first = client(h.shell()); first.click('font-increase'); first.click('font-increase');
  const restored = client(h.shell(), first.state.value), independent = client(h.shell());
  assert.equal(restored.state.value.fontScale, 120);
  restored.click('font-increase'); assert.equal(restored.state.value.fontScale, 130);
  independent.click('font-decrease'); assert.equal(independent.state.value.fontScale, 90);
  assert.equal(first.state.value.fontScale, 120);
});

test('host viewer state messages work independently of document render revisions without an echo loop', t => {
  const h = host(t), c = client(h.shell());
  const count = c.messages.filter(message => message.type === 'viewerStateChanged').length;
  c.send({ type: 'viewerState', state: readViewerState({ fontScale: 140, selectedTab: 'preview', pdfFitMode: 'custom', pdfZoom: 150 }) });
  assert.equal(c.state.value.fontScale, 140); assert.equal(c.state.value.pdfZoom, 150);
  assert.equal(c.messages.filter(message => message.type === 'viewerStateChanged').length, count);
});

test('webview preference messages persist only normalized viewer fields', async t => {
  const h = host(t); await h.open();
  await h.receive({ type: 'viewerStateChanged', state: { schemaVersion: 1, fontScale: 500, selectedTab: 'pdf', pdfFitMode: 'custom', pdfZoom: 150,
    typography: { bodySize: '90pt' }, source: 'must not persist author content' } });
  assert.deepEqual(h.workspaceValues.get('inkwell.viewerState'), { schemaVersion: 1, fontScale: 200, selectedTab: 'pdf', pdfFitMode: 'custom', pdfZoom: 150 });
  assert.deepEqual(h.editorWrites, []);
});

test('workspace persistence and keyboard commands leave document bytes, resolved compile configuration, and preamble unchanged', async t => {
  const h = host(t, { 'preview.fontScale': 130 }); await h.open();
  const before = h.readCompileConfig();
  const preamble = generatePreamble(parseInkwellStyle(h.source, before));
  assert.ok(h.messages.some(message => message.type === 'viewerState' && message.state.fontScale === 130));
  await h.provider.changeFontScale('increase'); await h.provider.changeFontScale('decrease'); await h.provider.changeFontScale('reset');
  assert.equal(h.workspaceValues.get('inkwell.viewerState').fontScale, 100);
  assert.equal(fs.readFileSync(h.sourcePath, 'utf8'), h.source); assert.equal(h.document.version, 1);
  assert.equal(fs.readFileSync(path.join(h.root, '.inkwell', 'manifest.json'), 'utf8'), h.manifest);
  assert.deepEqual(h.editorWrites, []);
  const after = h.readCompileConfig();
  assert.equal(after.fingerprint, before.fingerprint); assert.deepEqual(after.compatibility, before.compatibility);
  assert.equal(generatePreamble(parseInkwellStyle(h.source, after)), preamble);
  const reopened = host(t, { 'preview.fontScale': 170 }, h.workspaceValues); await reopened.open();
  assert.ok(reopened.messages.some(message => message.type === 'viewerState' && message.state.fontScale === 100));
  const other = host(t, { 'preview.fontScale': 170 }); await other.open();
  assert.ok(other.messages.some(message => message.type === 'viewerState' && message.state.fontScale === 170));
});

test('document font overrides are scoped to document containers and cannot style chrome', async t => {
  const h = host(t); await h.open();
  const update = h.messages.find(message => message.type === 'updateContent'); assert.ok(update);
  const rules = [...update.layoutCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, , declarations]) => /--(?:body-font|heading-font|mono-font|base-size|line-height)\s*:/.test(declarations));
  assert.ok(rules.length, 'custom mainfont must reach document CSS');
  for (const [, selector] of rules) {
    assert.match(selector, /\.inkwell-document/);
    assert.doesNotMatch(selector, /:root|\bbody\b|\.inkwell-toolbar|\.log-/);
  }
  const css = [...h.shell().matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
  for (const [, selector, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/\.inkwell-(?:toolbar|tab|compile-btn)|\.log-|\.run-(?:panel|cancel)/.test(selector)) {
      assert.doesNotMatch(declarations, /font(?:-family|-size)?\s*:[^;}]*var\(--(?:body-font|heading-font|base-size)/, selector.trim());
    }
  }
});

test('all viewer scale commands are contributed and registered for keyboard and command palette access', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
  const source = fs.readFileSync(path.join(extensionRoot, 'src', 'extension.ts'), 'utf8');
  for (const id of ['inkwell.preview.decreaseFontScale', 'inkwell.preview.increaseFontScale', 'inkwell.preview.resetFontScale']) {
    assert.ok(pkg.contributes.commands.some(command => command.command === id), `${id} must be discoverable`);
    assert.ok(source.includes(`registerCommand("${id}"`) || source.includes(`registerCommand('${id}'`), `${id} must be callable`);
  }
});

test('browser PDF fit follows pane resizing and custom zoom keeps both page edges reachable', {
  skip: !process.env.INKWELL_CHROME_BIN, timeout: 30000,
}, async t => {
  const h = host(t), shell = h.shell();
  const css = [...shell.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
  const body = shell.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1].replace(/<script\b[\s\S]*?<\/script>/g, '');
  const program = clientProgram(shell);
  const fixture = path.join(h.root, 'viewer.html');
  const stub = `
    window.viewerMeasurements = { renders: [] };
    window.acquireVsCodeApi = () => ({ getState: () => ({ selectedTab: 'pdf', pdfFitMode: 'width', pdfZoom: 100 }), setState() {}, postMessage() {} });
    window.pdfjsLib = { GlobalWorkerOptions: {}, getDocument() { return { promise: Promise.resolve({
      numPages: 1, destroy() {}, getPage() { return Promise.resolve({
        getViewport({ scale }) { return { width: 612 * scale, height: 792 * scale }; },
        render({ viewport }) { viewerMeasurements.renders.push(viewport.width); return { promise: Promise.resolve() }; }
      }); }
    }) }; } };
  `;
  const measure = `
    const pane = document.getElementById('pane-pdf'); pane.style.width = '1000px';
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'updateContent', revision: 1,
      documentUri: 'file:///fixture.md', sourceVersion: 1, html: '<p>Fixture</p>', pdfData: 'Zg==' } }));
    setTimeout(() => {
      viewerMeasurements.before = document.querySelector('canvas').width;
      pane.style.width = '600px'; window.dispatchEvent(new Event('resize'));
      setTimeout(() => {
        viewerMeasurements.after = document.querySelector('canvas').width;
        const container = document.createElement('div'); container.className = 'pdf-canvas-container';
        container.style.cssText = 'position:fixed;left:0;top:0;width:500px;height:500px';
        const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 900;
        container.appendChild(canvas); document.body.appendChild(container);
        viewerMeasurements.left = canvas.getBoundingClientRect().left;
        viewerMeasurements.scrollWidth = container.scrollWidth;
        container.scrollLeft = 1000;
        viewerMeasurements.maxScroll = container.scrollLeft;
        viewerMeasurements.right = canvas.getBoundingClientRect().right;
        canvas.width = 200; container.scrollLeft = 0;
        viewerMeasurements.smallLeft = canvas.getBoundingClientRect().left;
        const result = document.createElement('pre'); result.id = 'browser-result';
        result.textContent = JSON.stringify(viewerMeasurements); document.body.appendChild(result);
      }, 500);
    }, 100);
  `;
  fs.writeFileSync(fixture, `<style>${fs.readFileSync(path.join(extensionRoot, 'media/preview.css'), 'utf8')}\n${css}</style>${body}<script>${stub}</script><script>${program}</script><script>${measure}</script>`);
  const { stdout } = await require('node:util').promisify(require('node:child_process').execFile)(process.env.INKWELL_CHROME_BIN, [
    '--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${path.join(h.root, 'chrome-profile')}`, '--virtual-time-budget=1500', '--dump-dom', require('node:url').pathToFileURL(fixture).href,
  ], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  const result = stdout.match(/<pre id="browser-result">([^<]+)<\/pre>/);
  assert.ok(result, 'the actual browser client must render the PDF and emit its measurements');
  const measured = JSON.parse(result[1]);
  assert.equal(measured.before, 976); assert.equal(measured.after, 576);
  assert.ok(measured.renders.length >= 2, 'fit width must rerender after the pane changes size');
  assert.equal(measured.left, 0); assert.equal(measured.scrollWidth, 1000);
  assert.equal(measured.maxScroll, 500); assert.equal(measured.right, 500);
  assert.equal(measured.smallLeft, 150, 'a page narrower than its pane stays centered');
});
