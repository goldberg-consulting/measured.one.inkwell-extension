import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWarnings, checkDemoDiagnostics } from '../scripts/demo-policy.mjs';
import fs from 'node:fs';
import cp from 'node:child_process';

test('missing citations and final unresolved references fail regardless of PDF existence', () => {
  for (const line of [
    '[WARNING] Citeproc: citation fourier1822 not found',
    "[WARNING] Citation 'missing' not found",
    "LaTeX Warning: Reference `fig:missing' on page 1 undefined on input line 12.",
    'LaTeX Warning: There were undefined references.',
    'WARNING: reference fig:missing not found',
    'Unresolved placeholder {{peak_quarter}} — no code block exported "peak_quarter", so it will appear literally in the PDF.',
  ]) assert.deepEqual(checkWarnings(line, 'demo.md'), [line]);
});

test('warning exceptions require a reason and apply to only their named demo', () => {
  const line = 'Citation missing not found';
  assert.throws(() => checkWarnings(line, 'a.md', [{ demo: 'a.md', pattern: 'missing' }]));
  const policy = [{ demo: 'a.md', pattern: '^Citation missing not found$', reason: 'Intentional missing-key diagnostic fixture.' }];
  assert.deepEqual(checkWarnings(line, 'a.md', policy), []);
  assert.deepEqual(checkWarnings(line, 'b.md', policy), [line]);
  assert.deepEqual(checkWarnings('Overfull \\hbox (1pt too wide)', 'a.md'), []);
});

test('final reference status and surviving binding diagnostics determine demo success', () => {
  const early = { message: "LaTeX Warning: Reference `fig:plot' undefined on input line 3." };
  const binding = { message: 'Unresolved placeholder {{mean}} — no code block exported "mean".' };
  assert.deepEqual(checkDemoDiagnostics('Final output has resolved references.', [early], 'demo.md'), []);
  assert.deepEqual(checkDemoDiagnostics('Final output has resolved references.', [early, binding], 'demo.md'), [binding.message]);
  assert.deepEqual(checkDemoDiagnostics(early.message, [], 'demo.md'), [early.message]);
});

test('book full-width example reaches Pandoc as a semantic table', { skip: process.env.INKWELL_TABLES_PDF !== '1' }, () => {
  const source = fs.readFileSync(new URL('../examples/demo-tufte-book-vdqi.md', import.meta.url), 'utf8');
  const result = cp.spawnSync('pandoc', ['--from=markdown', '--to=json'], { input: source, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const ast = JSON.parse(result.stdout);
  const tables = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.t === 'Table') tables.push(value);
    for (const child of Object.values(value)) visit(child);
  }
  visit(ast.blocks);
  assert.ok(tables.some(table => JSON.stringify(table).includes('Caution')), 'Full-width comparison must be a Table node, not raw TeX containing pipe syntax.');
});
