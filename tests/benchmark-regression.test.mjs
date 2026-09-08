import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compareBenchmarks } from '../scripts/check-benchmark-regression.mjs';

const hash = 'a'.repeat(64);
function report(ms, { repetitions = 5, warmups = 1 } = {}) {
  const corpus = Array.from({ length: 10 }, (_, index) => ({ name: `demo-${index}.md`, sha256: hash }));
  const process = binary => ({ binary, milliseconds: 1, exitCode: 0, signal: null });
  return { schemaVersion: 1, success: true, runId: randomUUID(), repetitions, warmups,
    machine: { platform: 'darwin', arch: 'arm64', cpu: 'fixture', node: 'v25.2.1', osRelease: '25.5.0', memoryBytes: 1024 },
    runtime: { pandoc: 'fixture', xelatex: 'fixture', pdflatex: 'fixture', python: 'fixture' },
    benchmarkIdentity: { harnessSha256: hash, correctnessPolicySha256: hash }, corpusHash: hash, corpus, preparedCorpus: corpus.map(entry => ({ ...entry })),
    artifact: { archiveSha256: hash, verified: true },
    demos: Array.from({ length: repetitions + warmups }, (_, index) => index - warmups).flatMap(repetition => corpus.map(({ name }) => ({
      name, repetition, measured: repetition >= 0, cacheState: repetition === -warmups ? 'cold' : 'warm', totalMs: ms,
      success: true, expectedText: true, unresolved: [], runFailures: [], pages: 4, pdfBytes: 1000, pdfSha256: hash,
      texPasses: [process('xelatex')], pandoc: [process('pandoc')], runProcesses: [process('python3')],
    }))) };
}
const inputs = () => [report(100), report(65), report(68)];
function rejected(reports, reason) {
  const result = compareBenchmarks(...reports);
  assert.equal(result.ok, false);
  assert.match(result.failures.join(' '), reason);
  assert.equal(result.status, 'invalid-evidence');
  assert.equal(result.sustainedComparison, false);
  assert.equal(result.baselineMedianMs, null);
  assert.deepEqual(result.improvements, []);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'invalid evidence has no undefined, NaN or infinite summary values');
}

test('two complete comparable warm runs pass and retain evidence identities', () => {
  const reports = inputs(), result = compareBenchmarks(...reports);
  assert.equal(result.ok, true); assert.equal(result.status, 'passed');
  assert.equal(result.baselineMedianMs, 1000); assert.equal(result.candidateMedianMs, 650); assert.equal(result.confirmationMedianMs, 680);
  assert.deepEqual(result.runIds, reports.map(item => item.runId));
  assert.deepEqual(result.benchmarkIdentity, reports[0].benchmarkIdentity);
});

test('warmups are excluded and the median uses whole-corpus sums', () => {
  const reports = inputs(), baseline = reports[0];
  baseline.demos.filter(demo => demo.measured).forEach(demo => { demo.totalMs = 1; });
  for (let repetition = 0; repetition < 5; repetition++) baseline.demos.find(demo => demo.repetition === repetition && demo.name === `demo-${repetition}.md`).totalMs = 991;
  baseline.demos.filter(demo => !demo.measured).forEach(demo => { demo.totalMs = 1e9; });
  const result = compareBenchmarks(...reports);
  assert.equal(result.baselineMedianMs, 1000, 'sum of individual medians would incorrectly be 10');
  assert.equal(result.demos[0].baselineMedianMs, 1);
});

test('one noisy demo needs independent confirmation and exact ten percent is allowed', () => {
  const baseline = report(100), candidate = report(50), confirmation = report(50);
  const setDemo = (report, ms) => report.demos.filter(demo => demo.name === 'demo-0.md').forEach(demo => { demo.totalMs = ms; });
  setDemo(candidate, 120); assert.equal(compareBenchmarks(baseline, candidate, confirmation).ok, true);
  setDemo(confirmation, 120);
  assert.match(compareBenchmarks(baseline, candidate, confirmation).failures.join(' '), /demo-0.md regresses/);
  setDemo(candidate, 110); setDemo(confirmation, 110);
  assert.equal(compareBenchmarks(baseline, candidate, confirmation).ok, true);
});

test('both runs must meet the thirty percent corpus improvement threshold', () => {
  assert.equal(compareBenchmarks(report(100), report(70), report(70)).ok, true);
  for (const [candidate, confirmation] of [[71, 65], [65, 71], [100, 100]]) {
    const result = compareBenchmarks(report(100), report(candidate), report(confirmation));
    assert.equal(result.ok, false); assert.equal(result.status, 'threshold-failed');
    assert.match(result.failures.join(' '), /at least 30%/);
    assert.equal(result.sustainedComparison, true, 'valid but slow measurements remain reviewable');
  }
});

test('multiple warmups and even measured counts are supported', () => {
  assert.equal(compareBenchmarks(report(100, { repetitions: 6, warmups: 2 }), report(65, { repetitions: 6, warmups: 2 }), report(65, { repetitions: 6, warmups: 2 })).ok, true);
});

test('cached code runs do not require invented subprocesses', () => {
  const reports = inputs();
  reports.forEach(report => report.demos.filter(demo => demo.measured).forEach(demo => { demo.runProcesses = []; }));
  assert.equal(compareBenchmarks(...reports).ok, true);
});

for (const collection of ['texPasses', 'pandoc']) {
  for (const [label, mutate] of [
    ['missing processes', row => { delete row[collection]; }],
    ['empty processes', row => { row[collection] = []; }],
    ['mislabeled process', row => { row[collection][0].binary = 'python3'; }],
  ]) test(`${collection} ${label} cannot stand in for an actual Markdown compile`, () => {
    const reports = inputs(); mutate(reports[0].demos[0]); rejected(reports, /failed processes/);
  });
}

for (const collection of ['texPasses', 'pandoc', 'runProcesses']) {
  for (const [label, mutate] of [
    ['nonzero exit', process => { process.exitCode = 1; }],
    ['missing exit', process => { delete process.exitCode; }],
    ['signal', process => { process.signal = 'SIGTERM'; }],
    ['missing signal observation', process => { delete process.signal; }],
    ['invalid duration', process => { process.milliseconds = NaN; }],
  ]) test(`${collection} ${label} fails despite successful partial-PDF flags`, () => {
    const reports = inputs(), row = reports[0].demos[0]; row.pages = 1; mutate(row[collection][0]); rejected(reports, /failed processes/);
  });
}

for (const [label, mutate] of [
  ['missing PDF evidence', row => { delete row.pages; delete row.pdfBytes; delete row.pdfSha256; }],
  ['zero pages', row => { row.pages = 0; }], ['fractional pages', row => { row.pages = 1.5; }],
  ['invalid byte count', row => { row.pdfBytes = -1; }], ['invalid PDF hash', row => { row.pdfSha256 = 'old'; }],
  ['false success', row => { row.success = false; }], ['false expected text', row => { row.expectedText = false; }],
  ['missing warning evidence', row => { delete row.unresolved; }], ['unresolved citations', row => { row.unresolved = ['undefined citation']; }],
  ['failed run', row => { row.runFailures = [{ exitCode: 1 }]; }], ['missing observed processes', row => { delete row.texPasses; }],
  ['non-array failure evidence', row => { row.runFailures = ''; }],
]) test(`${label} cannot establish performance evidence`, () => {
  const reports = inputs(); mutate(reports[0].demos[0]); rejected(reports, /incomplete PDF evidence/);
});

for (const duration of [0, -1, Infinity, NaN, '65', null]) test(`duration ${String(duration)} is rejected in warmups and measured rows`, () => {
  for (const repetition of [-1, 0]) {
    const reports = inputs(); reports[1].demos.find(demo => demo.repetition === repetition).totalMs = duration; rejected(reports, /invalid timing/);
  }
});

for (const [key, values] of [['repetitions', [undefined, null, '5', 4, 5.5, 21, Infinity]], ['warmups', [undefined, null, '1', 0, 1.5, 6, Infinity]]]) {
  for (const value of values) test(`${key}=${String(value)} does not satisfy the protocol`, () => {
    const reports = inputs(); reports[0][key] = value; rejected(reports, /measured iterations/);
  });
}

for (const [label, mutate] of [
  ['missing warmups', report => { report.demos = report.demos.filter(demo => demo.measured); }],
  ['missing measurement', report => { report.demos.pop(); }],
  ['unknown demo', report => { report.demos.push({ ...report.demos[10], name: 'outside-corpus.md', totalMs: 1e6 }); }],
  ['duplicate warmup', report => { report.demos[1] = { ...report.demos[0] }; }],
  ['duplicate measurement', report => { report.demos[11] = { ...report.demos[10] }; }],
  ['out-of-range measurement', report => { report.demos[10].repetition = 5; }],
  ['out-of-range warmup', report => { report.demos[0].repetition = -2; }],
  ['fractional repetition', report => { report.demos[0].repetition = 0.5; }],
  ['measured warmup', report => { report.demos[0].measured = true; }],
  ['unmeasured measurement', report => { report.demos[10].measured = false; }],
  ['truthy nonboolean', report => { report.demos[10].measured = 'true'; }],
  ['cold measurement', report => { report.demos[10].cacheState = 'cold'; }],
  ['missing cache state', report => { delete report.demos[0].cacheState; }],
]) test(`${label} cannot alter the full-corpus comparison`, () => {
  const reports = inputs(); mutate(reports[0]); rejected(reports, /matrix|iteration|measured or cacheState/);
});

test('extra baseline time cannot fabricate improvement from identical legitimate timings', () => {
  const baseline = report(100);
  for (let repetition = 0; repetition < 5; repetition++) baseline.demos.push({ ...baseline.demos[10], name: 'outside-corpus.md', repetition, totalMs: 1000 });
  rejected([baseline, report(100), report(100)], /unknown demo/);
});

for (const [label, mutate] of [
  ['missing run identity', report => { delete report.runId; }], ['invalid run identity', report => { report.runId = 'same invocation'; }],
  ['missing harness identity', report => { delete report.benchmarkIdentity; }], ['invalid policy digest', report => { report.benchmarkIdentity.correctnessPolicySha256 = 'fixture'; }],
  ['false report success', report => { report.success = false; }], ['missing schema', report => { delete report.schemaVersion; }],
  ['missing machine', report => { report.machine = {}; }], ['unavailable runtime', report => { report.runtime.python = 'unavailable'; }],
  ['invalid corpus hash', report => { report.corpusHash = 'fixture'; }], ['missing source hashes', report => { delete report.corpus[0].sha256; }],
  ['duplicate corpus name', report => { report.corpus[1].name = report.corpus[0].name; }], ['incomplete corpus', report => { report.corpus.pop(); }],
  ['missing prepared corpus', report => { delete report.preparedCorpus; }],
  ['missing prepared source hash', report => { delete report.preparedCorpus[0].sha256; }],
  ['misnamed prepared source', report => { report.preparedCorpus[0].name = 'outside-corpus.md'; }],
  ['incomplete prepared corpus', report => { report.preparedCorpus.pop(); }],
]) test(`${label} fails without upgrading historical reports`, () => {
  const reports = inputs(); mutate(reports[0]); rejected(reports, /requires/);
});

for (const [label, mutate] of [
  ['source hash despite matching aggregate', report => { report.corpus[0].sha256 = 'b'.repeat(64); }],
  ['aggregate corpus hash', report => { report.corpusHash = 'b'.repeat(64); }],
  ['effective prepared source despite matching authored inputs', report => { report.preparedCorpus[0].sha256 = 'b'.repeat(64); }],
  ['harness bytes', report => { report.benchmarkIdentity.harnessSha256 = 'b'.repeat(64); }],
  ['correctness policy', report => { report.benchmarkIdentity.correctnessPolicySha256 = 'b'.repeat(64); }],
  ['machine', report => { report.machine.cpu = 'different'; }], ['runtime', report => { report.runtime.xelatex = 'different'; }],
]) test(`comparison rejects changed ${label}`, () => {
  const reports = inputs(); mutate(reports[1]); rejected(reports, /differs|differ/);
});

test('identity key and corpus entry ordering do not change equivalence', () => {
  const reports = inputs();
  for (const key of ['machine', 'runtime', 'benchmarkIdentity']) reports[1][key] = Object.fromEntries(Object.entries(reports[1][key]).reverse());
  reports[1].corpus.reverse(); reports[1].preparedCorpus.reverse(); assert.equal(compareBenchmarks(...reports).ok, true);
});

test('identical prepared inputs may differ from the authored source bytes', () => {
  const reports = inputs(); reports.forEach(report => report.preparedCorpus.forEach(entry => { entry.sha256 = 'b'.repeat(64); }));
  assert.equal(compareBenchmarks(...reports).ok, true);
});

test('confirmation cannot reuse the candidate or baseline invocation', () => {
  for (const index of [0, 1]) { const reports = inputs(); reports[2] = structuredClone(reports[index]); rejected(reports, /distinct harness run/); }
});

for (const [label, mutate] of [
  ['changed bytes', report => { report.artifact.archiveSha256 = 'b'.repeat(64); }],
  ['invalid hash', report => { report.artifact.archiveSha256 = 'invalid'; }],
  ['unverified bytes', report => { report.artifact.verified = false; }], ['missing artifact', report => { delete report.artifact; }],
]) test(`candidate ${label} cannot establish a packaged comparison`, () => {
  const reports = inputs(); mutate(reports[1]); rejected(reports, /VSIX|verified/);
});

test('malformed reports return structured failures without arithmetic', () => {
  for (const value of [null, undefined, [], 'report', 42, {}, { demos: null }, { corpus: {} }]) {
    for (const index of [0, 1, 2]) { const reports = inputs(); reports[index] = value; rejected(reports, /report|requires/); }
  }
  for (const mutate of [report => { report.demos[0] = null; }, report => { report.corpus[0] = null; }, report => { report.demos[0].texPasses[0] = null; }]) {
    const reports = inputs(); mutate(reports[0]); rejected(reports, /requires|includes/);
  }
});

test('finite row values cannot overflow into a misleading comparison', () => {
  const reports = inputs(); reports[0].demos.forEach(demo => { demo.totalMs = Number.MAX_VALUE; }); rejected(reports, /finite numeric bounds/);
});

test('the CLI preserves every input audit through direct paths and filesystem aliases', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-benchmark-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const names = ['baseline', 'candidate', 'confirmation'];
  const reports = inputs(), originals = reports.map(report => JSON.stringify(report));
  names.forEach((name, index) => fs.writeFileSync(path.join(root, `${name}.json`), originals[index]));
  fs.symlinkSync(root, path.join(root, 'directory-alias'), 'dir');
  const checker = fileURLToPath(new URL('../scripts/check-benchmark-regression.mjs', import.meta.url));
  for (const name of names) {
    const input = path.join(root, `${name}.json`);
    fs.symlinkSync(input, path.join(root, `${name}-link.json`));
    fs.linkSync(input, path.join(root, `${name}-hardlink.json`));
    for (const output of [input, `${name}.json`, `${name}-link.json`, `${name}-hardlink.json`, `directory-alias/${name}.json`]) {
      const result = spawnSync(process.execPath, [checker, ...names.map(key => `--${key}=${key}.json`), `--report=${output}`], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 1); assert.match(result.stderr, /must not overwrite/);
      names.forEach((key, index) => assert.equal(fs.readFileSync(path.join(root, `${key}.json`), 'utf8'), originals[index]));
    }
  }
  const result = spawnSync(process.execPath, [checker, ...names.map(key => `--${key}=${key}.json`), '--report=summary.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'summary.json'))).status, 'passed');
  fs.appendFileSync(path.join(root, 'summary.json'), 'old trailing content');
  const rewrite = spawnSync(process.execPath, [checker, ...names.map(key => `--${key}=${key}.json`), '--report=summary.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(rewrite.status, 0, rewrite.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'summary.json'))).status, 'passed', 'existing summaries remain replaceable without trailing bytes');
});

for (const linkMethod of ['symlinkSync', 'linkSync']) test(`the CLI preserves input bytes if ${linkMethod} replaces the output after path validation`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-benchmark-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const names = ['baseline', 'candidate', 'confirmation'], originals = inputs().map(report => JSON.stringify(report));
  names.forEach((name, index) => fs.writeFileSync(path.join(root, `${name}.json`), originals[index]));
  const hook = path.join(root, 'replace-output.mjs');
  fs.writeFileSync(hook, `import fs from 'node:fs';
const mkdir = fs.mkdirSync;
fs.mkdirSync = (...args) => {
  const result = mkdir(...args);
  fs.${linkMethod}('baseline.json', 'summary.json');
  return result;
};\n`);
  const checker = fileURLToPath(new URL('../scripts/check-benchmark-regression.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', hook, checker, ...names.map(key => `--${key}=${key}.json`), '--report=summary.json'], { cwd: root, encoding: 'utf8' });
  assert.ok(fs.existsSync(path.join(root, 'summary.json')), 'the race hook ran after the initial path check');
  assert.equal(result.status, 1); assert.match(result.stderr, /ELOOP|must not overwrite/);
  names.forEach((name, index) => assert.equal(fs.readFileSync(path.join(root, `${name}.json`), 'utf8'), originals[index]));
});
