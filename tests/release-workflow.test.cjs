const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const repo = path.resolve(__dirname, '..');
const api = import('../scripts/release-contract.mjs');
const packageJson = { name: 'inkwell', publisher: 'measure-one', version: '0.5.0' };

test('release preflight rejects a missing tap token and any tag/version mismatch', async () => {
  const { validateReleasePrerequisites } = await api;
  assert.throws(() => validateReleasePrerequisites({ packageJson, tag: 'v0.5.0', tapToken: '' }), /HOMEBREW_TAP_TOKEN/);
  for (const tag of ['0.5.0', 'v0.4.0', 'v0.5.0\nunsafe', 'refs/tags/v0.5.0']) {
    assert.throws(() => validateReleasePrerequisites({ packageJson, tag, tapToken: 'secret-do-not-print' }), /tag/);
  }
  assert.deepEqual(validateReleasePrerequisites({ packageJson, tag: 'v0.5.0', tapToken: 'secret-do-not-print' }), { version: '0.5.0', tag: 'v0.5.0', filename: 'inkwell-0.5.0.vsix' });
});

test('failed release CLI preflight emits no release outputs or secret values', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-release-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson));
  const output = path.join(root, 'github-output');
  const missing = spawnSync(process.execPath, [path.join(repo, 'scripts/release-contract.mjs'), 'preflight'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, TAP_TOKEN: '', RELEASE_TAG: 'v0.5.0', GITHUB_OUTPUT: output },
  });
  assert.notEqual(missing.status, 0); assert.equal(fs.existsSync(output), false);
  const mismatch = spawnSync(process.execPath, [path.join(repo, 'scripts/release-contract.mjs'), 'preflight'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, TAP_TOKEN: 'do-not-print-this-secret', RELEASE_TAG: 'v0.4.0', GITHUB_OUTPUT: output },
  });
  assert.notEqual(mismatch.status, 0); assert.equal(fs.existsSync(output), false);
  assert.doesNotMatch(mismatch.stdout + mismatch.stderr, /do-not-print-this-secret/);
});

test('read-only release preflight works before build dependencies are installed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-preflight-without-dependencies-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of ['release-contract.mjs', 'verify-vsix.mjs', 'build-asset-manifest.mjs', 'build-preview-assets.mjs']) {
    fs.copyFileSync(path.join(repo, 'scripts', name), path.join(root, 'scripts', name));
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'inkwell', publisher: 'measure-one', version: '0.5.0' }));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/release-contract.mjs'), 'preflight'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, TAP_TOKEN: 'fixture', RELEASE_TAG: 'v0.5.0', GITHUB_OUTPUT: undefined },
  });
  assert.equal(result.status, 0, result.stderr);
});

test('release checksums are derived from the validated actual file and match the bootstrap format', async t => {
  const { writeReleaseChecksums } = await api;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-release-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'inkwell-0.5.0.vsix'); fs.writeFileSync(file, 'actual artifact bytes');
  const calls = [];
  const result = writeReleaseChecksums(file, 'v0.5.0', (candidate, options) => { calls.push([candidate, options]); return { version: '0.5.0' }; });
  assert.deepEqual(calls, [[file, { tag: 'v0.5.0' }]]);
  const expected = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8'), `${expected}  inkwell-0.5.0.vsix\n`);
  assert.equal(result.sha256, expected);
  fs.unlinkSync(path.join(root, 'SHA256SUMS'));
  assert.throws(() => writeReleaseChecksums(file, 'v0.5.0'), /ZIP|archive/i);
  assert.equal(fs.existsSync(path.join(root, 'SHA256SUMS')), false);
});

test('tap updates change exactly one version and checksum while preserving other cask content', async () => {
  const { updateTapCask } = await api;
  const original = 'cask "inkwell" do\r\n  version "0.4.0"\r\n  sha256 "' + 'a'.repeat(64) + '"\r\n  name "Inkwell"\r\nend\r\n';
  const changed = updateTapCask(original, '0.5.0', 'b'.repeat(64));
  assert.equal(changed, original.replace('version "0.4.0"', 'version "0.5.0"').replace('a'.repeat(64), 'b'.repeat(64)));
  assert.throws(() => updateTapCask(original + '\nversion "second"', '0.5.0', 'b'.repeat(64)), /exactly one/);
  assert.throws(() => updateTapCask(original, 'bad\nversion', 'b'.repeat(64)), /version/);
});

test('promotion changes only audited RC metadata and rejects another candidate URL', async () => {
  const { promoteTapCandidate } = await api;
  const commit = 'a'.repeat(40), digest = 'b'.repeat(64);
  const source = `cask "inkwell" do\n  version "0.5.0"\n  sha256 "${'c'.repeat(64)}"\n  url "https://github.com/goldberg-consulting/measured.one.inkwell-extension/releases/download/inkwell-rc-${commit}/inkwell-0.5.0.vsix"\n  depends_on cask: "mactex"\nend\n`;
  const promoted = promoteTapCandidate(source, '0.5.0', digest, commit);
  assert.match(promoted, /releases\/download\/v#\{version\}\/inkwell-#\{version\}\.vsix/);
  assert.match(promoted, /depends_on cask: "mactex"/);
  assert.equal(promoteTapCandidate(promoted, '0.5.0', digest, commit), promoted);
  const singleQuoted = source.replace(/url "([^"\n]+)"/, "url '$1'");
  assert.match(promoteTapCandidate(singleQuoted, '0.5.0', digest, commit), /url "https:[^\n]+#\{version\}/);
  const versioned = source.replace('/inkwell-0.5.0.vsix', '/inkwell-#{version}.vsix');
  assert.equal(promoteTapCandidate(versioned, '0.5.0', digest, commit), promoted, 'Homebrew version interpolation retains the exact audited URL');
  assert.throws(() => promoteTapCandidate(versioned.replace(/url "([^"\n]+)"/, "url '$1'"), '0.5.0', digest, commit), /audited tap URL/);
  assert.throws(() => promoteTapCandidate(versioned.replace('version "0.5.0"', 'version "0.4.0"'), '0.5.0', digest, commit), /audited tap URL/);
  assert.throws(() => promoteTapCandidate(versioned.replace('#{version}', '#{version.major}'), '0.5.0', digest, commit), /audited tap URL/);
  assert.throws(() => promoteTapCandidate(source, '0.5.0', digest, 'd'.repeat(40)), /audited tap URL/);
});

test('tap release retries reject downgrades using full SemVer precedence', async () => {
  const { updateTapCask } = await api;
  const cask = version => `cask "inkwell" do\n  version "${version}"\n  sha256 "${'a'.repeat(64)}"\nend\n`;
  const ordered = ['0.5.0-alpha', '0.5.0-alpha.1', '0.5.0-alpha.beta', '0.5.0-beta', '0.5.0-beta.2', '0.5.0-beta.11', '0.5.0-rc.1', '0.5.0', '0.5.1', '0.10.0', '1.0.0'];
  for (let i = 1; i < ordered.length; i++) {
    assert.throws(() => updateTapCask(cask(ordered[i]), ordered[i - 1], 'b'.repeat(64)), /Refusing to downgrade/, `${ordered[i]} must not become ${ordered[i - 1]}`);
    assert.match(updateTapCask(cask(ordered[i - 1]), ordered[i], 'b'.repeat(64)), new RegExp(`version "${ordered[i].replaceAll('.', '\\.')}"`));
  }
  for (const [older, newer] of [
    ['0.5.0-9', '0.5.0-A'], ['0.5.0-A', '0.5.0-a'],
    ['0.5.0-9007199254740992', '0.5.0-9007199254740993'],
    ['9007199254740992.0.0', '9007199254740993.0.0'],
  ]) assert.throws(() => updateTapCask(cask(newer), older, 'b'.repeat(64)), /Refusing to downgrade/);
  for (const [previous, next] of [['0.5.0', '0.5.0'], ['0.5.0-rc.1', '0.5.0-rc.1']]) {
    assert.doesNotThrow(() => updateTapCask(cask(previous), next, 'b'.repeat(64)), 'equal SemVer precedence remains resumable');
  }
  assert.throws(() => updateTapCask(cask('0.5.0'), '0.5.0+build.1', 'b'.repeat(64)), /release version is invalid/, 'preserve the existing artifact version contract');
  assert.throws(() => updateTapCask(cask('latest'), '0.5.0', 'b'.repeat(64)), /existing tap version.*invalid/i);
});

test('a stale release CLI retry fails before changing the cask or creating a temporary replacement', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-tap-downgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cask = path.join(root, 'inkwell.rb'), sums = path.join(root, 'SHA256SUMS');
  const original = `cask "inkwell" do\r\n  version "0.5.1"\r\n  sha256 "${'a'.repeat(64)}"\r\nend\r\n`;
  fs.writeFileSync(cask, original); fs.writeFileSync(sums, `${'b'.repeat(64)}  inkwell-0.5.0.vsix\n`);
  const result = spawnSync(process.execPath, [path.join(repo, 'scripts/release-contract.mjs'), 'tap', cask, '0.5.0', sums], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Refusing to downgrade/);
  assert.equal(fs.readFileSync(cask, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(root).sort(), ['SHA256SUMS', 'inkwell.rb']);
});

test('resuming a public release validates original bytes without rewriting either artifact', async t => {
  const { verifyPublishedArtifact } = await api;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-published-artifact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'inkwell-0.5.0.vsix'), checksums = path.join(root, 'SHA256SUMS');
  const bytes = Buffer.from('original published bytes');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(file, bytes); fs.writeFileSync(checksums, `${sha}  inkwell-0.5.0.vsix\n`);
  const verify = (candidate, options) => { assert.equal(candidate, file); assert.equal(options.tag, 'v0.5.0'); return { version: '0.5.0' }; };
  assert.equal(verifyPublishedArtifact(file, checksums, 'v0.5.0', verify).sha256, sha);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.readFileSync(checksums, 'utf8'), `${sha}  inkwell-0.5.0.vsix\n`);
  fs.writeFileSync(file, 'different build');
  assert.throws(() => verifyPublishedArtifact(file, checksums, 'v0.5.0', verify), /does not match.*immutable/);
  fs.writeFileSync(file, bytes); fs.appendFileSync(checksums, `${sha}  inkwell-0.5.0.vsix\n`);
  assert.throws(() => verifyPublishedArtifact(file, checksums, 'v0.5.0', verify), /does not match.*immutable/);
  fs.writeFileSync(checksums, `${sha}  inkwell-0.5.0.vsix\n`);
  assert.throws(() => verifyPublishedArtifact(file, checksums, 'v0.5.0'), /ZIP|archive/i);
});

test('pending Homebrew notes are visible, idempotent, and removed only on completion', async () => {
  const { releaseNotes } = await api;
  const original = 'Existing release notes with a user-authored example.\n';
  const pending = releaseNotes(original, 'v0.5.0', true);
  assert.match(pending, /Homebrew publication pending/);
  assert.match(pending, /rerun the failed Release workflow for v0\.5\.0/);
  assert.match(pending, /without rebuilding or replacing/);
  assert.equal(releaseNotes(pending, 'v0.5.0', true), pending);
  assert.equal(releaseNotes(pending, 'v0.5.0', false), original);
  assert.equal(releaseNotes(original, 'v0.5.0', false), original);
});

test('an old tap or absent lifecycle tests block release before any tap execution', async t => {
  const { validateTapContract, verifyTapLifecycle } = await api;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-tap-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'Casks'));
  const cask = path.join(root, 'Casks/inkwell.rb');
  fs.writeFileSync(cask, 'postflight do\nend\nuninstall_postflight do\nend\n');
  assert.throws(() => validateTapContract(root), /deprecated lifecycle/);
  fs.writeFileSync(cask, 'installer script: { executable: "install.sh" }\nuninstall script: { executable: "install.sh" }\n');
  assert.throws(() => validateTapContract(root), /shared out\/install-cli/);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/install.sh'), 'node "$artifact/out/install-cli.js" --uninstall');
  assert.throws(() => validateTapContract(root), /missing mocked lifecycle tests/);
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests/lifecycle.test.cjs'), "require('node:test')('mock lifecycle',()=>{});");
  const calls = [];
  verifyTapLifecycle(root, (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; });
  assert.equal(calls[0].command, 'ruby'); assert.deepEqual(calls[0].args, ['-c', cask]);
  assert.equal(calls[1].command, process.execPath); assert.equal(calls[1].args[0], '--test');
  assert.equal(calls[1].options.env.TAP_TOKEN, undefined);
  assert.throws(() => verifyTapLifecycle(root, () => ({ status: 1, stderr: 'mock lifecycle failed' })), /mock lifecycle failed/);
});

test('release workflow validates credentials and actual content before publishing and never puts secrets in URLs', () => {
  const source = fs.readFileSync(path.join(repo, '.github/workflows/release.yml'), 'utf8');
  const workflow = YAML.parse(source), steps = workflow.jobs['build-and-publish'].steps;
  assert.equal(workflow.on.release, undefined);
  assert.equal(workflow.on.push, undefined, 'a tag push must not bypass explicit candidate/evidence selection');
  assert.equal(workflow.on.workflow_dispatch.inputs.candidate_run_id.required, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.evidence_run_id.required, true);
  assert.match(steps[0].with.ref, /^refs\/tags\//);
  const preflight = steps.findIndex(step => step.run?.includes('release-contract.mjs preflight'));
  const validated = steps.findIndex(step => step.run?.includes('release-contract.mjs checksums'));
  const published = steps.findIndex(step => /gh release (?:create|upload|edit)/.test(step.run || ''));
  assert.ok(preflight >= 0 && validated > preflight && published > validated);
  assert.ok(steps[preflight].env.TAP_TOKEN.includes('secrets.HOMEBREW_TAP_TOKEN'));
  assert.ok(steps.some(step => step.run?.includes('gh release upload') && step.run.includes('SHA256SUMS')));
  const evidence = steps.findIndex(step => step.run?.includes('release-evidence.mjs validate') && step.run.includes('--stage publish'));
  assert.ok(evidence > preflight && evidence < published);
  assert.match(steps.find(step => step.name === 'Authenticate candidate and evidence producer runs').run, /verify-run/);
  const tapCheckout = steps.find(step => step.with?.repository === 'goldberg-consulting/homebrew-inkwell');
  assert.equal(tapCheckout.with.ref, '${{ steps.evidence.outputs.tapCommit }}');
  const tapPrepared = steps.find(step => step.run?.includes('git -C tap commit'));
  assert.ok(tapPrepared.run.indexOf('release-contract.mjs verify-tap') < tapPrepared.run.indexOf('git -C tap commit'));
  assert.match(tapPrepared.run, /promote-tap/);
  assert.match(tapPrepared.run, /merge-base --is-ancestor/);
  assert.equal(steps.some(step => step.run?.includes('npm run package')), false, 'publication must never rebuild the tested VSIX');
  const upload = steps.find(step => step.run?.includes('gh release upload'));
  assert.equal(upload.if, "steps.existing.outputs.public != 'true'");
  assert.match(upload.run, /isDraft.*immutable/s);
  assert.doesNotMatch(upload.run, /--clobber/);
  assert.match(upload.run, /cmp.*inkwell-draft-existing/);
  const reused = steps.find(step => step.id === 'existing');
  assert.match(reused.run, /gh release download.*--pattern "\$VSIX".*--pattern SHA256SUMS/);
  assert.match(reused.run, /verify-published/);
  assert.doesNotMatch(reused.run, /gh release upload|--clobber/);
  assert.doesNotMatch(source, /x-access-token:|https:\/\/[^\s]*\$\{?TAP_TOKEN/);
  for (const step of steps) assert.doesNotMatch(step.run || '', /\$\{\{\s*(?:secrets\.|github\.event\.)/);
});

test('the public download precedes the tap push and tap failure leaves visible recovery instructions', () => {
  const steps = YAML.parse(fs.readFileSync(path.join(repo, '.github/workflows/release.yml'), 'utf8')).jobs['build-and-publish'].steps;
  const publish = steps.findIndex(step => step.id === 'public');
  const push = steps.findIndex(step => step.run?.includes('push origin HEAD:main'));
  const complete = steps.findIndex(step => step.run?.includes('release-contract.mjs notes complete'));
  assert.ok(publish >= 0 && push > publish && complete > push);
  assert.match(steps[publish].run, /--draft=false.*Homebrew pending.*--notes-file/);
  assert.match(steps[publish].run, /release-contract.mjs notes pending/);
  assert.equal(steps[push]['continue-on-error'], undefined);
  assert.match(steps[push].run, /set -euo pipefail/);
  assert.doesNotMatch(steps[push].run, /--force|\|\|\s*true/);
  assert.equal(steps[complete].if, undefined, 'completion must retain GitHub Actions success gating');
  assert.ok(steps[complete].run.indexOf('--stage complete') < steps[complete].run.indexOf('release-contract.mjs notes complete'));
  const failure = steps.find(step => step.if === "failure() && steps.public.outcome == 'success'");
  assert.match(failure.run, /GITHUB_STEP_SUMMARY/);
  assert.match(failure.run, /without rebuilding or overwriting/);
  assert.match(failure.run, /same exact tag/);
});

test('demo workflow installs the artifact requirements without swallowing installation failures', () => {
  const source = fs.readFileSync(path.join(repo, '.github/workflows/compile-demos.yml'), 'utf8');
  const steps = YAML.parse(source).jobs['compile-all-demos'].steps;
  const requirements = steps.find(step => step.name === 'Install required LaTeX packages').run;
  assert.match(requirements, /ARTIFACT_ROOT.*requirements-latex\.txt/);
  assert.doesNotMatch(requirements, /\|\|\s*true|texhash|mktexlsr/);
  assert.match(requirements, /tlmgr install "\$\{packages\[@\]\}"/);
  assert.ok(steps.some(step => step.run?.includes('out/doctor-cli.js') && step.run.includes('--full')));
  assert.ok(steps.findIndex(step => step.run?.includes('verify-vsix.mjs')) < steps.findIndex(step => step.name === 'Install required LaTeX packages'));
});

test('demo provisioning covers every required full Doctor CLI tool with a locked local Mermaid installation', () => {
  const doctor = fs.readFileSync(path.join(repo, 'src/doctor.ts'), 'utf8');
  const steps = YAML.parse(fs.readFileSync(path.join(repo, '.github/workflows/compile-demos.yml'), 'utf8')).jobs['compile-all-demos'].steps;
  const doctorIndex = steps.findIndex(step => step.run?.includes('out/doctor-cli.js'));
  const before = steps.slice(0, doctorIndex).map(step => step.run || '').join('\n');
  const core = doctor.match(/const core = new Set\(\[([^\n]+)\]\);/);
  assert.ok(core, 'revisit provisioning coverage when the Doctor tool definition changes');
  const required = new Set([...core[1].matchAll(/"([^"\n]+)"/g)].map(match => match[1]));
  for (const match of doctor.matchAll(/name === "([^"\n]+)"/g)) required.add(match[1]);
  for (const match of steps[doctorIndex].run.matchAll(/--require-tool ([a-z0-9-]+)/g)) required.add(match[1]);
  const provisions = {
    pandoc: /dpkg -i "\$RUNNER_TEMP\/pandoc\.deb"/,
    'pandoc-crossref': /install -m 755 .*\/pandoc-crossref/,
    xelatex: /sh "\$RUNNER_TEMP\/install-tinytex\.sh"/,
    pdflatex: /sh "\$RUNNER_TEMP\/install-tinytex\.sh"/,
    kpsewhich: /sh "\$RUNNER_TEMP\/install-tinytex\.sh"/,
    mmdc: /npm ci --prefix "\$mermaid_dir"/,
    ghostscript: /apt-get install -y .*ghostscript/,
  };
  for (const name of required) {
    assert.ok(provisions[name], `Required Doctor tool ${name} needs a provisioning contract`);
    assert.match(before, provisions[name], `Required Doctor tool ${name} must be installed before full Doctor`);
  }
  const mermaid = steps.find(step => step.name === 'Install and verify isolated Mermaid renderer').run;
  assert.match(mermaid, /cp scripts\/ci-tools\/mermaid\/package\.json scripts\/ci-tools\/mermaid\/package-lock\.json/);
  assert.match(mermaid, /node_modules\/\.bin.*GITHUB_PATH/);
  assert.match(mermaid, /PUPPETEER_CACHE_DIR.*RUNNER_TEMP/);
  assert.match(mermaid, /mmdc" -i .* -o .*smoke\.svg/);
  assert.match(mermaid, /test -s .*smoke\.svg/);
  assert.doesNotMatch(mermaid, /--global|npm (?:install|i) -g|--no-sandbox|SKIP_DOWNLOAD/);
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/ci-tools/mermaid/package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/ci-tools/mermaid/package-lock.json'), 'utf8'));
  assert.equal(manifest.private, true);
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
  for (const [name, pkg] of Object.entries(lock.packages).filter(([name]) => name)) {
    assert.match(pkg.integrity, /^sha512-/i, `${name} must be integrity-locked`);
    if (pkg.engines?.node) assert.ok(require('semver').satisfies('20.20.0', pkg.engines.node), `${name} must support CI Node 20`);
  }
});

test('release and demo workflow command blocks pass shell syntax checks without execution', () => {
  for (const file of ['release.yml', 'compile-demos.yml', 'verify.yml', 'release-candidate.yml', 'release-evidence.yml', 'macos-installation.yml']) {
    const workflow = YAML.parse(fs.readFileSync(path.join(repo, '.github/workflows', file), 'utf8'));
    for (const job of Object.values(workflow.jobs)) for (const step of job.steps || []) {
      if (!step.run) continue;
      const result = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
      assert.equal(result.status, 0, `${file}: ${step.name}: ${result.stderr}`);
    }
  }
});

test('Linux and macOS verify consume one immutable candidate and enforce actual packaged preview and host checks', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(repo, '.github/workflows/verify.yml'), 'utf8'));
  assert.equal(workflow.permissions.actions, 'read', 'reusable demo workflow cannot elevate its caller permissions');
  assert.equal(workflow.jobs.candidate.steps.filter(step => step.run?.includes('npm run package:vsix')).length, 1);
  assert.equal(workflow.jobs.verify.needs, 'candidate');
  assert.deepEqual(workflow.jobs.verify.strategy.matrix.include.map(entry => entry.platform).sort(), ['linux', 'macos']);
  assert.equal(workflow.jobs.verify.env.INKWELL_REQUIRE_BROWSER, 1);
  const macos = workflow.jobs.verify.strategy.matrix.include.find(entry => entry.platform === 'macos');
  assert.equal(macos.editor_binary, '', 'macOS editor archives have no stable top-level application path');
  const commands = workflow.jobs.verify.steps.map(step => step.run || '').join('\n');
  assert.match(commands, /INKWELL_PREVIEW_ASSET_ROOT=.*inkwell-artifact\/extension/);
  assert.match(commands, /cmp candidate\/candidate.json candidate\/rechecked.json/);
  assert.match(commands, /check-extension-host\.cjs --vsix/);
  assert.doesNotMatch(commands, /npm run package:vsix/);
  const activation = workflow.jobs.verify.steps.find(step => step.name === 'Activate the exact packaged extension in disposable editor profiles').run;
  assert.match(activation, /editor_path="\$RUNNER_TEMP\/inkwell-editor\/\$EDITOR_BINARY"/);
  assert.match(activation, /find "\$RUNNER_TEMP\/inkwell-editor" -type f -path '\*\/Contents\/MacOS\/Electron' -print0/);
  assert.match(activation, /while IFS= read -r -d '' candidate;/);
  assert.match(activation, /\[ "\$editor_count" -ne 1 \]/);
  assert.match(activation, /\[ ! -x "\$editor_path" \]/);
  assert.match(activation, /--editor "\$editor_path"/);
  assert.equal(workflow.jobs.demos.with['candidate-artifact'], 'inkwell-candidate');
  const demos = YAML.parse(fs.readFileSync(path.join(repo, '.github/workflows/compile-demos.yml'), 'utf8'));
  const demoCommands = demos.jobs['compile-all-demos'].steps.map(step => step.run || '').join('\n');
  assert.equal([...demoCommands.matchAll(/check-demos\.cjs --vsix=/g)].length, 2);
  assert.match(demoCommands, /--vsix-root="\$ARTIFACT_ROOT" --warmups=1 --repetitions=5/);
  assert.match(demoCommands, /--gate warm-preview/);
  assert.match(demoCommands, /check-benchmark-regression\.mjs/);
});

test('RC and final evidence stages never fabricate absent installation or performance results', () => {
  const rc = fs.readFileSync(path.join(repo, '.github/workflows/release-candidate.yml'), 'utf8');
  assert.ok(rc.indexOf('--stage rc') < rc.indexOf('gh release create'));
  assert.doesNotMatch(rc, /--clobber|npm run package/);
  assert.match(rc, /cmp "candidate\/\$vsix"/);
  for (const file of ['release.yml', 'release-candidate.yml', 'release-evidence.yml']) {
    const steps = YAML.parse(fs.readFileSync(path.join(repo, '.github/workflows', file), 'utf8')).jobs;
    const job = Object.values(steps)[0];
    assert.ok(job.steps.findIndex(step => step.run?.includes('verify-run')) < job.steps.findIndex(step => step.uses === 'actions/download-artifact@v4'), `${file} must authenticate provenance before fetching artifacts`);
  }
  const assembly = YAML.parse(fs.readFileSync(path.join(repo, '.github/workflows/release-evidence.yml'), 'utf8')).jobs.assemble.steps;
  const supplemental = assembly.find(step => step.with?.path === 'supplemental-source');
  assert.equal(supplemental.with.pattern, undefined, 'source workflow artifacts use different names and must be selected by validated gate records');
  assert.match(assembly.find(step => step.run?.includes('release-evidence.mjs select')).run, /--gates performance,pdf-parity,upgrade-from-0.4/);
  const installer = YAML.parse(fs.readFileSync(path.join(repo, '.github/workflows/macos-installation.yml'), 'utf8'));
  assert.ok(installer.on.schedule.length);
  assert.deepEqual(installer.jobs.install.strategy.matrix.profile, ['full-cask', 'existing-tex']);
  const commands = installer.jobs.install.steps.map(step => step.run || '').join('\n');
  assert.match(commands, /CANDIDATE_SHA256/);
  assert.match(commands, /cmp reports\/tex-root-before.txt reports\/tex-root-after.txt/);
  assert.match(commands, /out\/doctor-cli\.js.*--full.*--editor code/);
  assert.match(commands, /out\/smoke-cli\.js/);
  assert.doesNotMatch(commands, /--gate (?:clean-macos-cask|standalone-existing-tex)/, 'headless install is insufficient proof of the still-required no-code UI gate');
});
