const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../out/editor-installation');
const success = stdout => ({ stdout, stderr: '', exitCode: 0, rawExitCode: 0, signal: null, cancelled: false, timedOut: false, maxBufferExceeded: false });

test('cask uninstall preserves separately upgraded extensions and verifies removal of its version', async () => {
  const calls = [];
  const editors = [{ id: 'cursor', label: 'Cursor', path: '/fake/cursor', status: 'ok', extensionVersion: '0.5.1' }, { id: 'code', label: 'VS Code', path: '/fake/code', status: 'ok', extensionVersion: '0.5.0' }];
  const result = await api.uninstallEditorArtifact('0.5.0', editors, { execute: async (command, args) => { calls.push([command, args]); return success(''); } });
  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], '/fake/code');
  assert.deepEqual(calls[0][1], ['--uninstall-extension', 'measure-one.inkwell']);
  assert.match(result.log, /preserved separately installed Inkwell 0.5.1/);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-editors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = new Set(), calls = [];
  const options = { home: root, cwd: root, env: { PATH: '' }, binDirectories: [], applications: [path.join(root, 'Applications')], executable: file => paths.has(file),
    execute: async (command, args) => { calls.push({ command, args }); return success(args[0] === '--version' ? '1.99.0\narch\n' : 'measure-one.inkwell@0.5.0\n'); } };
  return { root, paths, calls, options };
}
for (const ids of [['cursor'], ['code'], ['cursor', 'code']]) test(`app-only discovery and exact installation: ${ids.join('+')}`, async t => {
  const f = fixture(t);
  for (const id of ids) f.paths.add(api.editorCandidates(id, f.options)[0]);
  const editors = await api.detectEditors(f.options);
  assert.deepEqual(editors.map(editor => editor.id), ids);
  assert.deepEqual(api.selectEditors(editors, 'auto'), editors);
  assert.deepEqual(api.selectEditors(editors, 'all'), editors);
  const artifact = path.join(f.root, "Inkwell's release file.vsix");
  fs.writeFileSync(artifact, 'fake archive; artifact validation is tested separately');
  const installed = await api.installEditorArtifact(artifact, '0.5.0', editors, f.options);
  assert.equal(installed.success, true);
  const installs = f.calls.filter(call => call.args[0] === '--install-extension');
  assert.equal(installs.length, ids.length);
  for (const call of installs) assert.deepEqual(call.args, ['--install-extension', artifact, '--force']);
});
test('PATH, Apple Silicon, Intel and user app-bundle CLI paths share one discovery contract', () => {
  const paths = api.editorCandidates('code', { home: '/Users/person', env: { PATH: '/custom/bin' } });
  for (const file of ['/custom/bin/code', '/opt/homebrew/bin/code', '/usr/local/bin/code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', '/Users/person/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code']) assert.ok(paths.includes(file));
});
test('a present broken editor is not reported as verified and an explicit missing selection fails', async t => {
  const f = fixture(t);
  f.paths.add(api.editorCandidates('cursor', f.options)[0]);
  f.options.execute = async () => ({ ...success(''), exitCode: 1, rawExitCode: 1 });
  const editors = await api.detectEditors(f.options);
  assert.equal(editors[0].status, 'broken');
  assert.throws(() => api.selectEditors(editors, 'auto'), /checks failed/);
  assert.throws(() => api.selectEditors(editors, 'code'), /No code/);
});
for (const kind of ['failure', 'wrong-version', 'null-exit', 'cancelled']) test(`installation cannot be complete after ${kind}`, async t => {
  const f = fixture(t);
  const vsix = path.join(f.root, 'release.vsix'); fs.writeFileSync(vsix, 'fixture');
  f.options.execute = async (_command, args) => args[0] === '--install-extension'
    ? { ...success(''), ...(kind === 'failure' ? { exitCode: 1 } : kind === 'null-exit' ? { rawExitCode: null } : kind === 'cancelled' ? { cancelled: true } : {}) }
    : success('measure-one.inkwell@0.4.0\n');
  const result = await api.installEditorArtifact(vsix, '0.5.0', [{ id: 'cursor', label: 'Cursor', path: '/fake/cursor', status: 'ok' }], f.options);
  assert.equal(result.success, false);
  assert.equal(result.editors[0].status, 'broken');
});
