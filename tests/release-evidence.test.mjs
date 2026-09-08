import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PUBLICATION_GATES, COMPLETION_GATES, recordEvidence, validateEvidenceBundle, validateGateReport, assertCleanReleaseCheckout, verifyRunProvenance, selectEvidence } from '../scripts/release-evidence.mjs';
import { compareBenchmarks } from '../scripts/check-benchmark-regression.mjs';

const candidate = { schemaVersion: 1, releaseCommit: 'a'.repeat(40), version: '0.5.0', filename: 'inkwell-0.5.0.vsix',
  vsixSha256: 'b'.repeat(64), assetsManifestSha256: 'c'.repeat(64) };
const previewSample = (warmup, callbackMs, timerLagMs) => ({ warmup, maximumCallbackMs: callbackMs, maximumTimerLagMs: timerLagMs,
  publication: { accepted: true, finalEditPresent: true } });
const previewSamples = () => [previewSample(true, 20, 30), previewSample(false, 30, 40), previewSample(false, 31, 41),
  previewSample(false, 32, 42), previewSample(false, 33, 43), previewSample(false, 34, 44)];
const host = { ok: true, machine: { platform: 'linux' }, artifact: { archiveSha256: candidate.vsixSha256 }, activation: { sampleCount: 5, p95Ms: 100, extensionChildProcesses: 0 },
  warmPreview: { ok: true, measuredSamples: 5, warmupSamples: 1, samples: previewSamples(), callbackMaximaMedianMs: 32,
    timerLagMaximaMedianMs: 42, maximumCallbackMs: 34, maximumTimerLagMs: 44, unchangedCompletionChildProcesses: 0 },
  iterations: [{ warmup: false, host: { workflow: { ok: true, pdf: { verified: true } } } }] };
function timing(ms) {
  const corpus = Array.from({ length: 10 }, (_, i) => ({ name: `demo-${i}.md`, sha256: 'a'.repeat(64) }));
  const process = binary => ({ binary, milliseconds: 1, exitCode: 0, signal: null });
  return { schemaVersion: 1, success: true, runId: randomUUID(), repetitions: 5, warmups: 1,
    machine: { platform: 'darwin', arch: 'arm64', cpu: 'fixture', node: 'v25.2.1', osRelease: '25.5.0', memoryBytes: 1024 },
    runtime: { pandoc: 'fixture', xelatex: 'fixture', pdflatex: 'fixture', python: 'fixture' },
    benchmarkIdentity: { harnessSha256: 'a'.repeat(64), correctnessPolicySha256: 'a'.repeat(64) }, corpusHash: 'a'.repeat(64), corpus, preparedCorpus: corpus.map(entry => ({ ...entry })),
    artifact: { archiveSha256: candidate.vsixSha256, verified: true }, demos: Array.from({ length: 6 }, (_, i) => i - 1).flatMap(repetition =>
      corpus.map(({ name }) => ({ name, repetition, measured: repetition >= 0, cacheState: repetition === -1 ? 'cold' : 'warm',
        totalMs: ms, success: true, expectedText: true, unresolved: [], runFailures: [], pages: 4, pdfBytes: 1000, pdfSha256: 'a'.repeat(64),
        texPasses: [process('xelatex')], pandoc: [process('pandoc')], runProcesses: [] }))) };
}
function report(gate, timings) {
  if (gate.startsWith('behavior-')) return '# tests 500\n# pass 500\n# fail 0\n';
  if (gate.startsWith('activation-') || gate === 'run-to-pdf' || gate === 'warm-preview') return { ...host, machine: { platform: gate.endsWith('-macos') ? 'darwin' : 'linux' } };
  if (gate === 'pdf-parity') return { ok: true, artifactSha256: candidate.vsixSha256, normalizedStyleParity: true, rasterGoldenPassed: true,
    pixelChannelThreshold: 10, maximumDifferentPixelFraction: 0.001, toolchainFingerprint: 'd'.repeat(64), templates: Array.from({ length: 10 }, (_, i) => `template-${i}`) };
  if (gate.startsWith('offline-')) return { platform: gate.endsWith('-macos') ? 'darwin' : 'linux', fixturePages: 100, externalNetworkBlocked: true, externalRequests: 0, actualPdfRequests: 1,
    cspViolations: [], browserErrors: [], printEnhancementsVerified: true, documentScrollIsolationVerified: true };
  if (gate === 'package') return { ok: true, archiveSha256: candidate.vsixSha256 };
  if (gate === 'performance') return compareBenchmarks(...(timings || [timing(100), timing(65), timing(65)]));
  if (gate === 'demos') return { success: true, artifact: { archiveSha256: candidate.vsixSha256 }, demos: Array.from({ length: 10 }, (_, index) =>
    ({ name: `demo-${index}`, success: true, expectedText: true, unresolved: [], runFailures: [] })) };
  return { ok: true, vsixSha256: candidate.vsixSha256, releaseCommit: candidate.releaseCommit, doctorReady: true, pdfVerified: true,
    cleanProfile: true, noCodeJourneyVerified: true, texRootBefore: '/fixture/TinyTeX', texRootAfter: '/fixture/TinyTeX',
    canonicalCommand: 'brew install --cask goldberg-consulting/inkwell/inkwell', previousVersion: '0.4.0',
    publishedUrl: `https://github.com/goldberg-consulting/measured.one.inkwell-extension/releases/download/v${candidate.version}/${candidate.filename}`,
    preserved: Object.fromEntries(['projects', 'documents', 'bibliographies', 'scripts', 'history', 'pdfs'].map(key => [key, true])),
    extensionRemoved: true, caskOwnedFilesRemoved: true, audit: true, style: true, lifecycle: true, tapCommit: 'd'.repeat(40) };
}
const bytes = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-release-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const add = (gate, identity = candidate) => {
    const input = path.join(root, `${gate}.report`), output = path.join(root, `${gate}.evidence.json`);
    const timings = gate === 'performance' ? [timing(100), timing(65), timing(65)] : undefined;
    fs.writeFileSync(input, bytes(report(gate, timings)));
    const inputs = [input];
    if (gate === 'performance') for (const [name, value] of [['current', timings[1]], ['confirmation', timings[2]], ['baseline', timings[0]]]) {
      const file = path.join(root, `${name}.json`); fs.writeFileSync(file, bytes(value)); inputs.push(file);
    }
    recordEvidence(identity, gate, inputs, output, gate.endsWith('-linux') ? 'linux' : 'darwin'); return output;
  };
  return { root, add };
}

test('publication cannot pass without every required gate; completion additionally requires public installation and preservation', t => {
  const f = fixture(t);
  assert.throws(() => validateEvidenceBundle(candidate, f.root), /missing evidence/);
  for (const gate of PUBLICATION_GATES) f.add(gate);
  assert.equal(validateEvidenceBundle(candidate, f.root).ok, true);
  assert.throws(() => validateEvidenceBundle(candidate, f.root, 'complete'), /public-install, reinstall, uninstall-preservation/);
  for (const gate of COMPLETION_GATES.filter(gate => !PUBLICATION_GATES.includes(gate))) f.add(gate);
  assert.equal(validateEvidenceBundle(candidate, f.root, 'complete').ok, true);
});

test('changed reports, mismatched commits and duplicate records fail closed', t => {
  const f = fixture(t), output = f.add('package');
  const original = JSON.parse(fs.readFileSync(output, 'utf8'));
  fs.appendFileSync(path.join(f.root, original.attachments[0].path), 'changed');
  assert.throws(() => validateEvidenceBundle(candidate, f.root), /report hash mismatch/);
  fs.writeFileSync(path.join(f.root, original.attachments[0].path), bytes(report('package')));
  fs.writeFileSync(output, JSON.stringify({ ...original, candidate: { ...candidate, releaseCommit: 'd'.repeat(40) } }));
  assert.throws(() => validateEvidenceBundle(candidate, f.root), /identity mismatch: releaseCommit/);
  fs.writeFileSync(output, JSON.stringify(original)); fs.copyFileSync(output, path.join(f.root, 'duplicate.evidence.json'));
  assert.throws(() => validateEvidenceBundle(candidate, f.root), /Duplicate evidence/);
});

test('symlink and traversal attachment paths are rejected', t => {
  const f = fixture(t), output = f.add('package');
  const record = JSON.parse(fs.readFileSync(output, 'utf8'));
  record.attachments[0].path = '../outside'; fs.writeFileSync(output, JSON.stringify(record));
  assert.throws(() => validateEvidenceBundle(candidate, f.root), /Unsafe evidence attachment/);
  fs.symlinkSync(output, path.join(f.root, 'linked.evidence.json'));
  assert.throws(() => validateEvidenceBundle(candidate, f.root), /symbolic links|Unsafe evidence attachment/);
});

test('records are immutable and empty or merely claimed success reports cannot create passing evidence', t => {
  const f = fixture(t), output = f.add('package');
  assert.throws(() => recordEvidence(candidate, 'package', [path.join(f.root, 'package.report')], output), /immutable/);
  for (const gate of COMPLETION_GATES) assert.throws(() => validateGateReport(gate, bytes({ ok: true }), candidate));
  assert.throws(() => validateGateReport('behavior-linux', bytes('# tests 0\n# fail 0\n'), candidate), /nonempty TAP/);
  assert.throws(() => validateGateReport('behavior-linux', bytes('# tests 2\nnot ok failed\n# fail 0\n'), candidate), /successful/);
});

test('activation budgets, subprocesses, missing PDF and partial demo corpus cannot pass', () => {
  for (const mutate of [r => { r.activation.p95Ms = 200; }, r => { r.activation.sampleCount = 4; }, r => { r.activation.extensionChildProcesses = 1; },
    r => { r.artifact.archiveSha256 = 'd'.repeat(64); }]) {
    const value = structuredClone(host); mutate(value);
    assert.throws(() => validateGateReport('activation-linux', bytes(value), candidate));
  }
  const missingPdf = structuredClone(host); delete missingPdf.iterations[0].host.workflow.pdf;
  assert.throws(() => validateGateReport('run-to-pdf', bytes(missingPdf), candidate), /PDF/);
  const demos = report('demos'); demos.demos.pop();
  assert.throws(() => validateGateReport('demos', bytes(demos), candidate), /ten demos/);
});

test('warm preview evidence retains coherent finite observations without inventing a shared-host timing threshold', () => {
  const representative = structuredClone(host);
  representative.warmPreview.samples = [previewSample(true, 20, 30), previewSample(false, 80, 70), previewSample(false, 90, 80),
    previewSample(false, 130, 120), previewSample(false, 90, 80), previewSample(false, 80, 70)];
  Object.assign(representative.warmPreview, { callbackMaximaMedianMs: 90, timerLagMaximaMedianMs: 80, maximumCallbackMs: 130, maximumTimerLagMs: 120 });
  assert.doesNotThrow(() => validateGateReport('warm-preview', bytes(representative), candidate));
  for (const mutate of [
    report => { report.warmPreview.callbackMaximaMedianMs = null; },
    report => { report.warmPreview.timerLagMaximaMedianMs = null; },
    report => { report.warmPreview.maximumCallbackMs = null; },
    report => { report.warmPreview.maximumTimerLagMs = null; },
    report => { report.warmPreview.samples = []; },
    report => { report.warmPreview.samples[1].maximumCallbackMs = null; },
    report => { report.warmPreview.callbackMaximaMedianMs = 91; },
    report => { report.warmPreview.timerLagMaximaMedianMs = 81; },
    report => { report.warmPreview.maximumCallbackMs = 999; },
    report => { report.warmPreview.maximumTimerLagMs = 999; },
    report => { report.warmPreview.samples[1].publication.accepted = false; },
    report => { report.warmPreview.unchangedCompletionChildProcesses = 1; },
  ]) {
    const value = structuredClone(representative); mutate(value);
    assert.throws(() => validateGateReport('warm-preview', bytes(value), candidate), /complete current-publication samples|coherent finite timing observations|zero-process/);
  }
});

test('headless smoke cannot masquerade as a clean no-code installation and a single benchmark cannot pass', () => {
  const value = report('clean-macos-cask'); delete value.noCodeJourneyVerified;
  assert.throws(() => validateGateReport('clean-macos-cask', bytes(value), candidate), /no-code journey/);
  const performance = report('performance'); performance.sustainedComparison = false;
  assert.throws(() => validateGateReport('performance', bytes(performance), candidate), /sustained/);
});

test('release identity refuses dirty tracked files and untracked runtime inputs', t => {
  const f = fixture(t);
  const git = args => { const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git(['init', '--quiet']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  fs.mkdirSync(path.join(f.root, 'src')); fs.writeFileSync(path.join(f.root, 'src/index.ts'), 'original');
  git(['add', 'src/index.ts']); git(['commit', '--quiet', '-m', 'fixture']);
  assert.doesNotThrow(() => assertCleanReleaseCheckout(f.root));
  fs.writeFileSync(path.join(f.root, 'src/index.ts'), 'modified');
  assert.throws(() => assertCleanReleaseCheckout(f.root), /clean tracked checkout/);
  fs.writeFileSync(path.join(f.root, 'src/index.ts'), 'original'); fs.writeFileSync(path.join(f.root, 'src/untracked.ts'), 'new source');
  assert.throws(() => assertCleanReleaseCheckout(f.root), /untracked build or test inputs/);
});

test('GitHub run provenance rejects fork, PR, failed, wrong-workflow and wrong-commit artifact producers', () => {
  const expected = { repository: 'owner/repository', commit: candidate.releaseCommit, workflows: ['.github/workflows/verify.yml'] };
  const run = { id: 123, repository: { full_name: expected.repository }, head_repository: { full_name: expected.repository },
    head_sha: expected.commit, path: expected.workflows[0], event: 'push', status: 'completed', conclusion: 'success' };
  assert.equal(verifyRunProvenance(run, expected).ok, true);
  for (const mutate of [r => { r.head_repository.full_name = 'fork/repository'; }, r => { r.event = 'pull_request'; },
    r => { r.head_sha = 'd'.repeat(40); }, r => { r.path = '.github/workflows/untrusted.yml'; }, r => { r.conclusion = 'failure'; },
    r => { r.status = 'in_progress'; }]) {
    const invalid = structuredClone(run); mutate(invalid); assert.throws(() => verifyRunProvenance(invalid, expected));
  }
});

test('one operating system cannot satisfy both platform gates', t => {
  assert.throws(() => validateGateReport('activation-macos', bytes(host), candidate), /wrong operating system/);
  assert.throws(() => validateGateReport('offline-macos', bytes(report('offline-linux')), candidate), /offline preview contract/);
  const f = fixture(t), output = f.add('behavior-linux');
  const record = JSON.parse(fs.readFileSync(output, 'utf8')); record.producer.platform = 'darwin';
  fs.writeFileSync(output, JSON.stringify(record));
  assert.throws(() => validateEvidenceBundle(candidate, f.root), /wrong operating system/);
});

test('performance aggregation recomputes retained measurements instead of trusting a passing summary', t => {
  const f = fixture(t), files = [];
  const timings = [timing(100), timing(65), timing(65)], summary = report('performance', timings);
  timings.slice(1).forEach(report => report.demos.forEach(demo => { demo.totalMs = 120; }));
  for (const [name, value] of [['summary', summary], ['current', timings[1]], ['confirmation', timings[2]], ['baseline', timings[0]]]) {
    const file = path.join(f.root, `${name}.json`); fs.writeFileSync(file, bytes(value)); files.push(file);
  }
  assert.throws(() => recordEvidence(candidate, 'performance', files, path.join(f.root, 'performance.evidence.json')), /Retained performance measurements fail/);
});

test('supplemental selection accepts differing artifact layouts without copying duplicate base gates', t => {
  const f = fixture(t); f.add('package'); f.add('performance');
  const selected = path.join(f.root, 'selected');
  assert.deepEqual(selectEvidence(candidate, f.root, selected, ['performance']).selected, ['performance']);
  assert.equal(fs.existsSync(path.join(selected, 'package')), false);
  const copied = JSON.parse(fs.readFileSync(path.join(selected, 'performance/performance.evidence.json'), 'utf8'));
  assert.equal(copied.attachments.length, 4);
  for (const attachment of copied.attachments) assert.ok(fs.existsSync(path.join(selected, 'performance', attachment.path)));
});
