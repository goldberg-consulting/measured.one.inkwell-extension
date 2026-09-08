const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function scaffoldFixture(t, name = 'Test project', pythonSuccess = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-python-setup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir);
  const messages = [];
  const terminalCommands = [];
  const setupCalls = [];
  const contexts = [];
  const stub = {
    commands: { executeCommand: async (...args) => { contexts.push(args); } },
    workspace: { workspaceFolders: [{ uri: { fsPath: projectDir } }], openTextDocument: async (file) => ({ file }) },
    window: {
      showInputBox: async () => name,
      showQuickPick: async (_items, options) => ({ label: options.placeHolder.startsWith('Seed') ? 'No' : 'Yes' }),
      showTextDocument: async () => {},
      showInformationMessage: (message) => { messages.push(message); },
      showErrorMessage: (message) => { messages.push(message); },
      showWarningMessage: (message) => { messages.push(message); },
      createOutputChannel: () => ({ appendLine() {}, show() {} }),
      createTerminal: () => ({ show() {}, sendText: (command) => terminalCommands.push(command) }),
      withProgress: async (_options, action) => action({ report() {} }),
    },
    ProgressLocation: { Notification: 15 },
  };
  const load = Module._load;
  const modulePath = require.resolve('../out/scaffold.js');
  delete require.cache[modulePath];
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return stub;
    if (request === './templates') return { selectTemplateCommand: async () => 'default' };
    if (request === './python-setup') return { setupPythonEnvironment: async (options) => {
      setupCalls.push(options);
      return { success: pythonSuccess, status: pythonSuccess ? 'ready' : 'failed', phase: 'install', message: 'Mock pip failure', log: 'pip failed' };
    } };
    if (request === './inkwell-output') return { getInkwellOutputChannel: () => ({ appendLine() {}, show() {} }) };
    return load.call(this, request, ...rest);
  };
  let scaffold;
  try { scaffold = require(modulePath); } finally { Module._load = load; }
  return { ...scaffold, root, projectDir, messages, terminalCommands, setupCalls, contexts };
}

for (const operation of ['initProject', 'setupWorkspace']) {
  test(`${operation} awaits Python failure and never reports completed setup`, async (t) => {
    const f = scaffoldFixture(t);
    await f[operation]();
    assert.equal(f.messages.some((message) => /initialized|setup complete/i.test(message)), false);
    assert.equal(f.terminalCommands.length, 0, 'Python setup must not send interpolated shell commands');
    assert.equal(f.setupCalls.length, 1);
    assert.ok(f.messages.some((message) => /Mock pip failure/.test(message)));
    assert.deepEqual(f.contexts, []);
  });
}

test('project walkthrough completes after the document is created and requested Python setup verifies', async t => {
  const f = scaffoldFixture(t, 'Verified project', true);
  await f.initProject(async () => ({ ready: true }));
  assert.ok(fs.existsSync(path.join(f.projectDir, 'Verified project.md')));
  assert.deepEqual(f.contexts, [['setContext', 'inkwell.projectCreated', true]]);
  const cancelled = scaffoldFixture(t, undefined);
  await cancelled.initProject(async () => ({ ready: false }));
  assert.deepEqual(cancelled.contexts, []);
});

test('project creation rejects traversal even when input validation is bypassed', async (t) => {
  const f = scaffoldFixture(t, '../escaped');
  await f.initProject();
  assert.equal(fs.existsSync(path.join(f.root, 'escaped.md')), false);
  assert.equal(fs.existsSync(path.join(f.projectDir, '.inkwell')), false, 'reject unsafe names before writing project files');
  assert.equal(f.setupCalls.length, 0);
});

function outcome(values = {}) {
  return { stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false, ...values };
}

function serviceFixture(t, override) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-python-service-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const environmentDir = path.join(root, 'venv');
  const pythonPath = path.join(environmentDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const calls = [];
  const createEnvironment = () => {
    fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
    fs.writeFileSync(pythonPath, 'fake interpreter', { mode: 0o755 });
    fs.writeFileSync(path.join(environmentDir, 'pyvenv.cfg'), 'home = /base/python');
  };
  const executeProcess = async (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    const overridden = override?.(call, calls);
    if (overridden) return overridden;
    if (args[0] === '-m' && args[1] === 'venv') createEnvironment();
    if (args[0] === '-c') return outcome({ stdout: JSON.stringify({ version: '3.13.1', prefix: environmentDir, basePrefix: '/base/python' }) });
    return outcome();
  };
  const { setupPythonEnvironment } = require('../out/python-setup.js');
  return { root, environmentDir, pythonPath, calls, createEnvironment, run: (options = {}) => setupPythonEnvironment({ projectDir: root, environmentDir, ...options }, { executeProcess }) };
}

test('venv creation failure is authoritative and stops dependency installation', async (t) => {
  const f = serviceFixture(t, () => outcome({ exitCode: 2, stderr: 'venv failed' }));
  const result = await f.run({ packages: ['numpy'] });
  assert.equal(result.success, false);
  assert.equal(result.phase, 'create');
  assert.equal(f.calls.length, 1);
  assert.match(result.log, /venv failed/);
});

test('pip install failure cannot report a ready environment', async (t) => {
  const f = serviceFixture(t, (call) => call.args.includes('install') ? outcome({ exitCode: 7, stderr: 'pip failed' }) : undefined);
  const result = await f.run({ packages: ['numpy'] });
  assert.equal(result.success, false);
  assert.equal(result.phase, 'install');
  assert.equal(f.calls.at(-1).args.includes('install'), true);
});

test('a preexisting directory without a valid venv is preserved and rejected', async (t) => {
  const f = serviceFixture(t);
  fs.mkdirSync(f.environmentDir);
  fs.writeFileSync(path.join(f.environmentDir, 'user-file.txt'), 'preserve');
  const result = await f.run();
  assert.equal(result.success, false);
  assert.equal(result.phase, 'preflight');
  assert.equal(f.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(f.environmentDir, 'user-file.txt'), 'utf8'), 'preserve');
});

test('a preexisting environment is freshly verified and never recreated', async (t) => {
  const f = serviceFixture(t);
  f.createEnvironment();
  const result = await f.run({ packages: ['numpy'] });
  assert.equal(result.success, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.pythonVersion, '3.13.1');
  assert.equal(f.calls.some((call) => call.args[1] === 'venv'), false);
  const install = f.calls.findIndex((call) => call.args.includes('install'));
  assert.ok(f.calls.findIndex((call) => call.args[0] === '-c') < install, 'validate existing interpreter before installation');
  assert.equal(f.calls.at(-2).args[0], '-c', 'fresh Python identity after installation');
  assert.deepEqual(f.calls.at(-1).args, ['-m', 'pip', 'check']);
});

test('fresh final Python probe failure prevents readiness even after pip succeeds', async (t) => {
  let probes = 0;
  const f = serviceFixture(t, (call) => call.args[0] === '-c' && ++probes === 2 ? outcome({ exitCode: 1, stderr: 'broken interpreter' }) : undefined);
  f.createEnvironment();
  const result = await f.run({ packages: ['numpy'] });
  assert.equal(result.success, false);
  assert.equal(result.phase, 'verify');
  assert.equal(probes, 2);
});

test('pip check and wrong interpreter identity each prevent readiness', async (t) => {
  const f = serviceFixture(t, (call) => call.args.includes('check') ? outcome({ exitCode: 1, stderr: 'incompatible dependencies' }) : undefined);
  assert.equal((await f.run()).success, false);
  const other = serviceFixture(t, (call) => call.args[0] === '-c' ? outcome({ stdout: JSON.stringify({ version: '3.13.1', prefix: '/different/env', basePrefix: '/base/python' }) }) : undefined);
  assert.equal((await other.run()).success, false);
});

test('requirements and package strings remain literal argv arguments', async (t) => {
  const f = serviceFixture(t);
  const requirementsFile = path.join(f.root, 'requirements "quoted"\n$(touch marker).txt');
  fs.writeFileSync(requirementsFile, 'numpy\n');
  const packages = ['numpy==2.2', 'something; touch marker', '$(touch marker)'];
  assert.equal((await f.run({ requirementsFile, packages })).success, true);
  const install = f.calls.find((call) => call.args.includes('install'));
  assert.deepEqual(install.args, ['-m', 'pip', 'install', '-r', requirementsFile, '--', ...packages]);
  assert.equal(fs.existsSync(path.join(f.root, 'marker')), false);
  assert.equal(f.calls.some((call) => call.command === 'sh' || call.command === 'bash'), false);
});

for (const failure of [
  { exitCode: 0, signal: 'SIGTERM' },
  { exitCode: 124, timedOut: true },
  { exitCode: 130, cancelled: true },
  { exitCode: 1, maxBufferExceeded: true },
]) {
  test(`setup process failure ${JSON.stringify(failure)} is never ready`, async (t) => {
    const f = serviceFixture(t, () => outcome(failure));
    const result = await f.run();
    assert.equal(result.success, false);
    assert.equal(result.status, failure.cancelled ? 'cancelled' : 'failed');
    assert.equal(f.calls.length, 1);
  });
}

test('project names reject traversal, shell syntax, and platform-reserved filenames', (t) => {
  const f = scaffoldFixture(t);
  for (const name of ['../escape', '..\\escape', '.', '..', '$(touch marker)', '`touch marker`', 'paper; touch marker', 'paper\nnext', 'CON', 'NUL.txt', 'paper.']) {
    assert.equal(typeof f.validateProjectName(name), 'string', name);
  }
  for (const name of ['Eli\'s paper', 'Project 0.5', 'été-report', 'name_with_underscores']) {
    assert.equal(f.validateProjectName(name), null, name);
  }
});

test('real child-process invocation preserves quotes, newlines, and shell syntax literally', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-python-argv-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const environmentDir = path.join(root, 'env "quotes"\n$(touch marker)');
  const requirementsFile = path.join(root, 'requirements "quotes"\n$(touch marker).txt');
  const pythonCommand = path.join(root, 'python "quotes"\n$(touch marker)');
  const callLog = path.join(root, 'calls.jsonl');
  const fakeInterpreter = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_PYTHON_SETUP_LOG, JSON.stringify({ command: process.argv[1], args }) + '\\n');
if (args[0] === '-m' && args[1] === 'venv') {
  const target = path.join(args[2], process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.copyFileSync(process.argv[1], target);
  fs.chmodSync(target, 0o755);
  fs.writeFileSync(path.join(args[2], 'pyvenv.cfg'), 'home = /base/python');
} else if (args[0] === '-c') {
  process.stdout.write(JSON.stringify({version:'3.13.1', prefix:path.dirname(path.dirname(process.argv[1])), basePrefix:'/base/python'}));
}
`;
  fs.writeFileSync(pythonCommand, fakeInterpreter, { mode: 0o755 });
  fs.writeFileSync(requirementsFile, 'numpy');
  const { setupPythonEnvironment } = require('../out/python-setup.js');
  const packages = ['numpy==2.2', 'evil; touch marker', '$(touch marker)'];
  const result = await setupPythonEnvironment({
    projectDir: root, environmentDir, pythonCommand, requirementsFile, packages,
    env: { TEST_PYTHON_SETUP_LOG: callLog }, timeoutMs: 10_000,
  });
  assert.equal(result.success, true, result.log);
  const calls = fs.readFileSync(callLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0].args, ['-m', 'venv', environmentDir]);
  assert.deepEqual(calls.find((call) => call.args.includes('install')).args, ['-m', 'pip', 'install', '-r', requirementsFile, '--', ...packages]);
  assert.equal(calls.at(-2).args[0], '-c');
  assert.deepEqual(calls.at(-1).args, ['-m', 'pip', 'check']);
  assert.equal(fs.existsSync(path.join(root, 'marker')), false);
});
