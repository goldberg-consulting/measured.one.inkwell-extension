const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const cp = require('node:child_process');
const workspace = { isTrusted: true, getWorkspaceFolder: () => undefined };
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'vscode') return { workspace, Uri: { file: fsPath => ({ fsPath }) }, window: { createOutputChannel: () => ({ appendLine() {} }) } };
  return originalLoad.call(this, request, ...args);
};
const inject = require('../out/inject');
const runner = require('../out/runner');
const authoring = require('../out/run-authoring');
const { SCATTER_PY } = require('../out/scaffold-assets');
Module._load = originalLoad;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-inline-binding-'));
  fs.mkdirSync(path.join(root, '.inkwell', 'scripts'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, source: path.join(root, 'document.md') };
}

test('starter scatter exports the bindings used by the shipped Ludus prose', () => {
  const demo = fs.readFileSync(path.join(__dirname, '../examples/demo-ludus.md'), 'utf8');
  const bindings = new Set([...SCATTER_PY.matchAll(/print\(f"::inkwell (\w+)=/g)].map(match => match[1]));
  for (const match of demo.matchAll(/\{\{(\w+)\}\}/g)) assert.ok(bindings.has(match[1]), `Missing seed export: ${match[1]}`);
  assert.ok(bindings.has('slope'), 'The inline expression also needs the fitted slope');
});

test('authoring-persisted hidden bulk output resolves bindings in prose, math, metadata and preview', async t => {
  const { root, source } = fixture(t);
  const original = '---\ntitle: "Quarter {{peak_quarter}}"\n---\n\n'
    + '```{shell display="none" output="vars"}\n'
    + 'printf \'{"peak_quarter":"Q2","peak_mean":"135.2","year_growth":"17.5"}\' > "$INKWELL_OUTPUT_DIR/vars.json"\n```\n\n'
    + 'Ridership peaked in {{peak_quarter}} at $x = {{peak_mean}}$, {{year_growth}}% higher.\n';
  const markdown = authoring.applyRunTextEdits(original, authoring.planBlockIdentities(original, () => 'bulk-bindings'));
  fs.writeFileSync(source, markdown);
  const [run] = await runner.runAllBlocks(markdown, source);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(run.block.id, 'bulk-bindings');
  const compiled = inject.prepareForCompilation(markdown, source);
  assert.deepEqual(compiled.unresolvedVars, []);
  assert.match(compiled.injected, /title: "Quarter Q2"/);
  assert.match(compiled.injected, /peaked in Q2 at \$x = 135\.2\$, 17\.5% higher/);
  assert.doesNotMatch(compiled.injected, /printf|vars\.json/);
  assert.equal(inject.prepareForPreview(markdown, source), compiled.injected);
  assert.ok(fs.existsSync(path.join(root, '.inkwell', 'compiled', 'document.md')));
});

test('literal Markdown code is excluded from bindings and unresolved-prose diagnostics', () => {
  const literal = [
    '```python\nprint("{{value}}")\n```',
    '~~~~text\n{{value}}\n~~~~',
    '    {{value}}',
    '> ```text\n> {{value}}\n> ```',
    '- ```text\n  {{value}}\n  ```',
    '`{{value}}` and ``example `{{value}}` ``',
  ].join('\n\n');
  const text = 'Body {{value}} and $x = {{value}}$.\n\n' + literal + '\n\nMissing {{missing}}.';
  const result = inject.substituteVariables(text, new Map([['value', '42']]));
  assert.ok(result.includes(literal), 'Literal source bytes must remain unchanged');
  assert.match(result, /^Body 42 and \$x = 42\$/);
  assert.deepEqual(inject.collectUnresolvedVars(result), ['missing']);
});

test('literal code containing Python expression syntax starts no evaluation', t => {
  const { root } = fixture(t);
  const literal = '```markdown\n`{python} 1 + 2`\n```\n\n`` `{python} 1 + 2` ``\n\n    `{python} 1 + 2`\n';
  const cache = path.join(root, 'inline-cache');
  assert.equal(inject.evaluateInlineExpressions(literal, new Map(), {}, root, root, cache), literal);
  assert.equal(fs.existsSync(cache), false, 'Literal expressions must not create an evaluation attempt');
});

test('generated table fences preserve the boundaries of adjacent literal code and prose', () => {
  const literal = '```inkwell-table-error\n{{value}}\n```\n```text\n{{value}}\n```\n';
  const text = literal + 'After {{value}}.';
  assert.equal(inject.substituteVariables(text, new Map([['value', '42']])), literal + 'After 42.');
  assert.deepEqual(inject.collectUnresolvedVars(text), ['value']);
});

test('explicit prose and math expressions resolve only their exact source spans', t => {
  const { root } = fixture(t);
  const binary = path.join(root, 'venv', 'bin', 'python3');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\ncase "$1" in --version) echo FakePython;; -c) echo "[]";; *) printf \'::result_0=3\\n::result_1=$&\\n\';; esac\n', { mode: 0o755 });
  const cache = path.join(root, 'inline-cache');
  const markdown = 'Escaped \\`{python} 1 + 2`.\n\nMath $x = `{python} 1 + 2`$.\n\nCost `{python} "$&"`.\n';
  const expected = 'Escaped \\`{python} 1 + 2`.\n\nMath $x = 3$.\n\nCost $&.\n';
  const evaluate = () => inject.evaluateInlineExpressions(markdown, new Map(), { pythonEnv: 'venv' }, root, root, cache);
  assert.equal(evaluate(), expected);
  assert.equal(evaluate(), expected, 'Cached results retain the same literal replacement semantics');
  assert.match(fs.readFileSync(path.join(cache, 'inline_eval', 'eval.py'), 'utf8'), /__r = 1 \+ 2/);
});

test('unmatched backtick runs remain literal and start no Python process', t => {
  const { root } = fixture(t);
  const cache = path.join(root, 'inline-cache');
  const originalExec = cp.execFileSync;
  let processes = 0;
  cp.execFileSync = () => { processes++; throw new Error('A literal example started a process'); };
  t.after(() => { cp.execFileSync = originalExec; });
  for (const literal of ['``{python} 1 + 2`', '`{python} 1 + 2``', '```{python} 1 + 2`', '`{python} 1 + 2```']) {
    assert.equal(inject.evaluateInlineExpressions(literal, new Map(), {}, root, root, cache), literal);
    assert.equal(processes, 0, `Unexpected process for ${literal}`);
    assert.equal(fs.existsSync(cache), false, 'Malformed delimiters must not create an evaluation attempt');
  }
});

test('binding protection preserves original CR, CRLF and LF source offsets and bytes', () => {
  for (const newline of ['\r', '\r\n', '\n']) {
    const literal = ['```text', '{{value}}', '```'].join(newline);
    const text = ['Text', '', literal, '', 'After {{value}}.'].join(newline);
    const expected = ['Text', '', literal, '', 'After 42.'].join(newline);
    assert.equal(inject.substituteVariables(text, new Map([['value', '42']])), expected);
    assert.deepEqual(inject.collectUnresolvedVars(expected), []);
    const metadata = ['---', 'title: "{{value}}"', '', 'header-includes: |', '    {{value}}', '---', ''].join(newline);
    assert.equal(inject.substituteVariables(metadata + text, new Map([['value', '42']])), metadata.replaceAll('{{value}}', '42') + expected);
  }
});
