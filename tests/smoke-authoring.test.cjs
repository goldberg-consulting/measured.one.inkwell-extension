const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (name, ...rest) {
  return name === 'vscode' ? require('../out/headless-vscode') : originalLoad.call(this, name, ...rest);
};
let prepareRunSource;
try { ({ prepareRunSource } = require('../out/smoke-cli')); } finally { Module._load = originalLoad; }

test('packaged demo preparation persists repeatable identities and preserves authored attributes', () => {
  const source = '```{python display="none" output="vars"}\nprint(1)\n```\n\n```{python id="run-fixture-1" inputs="data.csv"}\nprint(2)\n```\n';
  const prepared = prepareRunSource(source);
  assert.match(prepared, /display="none" output="vars" id="run-fixture-2"/);
  assert.ok(prepared.endsWith('```{python id="run-fixture-1" inputs="data.csv"}\nprint(2)\n```\n'));
  assert.equal(prepareRunSource(prepared), prepared);
  assert.equal(prepareRunSource(source), prepared);
});

test('packaged demo preparation rejects authored identity collisions', () => {
  assert.throws(() => prepareRunSource('```{python id="same"}\nprint(1)\n```\n```{python id="same"}\nprint(2)\n```\n'), /Duplicate/);
});
