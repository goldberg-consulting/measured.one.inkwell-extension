const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { resolveDocumentConfig } = require('../out/document-config');

function fixture(t, initial = '# Body\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-bib-ui-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'document.md'); fs.writeFileSync(source, initial);
  let text = initial, refreshes = 0;
  const answers = [], messages = [], edits = [], shown = [];
  const uri = file => ({ scheme: 'file', fsPath: file, toString: () => `file://${file}` });
  const document = { uri: uri(source), version: 1, languageId: 'markdown', isUntitled: false, isClosed: false, isDirty: false,
    getText: () => text, positionAt: offset => ({ offset }) };
  const editor = { document, succeeds: true, edit: async (callback, options) => {
    let change; callback({ replace: (range, replacement) => { change = { range, replacement }; } }); edits.push({ ...change, options });
    if (!editor.succeeds) return false;
    text = text.slice(0, change.range.start.offset) + change.replacement + text.slice(change.range.end.offset);
    document.version++; document.isDirty = true; return true;
  } };
  const take = items => { const answer = answers.shift(); return typeof answer === 'function' ? answer(items) : items ? items.find(item => item.setting?.key === answer || item.action === answer || item.value === answer) : answer; };
  const vscode = { Uri: { file: uri }, Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    workspace: { isTrusted: true, textDocuments: [document] },
    window: { activeTextEditor: editor, showQuickPick: async items => take(items), showInputBox: async () => take(), showSaveDialog: async () => take(), showOpenDialog: async () => take(),
      showInformationMessage: async value => messages.push(value), showErrorMessage: async value => messages.push(value), showTextDocument: async value => shown.push(value) } };
  const config = text => resolveDocumentConfig({ text, sourcePath: source });
  const original = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'vscode') return vscode;
    if (name === './config') return { getDocumentConfig: config, getInkwellProjectRoot: () => root };
    return original.call(this, name, ...args);
  };
  let api; try { delete require.cache[require.resolve('../out/bibliography-ui')]; api = require('../out/bibliography-ui'); } finally { Module._load = original; }
  return { root, source, document, editor, vscode, uri, answers, messages, edits, shown, text: () => text, config: () => config(text), refreshes: () => refreshes,
    run: () => api.configureBibliography(() => { refreshes++; }, config) };
}

test('bibliography creation produces one undoable unsaved document edit and a real editable file', async t => {
  const h = fixture(t), target = path.join(h.root, 'refs.bib');
  h.answers.push('references.bibliography', 'create', h.uri(target));
  assert.equal(await h.run(), true); assert.equal(h.edits.length, 1);
  assert.deepEqual(h.edits[0].options, { undoStopBefore: true, undoStopAfter: true });
  assert.match(h.text(), /bibliography:\n  - refs.bib/); assert.equal(h.document.isDirty, true);
  assert.equal(fs.readFileSync(h.source, 'utf8'), '# Body\n'); assert.match(fs.readFileSync(target, 'utf8'), /BibTeX/);
  assert.equal(h.shown[0].fsPath, target); assert.equal(h.refreshes(), 1);
});
for (const choices of [[], ['references.bibliography'], ['references.bibliography', 'create'], ['references.csl'], ['references.entrySpacing']]) {
  test(`cancelling bibliography configuration preserves files ${JSON.stringify(choices)}`, async t => {
    const h = fixture(t); h.answers.push(...choices); assert.equal(await h.run(), false);
    assert.equal(h.edits.length, 0); assert.deepEqual(fs.readdirSync(h.root), ['document.md']);
  });
}
for (const stale of ['version', 'trust', 'active editor']) {
  test(`bibliography picker rejects stale ${stale}`, async t => {
    const h = fixture(t); h.answers.push('references.heading', () => {
      if (stale === 'version') h.document.version++;
      if (stale === 'trust') h.vscode.workspace.isTrusted = false;
      if (stale === 'active editor') h.vscode.window.activeTextEditor = undefined;
      return 'Sources';
    });
    assert.equal(await h.run(), false); assert.equal(h.edits.length, 0); assert.match(h.messages.at(-1), /changed|Trust/);
  });
}

test('failed editor change rolls back only the bibliography created by this attempt', async t => {
  const h = fixture(t), file = path.join(h.root, 'new.bib'); h.editor.succeeds = false;
  h.answers.push('references.bibliography', 'create', h.uri(file));
  assert.equal(await h.run(), false); assert.equal(fs.existsSync(file), false); assert.equal(h.refreshes(), 0);
  fs.writeFileSync(file, 'User content'); h.answers.push('references.bibliography', 'create', h.uri(file));
  assert.equal(await h.run(), false); assert.equal(fs.readFileSync(file, 'utf8'), 'User content');
});

test('selected bibliography must still exist and cannot escape through a symlink', async t => {
  const h = fixture(t); h.answers.push('references.bibliography', 'choose', [h.uri(path.join(h.root, 'gone.bib'))]);
  assert.equal(await h.run(), false); assert.equal(h.edits.length, 0);
  fs.symlinkSync(os.tmpdir(), path.join(h.root, 'escape'));
  h.answers.push('references.bibliography', 'create', h.uri(path.join(h.root, 'escape', 'unexpected.bib')));
  assert.equal(await h.run(), false); assert.match(h.messages.at(-1), /symbolic links/); assert.equal(h.edits.length, 0);
});

test('reference lengths and page-break choice use canonical configuration and preserve unrelated YAML bytes', async t => {
  const text = '\uFEFF---\r\ntitle: \'Quoted # title\' # comment\r\ncustom: {x: 1, y: 2}\r\n...\r\nBody\r\n';
  const h = fixture(t, text); h.answers.push('references.entrySpacing', '0.8em');
  assert.equal(await h.run(), true); assert.equal(h.config().references.entrySpacing, '0.8em');
  assert.ok(h.text().includes("title: 'Quoted # title' # comment\r\ncustom: {x: 1, y: 2}\r\n"));
  assert.match(h.text(), /entry-spacing: 0.8em/); assert.ok(h.text().endsWith('...\r\nBody\r\n'));
  h.answers.push('references.pageBreak', 'always'); assert.equal(await h.run(), true); assert.equal(h.config().references.pageBreak, 'always');
});
