const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createDoctor, classifyTexOwnership, formatDoctorText, DOCTOR_REQUIRED_ASSETS } = require('../out/doctor');
const { runDoctorCli } = require('../out/doctor-cli');
const { loadTexRequirements, TEX_PACKAGE_FILES } = require('../out/tex-requirements');
const { planMigration, applyMigration } = require('../out/scaffold-migrations');
const Ajv = require('ajv');
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../schemas/doctor.schema.json'), 'utf8'));
const validateReport = new Ajv({ allErrors: true }).compile(schema);

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ok = (stdout = 'fixture version 1.0\n', overrides = {}) => ({ stdout, stderr: '', exitCode: 0, rawExitCode: 0, signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false, ...overrides });
const check = (report, id) => { const found = report.checks.find(entry => entry.id === id); assert.ok(found, `missing check ${id}`); return found; };
function write(file, contents) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); }
function fixture(t, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkwell-doctor-test ' $() \n"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extensionRoot = path.join(root, 'extension'), texRoot = path.join(root, 'TinyTeX');
  fs.mkdirSync(extensionRoot);
  fs.mkdirSync(texRoot);
  for (const relative of DOCTOR_REQUIRED_ASSETS) write(path.join(extensionRoot, relative), relative.endsWith('.json') ? '{}\n' : `fixture ${relative}\n`);
  write(path.join(extensionRoot, 'package.json'), JSON.stringify({ version: '0.5.0', publisher: 'measure-one', name: 'inkwell' }));
  write(path.join(extensionRoot, 'requirements-latex.txt'), config.requirements ?? '# installed authoritative manifest\ngeometry\namscls\n');
  const manifest = () => {
    const files = Object.fromEntries(DOCTOR_REQUIRED_ASSETS.map(relative => { const bytes = fs.readFileSync(path.join(extensionRoot, relative)); return [relative, { sha256: sha(bytes), size: bytes.length }]; }));
    write(path.join(extensionRoot, 'out/assets-manifest.json'), JSON.stringify({ schemaVersion: 1, extensionVersion: '0.5.0', files }));
  };
  manifest();
  const bin = path.join(root, 'bin');
  const names = ['pandoc', 'xelatex', 'pdflatex', 'lualatex', 'pandoc-crossref', 'mmdc', 'python3', 'kpsewhich', 'gs'];
  const binaries = {};
  for (const name of names) { binaries[name] = path.join(bin, name); write(binaries[name], 'fixture executable\n'); fs.chmodSync(binaries[name], 0o755); }
  for (const file of Object.values(TEX_PACKAGE_FILES).flat()) write(path.join(texRoot, 'files', file), 'installed fixture\n');
  write(path.join(texRoot, 'texmf-dist/ls-R'), 'initial database\n');
  const calls = [];
  const executeProcess = async (command, args, options) => {
    const name = path.basename(command);
    calls.push({ name, command, args: [...args], cwd: options.cwd });
    if (config.execute) { const response = await config.execute(name, args, options); if (response) return response; }
    if (args.length === 1 && args[0] === '--version') return ok(`${name} 1.0\n`);
    if (name === 'kpsewhich' && args[0] === '-var-value') return ok(texRoot + '\n');
    if (name === 'kpsewhich') return ok(path.join(texRoot, 'files', args.at(-1)) + '\n');
    if (name === 'pandoc') return ok('Doctor section\n\nSee sec.\u00a01.\n');
    throw new Error(`Unexpected process ${name} ${JSON.stringify(args)}`);
  };
  const dependencies = { executeProcess, findExecutable: name => config.missing?.includes(name) ? undefined : binaries[name], probeEditors: async () => config.editors || [],
    smokeCompile: async ({ temporaryRoot }) => { const pdfPath = path.join(temporaryRoot, 'actual-smoke.pdf'); write(pdfPath, '%PDF-1.4\nfixture smoke body\n%%EOF\n'); return { success: true, pdfPath, message: 'Actual fixture PDF produced.' }; }, ...config.dependencies };
  return { root, extensionRoot, texRoot, manifest, binaries, calls, dependencies, doctor: createDoctor(dependencies), options: { extensionRoot, mode: 'light', env: { PATH: bin } } };
}

test('broken or signalled executable version probes cannot report installed', async t => {
  for (const failure of [{ exitCode: 2 }, { rawExitCode: null }, { signal: 'SIGTERM' }, { timedOut: true }, { cancelled: true }, { maxBufferExceeded: true }]) {
    const f = fixture(t, { execute: (name, args) => name === 'pandoc' && args[0] === '--version' ? ok('pandoc 3.0', failure) : undefined });
    const result = await f.doctor.run(f.options);
    assert.equal(result.ready, false); assert.equal(result.tools.pandoc.state, 'broken'); assert.equal(check(result, 'tool:pandoc').status, 'error');
  }
});

test('light doctor uses only version probes and warm cache starts zero processes below budget', async t => {
  const f = fixture(t);
  const initial = await f.doctor.run(f.options);
  assert.equal(initial.ready, true);
  assert.ok(f.calls.every(call => call.name !== 'kpsewhich' && call.args.join() === '--version'));
  const count = f.calls.length, samples = [];
  for (let index = 0; index < 25; index++) {
    const started = performance.now(), result = await f.doctor.run(f.options);
    samples.push(performance.now() - started);
    assert.equal(result.cacheHit, true); assert.equal(result.processCount, 0);
  }
  assert.equal(f.calls.length, count);
  assert.ok(samples.sort((a, b) => a - b)[23] < 200, `p95 ${samples[23]}ms exceeds 200ms`);
});

test('activation cache miss is explicit and never starts a process', async t => {
  const f = fixture(t), result = await f.doctor.run({ ...f.options, cachedOnly: true });
  assert.equal(result.ready, false); assert.equal(result.processCount, 0); assert.equal(f.calls.length, 0); assert.equal(check(result, 'cached-health').status, 'skipped');
});

test('full doctor never repairs missing exact required packages', async t => {
  const f = fixture(t, { execute: (name, args) => name === 'kpsewhich' && args[0] === 'geometry.sty' ? ok('', { exitCode: 1 }) : undefined });
  const result = await f.doctor.run({ ...f.options, mode: 'full' });
  assert.equal(result.ready, false); assert.deepEqual(result.missingPackages, ['geometry']);
  assert.equal(check(result, 'tex-package:geometry').status, 'error'); assert.equal(check(result, 'tex-package:amscls').status, 'ok');
  assert.ok(f.calls.every(call => !/texhash|mktexlsr|brew|tlmgr|curl|chown|sudo/.test(call.name)));
  assert.deepEqual(f.calls.filter(call => call.name === 'kpsewhich' && !call.args[0].startsWith('-')).map(call => call.args[0]).sort(), ['amsthm.sty', 'geometry.sty']);
});

test('full readiness requires a real validated smoke PDF and crossref conversion', async t => {
  const f = fixture(t), result = await f.doctor.run({ ...f.options, mode: 'full' });
  assert.equal(result.ready, true); assert.equal(check(result, 'crossref-functional').status, 'ok'); assert.equal(check(result, 'smoke-compile').status, 'ok');
  assert.equal(fs.existsSync(check(result, 'smoke-compile').details.pdfPath), false, 'scratch fixture cleaned');
  const oldCalls = f.calls.length, cached = await f.doctor.run({ ...f.options, mode: 'full' });
  assert.equal(cached.cacheHit, true); assert.equal(f.calls.length, oldCalls);
});

test('missing or invalid smoke artifacts do not pass a successful callback', async t => {
  for (const smokeCompile of [undefined, async () => ({ success: true, message: 'claimed success' }), async ({ temporaryRoot }) => { const pdfPath = path.join(temporaryRoot, 'partial.pdf'); write(pdfPath, '%PDF-1.7 partial and truncated output'); return { success: true, pdfPath, message: 'claimed success' }; }]) {
    const f = fixture(t, { dependencies: { smokeCompile } }), report = await f.doctor.run({ ...f.options, mode: 'full' });
    assert.equal(report.ready, false); assert.notEqual(check(report, 'smoke-compile').status, 'ok');
  }
});

test('crossref mismatches remain errors even if executable versions succeed', async t => {
  const f = fixture(t, { execute: (name, args) => name === 'pandoc' && args[0] !== '--version' ? ok('See @sec:doctor.', { stderr: 'WARNING: pandoc-types mismatch\n' }) : undefined });
  const result = await f.doctor.run({ ...f.options, mode: 'full' });
  assert.equal(result.tools.pandoc.state, 'ready'); assert.equal(check(result, 'crossref-functional').status, 'error'); assert.equal(result.ready, false);
});

test('installed requirements are authoritative and unknown packages have no fallback mapping', async t => {
  for (const requirements of ['', 'made-up-package\n', '../unsafe\n']) {
    const f = fixture(t, { requirements });
    const result = await f.doctor.run({ ...f.options, mode: 'full' });
    assert.equal(check(result, 'requirements-manifest').status, 'error'); assert.equal(result.ready, false);
    assert.equal(f.calls.filter(call => call.name === 'kpsewhich' && !call.args[0].startsWith('-')).length, 0);
  }
  const installed = loadTexRequirements(path.join(__dirname, '..'));
  assert.equal(installed.packages.length, 101);
  assert.ok(!installed.packages.some(pkg => pkg.name === 'fix2col'));
  assert.deepEqual(installed.packages.find(pkg => pkg.name === 'caption').files, ['caption.sty', 'subcaption.sty']);
  assert.deepEqual(installed.packages.find(pkg => pkg.name === 'tools').files, ['array.sty', 'calc.sty', 'longtable.sty', 'multicol.sty', 'tabularx.sty']);
  assert.equal(TEX_PACKAGE_FILES.subcaption, undefined);
  assert.equal(TEX_PACKAGE_FILES.tabularx, undefined);
  const providers = fixture(t, { requirements: 'caption\ntools\n', execute: (name, args) => name === 'kpsewhich' && ['subcaption.sty', 'tabularx.sty'].includes(args[0]) ? ok('', { exitCode: 1 }) : undefined });
  const providerResult = await providers.doctor.run({ ...providers.options, mode: 'full' });
  assert.deepEqual(providerResult.missingPackages, ['caption', 'tools']);
});

test('bundled templates do not import obsolete fix2col', () => {
  function inspect(root) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (/\.(?:tex|latex|cls|sty)$/.test(entry.name)) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\bfix2col\b/);
    }
  }
  inspect(path.join(__dirname, '../templates'));
});

test('non-sty package files use explicit fonts, encoding and script coverage', async t => {
  const f = fixture(t, { requirements: 'tex-gyre\nly1\nepstopdf\n' });
  const result = await f.doctor.run({ ...f.options, mode: 'full' });
  assert.equal(result.ready, true);
  assert.ok(f.calls.some(call => call.name === 'kpsewhich' && call.args.join('|') === '--format=texmfscripts|epstopdf.pl'));
  assert.ok(f.calls.some(call => call.args[0] === 'ec-qplr.tfm'));
  assert.ok(f.calls.some(call => call.args[0] === 'ly1enc.def'));
});

test('packaged hash mismatch and omitted mandatory asset block readiness', async t => {
  const f = fixture(t);
  await f.doctor.run(f.options);
  write(path.join(f.extensionRoot, 'templates/inkwell.latex'), 'tampered');
  const corrupt = await f.doctor.run(f.options);
  assert.equal(corrupt.cacheHit, false); assert.equal(check(corrupt, 'assets').status, 'error');
  const manifest = JSON.parse(fs.readFileSync(path.join(f.extensionRoot, 'out/assets-manifest.json')));
  delete manifest.files['templates/inkwell.latex'];
  const missing = await f.doctor.run({ ...f.options, assetsManifest: manifest });
  assert.equal(check(missing, 'assets').status, 'error'); assert.match(check(missing, 'assets').message, /omits required/);
});

test('doctor reads legacy manifest names but never masks a corrupt canonical contract', async t => {
  const f = fixture(t), canonical = path.join(f.extensionRoot, 'out/assets-manifest.json');
  const legacy = path.join(f.extensionRoot, 'out/asset-manifest.json');
  fs.renameSync(canonical, legacy);
  assert.equal((await f.doctor.run(f.options)).ready, true);
  write(canonical, '{broken JSON');
  const damaged = await f.doctor.run(f.options);
  assert.equal(damaged.ready, false); assert.equal(damaged.cacheHit, false);
  assert.equal(check(damaged, 'assets').status, 'error');
  f.manifest(); write(legacy, '{broken legacy JSON');
  assert.equal((await f.doctor.run(f.options)).ready, true);
});

test('doctor requires the bundled output schema and rejects an escaping manifest link', async t => {
  const f = fixture(t), canonical = path.join(f.extensionRoot, 'out/assets-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(canonical, 'utf8'));
  delete manifest.files['schemas/doctor.schema.json'];
  const missing = await f.doctor.run({ ...f.options, assetsManifest: manifest });
  assert.equal(missing.ready, false); assert.match(check(missing, 'assets').message, /omits required file schemas\/doctor.schema.json/);
  const outside = path.join(f.root, 'outside-manifest.json'); fs.renameSync(canonical, outside); fs.symlinkSync(outside, canonical);
  const linked = await f.doctor.run(f.options);
  assert.equal(linked.ready, false); assert.match(check(linked, 'assets').message, /escapes the project root/);
});

test('published schema accepts actual healthy, failed, full, cached and CLI error JSON', async t => {
  const f = fixture(t), broken = fixture(t, { missing: ['pandoc'] });
  const reports = [
    await f.doctor.run({ ...f.options, cachedOnly: true }),
    await f.doctor.run(f.options),
    await f.doctor.run(f.options),
    await f.doctor.run({ ...f.options, mode: 'full' }),
    await broken.doctor.run(broken.options),
  ];
  const output = [];
  assert.equal(await runDoctorCli(['--json', '--unknown'], f.dependencies, { stdout: value => output.push(value), stderr: () => {} }), 2);
  reports.push(JSON.parse(output[0]));
  for (const report of reports) {
    const json = JSON.parse(JSON.stringify(report));
    assert.equal(validateReport(json), true, JSON.stringify(validateReport.errors));
  }
  const report = JSON.parse(JSON.stringify(reports[1]));
  for (const mutate of [r => { delete r.processCount; }, r => { r.schemaVersion = 2; }, r => { r.checks[0].status = 'success'; },
    r => { r.tools.pandoc.state = 'installed'; }, r => { r.durationMs = -1; }, r => { r.generatedAt = 'yesterday'; }]) {
    const invalid = structuredClone(report); mutate(invalid);
    assert.equal(validateReport(invalid), false, `Schema accepted ${JSON.stringify(invalid)}`);
  }
});

test('packaged asset traversal and outward symlinks are rejected read-only', async t => {
  const f = fixture(t), manifest = JSON.parse(fs.readFileSync(path.join(f.extensionRoot, 'out/assets-manifest.json')));
  manifest.files['../outside'] = { sha256: sha('outside') };
  const traversal = await f.doctor.run({ ...f.options, assetsManifest: manifest });
  assert.equal(check(traversal, 'assets').status, 'error');
  const asset = path.join(f.extensionRoot, 'guide.md'), outside = path.join(f.root, 'outside');
  write(outside, 'user guide'); fs.unlinkSync(asset); fs.symlinkSync(outside, asset);
  const symlink = await f.doctor.run(f.options);
  assert.equal(check(symlink, 'assets').status, 'error'); assert.equal(fs.readFileSync(outside, 'utf8'), 'user guide');
});

test('expected extension version cannot be claimed by a mismatched packaged manifest', async t => {
  const f = fixture(t);
  write(path.join(f.extensionRoot, 'package.json'), JSON.stringify({ version: '0.4.0' })); f.manifest();
  const report = await f.doctor.run({ ...f.options, expectedVersion: '0.5.0' });
  assert.equal(report.ready, false); assert.equal(check(report, 'assets').status, 'error'); assert.match(check(report, 'assets').message, /version 0.4.0 does not match/);
});

test('expected editors need exact version; CI without an editor can still check tools', async t => {
  const f = fixture(t, { editors: [{ id: 'cursor', path: '/fixture/Cursor', version: '2.0', extensionVersion: '0.4.0' }] });
  const required = await f.doctor.run({ ...f.options, expectedEditors: ['cursor', 'code'] });
  assert.equal(required.ready, false); assert.equal(check(required, 'editor:cursor').status, 'error'); assert.equal(check(required, 'editor:code').status, 'error');
  const optional = fixture(t), result = await optional.doctor.run(optional.options);
  assert.equal(result.ready, true); assert.equal(check(result, 'editors').status, 'skipped');
});

test('executable stats, manifest bytes, requirements and TeX database changes invalidate caches', async t => {
  const f = fixture(t), options = { ...f.options, mode: 'full' };
  let previous = await f.doctor.run(options);
  for (const mutate of [
    () => fs.appendFileSync(f.binaries.pandoc, 'new version'),
    () => { fs.appendFileSync(path.join(f.extensionRoot, 'requirements-latex.txt'), '\n# changed requirements hash\n'); f.manifest(); },
    () => fs.appendFileSync(path.join(f.texRoot, 'texmf-dist/ls-R'), 'updated index\n'),
    () => { fs.appendFileSync(path.join(f.extensionRoot, 'guide.md'), 'updated asset'); f.manifest(); },
  ]) {
    mutate(); const next = await f.doctor.run(options);
    assert.equal(next.cacheHit, false); assert.notEqual(next.fingerprint, previous.fingerprint); previous = next;
  }
  f.doctor.invalidate();
  assert.equal((await f.doctor.run(options)).cacheHit, false);
});

test('doctor inspects nested workspace scaffold edits without writing or stale cache', async t => {
  const f = fixture(t), workspaceRoot = path.join(f.root, 'workspace'); fs.mkdirSync(workspaceRoot);
  const migration = applyMigration(planMigration(workspaceRoot, f.extensionRoot)); assert.equal(migration.status, 'applied');
  const result = await f.doctor.run({ ...f.options, workspaceRoot }); assert.equal(check(result, 'workspace').status, 'ok');
  const guide = path.join(workspaceRoot, '.inkwell/guide.md'); fs.appendFileSync(guide, '\nuser edit');
  const before = fs.readFileSync(guide), after = await f.doctor.run({ ...f.options, workspaceRoot });
  assert.equal(after.cacheHit, false); assert.deepEqual(fs.readFileSync(guide), before);
});

test('normal root-owned MacTeX is supported and TinyTeX permission damage is classified without repair', () => {
  const mac = classifyTexOwnership({ root: '/usr/local/texlive/2026', ownerUid: 0, currentUid: 501, writable: false, platform: 'darwin' });
  assert.equal(mac.distribution, 'mactex'); assert.equal(mac.privilege, 'system-admin');
  const tiny = classifyTexOwnership({ root: '/Users/example/Library/TinyTeX', ownerUid: 501, currentUid: 501, writable: true, platform: 'darwin' });
  assert.equal(tiny.privilege, 'user');
  assert.equal(classifyTexOwnership({ ...tiny, ownerUid: 0 }).privilege, 'repair-required');
});

test('headless JSON and text use the same report and failing health exits nonzero', async t => {
  const f = fixture(t), output = [], errors = [], io = { stdout: text => output.push(text), stderr: text => errors.push(text) };
  const args = ['--extension-root', f.extensionRoot, '--light', '--json'];
  assert.equal(await runDoctorCli(args, f.dependencies, io), 0);
  const report = JSON.parse(output.pop()); assert.equal(report.schemaVersion, 1); assert.equal(report.ready, true); assert.match(formatDoctorText(report), /light doctor: ready/);
  assert.equal(await runDoctorCli([...args, '--editor', 'cursor'], f.dependencies, io), 1);
  assert.equal(JSON.parse(output.pop()).ready, false);
  assert.equal(await runDoctorCli(['--unknown'], f.dependencies, io), 2); assert.match(errors.pop(), /Unknown argument/);
});
