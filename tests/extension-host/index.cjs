'use strict';

// This module runs inside Cursor/Code's real Extension Host, never under mocks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const childProcess = require('node:child_process');
const asyncHooks = require('node:async_hooks');
const Module = require('node:module');
const vscode = require('vscode');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function observeWebviews(extensionPath) {
  const originalLoad = Module._load; const apis = new WeakMap();
  const publications = []; const panels = [];
  // Facades forward to the real frozen VS Code API. They neither change the
  // package bytes nor replace webviews, messages or promises with test doubles.
  const forward = (target, overrides = {}, bindMethods = false) => new Proxy({}, {
    get(_facade, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value = Reflect.get(target, key);
      return bindMethods && typeof value === 'function' ? value.bind(target) : value;
    },
    set(_facade, key, value) { return Reflect.set(target, key, value); },
    ownKeys() { return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(_facade, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
  const observePanel = panel => {
    const state = { ready: false, disposed: false, index: panels.length };
    panels.push(state);
    const readySubscription = panel.webview.onDidReceiveMessage(message => { if (message?.type === 'ready') state.ready = true; });
    const disposedSubscription = panel.onDidDispose(() => { state.disposed = true; readySubscription.dispose(); disposedSubscription.dispose(); });
    const webview = forward(panel.webview, { postMessage(message) {
      const record = { panel: state.index, type: message.type, revision: message.revision, documentUri: message.documentUri,
        sourceVersion: message.sourceVersion, html: typeof message.html === 'string' ? message.html : '', accepted: false };
      publications.push(record);
      const result = panel.webview.postMessage(message);
      Promise.resolve(result).then(accepted => { record.accepted = accepted === true; }, () => { record.accepted = false; });
      return result;
    } }, true);
    return forward(panel, { webview }, true);
  };
  Module._load = function (request, parent, ...rest) {
    const api = originalLoad.call(this, request, parent, ...rest);
    if (request !== 'vscode' || !parent?.filename?.startsWith(extensionPath + path.sep)) return api;
    let facade = apis.get(api);
    if (!facade) {
      facade = forward(api, { window: forward(api.window, { createWebviewPanel(...args) {
        return observePanel(api.window.createWebviewPanel(...args));
      } }, true) });
      apis.set(api, facade);
    }
    return facade;
  };
  return { publications, panels, stop() { Module._load = originalLoad; } };
}
async function bounded(promise, message, milliseconds = 30000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function observeProcesses(extensionPath) {
  const calls = [];
  const originals = new Map();
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    originals.set(name, childProcess[name]);
    childProcess[name] = function (...args) {
      const previousLimit = Error.stackTraceLimit;
      let stack;
      try { Error.stackTraceLimit = 50; stack = new Error().stack || ''; } finally { Error.stackTraceLimit = previousLimit; }
      calls.push({ method: name, executable: typeof args[0] === 'string' ? path.basename(args[0].split(/\s/)[0]) : '(non-string)',
        extensionOrigin: stack.includes(extensionPath), timeMs: performance.now() });
      return originals.get(name).apply(this, args);
    };
  }
  return { calls, stop() { for (const [name, original] of originals) childProcess[name] = original; } };
}
function currentRun(root) {
  const runs = path.join(root, '.inkwell', 'runs');
  const pointers = [];
  const walk = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === 'current.json') pointers.push(file);
    }
  };
  walk(runs);
  assert.equal(pointers.length, 1, 'Exactly one block should publish a current pointer.');
  const pointer = JSON.parse(fs.readFileSync(pointers[0], 'utf8'));
  const history = path.join(path.dirname(pointers[0]), 'history', pointer.runId);
  const manifest = JSON.parse(fs.readFileSync(path.join(history, 'run.json'), 'utf8'));
  assert.equal(manifest.status, 'success'); assert.equal(manifest.process.exitCode, 0);
  assert.equal(hash(JSON.stringify(manifest)), pointer.manifestHash, 'Current pointer must verify the manifest bytes.');
  const stdout = fs.readFileSync(path.join(history, manifest.stdout.path), 'utf8');
  assert.equal(hash(stdout), manifest.stdout.sha256);
  const artifact = manifest.artifacts.find(value => path.basename(value.path) === 'summary.txt');
  assert.ok(artifact, 'The shell output must be stored as a named artifact.');
  const artifactText = fs.readFileSync(path.join(history, artifact.path), 'utf8');
  assert.equal(hash(artifactText), artifact.sha256);
  return { pointer, manifest, stdout, artifactText };
}
async function runWorkflow(config) {
  const { planMigration, applyMigration } = require(config.fixtureHelper);
  const migration = applyMigration(planMigration(config.workspace, config.extensionPath));
  assert.equal(migration.success, true, JSON.stringify(migration.diagnostics));
  const source = path.join(config.workspace, 'workflow.md');
  fs.writeFileSync(source, config.fixtureText);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source));
  await vscode.window.showTextDocument(document, { preview: false });
  assert.equal(document.languageId, 'markdown'); assert.equal(vscode.workspace.isTrusted, true);
  assert.doesNotMatch(document.lineAt(2).text, /\bid=/, 'Fixture must begin with an anonymous executable fence.');
  await bounded(vscode.commands.executeCommand('inkwell.runCodeBlocks'), 'Run Code Blocks did not complete.');
  const saved = fs.readFileSync(source, 'utf8');
  const identity = saved.match(/\bid="([A-Za-z0-9_-]+)"/);
  assert.ok(identity, 'Run must persist an ID in the source fence before execution.');
  assert.equal(document.getText(), saved); assert.equal(document.isDirty, false);
  const first = currentRun(config.workspace);
  assert.equal(first.manifest.blockId, identity[1]);
  assert.equal(first.stdout, 'inline-success\n'); assert.equal(first.artifactText, 'inline-artifact\n');

  const target = () => ({ uri: document.uri.toString(), version: document.version, index: 0 });
  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', document.uri);
  assert.ok(lenses.some(value => value.command?.command === 'inkwell.extractCodeBlockToScript'), 'Real CodeLens provider exposes extraction.');
  assert.equal(await bounded(vscode.commands.executeCommand('inkwell.extractCodeBlockToScript', target()), 'Extract command did not complete.'), true);
  const extracted = document.getText();
  const reference = extracted.match(/\bfile="(\.inkwell\/scripts\/[^\"]+)"/);
  assert.ok(reference, 'Extraction must point to a project-owned script.');
  assert.match(extracted, new RegExp(`\\bid="${identity[1]}"`));
  assert.match(extracted, /display="both" output="summary" caption="Host result"/);
  assert.equal(extracted.includes("printf 'inline-success"), false, 'The extracted script must be the authoritative source.');
  const script = path.join(config.workspace, reference[1]);
  assert.equal(fs.readFileSync(script, 'utf8').includes("printf 'inline-success"), true);
  assert.equal(fs.realpathSync(vscode.window.activeTextEditor.document.uri.fsPath), fs.realpathSync(script), 'Extraction opens its script in the real editor.');
  assert.equal(await document.save(), true);
  assert.equal(await bounded(vscode.commands.executeCommand('inkwell.runThisBlock', target()), 'Extracted block rerun did not complete.'), true);
  const second = currentRun(config.workspace);
  assert.equal(second.stdout, first.stdout); assert.equal(second.artifactText, first.artifactText);
  assert.notEqual(second.pointer.runId, first.pointer.runId);
  assert.equal(fs.realpathSync(second.manifest.source.path), fs.realpathSync(script));

  const scriptDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(script));
  const editor = await vscode.window.showTextDocument(scriptDocument, { preview: false });
  // Assemble the artifact marker at runtime so PDF source-code display alone
  // cannot accidentally satisfy the output-insertion assertion below.
  const changedScript = 'printf "edited-success\\n"\nprintf "%s-%s\\n" "edited" "artifact" > "$INKWELL_OUTPUT_DIR/summary.txt"\n';
  assert.equal(await editor.edit(builder => builder.replace(new vscode.Range(scriptDocument.positionAt(0), scriptDocument.positionAt(scriptDocument.getText().length)), changedScript)), true);
  assert.equal(await scriptDocument.save(), true);
  assert.equal(await bounded(vscode.commands.executeCommand('inkwell.runChangedBlocks', target()), 'Run Changed Blocks did not complete.'), true);
  const third = currentRun(config.workspace);
  assert.equal(third.stdout, 'edited-success\n'); assert.equal(third.artifactText, 'edited-artifact\n');
  assert.notEqual(third.pointer.runId, second.pointer.runId);
  await vscode.window.showTextDocument(document, { preview: false });
  await bounded(vscode.commands.executeCommand('inkwell.compile'), 'Compiling the inserted run result did not finish.', 60000);
  const pdfPath = path.join(config.workspace, 'workflow.pdf');
  assert.ok(fs.existsSync(pdfPath), 'The actual editor Compile PDF command must publish a PDF.');
  const pdfBytes = fs.readFileSync(pdfPath);
  assert.equal(pdfBytes.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.match(pdfBytes.subarray(-2048).toString('latin1'), /%%EOF\s*$/);
  const pdfPython = process.env.INKWELL_PDF_PYTHON;
  const pdfReader = 'import sys\ntry:\n import pymupdf\nexcept ImportError:\n from pypdf import PdfReader\n print("\\n".join(page.extract_text() or "" for page in PdfReader(sys.argv[1]).pages))\nelse:\n with pymupdf.open(sys.argv[1]) as doc:\n  print("\\n".join(page.get_text() for page in doc))\n';
  const pdfText = childProcess.execFileSync(pdfPython || process.env.INKWELL_PDFTOTEXT || 'pdftotext',
    pdfPython ? ['-c', pdfReader, pdfPath] : [pdfPath, '-'], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.match(pdfText, /edited-artifact/, 'The published PDF must contain the current generated artifact, proving run output insertion.');
  assert.equal(changedScript.includes('edited-artifact'), false, 'The insertion marker must not also be literal source code.');
  const pdf = { verified: true, bytes: pdfBytes.length, sha256: hash(pdfBytes), insertedEditedArtifact: true,
    extractedTextSha256: hash(pdfText), textExtractor: pdfPython ? 'Python PyMuPDF/pypdf' : 'Poppler pdftotext', sourceVersion: document.version };
  await bounded(vscode.commands.executeCommand('inkwell.clearRunCache'), 'Clear Run Cache did not complete.');
  assert.equal(fs.readFileSync(script, 'utf8'), changedScript, 'Clear generated output must preserve the authored script.');
  assert.equal(fs.readFileSync(source, 'utf8'), document.getText(), 'Clear must preserve the saved source reference.');
  assert.throws(() => currentRun(config.workspace), /Exactly one block/, 'Clear must remove the current generated output pointer.');
  return { ok: true, identityPersisted: true, editorCodeLens: true, extractionPreservesAttributes: true,
    externalSourceAuthoritative: true, editedScriptInvalidatesOutput: true, clearPreservesScript: true,
    successfulRunCount: 3, pdf, sourceSha256: hash(document.getText()), scriptSha256: hash(changedScript) };
}

function monitorHostCallbacks() {
  const types = new Map(); const started = new Map();
  let callbackCount = 0; let maximumCallbackMs = 0; let maximumCallbackType = 'none';
  const hook = asyncHooks.createHook({
    init(id, type) { types.set(id, type); },
    before(id) { started.set(id, performance.now()); },
    after(id) {
      const start = started.get(id);
      if (start === undefined) return;
      const duration = performance.now() - start; started.delete(id); callbackCount++;
      if (duration > maximumCallbackMs) { maximumCallbackMs = duration; maximumCallbackType = types.get(id) || 'preexisting resource'; }
    },
    destroy(id) { types.delete(id); started.delete(id); },
  });
  const intervalMs = 10; let timer; let stopped = false; let ticks = 0; let maximumTimerLagMs = 0;
  let expected = performance.now() + intervalMs;
  const tick = () => {
    if (stopped) return;
    const now = performance.now(); ticks++; maximumTimerLagMs = Math.max(maximumTimerLagMs, now - expected);
    expected = now + intervalMs; timer = setTimeout(tick, intervalMs);
  };
  hook.enable(); timer = setTimeout(tick, intervalMs);
  return { stop() {
    stopped = true; clearTimeout(timer); hook.disable();
    return { callbackCount, maximumCallbackMs, maximumCallbackType, timerIntervalMs: intervalMs, timerTicks: ticks,
      maximumTimerLagMs: Math.max(0, maximumTimerLagMs) };
  } };
}
function citationArtifacts(root) {
  const directory = path.join(root, '.inkwell', '.cache', 'preview-cites');
  const names = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort() : [];
  let bytes = 0; let authoritativeCount = 0;
  for (const name of names) {
    const data = fs.readFileSync(path.join(directory, name)); bytes += data.length;
    const value = JSON.parse(data);
    if (value.engine === 'pandoc' && value.schemaVersion === 2 && value.resolved?.includes('alpha') && value.resolved?.includes('beta') && value.missing?.length === 0) authoritativeCount++;
  }
  return { fileCount: names.length, bytes, authoritativeCount };
}
async function runWarmPreview(config, webviews) {
  if (!fs.existsSync(path.join(config.workspace, '.inkwell/manifest.json'))) {
    const { planMigration, applyMigration } = require(config.fixtureHelper);
    const migration = applyMigration(planMigration(config.workspace, config.extensionPath));
    assert.equal(migration.success, true, JSON.stringify(migration.diagnostics));
  }
  const source = path.join(config.workspace, 'preview.md');
  fs.writeFileSync(path.join(config.workspace, 'host-references.bib'), config.bibliographyText);
  fs.writeFileSync(source, config.previewText);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source));
  let editor = await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
  const position = document.positionAt(document.getText().indexOf('@alpha') + 1);
  const complete = () => bounded(vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position, '@'), 'Citation completion did not finish.');
  let labels = []; let completionWarmupAttempts = 0;
  // File creation and the first document-open event deliberately happen through
  // the editor watcher pipeline. Let its initial generations settle before the
  // warm measurement, without replacing a failed provider with test data.
  while (completionWarmupAttempts++ < 20) {
    const initial = await complete();
    labels = initial?.items.map(item => typeof item.label === 'string' ? item.label : item.label.label) || [];
    if (labels.includes('alpha') && labels.includes('beta')) break;
    await delay(100);
  }
  assert.ok(labels.includes('alpha') && labels.includes('beta'), `The real citation provider must resolve both fixture keys; received ${JSON.stringify(labels)}.`);
  await bounded(vscode.commands.executeCommand('inkwell.preview'), 'Preview did not open.');
  await delay(1200);
  assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('inkwellPreview'))), 'The real editor must have an Inkwell webview tab open.');
  const waitForPublication = async (marker, after = 0) => {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const publication = webviews.publications.slice(after).find(value => value.type === 'updateContent' && value.accepted
        && value.documentUri === document.uri.toString() && value.sourceVersion === document.version && value.html.includes(marker));
      if (publication && webviews.panels[publication.panel]?.ready) return publication;
      await delay(25);
    }
    throw new Error(`No accepted current preview publication contained ${marker}; ready panels=${webviews.panels.filter(value => value.ready).length}.`);
  };
  const initialPublication = await waitForPublication('A small authoring document');
  editor = await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
  const warmProcesses = observeProcesses(config.extensionPath);
  let warmCompletion;
  try { warmCompletion = await complete(); } finally { warmProcesses.stop(); }
  assert.equal(warmProcesses.calls.filter(value => value.extensionOrigin).length, 0, 'Repeated completion on unchanged input must use the warmed cache.');
  const before = citationArtifacts(config.workspace);
  assert.ok(before.authoritativeCount >= 1, 'Preview warmup must produce a Pandoc cache containing both resolved citations.');

  const samples = [];
  for (let index = 0; index < 6; index++) {
    const firstMessage = webviews.publications.length;
    const monitor = monitorHostCallbacks();
    const processes = observeProcesses(config.extensionPath);
    const started = performance.now();
    let observation; let publication;
    try {
      for (let edit = 0; edit < 8; edit++) {
        const end = document.positionAt(document.getText().length);
        assert.equal(await editor.edit(builder => builder.insert(end, `\nHost edit ${index + 1}.${edit + 1}.`)), true);
        await delay(25);
      }
      // The real debounced render and language-service callbacks run during this
      // interval. Await an explicit refresh too, so each sample reaches output.
      await delay(450);
      await bounded(vscode.commands.executeCommand('inkwell.preview'), 'Warm preview refresh did not finish.');
      publication = await waitForPublication(`Host edit ${index + 1}.8.`, firstMessage);
      editor = await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
      await delay(100);
    } finally { observation = monitor.stop(); processes.stop(); }
    samples.push({ index, warmup: index === 0, edits: 8, durationMs: performance.now() - started, ...observation,
      publication: { accepted: publication.accepted, revision: publication.revision, sourceVersion: publication.sourceVersion,
        finalEditPresent: true, htmlBytes: Buffer.byteLength(publication.html), htmlSha256: hash(publication.html),
        messageCount: webviews.publications.length - firstMessage },
      extensionChildProcesses: processes.calls.filter(value => value.extensionOrigin), artifacts: citationArtifacts(config.workspace) });
  }
  const measured = samples.filter(value => !value.warmup);
  const maximumCallbackMs = Math.max(...measured.map(value => value.maximumCallbackMs));
  const maximumTimerLagMs = Math.max(...measured.map(value => value.maximumTimerLagMs));
  const callbackValues = measured.map(value => value.maximumCallbackMs).sort((a, b) => a - b);
  const timerLagValues = measured.map(value => value.maximumTimerLagMs).sort((a, b) => a - b);
  const mean = callbackValues.reduce((sum, value) => sum + value, 0) / callbackValues.length;
  const callbackMaximaMedianMs = callbackValues[2];
  const timerLagMaximaMedianMs = timerLagValues[2];
  const result = { ok: samples.length === 6 && measured.length === 5 && samples.filter(value => value.warmup).length === 1
      && samples.every(value => value.publication.accepted && value.publication.finalEditPresent),
    samples, measuredSamples: 5, warmupSamples: 1,
    protocol: { editSpacingMs: 25, editsPerSample: 8, initialPreviewSettleMs: 1200,
      callbackMeasurement: 'async_hooks before/after wall duration for all synchronous extension-host callbacks during edits, debounce and refresh; asynchronous waiting is excluded.',
      timerMeasurement: 'Maximum delay beyond a recurring 10 ms timer deadline; this is an event-loop lag proxy, not a task duration.',
      timingRole: 'Diagnostic host-scheduling observations. Release performance is decided by the separately retained same-machine baseline and confirmation benchmark reports.',
      artifactMeasurement: 'Citation-cache files/bytes plus actual real-API updateContent publications and HTML payload bytes; each sample must publish its final edit at the current document version to a ready webview.',
      publicationMeasurement: 'Transparent API facades preserve actual createWebviewPanel/postMessage calls and observe accepted messages; these are host publications, not browser paint acknowledgments.' },
    maximumCallbackMs, maximumTimerLagMs, callbackMaximaMedianMs, timerLagMaximaMedianMs, callbackMaximaP95Ms: callbackValues[4],
    callbackMaximaVarianceMs2: callbackValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / callbackValues.length,
    initialPreviewPublication: { accepted: true, readyReceived: true, revision: initialPublication.revision, sourceVersion: initialPublication.sourceVersion },
    completionWarmupAttempts, completionItemCount: warmCompletion.items.length, unchangedCompletionChildProcesses: 0, artifactsBefore: before,
    artifactsAfter: citationArtifacts(config.workspace), finalDocumentVersion: document.version };
  return result;
}

exports.run = async function () {
  const config = JSON.parse(fs.readFileSync(process.env.INKWELL_HOST_TEST_CONFIG, 'utf8'));
  const result = { ok: false, runtime: { node: process.version, versions: process.versions, vscode: vscode.version,
    appName: vscode.env.appName }, activation: null };
  let processes; let webviews;
  try {
    assert.equal(vscode.workspace.workspaceFolders.length, 1);
    assert.equal(fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath), fs.realpathSync(config.workspace));
    const extension = vscode.extensions.getExtension('measure-one.inkwell');
    assert.ok(extension, 'The verified packaged extension is loaded as a development extension.');
    assert.equal(fs.realpathSync(extension.extensionPath), fs.realpathSync(config.extensionPath));
    // Current Code versions can force-enable bundled extensions after launch
    // despite explicit disablement. Let that startup settle without importing
    // or activating Inkwell before measuring only Inkwell activation.
    await delay(config.hostSettleMs);
    assert.equal(extension.isActive, false, 'Activation must not occur before instrumentation; launch an empty workspace.');
    assert.equal(require.cache[path.join(config.extensionPath, 'out/extension.js')], undefined, 'Packaged entrypoint must remain unloaded before measurement.');
    webviews = observeWebviews(config.extensionPath);
    processes = observeProcesses(config.extensionPath);
    const started = performance.now();
    await bounded(extension.activate(), 'Packaged extension activation timed out.', 10000);
    const durationMs = performance.now() - started;
    await delay(300);
    processes.stop();
    result.activation = { durationMs, allChildProcesses: processes.calls,
      extensionChildProcesses: processes.calls.filter(value => value.extensionOrigin) };
    assert.equal(result.activation.extensionChildProcesses.length, 0, 'Activation must use cached/static checks without spawning child processes.');
    const commands = new Set(await vscode.commands.getCommands(true));
    const contributed = extension.packageJSON.contributes.commands.map(value => value.command);
    for (const command of contributed) assert.ok(commands.has(command), `Packaged command not registered: ${command}`);
    result.registeredCommands = contributed;
    if (config.fullWorkflow) {
      for (const command of ['inkwell.extractCodeBlockToScript', 'inkwell.openRunScript', 'inkwell.runThisBlock', 'inkwell.runChangedBlocks', 'inkwell.showCurrentRunDetails']) {
        assert.ok(commands.has(command), `Required 0.5 authoring command missing: ${command}`);
      }
      result.workflow = await runWorkflow(config);
    }
    if (config.warmPreview) {
      result.warmPreview = await runWarmPreview(config, webviews);
      assert.equal(result.warmPreview.ok, true, 'Warm preview did not publish every current edit to the ready webview.');
    }
    result.ok = true;
  } catch (error) { result.error = { message: error.message, stack: error.stack }; throw error; }
  finally { processes?.stop(); webviews?.stop(); fs.writeFileSync(config.resultFile, JSON.stringify(result, null, 2) + '\n'); }
};
