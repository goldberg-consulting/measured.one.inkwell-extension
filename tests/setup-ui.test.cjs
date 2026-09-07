const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function fixture() {
  const listeners = new Set(), endings = new Set(), executions = [], commands = new Map(), contexts = [];
  const disposable = set => listener => { set.add(listener); return { dispose: () => set.delete(listener) }; };
  const vscode = {
    TaskScope: { Workspace: 2 }, TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 2 },
    ProcessExecution: class { constructor(command, args, options) { Object.assign(this, { command, args, options }); } },
    Task: class { constructor(definition, scope, name, source, execution) { Object.assign(this, { definition, scope, name, source, execution }); } },
    tasks: {
      onDidEndTaskProcess: disposable(listeners), onDidEndTask: disposable(endings),
      executeTask: async task => { const execution = { task, terminated: false, terminate() { this.terminated = true; } }; executions.push(execution); return execution; },
    },
    commands: { registerCommand: (id, handler) => { commands.set(id, handler); return { dispose() {} }; },
      executeCommand: async (...args) => { contexts.push(args); } },
    workspace: { isTrusted: true },
    ProgressLocation: { Notification: 15 },
    window: { createOutputChannel: () => ({ appendLine() {}, show() {} }),
      withProgress: async (_options, callback) => callback({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
      showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined,
    },
  };
  const original = Module._load;
  Module._load = function(request, ...rest) { if (request === 'vscode') return vscode; return original.call(this, request, ...rest); };
  let api;
  try { delete require.cache[require.resolve('../out/setup-ui')]; api = require('../out/setup-ui'); } finally { Module._load = original; }
  const end = (exitCode, execution = executions.at(-1)) => { for (const listener of listeners) listener({ execution, exitCode }); };
  return { api, vscode, executions, commands, end, listeners, endings, contexts };
}
const plan = { id: 'install', title: 'Install one tool', steps: [{ id: 'pandoc', label: 'Install Pandoc',
  command: '/path with spaces/brew', args: ['install', 'pandoc'], cwd: '/project with spaces', verificationIds: ['tool:pandoc'] }] };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Setup / Repair and legacy commands await the same setup workflow', async () => {
  const h = fixture(); let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  h.api.registerSetupCommands({ subscriptions: [] }, { run: async () => { calls++; return pending; } });
  let complete = false;
  const operation = h.commands.get('inkwell.setupRepair')().then(() => { complete = true; });
  await tick(); assert.equal(complete, false); assert.equal(calls, 1);
  release({ status: 'complete' }); await operation;
  assert.equal(complete, true);
  await h.commands.get('inkwell.setupToolchain')(); assert.equal(calls, 2);
});

test('installation tasks use literal argument arrays and wait for process exit', async () => {
  const h = fixture(); let done = false;
  const operation = h.api.runInstallationTasks(plan).then(result => { done = true; return result; });
  await tick(); assert.equal(done, false);
  assert.equal(h.executions[0].task.execution.command, '/path with spaces/brew');
  assert.deepEqual(h.executions[0].task.execution.args, ['install', 'pandoc']);
  h.end(0); const result = await operation;
  assert.equal(result.exitCode, 0); assert.equal(result.rawExitCode, 0);
  assert.equal(h.listeners.size, 0); assert.equal(h.endings.size, 0);
});

for (const exitCode of [1, undefined]) test(`installation task exit ${exitCode} remains a failure`, async () => {
  const h = fixture(); const operation = h.api.runInstallationTasks(plan);
  await tick(); h.end(exitCode);
  const result = await operation;
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.rawExitCode, exitCode ?? null);
});

test('task cancellation terminates observed execution and cannot report success', async () => {
  const h = fixture(), controller = new AbortController();
  const operation = h.api.runInstallationTasks(plan, { signal: controller.signal });
  await tick(); controller.abort();
  assert.equal(h.executions[0].terminated, true);
  h.end(0);
  const result = await operation;
  assert.equal(result.cancelled, true); assert.notEqual(result.exitCode, 0);
});

test('the first failed task prevents subsequent installation steps', async () => {
  const h = fixture();
  const operation = h.api.runInstallationTasks({ ...plan, steps: [...plan.steps, { ...plan.steps[0], id: 'second' }] });
  await tick(); h.end(2); await operation;
  assert.equal(h.executions.length, 1);
});

test('task launch exceptions dispose observers and return an observed failure', async () => {
  const h = fixture();
  h.vscode.tasks.executeTask = () => { throw new Error('Task service unavailable'); };
  const result = await h.api.runInstallationTasks(plan);
  assert.notEqual(result.exitCode, 0); assert.match(result.error, /Task service unavailable/);
  assert.equal(h.listeners.size, 0); assert.equal(h.endings.size, 0);
});

test('a task ending without a process event cannot be fabricated into success', async () => {
  const h = fixture(); const pending = h.api.runInstallationTasks(plan);
  await tick(); for (const listener of h.endings) listener({ execution: h.executions[0] });
  const result = await pending;
  assert.notEqual(result.exitCode, 0); assert.equal(result.rawExitCode, null);
});

test('already cancelled installation does not launch any tasks', async () => {
  const h = fixture(), controller = new AbortController(); controller.abort();
  assert.equal((await h.api.runInstallationTasks(plan, { signal: controller.signal })).cancelled, true);
  assert.equal(h.executions.length, 0);
});

test('a task execution returned after the deadline is terminated and stays timed out', async () => {
  const h = fixture(); let release;
  h.vscode.tasks.executeTask = task => new Promise(resolve => { release = () => {
    const execution = { task, terminated: false, terminate() { this.terminated = true; } };
    h.executions.push(execution); resolve(execution);
  }; });
  const pending = h.api.runInstallationTasks(plan, { timeoutMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 15));
  release(); await tick();
  assert.equal(h.executions[0].terminated, true);
  h.end(0);
  const result = await pending;
  assert.equal(result.timedOut, true); assert.notEqual(result.exitCode, 0);
});

test('setup UI waits for smoke verification and never shows readiness after smoke failure', async () => {
  const h = fixture(); let release, saved;
  const messages = [];
  h.vscode.window.showInformationMessage = async message => { messages.push(message); };
  const pending = new Promise(resolve => { release = resolve; });
  const ui = h.api.createSetupUI({ extensionPath: '/tmp/isolated-extension', globalStorageUri: { fsPath: '/tmp/isolated-state' } }, {
    store: { load: async () => undefined, save: async state => { saved = structuredClone(state); } },
    doctor: async () => ({ mode: 'full', ready: false, status: 'warning', fingerprint: 'fixture', checks: [{ id: 'tool:pandoc', required: true, status: 'ok', message: 'Present' }] }),
    plan: () => ({ id: 'none', title: 'Ready', steps: [] }),
    readiness: async () => ({ ready: true }), smoke: async () => pending,
  });
  let done = false;
  const work = ui.run('/tmp/isolated-project').then(state => { done = true; return state; });
  await tick(); assert.equal(done, false); assert.equal(saved.stage, 'smoke-compile');
  release({ success: true, verified: false });
  assert.equal((await work).status, 'failed');
  assert.deepEqual(messages, []);
  assert.equal(h.executions.length, 0);
  assert.deepEqual(h.contexts, [['setContext', 'inkwell.setupVerified', false]]);
});

test('walkthrough setup completion is set only after a successful verified smoke build', async () => {
  const h = fixture(); let release;
  const ui = h.api.createSetupUI({ extensionPath: '/tmp/isolated-extension', globalStorageUri: { fsPath: '/tmp/isolated-state' } }, {
    store: { load: async () => undefined, save: async () => {} },
    doctor: async () => ({ mode: 'full', ready: true, status: 'ok', fingerprint: 'fixture', checks: [{ id: 'tool:pandoc', required: true, status: 'ok', message: 'Present' }] }),
    plan: () => ({ id: 'none', title: 'Ready', steps: [] }),
    readiness: async () => ({ ready: true }), smoke: async () => new Promise(resolve => { release = resolve; }),
  });
  const pending = ui.run('/tmp/isolated-project'); await tick();
  assert.deepEqual(h.contexts, []);
  release({ success: true, verified: true }); await pending;
  assert.deepEqual(h.contexts, [['setContext', 'inkwell.setupVerified', true]]);
});

test('untrusted UI setup cannot start probes, installation or scaffold work', async () => {
  const h = fixture(); h.vscode.workspace.isTrusted = false; let probes = 0;
  const ui = h.api.createSetupUI({ extensionPath: '/tmp/isolated-extension', globalStorageUri: { fsPath: '/tmp/isolated-state' } }, {
    doctor: async () => { probes++; throw new Error('Should not run'); },
  });
  assert.equal(await ui.run('/tmp/isolated-project'), undefined);
  assert.equal(probes, 0); assert.equal(h.executions.length, 0);
});
