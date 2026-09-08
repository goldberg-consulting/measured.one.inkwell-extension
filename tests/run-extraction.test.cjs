const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'vscode') return {
    Uri: { file: fsPath => ({ fsPath }) },
    workspace: { isTrusted: true, getWorkspaceFolder: () => undefined },
    window: { createOutputChannel: () => ({ appendLine() {} }) },
  };
  return originalLoad.call(this, request, ...args);
};
const { runAllBlocks, readCurrentRunResults } = require('../out/runner');
const { planScriptExtraction, extractScriptTransaction, applyRunTextEdits } = require('../out/run-authoring');
const { RunStore } = require('../out/run-store');
Module._load = originalLoad;

test('extracting a nested document block preserves its output and makes the script authoritative', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-extraction-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.inkwell'));
  fs.mkdirSync(path.join(root, 'chapters'));
  fs.writeFileSync(path.join(root, 'input.txt'), 'repeatable\n');
  const source = path.join(root, 'chapters', 'doc.md');
  let text = '# Extraction\n\n```{shell id="analysis" display="both" output="summary" caption="Verified result" inputs="input.txt"}\ncat input.txt\nprintf result > "$INKWELL_OUTPUT_DIR/summary.txt"\n```\n';
  fs.writeFileSync(source, text);
  const [inline] = await runAllBlocks(text, source);
  assert.equal(inline.exitCode, 0);
  const originalArtifact = fs.readFileSync(inline.artifacts.get('summary'), 'utf8');

  const plan = planScriptExtraction(text, 0, root);
  await extractScriptTransaction(plan, root, async edit => {
    text = applyRunTextEdits(text, [edit]);
    fs.writeFileSync(source, text);
    return true;
  });
  assert.match(text, /file="\.inkwell\/scripts\/analysis\.sh"/);
  assert.match(text, /display="both" output="summary" caption="Verified result" inputs="input.txt"/);
  assert.equal(text.includes('cat input.txt'), false);
  assert.equal(readCurrentRunResults(text, source)[0].exitCode, 1, 'old inline provenance cannot be injected');
  const [extracted] = await runAllBlocks(text, source);
  assert.equal(extracted.exitCode, 0);
  assert.equal(extracted.stdout, inline.stdout);
  assert.equal(fs.readFileSync(extracted.artifacts.get('summary'), 'utf8'), originalArtifact);
  assert.equal(new RunStore(root, source).currentDetails('analysis').manifest.source.path, plan.sourcePath);

  fs.writeFileSync(plan.sourcePath, 'echo edited\nprintf updated > "$INKWELL_OUTPUT_DIR/summary.txt"\n');
  assert.notEqual(readCurrentRunResults(text, source)[0].exitCode, 0);
  const [edited] = await runAllBlocks(text, source);
  assert.equal(edited.exitCode, 0);
  assert.equal(edited.stdout.trim(), 'edited');
  assert.equal(fs.readFileSync(edited.artifacts.get('summary'), 'utf8'), 'updated');
});
