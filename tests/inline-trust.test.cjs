const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const Module = require('node:module');

test('untrusted inline expressions remain literal and start no process or generated-file write', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-inline-trust-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vscode = { Uri: { file: fsPath => ({ fsPath }) }, workspace: { isTrusted: false, getWorkspaceFolder: () => undefined, getConfiguration: () => ({ get: (_key, value) => value }) },
    window: { createOutputChannel: () => ({ appendLine() {} }) } };
  const original = Module._load, execute = cp.execFileSync; let processes = 0;
  Module._load = function(name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
  cp.execFileSync = () => { processes++; throw new Error('Unexpected process'); };
  let inject;
  try { inject = require('../out/inject'); } finally { Module._load = original; }
  try {
    const text = 'Inline `{python} print("execute")`.';
    assert.equal(inject.evaluateInlineExpressions(text, new Map(), {}, root, root, path.join(root, 'cache')), text);
    assert.equal(inject.prepareForPreview(text, path.join(root, 'document.md')), text);
    assert.equal(processes, 0); assert.deepEqual(fs.readdirSync(root), []);
  } finally { cp.execFileSync = execute; }
});
