const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { resolveDocumentConfig } = require('../out/document-config');
const { BibliographyService, resolveBibliographyConfiguration } = require('../out/bibliography-service');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bib = (key, title = key) => `@book{${key}, title={${title}}, author={Doe, Jane}, year={2026}}\n`;

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-authoring-'));
  const service = new BibliographyService(), providers = {}, events = {}, watchers = [], diagnostics = new Map(), calls = [], messages = [], opened = [];
  let collectionDisposed = false, publications = 0;
  const uri = file => ({ scheme: 'file', fsPath: file, toString: () => `file://${file}` });
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range { constructor(a, b, c, d) { this.start = typeof a === 'number' ? new Position(a, b) : a; this.end = typeof a === 'number' ? new Position(c, d) : b; } }
  const event = name => {
    const handlers = new Set(); events[name] = value => { for (const handler of handlers) handler(value); };
    return handler => { handlers.add(handler); return { dispose: () => handlers.delete(handler) }; };
  };
  const disposed = () => ({ dispose() {} });
  const vscode = {
    Uri: { file: uri }, Position, Range,
    CompletionItemKind: { Reference: 17 }, DiagnosticSeverity: { Error: 0, Warning: 1 },
    CompletionItem: class { constructor(label, kind) { this.label = label; this.kind = kind; } },
    MarkdownString: class { value = ''; appendText(text) { this.value += text; return this; } },
    Hover: class { constructor(contents, range) { this.contents = contents; this.range = range; } },
    Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } },
    Diagnostic: class { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } },
    DiagnosticRelatedInformation: class { constructor(location, message) { this.location = location; this.message = message; } },
    languages: {
      createDiagnosticCollection: () => ({
        clear: () => { assert.equal(collectionDisposed, false, 'disposed collection cannot publish'); diagnostics.clear(); publications++; },
        set: (file, issues) => { assert.equal(collectionDisposed, false, 'disposed collection cannot publish'); diagnostics.set(file.fsPath, issues); },
        dispose: () => { collectionDisposed = true; diagnostics.clear(); },
      }),
      registerCompletionItemProvider: (selector, provider, trigger) => { providers.completion = provider.provideCompletionItems; providers.trigger = trigger; return disposed(); },
      registerHoverProvider: (selector, provider) => { providers.hover = provider.provideHover; return disposed(); },
      registerDefinitionProvider: (selector, provider) => { providers.definition = provider.provideDefinition; return disposed(); },
    },
    workspace: {
      isTrusted: options.trusted !== false, textDocuments: [],
      onDidOpenTextDocument: event('open'), onDidChangeTextDocument: event('change'), onDidCloseTextDocument: event('close'),
      createFileSystemWatcher: glob => {
        const watcher = { glob, dispose() {}, onDidChange: event(`watch:${glob}:change`), onDidCreate: event(`watch:${glob}:create`), onDidDelete: event(`watch:${glob}:delete`) };
        watchers.push(watcher); return watcher;
      },
      openTextDocument: async file => { opened.push(file.fsPath); return { uri: file }; },
    },
    window: {
      showInformationMessage: async message => messages.push(message),
      showQuickPick: async items => options.choose ? options.choose(items) : items[0],
      showTextDocument: async (document, settings) => opened.push({ document, settings }),
    },
    commands: { registerCommand: () => disposed() },
  };
  const write = (relative, text) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  const makeDocument = (name, initial) => {
    let text = initial;
    const document = { uri: uri(write(name, text)), languageId: 'markdown', isUntitled: false, isClosed: false, version: 1,
      getText: () => text,
      positionAt: offset => { const before = text.slice(0, offset), lines = before.split('\n'); return new Position(lines.length - 1, lines.at(-1).length); },
      offsetAt: position => { const lines = text.split('\n'); return lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character; },
      change: value => { text = value; document.version++; events.change({ document }); },
    };
    vscode.workspace.textDocuments.push(document); return document;
  };
  const replacements = {
    vscode,
    './config': {
      getDocumentConfig: (text, sourcePath) => resolveDocumentConfig({ text, sourcePath }),
      getInkwellProjectRoot: () => root,
      getResolvedReferences: (config, sourcePath) => resolveBibliographyConfiguration(config, sourcePath, root),
    },
    './bibliography-service': { preferredBibliographyEntry: require('../out/bibliography-service').preferredBibliographyEntry, bibliographyService: {
      snapshot: async resolved => { calls.push(['snapshot', resolved]); return options.snapshot ? options.snapshot(resolved, service) : service.snapshot(resolved); },
      invalidate: file => { calls.push(['invalidate', file]); service.invalidate(file); },
    } },
    './citation-pandoc': { citationPandocEngine: { render: async (...args) => {
      calls.push(['render', ...args]);
      if (options.render) return options.render(...args);
      return { body: args[0], resolvedKeys: new Set(), missingKeys: new Set(['missing']), engine: 'pandoc' };
    } } },
    './bibliography-ui': { configureBibliography: async () => {} },
  };
  const original = Module._load;
  Module._load = function(request, parent, ...rest) {
    if (parent?.filename.endsWith(`${path.sep}bibliography-authoring.js`) && replacements[request]) return replacements[request];
    return original.call(this, request, parent, ...rest);
  };
  let api;
  try { delete require.cache[require.resolve('../out/bibliography-authoring')]; api = require('../out/bibliography-authoring'); }
  finally { Module._load = original; }
  const document = makeDocument('document.md', options.text || '---\nbibliography: [first.bib, second.bib]\n---\n\nSee @shared and [@missing].\n');
  write('first.bib', bib('shared', 'First title') + bib('firstOnly'));
  write('second.bib', bib('shared', 'Second title') + bib('secondOnly'));
  const authoring = new api.BibliographyAuthoring(); vscode.window.activeTextEditor = { document };
  t.after(() => { authoring.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, api, authoring, vscode, document, makeDocument, providers, events, watchers, diagnostics, calls, messages, opened, write,
    position: (key, doc = document) => doc.positionAt(doc.getText().indexOf(`@${key}`) + 2),
    changeFile: (relative, kind = 'change') => events[`watch:${relative.endsWith('.bib') || relative.endsWith('.csl') ? '**/*.{bib,csl}' : '**/{defaults.yaml,.inkwell/manifest.json}'}:${kind}`](uri(path.join(root, relative))),
    publications: () => publications,
  };
}

test('activation registers language support and watchers without indexing or launching Pandoc', async t => {
  const h = fixture(t);
  await sleep(220);
  assert.deepEqual(h.calls, []); assert.equal(h.publications(), 0);
  assert.equal(h.providers.trigger, '@'); assert.equal(h.watchers.length, 2);
});

test('ordinary completion, safe hover, and definitions use earlier-file precedence and retain every duplicate location', async t => {
  const h = fixture(t);
  const completions = await h.providers.completion(h.document);
  assert.deepEqual(completions.map(item => item.label), ['shared', 'firstOnly', 'secondOnly']);
  assert.match(completions[0].detail, /^First title/);
  const hover = await h.providers.hover(h.document, h.position('shared'));
  assert.match(hover.contents.value, /^First title/); assert.match(hover.contents.value, /first file/);
  assert.notEqual(hover.contents.isTrusted, true);
  const definitions = await h.providers.definition(h.document, h.position('shared'));
  assert.deepEqual(definitions.map(location => path.basename(location.uri.fsPath)), ['first.bib', 'second.bib']);
  assert.equal(definitions[0].range.line, 0);
  assert.equal(h.calls.filter(call => call[0] === 'snapshot').length, 1, 'warm providers reuse the indexed document');
  assert.equal(h.calls.filter(call => call[0] === 'render').length, 1);
});

test('first edit publishes missing-key navigation and diagnostics at both bibliography definitions', async t => {
  const h = fixture(t);
  h.document.change(h.document.getText() + '\nAdditional text.\n');
  await sleep(250);
  const issues = h.diagnostics.get(h.document.uri.fsPath);
  assert.equal(issues.length, 1); assert.equal(issues[0].code, 'citation-missing');
  assert.equal(h.document.offsetAt(issues[0].range.start), h.document.getText().indexOf('@missing') + 1);
  for (const [name, other] of [['first.bib', 'second.bib'], ['second.bib', 'first.bib']]) {
    const duplicate = h.diagnostics.get(path.join(h.root, name)).find(issue => issue.code === 'bibliography-duplicate');
    assert.equal(duplicate.range.start.line, 0); assert.equal(duplicate.relatedInformation.length, 1);
    assert.equal(path.basename(duplicate.relatedInformation[0].location.uri.fsPath), other);
  }
});

test('an outdated asynchronous result cannot replace a newer document or its diagnostics', async t => {
  const waiting = deferred(), started = deferred();
  const h = fixture(t, { render: async body => {
    if (body.includes('old text')) { started.resolve(); await waiting.promise; return { missingKeys: new Set(['missing']) }; }
    return { missingKeys: new Set() };
  }, text: '---\nbibliography: first.bib\n---\nold text @missing\n' });
  const old = h.providers.completion(h.document); await started.promise;
  h.document.change('---\nbibliography: second.bib\n---\nnew text @shared\n');
  const latest = await h.providers.completion(h.document);
  assert.match(latest.find(item => item.label === 'shared').detail, /^Second title/);
  waiting.resolve(); assert.deepEqual(await old, []);
  assert.equal(h.diagnostics.has(h.document.uri.fsPath), false);
  assert.match((await h.providers.completion(h.document))[0].detail, /^Second title/);
});

test('simultaneous provider requests share one pending index and citation render', async t => {
  const waiting = deferred();
  const h = fixture(t, { render: async () => { await waiting.promise; return { missingKeys: new Set() }; } });
  const completed = h.providers.completion(h.document), hovered = h.providers.hover(h.document, h.position('shared'));
  const definitions = h.providers.definition(h.document, h.position('shared'));
  waiting.resolve(); const results = await Promise.all([completed, hovered, definitions]);
  assert.equal(results[0].length, 3); assert.equal(results[2].length, 2);
  assert.equal(h.calls.filter(call => call[0] === 'snapshot').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'render').length, 1);
});

for (const target of ['first.bib', 'style.csl', 'defaults.yaml', '.inkwell/manifest.json']) test(`${target} change invalidates the affected document's cached authoring state`, async t => {
  const h = fixture(t, { text: '---\nbibliography: first.bib\ncsl: style.csl\n---\n@shared\n' });
  h.write('style.csl', '<style/>'); await h.providers.completion(h.document);
  const count = h.calls.filter(call => call[0] === 'snapshot').length;
  h.write('first.bib', bib('shared', 'Changed title'));
  h.changeFile(target); const completion = await h.providers.completion(h.document);
  assert.match(completion[0].detail, /^Changed title/);
  assert.equal(h.calls.filter(call => call[0] === 'snapshot').length, count + 1);
  assert.ok(h.calls.some(call => call[0] === 'invalidate' && call[1] === path.join(h.root, target)));
});

test('discovery creation and deletion update completions; unrelated external files do not refresh this document', async t => {
  const h = fixture(t, { text: '@shared\n' });
  await h.providers.completion(h.document);
  h.write('references/new.bib', bib('newKey')); h.changeFile('references/new.bib', 'create');
  assert.ok((await h.providers.completion(h.document)).some(item => item.label === 'newKey'));
  fs.rmSync(path.join(h.root, 'references/new.bib')); h.changeFile('references/new.bib', 'delete');
  assert.equal((await h.providers.completion(h.document)).some(item => item.label === 'newKey'), false);
  const count = h.calls.filter(call => call[0] === 'snapshot').length;
  h.changeFile('../unrelated/another.bib'); await h.providers.completion(h.document);
  assert.equal(h.calls.filter(call => call[0] === 'snapshot').length, count);
});

test('untrusted documents retain read-only indexing without a Pandoc process', async t => {
  const h = fixture(t, { trusted: false });
  assert.equal((await h.providers.completion(h.document)).length, 3);
  assert.equal(h.calls.some(call => call[0] === 'render'), false);
  assert.equal(h.diagnostics.get(path.join(h.root, 'first.bib'))[0].code, 'bibliography-duplicate');
});

for (const action of ['close', 'dispose']) test(`${action} invalidates pending results and prevents later publication`, async t => {
  const waiting = deferred(), started = deferred();
  const h = fixture(t, { render: async () => { started.resolve(); await waiting.promise; return { missingKeys: new Set(['missing']) }; } });
  const pending = h.providers.completion(h.document); await started.promise;
  if (action === 'close') { h.document.isClosed = true; h.events.close(h.document); } else h.authoring.dispose();
  const published = h.publications(); waiting.resolve(); assert.deepEqual(await pending, []);
  await sleep(200); assert.equal(h.publications(), published); assert.equal(h.diagnostics.size, 0);
});

test('bibliography doctor opens a missing citation occurrence and lets duplicate problems navigate to either source', async t => {
  let select = 'citation-missing';
  const h = fixture(t, { choose: items => items.find(item => item.issue.code === select && (select !== 'bibliography-duplicate' || item.issue.sourcePath.endsWith('second.bib'))) });
  await h.authoring.doctor(); assert.equal(h.opened[0], h.document.uri.fsPath);
  assert.equal(h.document.offsetAt(h.opened[1].settings.selection.start), h.document.getText().indexOf('@missing') + 1);
  select = 'bibliography-duplicate'; await h.authoring.doctor();
  assert.equal(h.opened[2], path.join(h.root, 'second.bib'));
});

test('failed Pandoc rendering produces an actionable approximation warning', async t => {
  const h = fixture(t, { render: async () => { throw new Error('CSL conversion failed'); } });
  await h.providers.completion(h.document);
  assert.ok(h.diagnostics.get(h.document.uri.fsPath)?.some(issue => issue.code === 'bibliography-preview-approximate' && issue.message.includes('CSL conversion failed')));
});

test('citation locations exclude multiline code spans, escaped at signs, code fences, and email addresses', t => {
  const h = fixture(t);
  const text = 'Real @missing; `inline @missing`; ``multi\nline @missing``; \\@missing; person@example.org\n\n```python\n@missing\n```\n\n-@other [@shared, p. 3]\n';
  assert.deepEqual(h.api.citationLocations(text).map(item => item.key), ['missing', 'other', 'shared']);
});

test('citation source offsets remain exact with Unicode, CRLF, unequal backtick runs and an unmatched delimiter', t => {
  const h = fixture(t);
  const text = '😀 ``code ` @hidden`` and @visible\r\n\\\\@other; `unclosed @final\r\n';
  const locations = h.api.citationLocations(text);
  assert.deepEqual(locations.map(item => item.key), ['visible', 'other', 'final']);
  for (const location of locations) assert.equal(text.slice(location.start, location.end), location.key);
  assert.equal(locations[1].line, 2); assert.equal(locations[1].column, 4);
});

test('disposal while completion construction yields prevents starting a citation process', async t => {
  let h;
  h = fixture(t, { snapshot: async (resolved, service) => {
    const snapshot = await service.snapshot(resolved);
    const entries = Array.from({ length: 129 }, (_, index) => ({ ...snapshot.entries[0], key: `key${index}` }));
    setImmediate(() => h.authoring.dispose());
    return { ...snapshot, entries };
  } });
  assert.deepEqual(await h.providers.completion(h.document), []);
  assert.equal(h.calls.some(call => call[0] === 'render'), false);
  assert.equal(h.publications(), 0);
});

test('a pending doctor picker cannot navigate after the authoring controller is disposed', async t => {
  const selected = deferred(), shown = deferred();
  const h = fixture(t, { choose: async items => { shown.resolve(items); return selected.promise; } });
  const pending = h.authoring.doctor(), items = await shown.promise;
  h.authoring.dispose(); selected.resolve(items[0]); await pending;
  assert.deepEqual(h.opened, []);
});

test('closing one source keeps shared duplicate diagnostics needed by another open document', async t => {
  const h = fixture(t);
  const second = h.makeDocument('another.md', h.document.getText());
  await h.providers.completion(h.document); await h.providers.completion(second);
  const file = path.join(h.root, 'first.bib');
  assert.equal(h.diagnostics.get(file).length, 1, 'shared definitions produce one diagnostic per source');
  h.document.isClosed = true; h.events.close(h.document);
  assert.equal(h.diagnostics.has(h.document.uri.fsPath), false);
  assert.equal(h.diagnostics.get(file).length, 1);
  assert.equal(h.diagnostics.get(second.uri.fsPath)[0].code, 'citation-missing');
});

test('citation source locations match Pandoc punctuation and braced-key rules', t => {
  const h = fixture(t);
  const text = '@a&b @Foo_bar--baz @Foo_bar.baz. [@{https://example.com/bib?name=foo&year=2026}, p. 3] @{end.}';
  const locations = h.api.citationLocations(text);
  assert.deepEqual(locations.map(item => item.key), ['a&b', 'Foo_bar', 'Foo_bar.baz', 'https://example.com/bib?name=foo&year=2026', 'end.']);
  for (const location of locations) assert.equal(text.slice(location.start, location.end), location.key);
});
