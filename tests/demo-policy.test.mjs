import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWarnings } from '../scripts/demo-policy.mjs';

test('missing citations and final unresolved references fail regardless of PDF existence', () => {
  for (const line of [
    '[WARNING] Citeproc: citation fourier1822 not found',
    "[WARNING] Citation 'missing' not found",
    "LaTeX Warning: Reference `fig:missing' on page 1 undefined on input line 12.",
    'LaTeX Warning: There were undefined references.',
    'WARNING: reference fig:missing not found',
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
