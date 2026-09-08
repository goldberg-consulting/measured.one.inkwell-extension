const test = require('node:test');
const assert = require('node:assert/strict');
const { planMacInstallation, executeInstallationPlan } = require('../out/macos-install');
const ready = { installed: true };
const base = () => ({ platform: 'darwin', brew: '/opt/homebrew/bin/brew', tools: { pandoc: ready, crossref: ready, mmdc: ready, xelatex: ready, pdflatex: ready, ghostscript: ready }, missingPackages: [], requirementsHash: 'artifact-hash', cwd: '/tmp' });
test('full MacTeX is the zero-maintenance default only when no TeX distribution exists', () => {
  const facts = base(); facts.tools.xelatex = {}; facts.tools.pdflatex = {};
  const plan = planMacInstallation(facts);
  assert.deepEqual(plan.steps.map(step => step.args), [['install', '--cask', 'mactex']]);
});
test('a working user TinyTeX is preserved and installs only missing packages without sudo', () => {
  const plan = planMacInstallation({ ...base(), tex: { root: '/Users/person/Library/TinyTeX', distribution: 'tinytex', writable: true, ownedByCurrentUser: true, tlmgr: '/Users/person/Library/TinyTeX/bin/tlmgr' }, missingPackages: ['booktabs', 'booktabs', 'fvextra'] });
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(plan.steps[0].args, ['install', 'booktabs', 'fvextra']);
  assert.doesNotMatch(JSON.stringify(plan), /sudo|chown|mactex|update/);
});
test('normal system MacTeX keeps its ownership and uses its privileged package manager policy', () => {
  const plan = planMacInstallation({ ...base(), tex: { root: '/usr/local/texlive/2026', distribution: 'full', writable: false, ownedByCurrentUser: false, tlmgr: '/Library/TeX/texbin/tlmgr' }, missingPackages: ['fvextra'] });
  assert.deepEqual(plan.steps[0].args, ['/Library/TeX/texbin/tlmgr', 'install', 'fvextra']);
  assert.equal(plan.steps[0].command, '/usr/bin/sudo');
  assert.doesNotMatch(JSON.stringify(plan), /chown|--cask/);
});
test('wrongly owned TinyTeX is diagnosed without ownership changes or sudo', () => {
  const plan = planMacInstallation({ ...base(), tex: { root: '/Users/person/Library/TinyTeX', distribution: 'tinytex', writable: false, ownedByCurrentUser: false, tlmgr: '/fake/tlmgr' }, missingPackages: ['fvextra'] });
  assert.equal(plan.steps.length, 0);
  assert.match(plan.diagnostics.join(' '), /not writable/);
});
test('existing incomplete TeX is not replaced with a second distribution', () => {
  const facts = base(); facts.tools.xelatex = { path: '/existing/xelatex' }; facts.tools.pdflatex = {};
  const plan = planMacInstallation(facts);
  assert.equal(plan.steps.some(step => step.args.includes('--cask')), false);
  assert.ok(plan.diagnostics.length);
});
test('Mermaid uses Homebrew without any npm dependency and an unchanged plan does no work', () => {
  const facts = base(); facts.tools.mmdc = {};
  assert.deepEqual(planMacInstallation(facts).steps[0].args, ['install', 'mermaid-cli']);
  assert.equal(planMacInstallation(base()).steps.length, 0);
});
test('invalid package names cannot become installer arguments', () => {
  assert.throws(() => planMacInstallation({ ...base(), tex: { root: '/tex', tlmgr: '/tex/tlmgr' }, missingPackages: ['booktabs; touch /tmp/sentinel'] }), /invalid TeX package/);
});
test('installation observes failure and stops subsequent package commands', async () => {
  const facts = base(); facts.tools.mmdc = {}; facts.tools.xelatex = {}; facts.tools.pdflatex = {};
  const calls = [];
  const result = await executeInstallationPlan(planMacInstallation(facts), { execute: async (command, args) => { calls.push([command, args]); return { stdout: '', stderr: 'failed', exitCode: 23, rawExitCode: 23, signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false }; } });
  assert.equal(result.exitCode, 23);
  assert.equal(calls.length, 1);
});
