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
  let removed = false;
  const result = await api.uninstallEditorArtifact('0.5.0', editors, { execute: async (command, args) => { calls.push([command, args]); if (args[0] === '--uninstall-extension') removed = true; return success(command === '/fake/cursor' ? 'measure-one.inkwell@0.5.1' : removed ? '' : 'measure-one.inkwell@0.5.0'); } });
  assert.equal(result.success, true);
  assert.equal(calls.length, 4);
  assert.equal(calls[2][0], '/fake/code');
  assert.deepEqual(calls[2][1], ['--uninstall-extension', 'measure-one.inkwell']);
  assert.match(result.log, /preserved separately installed Inkwell 0.5.1/);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-editors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = new Set(), calls = [], versions = new Map();
  const options = { home: root, cwd: root, env: { PATH: '' }, binDirectories: [], applications: [path.join(root, 'Applications')], executable: file => paths.has(file),
    execute: async (command, args) => { calls.push({ command, args });
      if (args[0] === '--install-extension') versions.set(command, '0.5.0');
      return success(args[0] === '--version' ? '1.99.0\narch\n' : `measure-one.inkwell@${versions.get(command) || '0.4.0'}\n`); } };
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

for (const version of ['0.5.0', '0.5.1', '0.6.0-rc.1', '0.10.0', 'unknown']) test(`installed ${version} is verified and preserved without a force install`, async t => {
  const f = fixture(t), vsix = path.join(f.root, 'release.vsix'); fs.writeFileSync(vsix, 'fixture');
  const calls = [];
  f.options.execute = async (_command, args) => { calls.push(args); return success(`measure-one.inkwell@${version}\n`); };
  const result = await api.installEditorArtifact(vsix, '0.5.0', [{ id: 'cursor', label: 'Cursor', path: '/fake/cursor', status: 'ok', extensionVersion: '0.4.0' }], f.options);
  assert.deepEqual(calls, [['--list-extensions', '--show-versions']]);
  assert.equal(result.success, version === '0.5.0');
  assert.equal(result.editors[0].extensionVersion, version);
  assert.match(result.log, version === '0.5.0' ? /no installation needed/ : /partial/);
});

for (const [allowDowngrade, downgradeConsent] of [[false, false], [true, false], [false, true], [true, true]]) test(`downgrade requires flag=${allowDowngrade} and consent=${downgradeConsent}`, async t => {
  const f = fixture(t), vsix = path.join(f.root, 'release.vsix'); fs.writeFileSync(vsix, 'fixture');
  let version = '0.6.0', writes = 0;
  f.options.execute = async (_command, args) => { if (args[0] === '--install-extension') { writes++; version = '0.5.0'; } return success(`measure-one.inkwell@${version}\n`); };
  const result = await api.installEditorArtifact(vsix, '0.5.0', [{ id: 'cursor', label: 'Cursor', path: '/fake/cursor', status: 'ok' }], { ...f.options, allowDowngrade, downgradeConsent });
  assert.equal(writes, allowDowngrade && downgradeConsent ? 1 : 0);
  assert.equal(result.success, allowDowngrade && downgradeConsent);
});

test('a mixed-editor upgrade preserves a newer release and reports partial while upgrading an older release', async t => {
  const f = fixture(t), vsix = path.join(f.root, 'release.vsix'); fs.writeFileSync(vsix, 'fixture');
  const versions = { '/fake/cursor': '0.5.1', '/fake/code': '0.4.0' }, writes = [];
  f.options.execute = async (command, args) => { if (args[0] === '--install-extension') { writes.push(command); versions[command] = '0.5.0'; } return success(`measure-one.inkwell@${versions[command]}\n`); };
  const editors = ['cursor', 'code'].map(id => ({ id, label: id, path: `/fake/${id}`, status: 'ok' }));
  const result = await api.installEditorArtifact(vsix, '0.5.0', editors, f.options);
  assert.equal(result.success, false); assert.deepEqual(writes, ['/fake/code']);
  assert.deepEqual(result.editors.map(editor => editor.extensionVersion), ['0.5.1', '0.5.0']);
});

for (const version of ['0.4.9', '0.5.0-rc.10']) test(`older release ${version} upgrades and verifies the exact artifact version`, async t => {
  const f = fixture(t), vsix = path.join(f.root, 'release.vsix'); fs.writeFileSync(vsix, 'fixture');
  let current = version;
  f.options.execute = async (_command, args) => { if (args[0] === '--install-extension') current = '0.5.0'; return success(`measure-one.inkwell@${current}\n`); };
  const result = await api.installEditorArtifact(vsix, '0.5.0', [{ id: 'cursor', label: 'Cursor', path: '/fake/cursor', status: 'ok' }], f.options);
  assert.equal(result.success, true); assert.equal(current, '0.5.0');
});

test('a failed fresh extension-list probe prevents any install', async t => {
  const f = fixture(t), vsix = path.join(f.root, 'release.vsix'); fs.writeFileSync(vsix, 'fixture');
  const calls = [];
  f.options.execute = async (_command, args) => { calls.push(args); return { ...success(''), exitCode: 1 }; };
  const result = await api.installEditorArtifact(vsix, '0.5.0', [{ id: 'cursor', label: 'Cursor', path: '/fake/cursor', status: 'ok' }], f.options);
  assert.equal(result.success, false); assert.deepEqual(calls, [['--list-extensions', '--show-versions']]);
});

for (const failed of [false, true]) test(`uninstall freshly checks concurrent upgrade and failed probe (${failed})`, async () => {
  const calls = [];
  const result = await api.uninstallEditorArtifact('0.5.0', [{ id: 'code', label: 'VS Code', path: '/fake/code', status: 'ok', extensionVersion: '0.5.0' }], { execute: async (_command, args) => { calls.push(args); return { ...success('measure-one.inkwell@0.6.0'), exitCode: failed ? 1 : 0 }; } });
  assert.equal(result.success, !failed); assert.deepEqual(calls, [['--list-extensions', '--show-versions']]);
});
