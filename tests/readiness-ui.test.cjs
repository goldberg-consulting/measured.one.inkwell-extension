const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function fixture(t, probe, choices = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-readiness-ui-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], prompts = [], commands = [], state = new Map();
  const uri = file => ({ fsPath: file, scheme: 'file', toString: () => `file://${file}` });
  const ask = async message => { prompts.push(message); return choices.shift(); };
  const vscode = {
    Uri: { file: uri },
    workspace: { isTrusted: true, getWorkspaceFolder: () => ({ uri: uri(root) }) },
    window: { showInformationMessage: ask, showWarningMessage: ask, showErrorMessage: ask, showQuickPick: async items => items[0] },
    commands: { executeCommand: async (...args) => commands.push(args) },
  };
  const original = Module._load;
  Module._load = function(request, parent, ...rest) {
    if (request === 'vscode') return vscode;
    if (request === './project-readiness') return { isProjectOptedIn: () => false, ensureProjectReady: async options => { calls.push(options); return probe(options); } };
    if (request === './inkwell-output') return { getInkwellOutputChannel: () => ({ appendLine() {}, show() {} }) };
    return original.call(this, request, parent, ...rest);
  };
  let api;
  try {
    delete require.cache[require.resolve('../out/project-readiness-ui')];
    api = require('../out/project-readiness-ui');
  } finally { Module._load = original; }
  const context = { extensionPath: root, workspaceState: { get: (key, fallback) => state.has(key) ? state.get(key) : fallback, update: async (key, value) => state.set(key, value) } };
  return { root, calls, prompts, commands, state, api, gate: new api.ProjectReadinessGate(context), document: { uri: uri(path.join(root, 'draft.md')), isUntitled: false } };
}

const result = status => ({ status, ready: status === 'ready', actions: [], diagnostics: [] });

test('first action offers setup once and awaits verified readiness before continuing', async t => {
  const h = fixture(t, options => result(options.explicitSetup ? 'ready' : 'setup-required'), ['Set up this workspace']);
  assert.equal(await h.gate.ensure(h.document), true);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].explicitSetup, true);
  assert.deepEqual(h.commands.at(-1), ['setContext', 'inkwell.hasProject', true]);
});

test('dont ask here persists and suppresses subsequent prompts without authorizing setup', async t => {
  const h = fixture(t, options => result(options.dontAskHere ? 'suppressed' : 'setup-required'), ["Don't ask here"]);
  assert.equal(await h.gate.ensure(h.document), false);
  assert.equal(await h.gate.ensure(h.document), false);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.calls.some(call => call.explicitSetup), false);
  assert.equal(h.calls[1].dontAskHere, true);
  assert.deepEqual(fs.readdirSync(h.root), []);
});

test('background document switches do not prompt or opt in a plain workspace', async t => {
  const h = fixture(t, () => result('setup-required'));
  assert.equal(await h.gate.ensure(h.document, false), false);
  assert.deepEqual(h.prompts, []);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].explicitSetup, undefined);
});

test('simultaneous preview and compile share a readiness prompt and migration', async t => {
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const h = fixture(t, () => pending);
  const a = h.gate.ensure(h.document);
  const b = h.gate.ensure(h.document);
  assert.equal(h.calls.length, 1);
  complete(result('ready'));
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
});

test('Keep my files explicitly resolves managed conflicts and still verifies success', async t => {
  const h = fixture(t, options => result(options.resolveConflicts ? 'ready' : 'conflicts'), ['Keep my files']);
  assert.equal(await h.gate.ensure(h.document), true);
  assert.equal(h.calls[1].resolveConflicts, 'keep-user-files');
});

test('Compare opens the exact proposed file and leaves readiness unresolved', async t => {
  const h = fixture(t, () => ({ ...result('conflicts'), actions: [{ id: 'compare', path: '/tmp/user-guide.md', proposedPath: '/tmp/user-guide.md.new' }] }), ['Compare files']);
  assert.equal(await h.gate.ensure(h.document), false);
  assert.equal(h.commands[0][0], 'vscode.diff');
  assert.equal(h.commands[0][1].fsPath, '/tmp/user-guide.md');
  assert.equal(h.commands[0][2].fsPath, '/tmp/user-guide.md.new');
  assert.equal(h.calls.length, 1);
});

test('unsaved documents never trigger a project probe or write', async t => {
  const h = fixture(t, () => { throw new Error('must not probe'); });
  h.document.isUntitled = true;
  assert.equal(await h.gate.ensure(h.document), false);
  assert.equal(h.calls.length, 0);
});
