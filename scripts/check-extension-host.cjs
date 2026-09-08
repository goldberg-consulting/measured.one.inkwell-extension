#!/usr/bin/env node
'use strict';

// Launches the editor's real extension host against verified, unchanged VSIX
// bytes. Every profile, extension directory and workspace is disposable.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const repositoryRoot = path.resolve(__dirname, '..');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { sampleCount: values.length, medianMs: sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
  p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], meanMs: mean,
  varianceMs2: values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length };
}
function builtinHarnessConfig(editor, platform = process.platform) {
  const builtinRoot = platform === 'darwin' ? path.resolve(editor, '../../Resources/app/extensions')
    : platform === 'linux' ? path.resolve(editor, '../resources/app/extensions') : undefined;
  const disabledBuiltins = [];
  let editorProduct;
  if (builtinRoot && fs.existsSync(path.join(builtinRoot, '../product.json'))) {
    const product = JSON.parse(fs.readFileSync(path.join(builtinRoot, '../product.json'), 'utf8'));
    editorProduct = { name: product.nameLong, version: product.version, commit: product.commit, date: product.date };
  }
  if (builtinRoot && fs.existsSync(builtinRoot)) for (const name of fs.readdirSync(builtinRoot).sort()) {
    const manifestPath = path.join(builtinRoot, name, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.main || manifest.browser) disabledBuiltins.push(`${manifest.publisher}.${manifest.name}`);
  }
  return { disabledBuiltins, editorProduct };
}
function options(argv) {
  const result = { mode: 'full', samples: 5, warmups: 1, timeoutSeconds: 120,
    editor: process.env.INKWELL_EDITOR_BIN || '/Applications/Cursor.app/Contents/MacOS/Cursor' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    const equals = argument.indexOf('=');
    const name = equals < 0 ? argument : argument.slice(0, equals);
    const value = equals < 0 ? argv[++index] : argument.slice(equals + 1);
    if (!value || !['--vsix', '--editor', '--report', '--mode', '--samples', '--warmups', '--timeout-seconds'].includes(name)) {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
    result[{ '--vsix': 'vsix', '--editor': 'editor', '--report': 'report', '--mode': 'mode', '--samples': 'samples',
      '--warmups': 'warmups', '--timeout-seconds': 'timeoutSeconds' }[name]] = value;
  }
  if (!result.vsix) throw new Error('--vsix FILE is required; a source checkout is never an extension under test.');
  if (!['activation', 'preview', 'full'].includes(result.mode)) throw new Error('--mode must be activation, preview or full.');
  for (const key of ['samples', 'warmups', 'timeoutSeconds']) result[key] = Number(result[key]);
  if (!Number.isSafeInteger(result.samples) || result.samples < 5 || result.samples > 30) throw new Error('--samples must be 5–30.');
  if (!Number.isSafeInteger(result.warmups) || result.warmups < 0 || result.warmups > 5) throw new Error('--warmups must be 0–5.');
  if (!Number.isSafeInteger(result.timeoutSeconds) || result.timeoutSeconds < 15 || result.timeoutSeconds > 600) throw new Error('--timeout-seconds must be 15–600.');
  result.vsix = path.resolve(result.vsix); result.editor = path.resolve(result.editor);
  if (result.report) result.report = path.resolve(result.report);
  return result;
}
function processTable() {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
  });
  return new Map(output.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
    return match ? [[Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), birth: match[4] }]] : [];
  }));
}
function trackEditorProcesses(editorPid) {
  const owned = new Map(); let stopped = false; let error;
  const sample = () => {
    const rows = processTable();
    const editor = rows.get(editorPid);
    if (editor && !owned.has(editorPid)) owned.set(editorPid, editor.birth);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows.values()) {
        const parent = rows.get(row.parent);
        if (!owned.has(row.pid) && parent && owned.get(parent.pid) === parent.birth) {
          owned.set(row.pid, row.birth); changed = true;
        }
      }
    }
    // Compare PID and creation time before every signal to avoid PID-reuse kills.
    return [...rows.values()].filter(row => owned.get(row.pid) === row.birth);
  };
  const safelySample = () => { try { return sample(); } catch (cause) { error = cause.message; return []; } };
  safelySample();
  const timer = setInterval(() => { if (!stopped) safelySample(); }, 200);
  const signal = name => {
    const current = safelySample();
    const groups = new Set();
    for (const row of current) {
      // A verified owned group leader covers children created between samples.
      if (row.group === row.pid && !groups.has(row.group)) {
        try { process.kill(-row.group, name); groups.add(row.group); } catch (cause) { if (cause.code !== 'ESRCH') error = cause.message; }
      }
    }
    for (const row of current) if (!groups.has(row.group)) {
      try { process.kill(row.pid, name); } catch (cause) { if (cause.code !== 'ESRCH') error = cause.message; }
    }
  };
  return { signal, async close() {
    stopped = true; clearInterval(timer);
    let remaining = safelySample();
    if (remaining.length) {
      signal('SIGTERM');
      const deadline = Date.now() + 1500;
      while ((remaining = safelySample()).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (remaining.length) {
        signal('SIGKILL');
        const deadline = Date.now() + 1000;
        while ((remaining = safelySample()).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    return { observedProcesses: owned.size, survivors: remaining.map(row => ({ pid: row.pid, group: row.group, birth: row.birth })), ...(error ? { error } : {}) };
  } };
}
function launch(editor, args, env, logFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const log = fs.openSync(logFile, 'wx', 0o600);
    let child;
    try { child = spawn(editor, args, { env, stdio: ['ignore', log, log], detached: process.platform !== 'win32' }); }
    catch (error) { fs.closeSync(log); reject(error); return; }
    fs.closeSync(log);
    const processes = trackEditorProcesses(child.pid);
    let timedOut = false;
    const stop = signal => processes.signal(signal);
    let escalation;
    const timeout = setTimeout(() => { timedOut = true; stop('SIGTERM'); escalation = setTimeout(() => stop('SIGKILL'), 5000); }, timeoutMs);
    const onInterrupt = () => stop('SIGTERM');
    process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      clearTimeout(timeout); clearTimeout(escalation);
      process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
      const cleanup = await processes.close();
      resolve({ code, signal, timedOut, cleanup });
    });
  });
}

async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/check-extension-host.cjs --vsix FILE [--editor ELECTRON_BINARY] [--mode full|activation|preview] [--samples 5] [--warmups 1] [--report FILE]');
    return;
  }
  fs.accessSync(opts.editor, fs.constants.X_OK);
  if (process.platform === 'win32') throw new Error('The packaged host harness currently supports macOS and Linux process cleanup only.');
  const { readZipEntries, verifyVsix } = await import(pathToFileURL(path.join(__dirname, 'verify-vsix.mjs')));
  const archive = fs.readFileSync(opts.vsix);
  const entries = readZipEntries(archive);
  const packageJson = JSON.parse(entries.get('extension/package.json'));
  const verified = verifyVsix(archive, { tag: `v${packageJson.version}` });
  const { disabledBuiltins, editorProduct } = builtinHarnessConfig(opts.editor);
  // macOS Unix socket paths have a 103-byte limit; the default per-user temp
  // directory is too long once Cursor appends its profile IPC socket name.
  const temporaryRoot = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'inkwell-host-'));
  // Resolve /var aliases so extensionOrigin stack comparisons use the host's path.
  const root = fs.realpathSync(temporaryRoot);
  const extensionPath = path.join(root, 'packaged-extension');
  for (const [name, bytes] of entries) {
    if (!name.startsWith('extension/')) continue;
    const file = path.join(extensionPath, name.slice('extension/'.length));
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx' });
  }
  let fixtureHelper;
  if (opts.mode !== 'activation') {
    fixtureHelper = path.join(root, 'fixture-helper.cjs');
    await require('esbuild').build({ entryPoints: [path.join(repositoryRoot, 'src/scaffold-migrations.ts')],
      outfile: fixtureHelper, bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' });
  }
  const testFile = path.join(repositoryRoot, 'tests/extension-host/index.cjs');
  const fixtureText = fs.readFileSync(path.join(repositoryRoot, 'tests/extension-host/workflow.md'), 'utf8');
  const previewText = fs.readFileSync(path.join(repositoryRoot, 'tests/extension-host/preview.md'), 'utf8');
  const bibliographyText = fs.readFileSync(path.join(repositoryRoot, 'tests/extension-host/preview.bib'), 'utf8');
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), ok: false, mode: opts.mode, artifact: verified,
    temporaryRoot: root, machine: { platform: process.platform, arch: process.arch, release: os.release(),
      cpu: os.cpus()[0]?.model, logicalCPUs: os.cpus().length, totalMemoryBytes: os.totalmem(), node: process.version },
    editorBinary: opts.editor, editorProduct, disabledBuiltins, corpusSha256: sha256(fixtureText),
    previewCorpusSha256: sha256(previewText + '\0' + bibliographyText), testSha256: sha256(fs.readFileSync(testFile)),
    harnessSha256: sha256(fs.readFileSync(__filename)),
    fixtureHelperSha256: fixtureHelper ? sha256(fs.readFileSync(fixtureHelper)) : null,
    protocol: { samples: opts.samples, warmups: opts.warmups, activationP95LimitMs: 200,
      cache: 'Fresh editor process and empty user profile per iteration; shared OS filesystem cache after warmup.',
      hostSettleMs: 1000,
      hostSettleReason: 'Allow unrelated editor builtin startup to settle before activating the still-unloaded Inkwell package.',
      measuredInterval: 'vscode.Extension.activate() through resolution, including packaged module load.',
      processObservation: 'All Node child_process entrypoints in extension host, from before activate through 300 ms after it resolves; extension stack origins are distinguished from unrelated builtins.',
      editorCleanup: 'Sample editor descendants every 200 ms by parent lineage, retaining PID plus creation-time identities across detached process groups; verify identity before bounded TERM/KILL cleanup on exit, timeout or interrupt.',
      workflow: opts.mode === 'full' ? 'Once, after the last measured activation, through real editor commands and saved files.' : 'Not run (focused mode).',
      warmPreview: opts.mode !== 'activation' ? 'Five measured real-editor edit bursts after one warmup; callback and timer-lag observations are retained with the current-publication and warm citation zero-process checks. Release performance requires the separate same-machine baseline and confirmation benchmark reports.' : 'Not run (activation-only mode).' }, iterations: [] };
  const reportPath = opts.report || path.join(root, 'report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  writeJson(reportPath, report);
  console.log(`Packaged extension host evidence: ${reportPath}`);
  try {
    for (let index = 0; index < opts.warmups + opts.samples; index++) {
      const iteration = path.join(root, `iteration-${index}`);
      const workspace = path.join(iteration, 'workspace');
      const profile = path.join(iteration, 'user-data');
      const extensions = path.join(iteration, 'extensions');
      fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(path.join(profile, 'User'), { recursive: true }); fs.mkdirSync(extensions);
      writeJson(path.join(profile, 'User/settings.json'), { 'security.workspace.trust.enabled': false,
        'workbench.startupEditor': 'none', 'workbench.welcomePage.walkthroughs.openOnInstall': false,
        'window.restoreWindows': 'none', 'window.titleBarStyle': 'custom', 'extensions.autoUpdate': false,
        'extensions.autoCheckUpdates': false, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
        'git.enabled': false, 'npm.autoDetect': 'off', 'task.autoDetect': 'off', 'typescript.disableAutomaticTypeAcquisition': true,
        'inkwell.autoCompile': 'off', 'files.autoSave': 'off' });
      const resultFile = path.join(iteration, 'result.json');
      const configFile = path.join(iteration, 'config.json');
      writeJson(configFile, { workspace, extensionPath, resultFile, fixtureHelper, fixtureText, previewText, bibliographyText,
        fullWorkflow: opts.mode === 'full' && index === opts.warmups + opts.samples - 1,
        warmPreview: opts.mode !== 'activation' && index === opts.warmups + opts.samples - 1 });
      const env = { ...process.env, INKWELL_HOST_TEST_CONFIG: configFile };
      for (const key of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI', 'NODE_OPTIONS', 'VSCODE_NODE_OPTIONS', 'VSCODE_EXTENSIONS']) delete env[key];
      const args = [workspace, '--new-window', '--user-data-dir', profile, '--extensions-dir', extensions,
        '--extensionDevelopmentPath', extensionPath, '--extensionTestsPath', testFile,
        '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--skip-onboarding',
        '--disable-telemetry', '--disable-updates', '--disable-crash-reporter', '--skip-add-to-recently-opened',
        '--use-inmemory-secretstorage', '--disable-gpu', '--force-disable-user-env', '--sync', 'off'];
      if (path.basename(opts.editor).toLowerCase().includes('cursor')) args.push('--classic');
      for (const id of disabledBuiltins) args.push('--disable-extension', id);
      console.log(`Editor iteration ${index + 1}/${opts.warmups + opts.samples}${index < opts.warmups ? ' (warmup)' : ''}`);
      const outcome = await launch(opts.editor, args, env, path.join(iteration, 'editor.log'), opts.timeoutSeconds * 1000);
      const host = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
      report.iterations.push({ index, warmup: index < opts.warmups, ...outcome, host });
      if (host?.workflow) report.workflow = host.workflow;
      if (host?.warmPreview) report.warmPreview = host.warmPreview;
      writeJson(reportPath, report);
      if (outcome.timedOut || outcome.code !== 0 || outcome.cleanup?.error || outcome.cleanup?.survivors.length || !host?.ok) throw new Error(`Editor iteration ${index + 1} failed: ${host?.error?.message || JSON.stringify(outcome)}. See ${iteration}`);
    }
    const measured = report.iterations.filter(value => !value.warmup);
    report.activation = statistics(measured.map(value => value.host.activation.durationMs));
    report.activation.extensionChildProcesses = measured.reduce((sum, value) => sum + value.host.activation.extensionChildProcesses.length, 0);
    report.activation.allObservedChildProcesses = measured.reduce((sum, value) => sum + value.host.activation.allChildProcesses.length, 0);
    for (const [name, bytes] of entries) if (name.startsWith('extension/')) {
      const actual = fs.readFileSync(path.join(extensionPath, name.slice('extension/'.length)));
      if (!actual.equals(bytes)) throw new Error(`Packaged asset changed during host tests: ${name}`);
    }
    if (report.activation.p95Ms >= 200) throw new Error(`Activation p95 ${report.activation.p95Ms.toFixed(1)} ms exceeds the <200 ms gate.`);
    if (report.activation.extensionChildProcesses !== 0) throw new Error('Activation launched a child process.');
    if (opts.mode === 'full' && !measured.at(-1).host.workflow?.ok) throw new Error('The packaged run/extract/rerun workflow did not complete.');
    if (opts.mode !== 'activation' && !measured.at(-1).host.warmPreview?.ok) throw new Error('The warm preview responsiveness fixture did not complete.');
    report.ok = true;
    console.log(`Passed: activation p95 ${report.activation.p95Ms.toFixed(1)} ms, ${report.activation.extensionChildProcesses} extension child processes${opts.mode === 'full' ? ', run/extract/rerun/clear workflow' : ''}.`);
  } catch (error) {
    report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; console.error(error.message);
  } finally { report.finishedAt = new Date().toISOString(); writeJson(reportPath, report); }
}
module.exports = { trackEditorProcesses, builtinHarnessConfig };
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
