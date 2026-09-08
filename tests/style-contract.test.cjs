const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixtures, describe } = require('./helpers/style-contract.cjs');
const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/style/capabilities.json'), 'utf8'));

test('reviewed capability fixtures retain normalized settings, CSS tokens, and LaTeX macros', () => {
  const actual = fixtures().map(describe);
  assert.equal(new Set(actual.map(item => item.template)).size, 10);
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
  for (const item of actual) {
    assert.deepEqual(item.diagnostics.filter(diagnostic => diagnostic.severity === "error"), [], item.id);
    assert.equal(item.tablePdfOptions.defaults.fontSizePt, item.table.fontSizePt);
    if (item.id.includes('typography-')) {
      assert.equal(item.typography.headingFont, 'Arial');
      assert.match(item.typographyCss, /--inkwell-heading-color:#336699/);
      assert.match(item.latexMacros, /336699/);
      assert.equal(item.typography.codeSizePt, 8);
      assert.equal(item.typography.referenceSizePt, 7);
    }
  }
});
