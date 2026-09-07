const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const build = process.env.INKWELL_TABLE_TEST_OUT || path.join(__dirname, '../out');
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'vscode') return { Uri: { file: fsPath => ({ fsPath }) }, workspace: { getWorkspaceFolder: () => undefined }, window: { createOutputChannel: () => ({ appendLine() {} }) } };
  return originalLoad.call(this, request, ...args);
};
const runner = require(path.join(build, 'runner'));
const inject = require(path.join(build, 'inject'));
Module._load = originalLoad;

function fixture(t, files, attrs = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-table-injection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'document.md');
  const markdown = '```{shell id=stable ' + attrs + '}\necho outputs\n```';
  fs.writeFileSync(source, markdown);
  const artifacts = new Map();
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file); fs.writeFileSync(full, content);
    artifacts.set(path.basename(file, path.extname(file)), full);
  }
  const result = { block: runner.parseCodeBlocks(markdown)[0], blockId: 'persisted-block-id', runId: 'attempt-one',
    stdout: '', stderr: '', exitCode: 0, cached: true, cacheStatus: 'hit', artifacts };
  const diagnostics = [];
  const render = () => inject.injectResults(markdown, [result], 'output', root, root, { sourceFile: source, tableDiagnostics: diagnostics });
  return { root, source, markdown, artifacts, result, diagnostics, render };
}
function tables(markdown) {
  return [...markdown.matchAll(/^(`{3,})inkwell-table-data\n([^\n]+)\n\1(?:\n|$)/gm)].map(match => JSON.parse(match[2]));
}

test('CSV injection preserves quoted multiline cells, doubled quotes and literal pipes', t => {
  const h = fixture(t, { 'data.csv': 'Name,Note,Value\r\n"A, B","He said ""yes""\r\nthen | kept",001\r\n' }, 'caption="Example" table-preset=grid');
  const [table] = tables(h.render());
  assert.ok(table, 'CSV must be transported as structured cells');
  assert.deepEqual(table.headers, ['Name', 'Note', 'Value']);
  assert.deepEqual(table.rows, [['A, B', 'He said "yes"\nthen | kept', '001']]);
  assert.equal(table.attributes['table-preset'], 'grid'); assert.equal(table.caption, 'Example');
  assert.deepEqual(h.diagnostics, []);
});

test('malformed table artifacts emit typed visible errors rather than broken images', t => {
  const h = fixture(t, { 'bad.csv': 'a,b\n"unclosed,2' });
  const rendered = h.render();
  assert.doesNotMatch(rendered, /!\[/);
  assert.match(rendered, /Inkwell table error/);
  assert.equal(h.diagnostics.length, 1); assert.equal(h.diagnostics[0].severity, 'error');
  assert.equal(h.diagnostics[0].source, path.join(h.root, 'bad.csv'));
});

test('artifact labels and attributes survive multiple output ordering and attempt changes', t => {
  const h = fixture(t, { 'one.csv': 'a\n1', 'two.json': '[{"b":2}]' }, 'label=summary caption="Both" table-density=compact unknown="future value"');
  const first = tables(h.render());
  assert.equal(new Set(first.map(table => table.label)).size, 2);
  for (const table of first) {
    assert.match(table.label, /^tbl:summary-/);
    assert.equal(table.attributes['unknown'], 'future value');
    assert.equal(table.attributes['table-density'], 'compact');
    assert.equal(table.attributes['data-inkwell-block'], 'persisted-block-id');
  }
  const labels = Object.fromEntries(first.map(table => [table.attributes['data-inkwell-artifact'], table.label]));
  h.result.artifacts = new Map([...h.artifacts].reverse()); h.result.runId = 'new-attempt';
  assert.deepEqual(Object.fromEntries(tables(h.render()).map(table => [table.attributes['data-inkwell-artifact'], table.label])), labels);
  h.result.block.output = 'two';
  assert.equal(tables(h.render())[0].label, 'tbl:summary');
});

test('literal cells and error text never participate in document bindings or Python evaluation', t => {
  const value = '{{unsafe}} `{python} __import__("os").system("never-run")`\n````';
  const h = fixture(t, { 'data.json': JSON.stringify([{ literal: value }]) });
  const rendered = h.render();
  const substituted = inject.substituteVariables('Outside {{unsafe}}\n' + rendered, new Map([['unsafe', 'resolved']]));
  assert.ok(substituted.startsWith('Outside resolved\n'));
  assert.equal(tables(substituted)[0].rows[0][0], value);
  assert.deepEqual(inject.collectUnresolvedVars(substituted + '\n{{missing}}'), ['missing']);
  const cache = path.join(h.root, 'no-inline-work');
  assert.equal(inject.evaluateInlineExpressions(rendered, new Map(), {}, h.root, h.root, cache), rendered);
  assert.equal(fs.existsSync(cache), false, 'literal expressions must not create an inline evaluation attempt');
  const { literalFence, TABLE_DATA_ERROR_FENCE } = require(path.join(build, 'table-data'));
  const error = literalFence(value, TABLE_DATA_ERROR_FENCE);
  assert.equal(inject.evaluateInlineExpressions(error, new Map(), {}, h.root, h.root, cache), error);
  assert.equal(inject.substituteVariables(error, new Map([['unsafe', 'resolved']])), error);
  assert.deepEqual(inject.collectUnresolvedVars(error), []);
});

test('source-authored caption, label and presentation bindings resolve while data remains literal', t => {
  const h = fixture(t, { 'data.json': '[{"cell":"{{mean}}"}]' }, 'caption="Mean {{mean}}; {{missing}}" label="summary-{{mean}}" table-preset="{{preset}}"');
  h.result.stdout = '::inkwell mean=12\n::inkwell preset=grid';
  const rendered = h.render(), [table] = tables(rendered);
  assert.equal(table.caption, 'Mean 12; {{missing}}');
  assert.equal(table.label, 'tbl:summary-12');
  assert.equal(table.attributes['table-preset'], 'grid');
  assert.equal(table.rows[0][0], '{{mean}}');
  assert.deepEqual(inject.collectUnresolvedVars(rendered), ['missing']);
});

test('quoted fence attributes can contain braces without altering block identity or body boundaries', () => {
  const markdown = 'Before\n\n```{shell id=first caption="Mean {{mean}}" label=summary}\necho "body }"\n```\n\n'
    + "```{python id=second caption='Literal } and {{value}}'}\nprint('second')\n```";
  const blocks = runner.parseCodeBlocks(markdown);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map(block => [block.id, block.index, block.lang]), [['first', 0, 'shell'], ['second', 1, 'python']]);
  assert.equal(blocks[0].caption, 'Mean {{mean}}');
  assert.equal(blocks[1].caption, 'Literal } and {{value}}');
  assert.equal(blocks[0].source, 'echo "body }"');
  assert.equal(blocks[0].startLine, 3);
  assert.equal(runner.parseCodeBlocks('```{shell caption="unclosed}\necho no\n```').length, 0);
});

test('failed and cache-missing runs cannot inject otherwise well-formed table artifacts', t => {
  const h = fixture(t, { 'data.csv': 'a\n1' });
  h.result.cacheStatus = 'miss'; assert.equal(h.render(), '');
  h.result.cacheStatus = 'hit'; h.result.exitCode = 1; assert.equal(h.render(), '');
  assert.deepEqual(h.diagnostics, []);
});

test('unselected or hidden outputs do not add table diagnostics to the document', t => {
  const h = fixture(t, { 'bad.csv': 'a,b\n"unclosed', 'good.csv': 'a\n1' });
  h.result.block.output = 'good';
  assert.equal(tables(h.render()).length, 1); assert.deepEqual(h.diagnostics, []);
  h.result.block.output = undefined; h.result.block.display = 'code';
  assert.match(h.render(), /echo outputs/); assert.deepEqual(h.diagnostics, []);
  h.result.block.display = 'none'; assert.equal(h.render(), ''); assert.deepEqual(h.diagnostics, []);
});

test('non-tabular JSON stays safe code and malformed JSON or non-UTF8 has visible diagnostics', t => {
  const h = fixture(t, { 'scalar.json': '{"value":"```"}' });
  assert.match(h.render(), /^````json/); assert.deepEqual(tables(h.render()), []);
  fs.writeFileSync(h.artifacts.get('scalar'), '{broken');
  assert.match(h.render(), /Inkwell table error/);
  assert.equal(h.diagnostics.at(-1).code, 'table-json-parse');
  fs.writeFileSync(h.artifacts.get('scalar'), Buffer.from([0xff]));
  assert.match(h.render(), /UTF-8/); assert.equal(h.diagnostics.at(-1).code, 'table-encoding');
});

test('compiled preparation surfaces malformed artifacts from an eligible current RunStore run', async t => {
  const h = fixture(t, {});
  fs.mkdirSync(path.join(h.root, '.inkwell', 'scripts'), { recursive: true });
  const markdown = '```{shell id=generated}\nprintf \'a,b\\n"unclosed,2\' > "$INKWELL_OUTPUT_DIR/bad.csv"\n```';
  fs.writeFileSync(h.source, markdown);
  const [run] = await runner.runAllBlocks(markdown, h.source);
  assert.equal(run.exitCode, 0, run.stderr);
  const prepared = inject.prepareForCompilation(markdown, h.source);
  assert.equal(prepared.tableDiagnostics.length, 1);
  assert.equal(prepared.tableDiagnostics[0].severity, 'error');
  assert.match(prepared.injected, /Inkwell table error/);
  assert.doesNotMatch(prepared.injected, /!\[/);
  const untouched = inject.prepareForCompilation('Plain document', h.source);
  assert.deepEqual(untouched.tableDiagnostics, []);
});

test('real runs resolve source caption bindings without substituting artifact cells', async t => {
  const h = fixture(t, {});
  fs.mkdirSync(path.join(h.root, '.inkwell', 'scripts'), { recursive: true });
  const markdown = '```{shell id=bound caption="Mean {{mean}}" label="mean-{{mean}}"}\n'
    + 'printf \'::inkwell mean=12\\n\'\nprintf \'cell\\n{{mean}}\\n\' > "$INKWELL_OUTPUT_DIR/data.csv"\n```';
  fs.writeFileSync(h.source, markdown);
  const [run] = await runner.runAllBlocks(markdown, h.source);
  assert.equal(run.exitCode, 0, run.stderr);
  const prepared = inject.prepareForCompilation(markdown, h.source);
  assert.deepEqual(prepared.tableDiagnostics, []);
  assert.deepEqual(prepared.unresolvedVars, []);
  const [table] = tables(prepared.injected);
  assert.equal(table.caption, 'Mean 12'); assert.equal(table.label, 'tbl:mean-12');
  assert.deepEqual(table.rows, [['{{mean}}']]);
});
