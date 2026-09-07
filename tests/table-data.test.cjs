const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const build = process.env.INKWELL_TABLE_TEST_OUT || path.join(__dirname, '../out');
const { parseCsvTable, parseJsonTable, decodeTableData, encodeTableData, literalFence, artifactTableLabel,
  TableDataError, TABLE_DATA_LIMITS } = require(path.join(build, 'table-data'));
const payload = (changes = {}) => ({ schemaVersion: 1, headers: ['x'], rows: [['value']], attributes: {}, ...changes });
const fails = (fn, code) => assert.throws(fn, error => error instanceof TableDataError && (!code || error.code === code));

test('CSV retains literal RFC 4180 cell values and leading zeroes', () => {
  const table = parseCsvTable('\uFEFFName,Note,Value,Space\r\n"A, B","He said ""yes""\r\nthen | kept",001,  padded  \r\n');
  assert.deepEqual(table.headers, ['Name', 'Note', 'Value', 'Space']);
  assert.deepEqual(table.rows, [['A, B', 'He said "yes"\nthen | kept', '001', '  padded  ']]);
});

test('CSV preserves duplicate and empty headers, empty cells and header-only tables', () => {
  assert.deepEqual(parseCsvTable('same,same,\na,,\n').rows, [['a', '', '']]);
  assert.deepEqual(parseCsvTable('same,same,\n').headers, ['same', 'same', '']);
  assert.deepEqual(parseCsvTable('head\n\nlast\n').rows, [[''], ['last']]);
  assert.deepEqual(parseCsvTable('head\rfirst\rsecond\r').rows, [['first'], ['second']]);
  assert.deepEqual(parseCsvTable('one,two').rows, []);
});

test('CSV malformed quoting and inconsistent columns surface located errors', () => {
  for (const source of ['a,b\n"unclosed,2', 'a,b\n1,2,3', 'a,b\n"bad"tail,2']) {
    assert.throws(() => parseCsvTable(source), error => error instanceof TableDataError && error.code.startsWith('csv-') && error.line >= 2);
  }
  fails(() => parseCsvTable(''), 'table-empty-csv');
});

test('JSON object records use stable union columns and literal nested values', () => {
  const table = parseJsonTable('[{"first":"001","note":"a|b\\n**literal**"},{"second":null,"first":true},{"third":{"x":[1,2]},"second":3}]');
  assert.deepEqual(table.headers, ['first', 'note', 'second', 'third']);
  assert.deepEqual(table.rows, [['001', 'a|b\n**literal**', '', ''], ['true', '', 'null', ''], ['', '', '3', '{"x":[1,2]}']]);
  assert.deepEqual(parseJsonTable('[{"__proto__":"ordinary","constructor":"kept"}]').rows, [['ordinary', 'kept']]);
});

test('valid non-table JSON is distinguished from malformed or mixed record tables', () => {
  for (const source of ['[]', '{}', 'null', '42', '[1,2]', '[null]', '[[1,2]]', '[{},{}]']) assert.equal(parseJsonTable(source), undefined);
  fails(() => parseJsonTable('[{"x":1},null]'), 'table-json-rows');
  fails(() => parseJsonTable('[{"x":1},[]]'), 'table-json-rows');
  fails(() => parseJsonTable('{broken'), 'table-json-parse');
  fails(() => parseJsonTable('[{"x":9007199254740993}]'), 'table-json-number');
  fails(() => parseJsonTable('[{"x":{"nested":9007199254740993}}]'), 'table-json-number');
  fails(() => parseJsonTable('[{"x":1e309}]'), 'table-json-number');
  assert.deepEqual(parseJsonTable('[{"x":"9007199254740993"}]').rows, [['9007199254740993']]);
});

test('bounded ingestion fails explicitly on source, record, row, column and cell limits', () => {
  fails(() => parseCsvTable('x'.repeat(TABLE_DATA_LIMITS.sourceBytes + 1)), 'table-source-limit');
  fails(() => parseJsonTable(' '.repeat(TABLE_DATA_LIMITS.sourceBytes + 1)), 'table-source-limit');
  fails(() => parseCsvTable('a\n' + 'x'.repeat(TABLE_DATA_LIMITS.recordCharacters + 1)));
  fails(() => parseJsonTable(JSON.stringify(Array(TABLE_DATA_LIMITS.rows + 1).fill({ a: 1 }))), 'table-dimensions-limit');
  fails(() => parseCsvTable(Array(TABLE_DATA_LIMITS.columns + 1).fill('x').join(',')), 'table-dimensions-limit');
  fails(() => parseCsvTable('x\n'.repeat(TABLE_DATA_LIMITS.rows + 2) + '"malformed beyond known excess'), 'table-dimensions-limit');
  fails(() => parseJsonTable(JSON.stringify(Array(1000).fill(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [i, '']))))), 'table-dimensions-limit');
});

test('transport round trips literal syntax with a delimiter longer than cell backticks', () => {
  const table = payload({ headers: ['<literal>'], rows: [['one\n``````\n{{binding}} `{python} 1+1` | "quote" \\ α']],
    caption: 'A caption', label: 'tbl:stable', attributes: { 'table-preset': 'grid', 'unknown-future': '<keep>' } });
  const encoded = encodeTableData(table);
  const [open, json, close] = encoded.split('\n');
  assert.equal(open, '```````inkwell-table-data'); assert.equal(close, '```````');
  assert.deepEqual(decodeTableData(json), table);
  assert.equal(literalFence('` '.repeat(200000)).split('\n')[0], '```text');
});

test('decoder enforces the versioned literal-cell contract and size bounds', () => {
  for (const bad of [payload({ schemaVersion: 2 }), payload({ rows: [[1]] }), payload({ rows: [['a', 'b']] }),
    payload({ headers: [] }), payload({ attributes: { size: 4 } }), payload({ label: 'wrong-prefix' }), payload({ rows: [['a\0b']] })]) {
    fails(() => decodeTableData(JSON.stringify(bad)));
  }
  fails(() => decodeTableData('{'), 'table-payload-json');
  fails(() => decodeTableData(' '.repeat(TABLE_DATA_LIMITS.payloadBytes + 1)), 'table-payload-limit');
  assert.deepEqual(decodeTableData(JSON.stringify(payload({ rows: [['a\r\nb\rc']] }))).rows, [['a\nb\nc']]);
  fails(() => parseJsonTable('[{"x":"\\ud800"}]'), 'table-cell-text');
  fails(() => decodeTableData(JSON.stringify(payload({ rows: [['\udc00']] }))), 'table-cell-text');
  assert.deepEqual(parseJsonTable('[{"x":"\\ud83c\\udf0e"}]').rows, [['🌎']]);
});

test('artifact identity is stable and explicit labels only acquire suffixes for multiple outputs', () => {
  const id = artifactTableLabel('/doc/a.md', 'block', 'one');
  assert.equal(id, artifactTableLabel('/doc/a.md', 'block', 'one'));
  assert.notEqual(id, artifactTableLabel('/doc/b.md', 'block', 'one'));
  assert.notEqual(id, artifactTableLabel('/doc/a.md', 'block', 'two'));
  assert.equal(artifactTableLabel('/a', 'block', 'one', 'summary'), 'tbl:summary');
  assert.equal(artifactTableLabel('/a', 'block', 'one', 'tbl:summary'), 'tbl:summary');
  assert.notEqual(artifactTableLabel('/a', 'block', 'one', 'summary', true), artifactTableLabel('/a', 'block', 'two', 'summary', true));
});
