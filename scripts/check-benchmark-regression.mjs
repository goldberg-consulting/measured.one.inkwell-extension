import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const runId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const positive = value => Number.isFinite(value) && value > 0;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.trim().length > 0 && value !== 'unavailable';
const validManifest = value => Array.isArray(value) && value.length === 10
  && value.every(entry => object(entry) && text(entry.name) && sha256(entry.sha256))
  && new Set(value.map(entry => entry.name)).size === 10;
const manifestIdentity = manifest => JSON.stringify(manifest.map(({ name, sha256 }) => [name, sha256]).sort());
const sameFields = (left, right) => JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
const flatIdentity = value => object(value) && Object.keys(value).length > 0 && Object.values(value).every(item =>
  text(item) || (typeof item === 'number' && Number.isFinite(item)));
const validProcess = process => object(process) && text(process.binary) && positive(process.milliseconds)
  && process.exitCode === 0 && process.signal === null;
const validDemo = demo => object(demo) && demo.success === true && demo.expectedText === true
  && Array.isArray(demo.unresolved) && demo.unresolved.length === 0
  && Array.isArray(demo.runFailures) && demo.runFailures.length === 0
  && positiveInteger(demo.pages) && positiveInteger(demo.pdfBytes) && sha256(demo.pdfSha256)
  && ['texPasses', 'pandoc', 'runProcesses'].every(key => Array.isArray(demo[key]) && demo[key].every(validProcess))
  && demo.texPasses.length > 0 && demo.texPasses.every(process => /^(?:xelatex|pdflatex|lualatex)(?:\.exe)?$/.test(process.binary))
  && demo.pandoc.length > 0 && demo.pandoc.every(process => /^pandoc(?:\.exe)?$/.test(process.binary));

function validateReport(report, label, failures) {
  const fail = message => failures.push(`${label} ${message}`);
  if (!object(report)) { fail('must be a benchmark report object.'); return; }
  if (report.schemaVersion !== 1 || report.success !== true) fail('requires schemaVersion 1 and complete report success.');
  if (!runId(report.runId)) fail('requires a harness-generated UUID runId.');
  if (!flatIdentity(report.benchmarkIdentity) || !sha256(report.benchmarkIdentity.harnessSha256)
      || !sha256(report.benchmarkIdentity.correctnessPolicySha256)) fail('requires harness and correctness-policy SHA256 identities.');
  if (!flatIdentity(report.machine) || !['platform', 'arch', 'cpu', 'node', 'osRelease'].every(key => text(report.machine[key]))
      || !positiveInteger(report.machine.memoryBytes)) fail('requires complete machine identity.');
  if (!flatIdentity(report.runtime) || !['pandoc', 'xelatex', 'pdflatex', 'python'].every(key => text(report.runtime[key]))) fail('requires complete runtime identity.');
  if (!sha256(report.corpusHash)) fail('requires a corpus SHA256.');
  const validCounts = Number.isInteger(report.repetitions) && report.repetitions >= 5 && report.repetitions <= 20
    && Number.isInteger(report.warmups) && report.warmups >= 1 && report.warmups <= 5;
  if (!validCounts) fail('requires 5 to 20 measured iterations and 1 to 5 unmeasured warmups.');
  const validCorpus = validManifest(report.corpus);
  if (!validCorpus) fail('requires the complete ten-demo corpus with unique names and source SHA256 values.');
  if (!validManifest(report.preparedCorpus) || (validCorpus
      && JSON.stringify(report.preparedCorpus.map(entry => entry.name).sort()) !== JSON.stringify(report.corpus.map(entry => entry.name).sort()))) {
    fail('requires a complete preparedCorpus manifest with matching demo names and effective source SHA256 values.');
  }
  if (!Array.isArray(report.demos)) { fail('requires demo records.'); return; }
  if (!validCounts || !validCorpus) return;
  const names = new Set(report.corpus.map(entry => entry.name)), iterations = new Set();
  if (report.demos.length !== names.size * (report.repetitions + report.warmups)) fail('must contain exactly the declared warmup and measured demo matrix.');
  for (const demo of report.demos) {
    if (!validDemo(demo)) fail('includes failed processes, incomplete PDF evidence, or unresolved output; no performance waiver is implied.');
    if (!object(demo)) continue;
    if (!positive(demo.totalMs)) fail('contains an invalid timing record.');
    if (!names.has(demo.name) || !Number.isInteger(demo.repetition) || demo.repetition < -report.warmups || demo.repetition >= report.repetitions) {
      fail('contains an unknown demo or out-of-range iteration.'); continue;
    }
    if (demo.measured !== (demo.repetition >= 0) || demo.cacheState !== (demo.repetition === -report.warmups ? 'cold' : 'warm')) fail('contains incorrect measured or cacheState evidence.');
    const key = JSON.stringify([demo.name, demo.repetition]);
    if (iterations.has(key)) fail('repeats a demo/iteration.');
    iterations.add(key);
  }
  for (const name of names) for (let repetition = -report.warmups; repetition < report.repetitions; repetition++) {
    if (!iterations.has(JSON.stringify([name, repetition]))) fail(`is missing ${name} iteration ${repetition}.`);
  }
}

/** Two independent warm runs confirm a regression; one noisy sample is never a
 * release decision. Invalid/partial baseline PDFs cannot establish a target.
 */
export function compareBenchmarks(baseline, candidate, confirmation) {
  const failures = [];
  const reports = [baseline, candidate, confirmation];
  reports.forEach((report, index) => validateReport(report, ['baseline', 'candidate', 'confirmation'][index], failures));
  const artifactSha256 = sha256(candidate?.artifact?.archiveSha256) ? candidate.artifact.archiveSha256 : null;
  if (!artifactSha256 || confirmation?.artifact?.archiveSha256 !== artifactSha256) failures.push('Candidate and confirmation must identify the same verified VSIX bytes.');
  if (candidate?.artifact?.verified !== true || confirmation?.artifact?.verified !== true) failures.push('Packaged candidate bytes were not verified by the runtime harness.');
  const invalid = () => ({ schemaVersion: 1, ok: false, status: 'invalid-evidence', sustainedComparison: false, artifactSha256,
    baselineMedianMs: null, candidateMedianMs: null, confirmationMedianMs: null, improvements: [], demos: [], failures: [...new Set(failures)] });
  if (failures.length) return invalid();
  if (new Set(reports.map(report => report.runId)).size !== 3) failures.push('Baseline, candidate and confirmation require distinct harness run identities.');
  for (const report of reports.slice(1)) {
    if (!sameFields(report.machine, baseline.machine) || !sameFields(report.runtime, baseline.runtime)) failures.push('Machine or runtime differs from the baseline.');
    if (report.corpusHash !== baseline.corpusHash || manifestIdentity(report.corpus) !== manifestIdentity(baseline.corpus)) failures.push('Corpus inputs differ from the baseline.');
    if (manifestIdentity(report.preparedCorpus) !== manifestIdentity(baseline.preparedCorpus)) failures.push('Prepared corpus inputs differ from the baseline.');
    if (!sameFields(report.benchmarkIdentity, baseline.benchmarkIdentity)) failures.push('Harness or correctness policy differs from the baseline.');
  }
  if (failures.length) return invalid();
  const names = baseline.corpus.map(entry => entry.name).sort();
  const corpusMedian = report => median(Array.from({ length: report.repetitions }, (_, repetition) => report.demos
    .filter(demo => demo.measured && demo.repetition === repetition).reduce((sum, demo) => sum + demo.totalMs, 0)));
  const baselineMs = corpusMedian(baseline), candidateMs = corpusMedian(candidate), confirmationMs = corpusMedian(confirmation);
  const improvements = [candidateMs, confirmationMs].map(value => 1 - value / baselineMs);
  if (![baselineMs, candidateMs, confirmationMs].every(positive) || !improvements.every(Number.isFinite)) {
    failures.push('Timing aggregation exceeds finite numeric bounds.'); return invalid();
  }
  if (improvements.some(value => value < 0.30)) failures.push('Both warm runs must improve corpus median compilation by at least 30%.');
  const demos = names.map(name => {
    const timings = reports.map(report => median(report.demos.filter(demo => demo.measured && demo.name === name).map(demo => demo.totalMs)));
    const regressions = timings.slice(1).map(value => value / timings[0] - 1);
    const sustainedRegression = timings.slice(1).every(value => value > timings[0] * 1.10);
    if (sustainedRegression) failures.push(`${name} regresses by over 10% on both confirmation runs.`);
    return { name, baselineMedianMs: timings[0], candidateMedianMs: timings[1], confirmationMedianMs: timings[2], regressions, sustainedRegression };
  });
  if (demos.some(demo => !demo.regressions.every(Number.isFinite))) {
    failures.push('Per-demo timing ratios exceed finite numeric bounds.'); return invalid();
  }
  return { schemaVersion: 1, ok: failures.length === 0, status: failures.length ? 'threshold-failed' : 'passed', sustainedComparison: true, artifactSha256,
    runIds: reports.map(report => report.runId), benchmarkIdentity: { ...baseline.benchmarkIdentity }, corpusHash: baseline.corpusHash,
    baselineMedianMs: baselineMs, candidateMedianMs: candidateMs, confirmationMedianMs: confirmationMs,
    improvements, demos, failures: [...new Set(failures)] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = Object.fromEntries(process.argv.slice(2).map(argument => argument.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)));
    if (!options.baseline || !options.candidate || !options.confirmation || !options.report) throw new Error('Usage: check-benchmark-regression.mjs --baseline=FILE --candidate=FILE --confirmation=FILE --report=FILE');
    const output = path.resolve(options.report);
    let outputStat;
    try { outputStat = fs.statSync(output); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const inputIdentities = [];
    for (const key of ['baseline', 'candidate', 'confirmation']) {
      const input = path.resolve(options[key]), inputStat = fs.statSync(input);
      inputIdentities.push({ input, stat: inputStat });
      if (output === input || (outputStat && outputStat.dev === inputStat.dev && outputStat.ino === inputStat.ino)) {
        throw new Error('The comparison report must not overwrite an input report or its filesystem alias.');
      }
    }
    const read = name => JSON.parse(fs.readFileSync(options[name], 'utf8'));
    const report = compareBenchmarks(read('baseline'), read('candidate'), read('confirmation'));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    // Do not truncate until the opened file is proved separate from every
    // retained input. Descriptor writes cannot follow a later path swap.
    const descriptor = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT
      | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0), 0o600);
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile()) throw new Error('The comparison report must be a regular file.');
      for (const { input, stat } of inputIdentities) {
        const current = fs.statSync(input);
        if ([stat, current].some(identity => opened.dev === identity.dev && opened.ino === identity.ino)) {
          throw new Error('The comparison report must not overwrite an input report or its filesystem alias.');
        }
      }
      fs.ftruncateSync(descriptor, 0);
      fs.writeFileSync(descriptor, JSON.stringify(report, null, 2) + '\n');
    } finally { fs.closeSync(descriptor); }
    console.log(report.ok ? 'Both repeated warm benchmark gates passed.' : report.failures.join('\n'));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
