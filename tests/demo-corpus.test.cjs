const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const repo = path.resolve(__dirname, '..');

test('every compiled demo has meaningful expected PDF text', () => {
  const expectations = JSON.parse(fs.readFileSync(path.join(repo, 'tests/fixtures/demo-text.json'), 'utf8'));
  const demos = fs.readdirSync(path.join(repo, 'examples')).filter(name => /^demo-.*\.md$/.test(name));
  for (const demo of demos) {
    const fragments = expectations[demo];
    assert.ok(Array.isArray(fragments) && fragments.length > 0, `${demo} needs expected PDF text`);
    assert.ok(fragments.every(fragment => typeof fragment === 'string' && fragment.trim()), `${demo} needs nonempty text fragments`);
  }
});

test('demo checker rejects missing or empty expectations before loading the compiler', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-demo-corpus-test-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, 'scripts'));
  fs.mkdirSync(path.join(fixture, 'examples'));
  fs.mkdirSync(path.join(fixture, 'tests/fixtures'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'scripts/check-demos.cjs'), path.join(fixture, 'scripts/check-demos.cjs'));
  fs.writeFileSync(path.join(fixture, 'examples/demo-new.md'), '# New demo\n');
  for (const expectations of [{}, { 'demo-new.md': [] }, { 'demo-new.md': [' '] }, { 'demo-new.md': [42] }]) {
    fs.writeFileSync(path.join(fixture, 'tests/fixtures/demo-text.json'), JSON.stringify(expectations));
    const result = cp.spawnSync(process.execPath, [path.join(fixture, 'scripts/check-demos.cjs')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing or invalid PDF text expectations for demo-new\.md/);
    assert.doesNotMatch(result.stderr, /TypeError|Cannot find module/);
  }
});

test('demo fixtures stage the configured Python environment and mixed-report dependencies', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-demo-setup-test-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const directory of ['scripts', 'examples/mixed-report', 'tests/fixtures', 'out', 'runtime/bin', 'isolated']) {
    fs.mkdirSync(path.join(fixture, directory), { recursive: true });
  }
  for (const script of ['check-demos.cjs', 'demo-policy.mjs']) {
    fs.copyFileSync(path.join(repo, 'scripts', script), path.join(fixture, 'scripts', script));
  }
  fs.writeFileSync(path.join(fixture, 'examples/demo-tufte.md'), '```{python}\nprint("fixture")\n```\n');
  fs.writeFileSync(path.join(fixture, 'examples/mixed-report/trend.py'), 'print("trend")\n');
  fs.writeFileSync(path.join(fixture, 'examples/mixed-report/package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(fixture, 'examples/mixed-report/local-output.csv'), 'not a bundled asset\n');
  fs.writeFileSync(path.join(fixture, 'tests/fixtures/demo-text.json'), JSON.stringify({ 'demo-tufte.md': ['Fixture'] }));
  fs.writeFileSync(path.join(fixture, 'tests/fixtures/warning-allowlist.json'), '[]\n');
  fs.writeFileSync(path.join(fixture, 'out/scaffold-assets.js'), 'exports.STARTER_BIB = ""; exports.SCAFFOLD_SEED_FILES = {};\n');
  fs.writeFileSync(path.join(fixture, 'out/bundled-assets.js'), 'exports.BUNDLED_ASSET_PATHS = ["examples/mixed-report/trend.py", "examples/mixed-report/package-lock.json"];\n');
  fs.writeFileSync(path.join(fixture, 'runtime/bin/python'), 'fixture interpreter\n');
  const preload = path.join(fixture, 'preload.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const path = require('node:path');
    const root = __dirname;
    require('node:os').tmpdir = () => path.join(root, 'isolated');
    require('node:child_process').execFileSync = (binary, args) => {
      if (args[0] === 'ci') fs.writeFileSync(path.join(root, 'npm-call.json'), JSON.stringify({ binary, args }));
      if (args[0] === '-c') throw new Error('Fixture setup complete; compilation intentionally not started');
      return 'fixture version';
    };
  `);
  const result = cp.spawnSync(process.execPath, ['--require', preload, path.join(fixture, 'scripts/check-demos.cjs')], {
    encoding: 'utf8', env: { ...process.env, INKWELL_TEST_PYTHON: path.join(fixture, 'runtime/bin/python') },
  });
  assert.match(result.stderr, /Fixture setup complete/);
  const [work] = fs.readdirSync(path.join(fixture, 'isolated'));
  const project = path.join(fixture, 'isolated', work, 'project');
  assert.equal(fs.readFileSync(path.join(project, '.venv/bin/python'), 'utf8'), 'fixture interpreter\n');
  assert.equal(fs.existsSync(path.join(project, 'venv')), false);
  const mixedReport = path.join(project, '.inkwell/scripts/mixed-report');
  assert.equal(fs.readFileSync(path.join(mixedReport, 'trend.py'), 'utf8'), 'print("trend")\n');
  assert.equal(fs.readFileSync(path.join(mixedReport, 'package-lock.json'), 'utf8'), '{}\n');
  assert.equal(fs.existsSync(path.join(mixedReport, 'local-output.csv')), false);
  const npm = JSON.parse(fs.readFileSync(path.join(fixture, 'npm-call.json'), 'utf8'));
  assert.deepEqual(npm.args, ['ci', '--prefix', fs.realpathSync(mixedReport), '--no-audit', '--no-fund']);
});
