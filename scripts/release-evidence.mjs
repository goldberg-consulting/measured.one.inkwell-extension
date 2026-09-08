import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readZipEntries, verifyVsix } from './verify-vsix.mjs';
import { ASSET_MANIFEST_PATH, isSafeRelativePath } from './build-asset-manifest.mjs';
import { compareBenchmarks } from './check-benchmark-regression.mjs';

export const PUBLICATION_GATES = Object.freeze(['behavior-linux', 'behavior-macos', 'package', 'activation-linux', 'activation-macos',
  'offline-linux', 'offline-macos', 'run-to-pdf', 'warm-preview', 'pdf-parity', 'demos', 'performance', 'upgrade-from-0.4', 'clean-macos-cask', 'standalone-existing-tex', 'tap-audit']);
export const COMPLETION_GATES = Object.freeze([...PUBLICATION_GATES, 'public-install', 'reinstall', 'uninstall-preservation', 'public-tap-audit']);
export const RC_GATES = Object.freeze(PUBLICATION_GATES.filter(gate => !['clean-macos-cask', 'standalone-existing-tex', 'tap-audit'].includes(gate)));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); };
const nonnegativeNumber = value => Number.isFinite(value) && value >= 0;
const median = values => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};

export function verifyRunProvenance(run, { repository, commit, workflows }) {
  ensure(run?.repository?.full_name === repository && run.head_repository?.full_name === repository,
    'Release evidence must originate in the expected repository, never a fork.');
  ensure(run.head_sha === commit, 'Evidence workflow ran at a different source commit.');
  ensure(workflows.includes(run.path), 'Evidence came from an untrusted workflow.');
  ensure(['push', 'workflow_dispatch', 'schedule'].includes(run.event), 'Pull-request or indirect workflow artifacts cannot authorize publication.');
  ensure(run.status === 'completed' && run.conclusion === 'success', 'Evidence workflow has not completed successfully.');
  return { ok: true, runId: run.id, repository, commit, workflow: run.path, event: run.event };
}
const expectedPlatform = gate => gate.endsWith('-linux') ? 'linux' : gate.endsWith('-macos') ? 'darwin' : undefined;

export function candidateIdentity(vsix, commit) {
  ensure(/^[a-f0-9]{40}$/.test(commit), 'A full release commit SHA is required.');
  const bytes = fs.readFileSync(vsix), entries = readZipEntries(bytes);
  const pkg = JSON.parse(entries.get('extension/package.json'));
  const verified = verifyVsix(bytes, { tag: `v${pkg.version}` });
  return { schemaVersion: 1, releaseCommit: commit, version: verified.version, filename: `inkwell-${verified.version}.vsix`,
    vsixSha256: verified.archiveSha256, assetsManifestSha256: sha(entries.get(`extension/${ASSET_MANIFEST_PATH}`)) };
}

function validIdentity(candidate) {
  ensure(candidate?.schemaVersion === 1 && /^[a-f0-9]{40}$/.test(candidate.releaseCommit)
    && /^[a-f0-9]{64}$/.test(candidate.vsixSha256) && /^[a-f0-9]{64}$/.test(candidate.assetsManifestSha256)
    && candidate.filename === `inkwell-${candidate.version}.vsix`, 'Invalid candidate identity.');
}
function matchingIdentity(left, right) {
  validIdentity(left); validIdentity(right);
  for (const key of ['releaseCommit', 'version', 'filename', 'vsixSha256', 'assetsManifestSha256']) {
    ensure(left[key] === right[key], `Release evidence identity mismatch: ${key}.`);
  }
}

export function validateGateReport(gate, bytes, candidate) {
  ensure(COMPLETION_GATES.includes(gate), `Unknown release gate: ${gate}`);
  if (gate.startsWith('behavior-')) {
    const text = bytes.toString('utf8');
    ensure(/(?:#|ℹ) tests [1-9]\d*/.test(text) && /(?:#|ℹ) fail 0(?:\r?\n|$)/.test(text) && !/^(?:not ok |✖)/m.test(text), `${gate} requires a successful, nonempty TAP or Node test report.`);
    return;
  }
  const report = JSON.parse(bytes.toString('utf8'));
  if (gate.startsWith('offline-')) {
    ensure(report.platform === expectedPlatform(gate) && report.fixturePages === 100 && report.externalNetworkBlocked === true && report.externalRequests === 0
      && report.actualPdfRequests === 1 && report.cspViolations?.length === 0 && report.browserErrors?.length === 0
      && report.printEnhancementsVerified === true && report.documentScrollIsolationVerified === true,
    `${gate} did not prove the offline preview contract.`);
  } else if (gate.startsWith('activation-') || gate === 'run-to-pdf' || gate === 'warm-preview') {
    ensure(report.ok === true && report.artifact?.archiveSha256 === candidate.vsixSha256 && report.activation?.sampleCount >= 5
      && report.activation.p95Ms < 200 && report.activation.extensionChildProcesses === 0, `${gate} requires successful actual-VSIX activation evidence.`);
    if (expectedPlatform(gate)) ensure(report.machine?.platform === expectedPlatform(gate), `${gate} has evidence from the wrong operating system.`);
    if (gate === 'run-to-pdf') {
      const workflow = report.iterations?.filter(item => !item.warmup).at(-1)?.host?.workflow;
      ensure(workflow?.ok === true && workflow.pdf?.verified === true, 'The real editor workflow must compile and verify the edited run artifact in a PDF.');
    }
    if (gate === 'warm-preview') {
      const warmPreview = report.warmPreview, samples = warmPreview?.samples;
      const measured = Array.isArray(samples) ? samples.filter(sample => sample?.warmup === false) : [];
      const warmups = Array.isArray(samples) ? samples.filter(sample => sample?.warmup === true) : [];
      const callbackMaxima = measured.map(sample => sample.maximumCallbackMs);
      const timerLagMaxima = measured.map(sample => sample.maximumTimerLagMs);
      const completeSamples = Array.isArray(samples) && samples.every(sample => sample && typeof sample.warmup === 'boolean'
        && nonnegativeNumber(sample.maximumCallbackMs) && nonnegativeNumber(sample.maximumTimerLagMs)
        && sample.publication?.accepted === true && sample.publication?.finalEditPresent === true);
      ensure(warmPreview?.ok === true && warmPreview.measuredSamples >= 5 && warmPreview.warmupSamples >= 1
        && measured.length === warmPreview.measuredSamples && warmups.length === warmPreview.warmupSamples && completeSamples
        && [warmPreview.callbackMaximaMedianMs, warmPreview.timerLagMaximaMedianMs, warmPreview.maximumCallbackMs, warmPreview.maximumTimerLagMs].every(nonnegativeNumber)
        && warmPreview.callbackMaximaMedianMs === median(callbackMaxima) && warmPreview.timerLagMaximaMedianMs === median(timerLagMaxima)
        && warmPreview.maximumCallbackMs === Math.max(...callbackMaxima) && warmPreview.maximumTimerLagMs === Math.max(...timerLagMaxima)
        && warmPreview.unchangedCompletionChildProcesses === 0,
      'Warm preview must retain complete current-publication samples, coherent finite timing observations, and the warm citation zero-process result.');
    }
  } else if (gate === 'pdf-parity') {
    ensure(report.ok === true && report.artifactSha256 === candidate.vsixSha256 && report.normalizedStyleParity === true
      && report.rasterGoldenPassed === true && report.pixelChannelThreshold === 10 && report.maximumDifferentPixelFraction <= 0.005
      && /^[a-f0-9]{64}$/.test(report.toolchainFingerprint) && new Set(report.templates).size === 10,
    'PDF parity requires all templates, normalized styles and pinned-toolchain raster goldens within the declared tolerance.');
  } else if (gate === 'demos') {
    ensure(report.success === true && report.artifact?.archiveSha256 === candidate.vsixSha256
      && new Set(report.demos?.map(item => item.name)).size === 10 && report.demos.every(item => item.success && item.expectedText
        && !item.unresolved?.length && !item.runFailures?.length), 'All ten demos must pass through the exact packaged compiler.');
  } else if (gate === 'package') {
    ensure(report.ok === true && report.archiveSha256 === candidate.vsixSha256, 'Package evidence must validate the same VSIX bytes.');
  } else if (gate === 'performance') {
    ensure(report.ok === true && report.sustainedComparison === true && report.artifactSha256 === candidate.vsixSha256
      && report.failures?.length === 0 && report.improvements?.length === 2 && report.improvements.every(value => Number.isFinite(value) && value >= 0.3),
      'Performance evidence must pass sustained comparisons for the same candidate.');
  } else {
    ensure(report.ok === true && report.vsixSha256 === candidate.vsixSha256 && report.releaseCommit === candidate.releaseCommit,
      `${gate} requires successful evidence for this release commit and VSIX.`);
    if (['clean-macos-cask', 'standalone-existing-tex', 'public-install'].includes(gate)) {
      ensure(report.doctorReady === true && report.pdfVerified === true && report.cleanProfile === true && report.noCodeJourneyVerified === true,
        `${gate} requires a clean editor no-code journey, full doctor and real PDF.`);
      if (gate === 'standalone-existing-tex') ensure(report.texRootBefore && report.texRootBefore === report.texRootAfter, 'Standalone setup must preserve the existing TeX installation.');
      if (gate === 'public-install') ensure(report.canonicalCommand === 'brew install --cask goldberg-consulting/inkwell/inkwell', 'Public installation must use the canonical command.');
    }
    if (['upgrade-from-0.4', 'reinstall', 'uninstall-preservation'].includes(gate)) {
      ensure(['projects', 'documents', 'bibliographies', 'scripts', 'history', 'pdfs'].every(key => report.preserved?.[key] === true), `${gate} did not verify every user-file preservation category.`);
      if (gate === 'upgrade-from-0.4') ensure(report.previousVersion === '0.4.0', 'Upgrade evidence must begin at Inkwell 0.4.0.');
      if (gate === 'uninstall-preservation') ensure(report.extensionRemoved === true && report.caskOwnedFilesRemoved === true, 'Uninstall evidence must verify editor and cask removal.');
    }
    if (gate === 'tap-audit' || gate === 'public-tap-audit') ensure(report.audit === true && report.style === true && report.lifecycle === true && /^[a-f0-9]{40}$/.test(report.tapCommit), 'Tap evidence requires audit, style, lifecycle tests and an exact tap commit.');
    if (gate === 'public-tap-audit') ensure(report.publishedUrl === `https://github.com/goldberg-consulting/measured.one.inkwell-extension/releases/download/v${candidate.version}/${candidate.filename}`,
      'Final tap audit must verify the canonical public release URL.');
  }
}

function validateRetainedReports(gate, reports, candidate) {
  validateGateReport(gate, reports[0], candidate);
  if (gate === 'performance') {
    ensure(reports.length >= 4, 'Performance evidence must retain comparison, candidate, confirmation and baseline reports.');
    const values = reports.map(bytes => JSON.parse(bytes.toString('utf8')));
    const observed = compareBenchmarks(values[3], values[1], values[2]);
    ensure(observed.ok && observed.artifactSha256 === candidate.vsixSha256, `Retained performance measurements fail: ${observed.failures?.join('; ')}`);
    ensure(JSON.stringify(observed) === JSON.stringify(values[0]), 'Performance summary differs from its retained measurements.');
  }
}

export function recordEvidence(candidate, gate, reports, destination, platform = process.platform) {
  validIdentity(candidate);
  ensure(Array.isArray(reports) && reports.length, 'At least one actual report is required.');
  const inputs = reports.map(file => { ensure(fs.lstatSync(file).isFile(), `Report is not a regular file: ${file}`); return { file, bytes: fs.readFileSync(file) }; });
  validateRetainedReports(gate, inputs.map(input => input.bytes), candidate);
  if (expectedPlatform(gate)) ensure(platform === expectedPlatform(gate), 'Cannot label evidence as a different producer operating system.');
  ensure(!fs.existsSync(destination), 'Evidence records are immutable; choose a new output directory.');
  const parent = path.dirname(destination);
  const attachments = inputs.map(({ file, bytes }, index) => {
    ensure(bytes.length > 0, `Empty report: ${file}`);
    const relative = `attachments/${gate}/${index}-${path.basename(file)}`;
    ensure(isSafeRelativePath(relative), 'Unsafe evidence filename.');
    const target = path.join(parent, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: 'wx' });
    return { path: relative, size: bytes.length, sha256: sha(bytes) };
  });
  const result = { schemaVersion: 1, candidate, gate, status: 'passed', recordedAt: new Date().toISOString(),
    producer: { runId: process.env.GITHUB_RUN_ID || null, job: process.env.GITHUB_JOB || null, platform,
      arch: process.arch, node: process.version, osRelease: os.release() }, attachments };
  write(destination, result); return result;
}

export function validateEvidence(candidate, vsix, evidenceRoot, stage = 'publish') {
  matchingIdentity(candidate, candidateIdentity(vsix, candidate.releaseCommit));
  return validateEvidenceBundle(candidate, evidenceRoot, stage);
}

/** Import only explicitly requested gates, leaving duplicate base reports out. */
export function selectEvidence(candidate, sourceRoot, destination, gates) {
  validIdentity(candidate);
  ensure(gates.length && gates.every(gate => COMPLETION_GATES.includes(gate)), 'Select explicit recognized supplemental gates.');
  ensure(!fs.existsSync(destination), 'Selected evidence output must be new.');
  const root = fs.realpathSync(sourceRoot), selected = new Set();
  const walk = directory => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      ensure(!item.isSymbolicLink(), 'Supplemental evidence cannot contain symbolic links.');
      if (item.isDirectory() && item.name !== 'attachments') walk(file);
      else if (item.isFile() && item.name.endsWith('.evidence.json')) {
        const record = json(file);
        if (!gates.includes(record.gate)) continue;
        matchingIdentity(candidate, record.candidate);
        ensure(!selected.has(record.gate), `Duplicate supplemental gate: ${record.gate}`);
        ensure(record.status === 'passed' && Array.isArray(record.attachments) && record.attachments.length, 'Invalid supplemental evidence record.');
        const targetRoot = path.join(destination, record.gate);
        for (const attachment of record.attachments) {
          ensure(isSafeRelativePath(attachment.path), 'Unsafe supplemental attachment path.');
          const input = path.join(path.dirname(file), attachment.path), real = fs.realpathSync(input);
          ensure(real.startsWith(root + path.sep) && !fs.lstatSync(input).isSymbolicLink() && fs.statSync(input).isFile(), 'Supplemental attachment escapes its source bundle.');
          const bytes = fs.readFileSync(input);
          ensure(bytes.length === attachment.size && sha(bytes) === attachment.sha256, 'Supplemental attachment hash mismatch.');
          const output = path.join(targetRoot, attachment.path); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, bytes, { flag: 'wx' });
        }
        write(path.join(targetRoot, `${record.gate}.evidence.json`), record); selected.add(record.gate);
      }
    }
  };
  walk(root);
  ensure(selected.size, 'The supplemental run contained no requested evidence gates.');
  return { ok: true, selected: [...selected].sort() };
}

export function validateEvidenceBundle(candidate, evidenceRoot, stage = 'publish') {
  validIdentity(candidate);
  ensure(['rc', 'publish', 'complete'].includes(stage), 'Evidence stage must be rc, publish or complete.');
  const required = stage === 'complete' ? COMPLETION_GATES : stage === 'rc' ? RC_GATES : PUBLICATION_GATES;
  const found = new Map();
  let tapCommit;
  const root = fs.realpathSync(evidenceRoot);
  const walk = directory => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      ensure(!item.isSymbolicLink(), 'Evidence cannot contain symbolic links.');
      if (item.isDirectory() && item.name !== 'attachments') walk(file);
      else if (item.isFile() && item.name.endsWith('.evidence.json')) {
        const evidence = json(file);
        ensure(evidence.schemaVersion === 1 && evidence.status === 'passed' && COMPLETION_GATES.includes(evidence.gate), `Invalid evidence record: ${file}`);
        matchingIdentity(candidate, evidence.candidate);
        if (expectedPlatform(evidence.gate)) ensure(evidence.producer?.platform === expectedPlatform(evidence.gate), 'Evidence producer has the wrong operating system.');
        ensure(!found.has(evidence.gate), `Duplicate evidence for ${evidence.gate}; select one coherent evidence set.`);
        ensure(Array.isArray(evidence.attachments) && evidence.attachments.length > 0, `Missing reports for ${evidence.gate}.`);
        const bytes = evidence.attachments.map(attachment => {
          ensure(isSafeRelativePath(attachment.path), 'Unsafe evidence attachment path.');
          const target = path.join(path.dirname(file), attachment.path), resolved = fs.realpathSync(target);
          ensure(resolved.startsWith(root + path.sep) && !fs.lstatSync(target).isSymbolicLink() && fs.statSync(target).isFile(), 'Evidence attachment must remain a regular file inside its bundle.');
          const contents = fs.readFileSync(target);
          ensure(contents.length === attachment.size && sha(contents) === attachment.sha256, `Evidence report hash mismatch: ${attachment.path}`);
          return contents;
        });
        validateRetainedReports(evidence.gate, bytes, candidate);
        if (evidence.gate === 'tap-audit') tapCommit = JSON.parse(bytes[0].toString('utf8')).tapCommit;
        found.set(evidence.gate, { record: path.relative(root, file), sha256: sha(fs.readFileSync(file)) });
      }
    }
  };
  walk(root);
  const missing = required.filter(gate => !found.has(gate));
  ensure(!missing.length, `Release is blocked by missing evidence: ${missing.join(', ')}.`);
  return { schemaVersion: 1, ok: true, stage, candidate, tapCommit, gates: Object.fromEntries(required.map(gate => [gate, found.get(gate)])) };
}

function args(argv) {
  const values = { reports: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i], value = argv[++i];
    ensure(value && ['--vsix', '--commit', '--output', '--candidate', '--gate', '--gates', '--report', '--evidence', '--stage', '--run-id', '--workflow', '--repository'].includes(key), `Unknown or incomplete argument: ${key}`);
    if (key === '--report') values.reports.push(path.resolve(value)); else values[key.slice(2)] = value;
  }
  return values;
}

export function assertCleanReleaseCheckout(root = process.cwd()) {
  for (const args of [['diff', '--quiet'], ['diff', '--cached', '--quiet']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    ensure(result.status === 0, 'Release identity requires a clean tracked checkout; commit or isolate changes before creating evidence.');
  }
  const files = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  ensure(files.status === 0, 'Cannot inspect untracked release inputs.');
  const unknown = files.stdout.split('\0').filter(name => /^(?:src|templates|filters|csl|media|schemas|examples|scripts|tests|benchmarks|\.github)\//.test(name)
    || /^(?:package(?:-lock)?\.json|requirements-latex\.txt|tsconfig\.json|\.vscodeignore)$/.test(name));
  ensure(!unknown.length, `Release identity cannot include untracked build or test inputs: ${unknown.join(', ')}.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...argv] = process.argv.slice(2), options = args(argv);
    const candidate = options.candidate ? json(options.candidate) : undefined;
    const commit = options.commit || candidate?.releaseCommit;
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    ensure(head.status === 0 && head.stdout.trim() === commit, 'Run the release harness from the exact candidate commit checkout.');
    if (command === 'init') assertCleanReleaseCheckout();
    let result;
    if (command === 'init') { result = candidateIdentity(options.vsix, commit); write(options.output, result); }
    else if (command === 'record') result = recordEvidence(candidate, options.gate, options.reports, options.output);
    else if (command === 'validate') { result = validateEvidence(candidate, options.vsix, options.evidence, options.stage); if (options.output) write(options.output, result); }
    else if (command === 'select') result = selectEvidence(candidate, options.evidence, options.output, (options.gates || '').split(','));
    else if (command === 'verify-run') {
      const repository = options.repository || process.env.GITHUB_REPOSITORY;
      ensure(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') && /^\d+$/.test(options['run-id'] || ''), 'A valid repository and numeric workflow run ID are required.');
      const workflows = (options.workflow || '').split(',');
      ensure(workflows.length && workflows.every(value => /^\.github\/workflows\/[a-z-]+\.yml$/.test(value)), 'Explicit trusted workflow paths are required.');
      const response = spawnSync('gh', ['api', `repos/${repository}/actions/runs/${options['run-id']}`], { encoding: 'utf8' });
      ensure(response.status === 0, 'Authenticated workflow provenance could not be fetched.');
      result = verifyRunProvenance(JSON.parse(response.stdout), { repository, commit, workflows });
    }
    else throw new Error('Usage: release-evidence.mjs init|record|validate --commit COMMIT or --candidate FILE, with --vsix, --gate, --report, --evidence and --output as applicable.');
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
