const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { doctorToInstallationPlan, asSetupPlan, requestedPackagePlan, probeRequestedPackage } = require('../out/setup-adapters');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-setup-adapters-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['tlmgr', 'kpsewhich']) fs.writeFileSync(path.join(root, name), 'fixture', { mode: 0o755 });
  const tools = Object.fromEntries(['pandoc', 'pandoc-crossref', 'xelatex', 'pdflatex', 'mmdc', 'ghostscript'].map(name => [name, { state: 'ready', path: path.join(root, name) }]));
  tools.kpsewhich = { state: 'ready', path: path.join(root, 'kpsewhich') };
  const report = { schemaVersion: 1, mode: 'full', ready: false, status: 'warning', checks: [], tools, missingPackages: [],
    tex: { root, distribution: 'tinytex', ownerUid: 501, currentUid: 501, writable: true, privilege: 'user', message: 'User-owned TeX' }, fingerprint: 'probe' };
  return { root, report };
}

test('Doctor facts produce matching verification IDs and preserve an existing user-owned TeX tree', t => {
  const f = fixture(t);
  f.report.tools['pandoc-crossref'].state = 'missing'; f.report.missingPackages = ['booktabs'];
  const plan = doctorToInstallationPlan(f.report, { cwd: f.root, extensionRoot: f.root, requirementsHash: 'exactrequirements', platform: 'darwin', brew: '/opt/homebrew/bin/brew' });
  assert.deepEqual(plan.steps[0].args, ['install', 'pandoc-crossref']);
  assert.deepEqual(plan.steps[0].verificationIds, ['tool:pandoc-crossref']);
  assert.equal(plan.steps[1].command, path.join(f.root, 'tlmgr'));
  assert.deepEqual(plan.steps[1].args, ['install', 'booktabs']);
  assert.deepEqual(plan.steps[1].verificationIds, ['tex-package:booktabs']);
  assert.equal(plan.steps.some(step => step.args.includes('mactex')), false);
});

test('an explicit package plan contains only that package and respects system TeX privileges', t => {
  const f = fixture(t); f.report.tex.privilege = 'system-admin';
  const plan = requestedPackagePlan(f.report, 'booktabs', f.root);
  assert.equal(plan.steps.length, 1); assert.equal(plan.steps[0].command, '/usr/bin/sudo');
  assert.deepEqual(plan.steps[0].args, [path.join(f.root, 'tlmgr'), 'install', 'booktabs']);
  f.report.tex.privilege = 'repair-required';
  assert.throws(() => requestedPackagePlan(f.report, 'booktabs', f.root), /User-owned TeX/);
  assert.throws(() => requestedPackagePlan(f.report, '--repository=malicious', f.root), /one TeX package/);
});

test('known package verification checks real files rather than accepting exit zero alone', async t => {
  const f = fixture(t);
  const execute = async () => ({ exitCode: 0, rawExitCode: 0, stdout: path.join(f.root, 'missing.sty'), stderr: '' });
  const result = await probeRequestedPackage(f.report, 'booktabs', { cwd: f.root, execute });
  assert.equal(result.checks.find(check => check.id === 'tex-package:booktabs').status, 'error');
  assert.equal(f.report.checks.length, 0);
});

test('requested script packages use the same TeX file format arguments as Doctor', async t => {
  const f = fixture(t), calls = [];
  const script = path.join(f.root, 'epstopdf.pl'); fs.writeFileSync(script, 'installed script');
  const result = await probeRequestedPackage(f.report, 'epstopdf', { cwd: f.root, execute: async (_command, args) => {
    calls.push(args); return { exitCode: 0, rawExitCode: 0, stdout: script, stderr: '' };
  } });
  assert.deepEqual(calls, [['--format=texmfscripts', 'epstopdf.pl']]);
  assert.equal(result.checks.at(-1).status, 'ok');
});

test('unknown package verification uses exact local inventory and rejects partial matches or signals', async t => {
  const f = fixture(t), calls = [];
  let stdout = 'custom-package-extra\n', signal = null;
  const execute = async (command, args) => { calls.push({ command, args }); return { exitCode: 0, rawExitCode: 0, stdout, stderr: '', signal }; };
  let result = await probeRequestedPackage(f.report, 'custom-package', { cwd: f.root, execute });
  assert.equal(result.checks.at(-1).status, 'error');
  assert.deepEqual(calls[0].args, ['info', '--only-installed', '--data', 'name', 'custom-package']);
  stdout = 'custom-package\n';
  result = await probeRequestedPackage(f.report, 'custom-package', { cwd: f.root, execute });
  assert.equal(result.checks.at(-1).status, 'ok');
  signal = 'SIGTERM';
  assert.equal((await probeRequestedPackage(f.report, 'custom-package', { cwd: f.root, execute })).checks.at(-1).status, 'error');
});

test('installation diagnostics prevent any plan being offered for consent', () => {
  assert.throws(() => asSetupPlan({ id: 'blocked', title: 'Blocked', steps: [], diagnostics: ['Missing Homebrew'], requirementsHash: 'hash' }), /Missing Homebrew/);
});
