// Exercise the actual extension compiler in disposable projects. No live
// repository .inkwell directory is read, copied, or written by this harness.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const repo = path.resolve(__dirname, '..');
const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)));
const implementation = path.resolve(options.implementation || repo);
const repetitions = Number(options.repetitions || 1);
const baseline = Object.hasOwn(options, 'baseline');
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error('Invalid repetitions');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-demos-'));
const project = path.join(work, 'project');
const disposable = () => ({ dispose() {} });
const uri = p => ({ fsPath: p, toString: () => `file://${p}`, path: p });
const channel = { appendLine() {}, append() {}, show() {}, dispose() {} };
const vscode = {
  Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
  window: { createOutputChannel: () => channel, showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined, showWarningMessage: async () => undefined,
    onDidChangeActiveTextEditor: disposable, setStatusBarMessage() {} },
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    getWorkspaceFolder: () => ({ uri: uri(project) }), workspaceFolders: [{ uri: uri(project) }],
    onDidSaveTextDocument: disposable, onDidChangeConfiguration: disposable,
    onDidOpenTextDocument: disposable, onDidCloseTextDocument: disposable },
  commands: { executeCommand: async () => undefined, registerCommand: disposable },
  languages: { createDiagnosticCollection: () => ({ ...disposable(), set() {}, delete() {} }), registerCodeActionsProvider: disposable },
  CodeActionKind: { QuickFix: 'quickfix' }, Range: class {}, Diagnostic: class {}, CodeAction: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1 }, ProgressLocation: { Notification: 15 },
};
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'vscode') return vscode;
  if (request === 'markdown-it') return originalLoad.call(this, require.resolve('markdown-it'), ...args);
  return originalLoad.call(this, request, ...args);
};
// Template discovery historically creates ~/.inkwell on a read. Isolate it.
os.homedir = () => path.join(work, 'home');
const processes = [];
const originalExec = cp.execFile;
cp.execFile = function(binary, argv, opts, callback) {
  const started = performance.now();
  return originalExec(binary, argv, opts, (error, stdout, stderr) => {
    processes.push({ binary: path.basename(binary), argv: argv.map(arg => arg.replaceAll(work, '<workspace>')),
      milliseconds: performance.now() - started, exitCode: error ? error.code ?? null : 0 });
    callback(error, stdout, stderr);
  });
};
cp.execFile[require('node:util').promisify.custom] = (binary, argv, opts) => new Promise((resolve, reject) => {
  cp.execFile(binary, argv, opts, (error, stdout, stderr) => {
    if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
    else resolve({ stdout, stderr });
  });
});
const originalSpawn = cp.spawn;
cp.spawn = function(binary, argv, opts) {
  const started = performance.now();
  const child = originalSpawn(binary, argv, opts);
  child.on('close', (exitCode, signal) => processes.push({ binary: path.basename(binary),
    argv: argv.map(arg => arg.replaceAll(work, '<workspace>')), milliseconds: performance.now() - started, exitCode, signal }));
  return child;
};
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const result = { schemaVersion: 1, timestamp: new Date().toISOString(), baseline,
  corpusSource: Object.hasOwn(options, 'committed-examples') ? 'HEAD examples (preserve local edits)' : 'working examples',
  implementation: options.implementation ? 'frozen baseline' : 'working tree',
  machine: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, node: process.version },
  repetitions, corpus: [], phases: {}, demos: [], limitations: [
    'Activation is module-load time only; a real extension-host activation budget remains a release gate.',
    'PDF transfer measures the existing asynchronous read/base64 payload cost, not browser page painting.',
    'Compile planning is compiler wall time less observed child-process wall time; includes staging and publication.',
  ] };

async function main() {
  const { checkWarnings } = await import('./demo-policy.mjs');
  const policy = JSON.parse(fs.readFileSync(path.join(repo, 'tests/fixtures/warning-allowlist.json'), 'utf8'));
  fs.mkdirSync(path.join(project, '.inkwell/references'), { recursive: true });
  const scaffold = fs.readFileSync(path.join(repo, 'src/scaffold.ts'), 'utf8');
  // Seed from the shipped scaffold, never from the author's project bibliography.
  const seed = scaffold.match(/const STARTER_BIB = `([\s\S]*?)`;/)[1].replaceAll('\\\\', '\\');
  const bib = baseline ? seed.replace(/(?:^|\n)@book\{fourier1822,[\s\S]*?\n\}\n/, '\n') : seed;
  fs.writeFileSync(path.join(project, '.inkwell/references/refs.bib'), bib);
  fs.writeFileSync(path.join(project, '.inkwell/manifest.json'), '{"template":"default"}\n');
  fs.mkdirSync(path.join(project, '.inkwell/scripts'), { recursive: true });
  for (const [constant, name] of [['SINE_PLOT_PY', 'sine_plot.py'], ['SCATTER_PY', 'scatter.py'], ['CONVERGENCE_TABLE_PY', 'convergence_table.py']]) {
    const script = scaffold.match(new RegExp(`const ${constant} = \u0060([\\s\\S]*?)\u0060;`))[1].replaceAll('\\\\', '\\');
    fs.writeFileSync(path.join(project, '.inkwell/scripts', name), script);
  }
  const examples = fs.readdirSync(path.join(repo, 'examples')).filter(f => /^demo-.*\.md$/.test(f)).sort();
  for (const name of examples) {
    const text = Object.hasOwn(options, 'committed-examples')
      ? cp.execFileSync('git', ['show', `HEAD:examples/${name}`], { cwd: repo })
      : fs.readFileSync(path.join(repo, 'examples', name));
    fs.writeFileSync(path.join(project, name), text);
    result.corpus.push({ name, sha256: hash(text) });
  }
  const python = process.env.INKWELL_TEST_PYTHON || 'python3';
  process.env.MPLCONFIGDIR = path.join(work, 'matplotlib');
  if (path.isAbsolute(python) && path.basename(path.dirname(python)) === 'bin') {
    fs.symlinkSync(path.dirname(path.dirname(python)), path.join(project, 'venv'), 'dir');
  }
  const tufte = fs.readFileSync(path.join(project, 'demo-tufte.md'), 'utf8');
  const code = tufte.match(/```\{python[^\n]*\}\n([\s\S]*?)\n```/)[1];
  cp.execFileSync(python, ['-c', code], { cwd: project, env: { ...process.env, MPLCONFIGDIR: path.join(work, 'matplotlib') }, stdio: 'pipe' });
  const moduleStart = performance.now();
  const { compile } = require(path.join(implementation, 'out/compiler.js'));
  const { InkwellPreviewProvider } = require(path.join(implementation, 'out/preview.js'));
  const { renderCitations } = require(path.join(implementation, 'out/citations.js'));
  const { runAllBlocks } = require(path.join(implementation, 'out/runner.js'));
  result.phases.activationModuleLoadMs = performance.now() - moduleStart;
  const citationText = 'Evidence [@knuth1984; @harris2020, p. 3].';
  for (const mode of ['cold', 'warm']) {
    const start = performance.now();
    const cite = await renderCitations(citationText, { projectRoot: project, sourceFile: path.join(project, 'citation.md') });
    result.phases[`citations${mode}Ms`] = performance.now() - start;
    result.phases[`citations${mode}Engine`] = cite.engine;
  }
  const preview = new InkwellPreviewProvider({ extensionPath: implementation });
  preview.panel = { webview: { postMessage: async () => true, asWebviewUri: uri => uri, options: {} } };
  preview.initialized = true;
  const plainDoc = { uri: uri(path.join(project, 'plain.md')), fileName: path.join(project, 'plain.md'), languageId: 'markdown', version: 1,
    getText: () => '# Benchmark\n\nOrdinary writing.\n\n'.repeat(100) };
  preview.currentDocument = plainDoc;
  const previewStart = performance.now();
  await preview.sendContentUpdate(plainDoc);
  result.phases.previewRenderMs = performance.now() - previewStart;
  const runStart = performance.now();
  await new Promise((resolve, reject) => cp.execFile(process.execPath, ['-e', 'console.log("inkwell benchmark")'], { cwd: project }, err => err ? reject(err) : resolve()));
  result.phases.codeProcessMs = performance.now() - runStart;

  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const name of examples) {
      const source = path.join(project, name);
      const document = { uri: uri(source), fileName: source, languageId: 'markdown', version: 1, getText: () => fs.readFileSync(source, 'utf8') };
      const offset = processes.length;
      const runStart = performance.now();
      const runs = await runAllBlocks(document.getText(), source);
      const runMs = performance.now() - runStart;
      const compileOffset = processes.length;
      const start = performance.now();
      const compiled = await compile(document);
      const totalMs = performance.now() - start;
      const observed = processes.slice(compileOffset);
      // First-pass undefined references are normal; only the final TeX log
      // and Pandoc's warnings determine unresolved-reference failure.
      const engineLogPath = compiled.log.match(/\[inkwell\] full engine log: ([^\n]+)/)?.[1];
      const finalLog = compiled.log.split('\n').filter(line => /\[WARNING\]/.test(line)).join('\n') + '\n' +
        (engineLogPath && fs.existsSync(engineLogPath) ? fs.readFileSync(engineLogPath, 'utf8') : compiled.log);
      const warnings = checkWarnings(finalLog, name, policy);
      const record = { name, repetition, success: compiled.success, totalMs,
        runMs, runProcesses: processes.slice(offset, compileOffset).map(p => ({ binary: p.binary, milliseconds: p.milliseconds, exitCode: p.exitCode })),
        runFailures: runs.filter(run => run.exitCode !== 0).map(run => ({ index: run.block.index, exitCode: run.exitCode, stderr: run.stderr })),
        compilePlanningMs: Math.max(0, totalMs - observed.reduce((sum, p) => sum + p.milliseconds, 0)),
        texPasses: observed.filter(p => /^(?:xe|pdf|lua)latex$/.test(p.binary)),
        pandoc: observed.filter(p => p.binary === 'pandoc'), unresolved: warnings, expectedText: false };
      const logFile = path.join(work, `${repetition}-${name}.log`);
      fs.writeFileSync(logFile, compiled.log);
      if (compiled.success && compiled.pdfPath) {
        const transferStart = performance.now();
        const pdf = await fs.promises.readFile(compiled.pdfPath);
        record.pdfBytes = pdf.length;
        record.pdfSha256 = hash(pdf);
        record.pdfPayloadBytes = pdf.toString('base64').length;
        record.pdfTransferMs = performance.now() - transferStart;
        const text = cp.execFileSync(process.env.INKWELL_PDF_PYTHON || python, ['-c', 'import sys,json; from pypdf import PdfReader; r=PdfReader(sys.argv[1]); print(json.dumps({"pages":len(r.pages),"text":" ".join(p.extract_text() or "" for p in r.pages)}))', compiled.pdfPath], { encoding: 'utf8' });
        const extracted = JSON.parse(text);
        record.pages = extracted.pages;
        const expected = JSON.parse(fs.readFileSync(path.join(repo, 'tests/fixtures/demo-text.json'), 'utf8'))[name];
        record.expectedText = expected.every(fragment => extracted.text.replace(/\s+/g, ' ').toLowerCase().includes(fragment.toLowerCase()));
      }
      result.demos.push(record);
      console.log(`${record.success && record.expectedText && !warnings.length ? 'PASS' : 'FAIL'} ${name} ${(totalMs / 1000).toFixed(2)}s${warnings.length ? ` (${warnings.length} unresolved warnings)` : ''}`);
    }
  }
  result.success = result.demos.every(d => d.success && d.expectedText && !d.unresolved.length && !d.runFailures.length);
  console.log(`Reports and isolated outputs: ${work}`);
  const report = path.resolve(options.report || path.join(work, 'report.json'));
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, JSON.stringify(result, null, 2) + '\n');
  if (!result.success && !baseline) process.exitCode = 1;
}
main().catch(error => { console.error(error); console.error(`Isolated work: ${work}`); process.exitCode = 1; });
