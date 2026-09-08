import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyVsix } from './verify-vsix.mjs';
import { isReleaseVersion } from './build-asset-manifest.mjs';

const validVersion = isReleaseVersion;
export function validateReleasePrerequisites({ packageJson, tag, tapToken }) {
  if (typeof tapToken !== 'string' || !tapToken.trim()) throw new Error('HOMEBREW_TAP_TOKEN must be configured before any release or tap publication.');
  if (packageJson?.name !== 'inkwell' || packageJson?.publisher !== 'measure-one' || !validVersion(packageJson.version)) throw new Error('The release package identity or version is invalid.');
  if (tag !== `v${packageJson.version}`) throw new Error(`The release tag must be exactly v${packageJson.version}.`);
  return { version: packageJson.version, tag, filename: `inkwell-${packageJson.version}.vsix` };
}

export function writeReleaseChecksums(vsixPath, tag, verify = verifyVsix) {
  const artifact = verify(vsixPath, { tag });
  const filename = `inkwell-${artifact.version}.vsix`;
  if (path.basename(vsixPath) !== filename) throw new Error(`The verified release artifact must be named ${filename}.`);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(vsixPath)).digest('hex');
  const checksumPath = path.join(path.dirname(vsixPath), 'SHA256SUMS');
  fs.writeFileSync(checksumPath, `${sha256}  ${filename}\n`);
  return { filename, sha256, checksumPath };
}

export function verifyPublishedArtifact(vsixPath, checksumPath, tag, verify = verifyVsix) {
  const artifact = verify(vsixPath, { tag });
  const filename = `inkwell-${artifact.version}.vsix`;
  if (path.basename(vsixPath) !== filename) throw new Error(`The public release artifact must be named ${filename}.`);
  const entries = fs.readFileSync(checksumPath, 'utf8').trim().split(/\r?\n/).map(line => line.match(/^([a-f0-9]{64})  ([^\r\n]+)$/));
  if (entries.some(entry => !entry)) throw new Error('The published SHA256SUMS file is malformed.');
  const matching = entries.filter(entry => entry[2] === filename);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(vsixPath)).digest('hex');
  if (matching.length !== 1 || matching[0][1] !== sha256) throw new Error('The published VSIX does not match its immutable SHA256SUMS entry. Do not replace the release assets.');
  return { filename, sha256, checksumPath };
}

const pendingStart = '<!-- inkwell-homebrew-pending:start -->';
const pendingEnd = '<!-- inkwell-homebrew-pending:end -->';
export function releaseNotes(body, tag, pending) {
  if (!validVersion(tag?.replace(/^v/, '')) || !tag.startsWith('v')) throw new Error('The release notes tag is invalid.');
  body = typeof body === 'string' ? body : '';
  const expression = new RegExp(`${pendingStart}[\\s\\S]*?${pendingEnd}\\n*`, 'g');
  const original = body.replace(expression, '');
  if (!pending) return original;
  return `${pendingStart}\n**Homebrew publication pending.** The verified VSIX and SHA256SUMS are public; the matching Homebrew tap update has not been confirmed.\n\nMaintainers: rerun the failed Release workflow for ${tag}, or dispatch that exact tag. The workflow reuses and validates the public assets without rebuilding or replacing them, verifies the current tap lifecycle, and retries a normal fast-forward tap push. Resolve any tap conflict in its own repository before retrying.\n${pendingEnd}\n\n${original}`;
}

// SemVer 2.0 precedence: ignore build metadata and compare numeric identifiers
// without converting them to potentially lossy JavaScript Numbers.
function compareVersions(left, right) {
  const parse = version => {
    const parts = version.split('+')[0].match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
    return { core: parts.slice(1, 4).map(BigInt), pre: parts[4]?.split('.') || [] };
  };
  const a = parse(left), b = parse(right);
  const compare = (x, y) => x === y ? 0 : x < y ? -1 : 1;
  for (let i = 0; i < 3; i++) {
    const order = compare(a.core[i], b.core[i]);
    if (order) return order;
  }
  if (!a.pre.length) return b.pre.length ? 1 : 0;
  if (!b.pre.length) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const numericA = /^\d+$/.test(a.pre[i]), numericB = /^\d+$/.test(b.pre[i]);
    if (numericA !== numericB) return numericA ? -1 : 1;
    const order = compare(numericA ? BigInt(a.pre[i]) : a.pre[i], numericB ? BigInt(b.pre[i]) : b.pre[i]);
    if (order) return order;
  }
  return 0;
}

export function updateTapCask(source, version, sha256) {
  if (!validVersion(version)) throw new Error('The tap release version is invalid.');
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('The tap release checksum is invalid.');
  const fieldPattern = field => new RegExp(`^(\\s*${field}\\s+)(["'])([^"'\\r\\n]*)(\\2)([^\\r\\n]*)$`, 'gm');
  const previous = [...source.matchAll(fieldPattern('version'))];
  if (previous.length !== 1) throw new Error('The tap cask must contain exactly one version declaration.');
  const previousVersion = previous[0][3];
  if (!validVersion(previousVersion)) throw new Error('The existing tap version is invalid; refusing to guess release precedence.');
  if (compareVersions(version, previousVersion) < 0) throw new Error(`Refusing to downgrade the Homebrew tap from ${previousVersion} to ${version}. This release retry is stale; leave the newer tap version in place.`);
  const replace = (text, field, value) => {
    const expression = fieldPattern(field);
    let count = 0;
    const result = text.replace(expression, (_match, before, quote, _previous, _endQuote, suffix) => { count++; return `${before}${quote}${value}${quote}${suffix}`; });
    if (count !== 1) throw new Error(`The tap cask must contain exactly one ${field} declaration.`);
    return result;
  };
  return replace(replace(source, 'version', version), 'sha256', sha256);
}

/** The audited candidate tree may change only its release metadata for promotion. */
export function promoteTapCandidate(source, version, sha256, releaseCommit) {
  if (!/^[a-f0-9]{40}$/.test(releaseCommit)) throw new Error('The audited candidate needs an exact release commit.');
  const canonical = 'https://github.com/goldberg-consulting/measured.one.inkwell-extension/releases/download/v#{version}/inkwell-#{version}.vsix';
  const candidate = `https://github.com/goldberg-consulting/measured.one.inkwell-extension/releases/download/inkwell-rc-${releaseCommit}/inkwell-${version}.vsix`;
  const versionedCandidate = candidate.replace(`/inkwell-${version}.vsix`, '/inkwell-#{version}.vsix');
  const urls = [...source.matchAll(/^(\s*url\s+)(["'])([^"'\r\n]+)\2([^\r\n]*)$/gm)];
  const versions = [...source.matchAll(/^\s*version\s+(["'])([^"'\r\n]+)\1[^\r\n]*$/gm)];
  const url = urls[0];
  // Homebrew requires version interpolation even with an immutable commit tag.
  // Only accept its exact expansion; single-quoted Ruby does not interpolate.
  const interpolatedCandidate = url?.[2] === '"' && url[3] === versionedCandidate
    && versions.length === 1 && versions[0][2] === version;
  const finalUrl = url?.[2] === '"' && url[3] === canonical;
  if (urls.length !== 1 || !(url[3] === candidate || interpolatedCandidate || finalUrl)) throw new Error('The audited tap URL does not match this immutable RC or its canonical final URL.');
  return updateTapCask(source.replace(urls[0][0], `${urls[0][1]}"${canonical}"${urls[0][4]}`), version, sha256);
}

export function validateTapContract(root) {
  root = path.resolve(root);
  const caskPath = path.join(root, 'Casks/inkwell.rb');
  const cask = fs.readFileSync(caskPath, 'utf8');
  if (/^\s*(?:postflight|uninstall_postflight)\s+do\b/m.test(cask)) throw new Error('The Homebrew tap still uses deprecated lifecycle callbacks. Upgrade the tap before releasing.');
  if (!/\binstaller\s+script\s*:/.test(cask) || !/\buninstall\s+script\s*:/.test(cask)) throw new Error('The Homebrew tap must define supported install and uninstall script lifecycle methods.');
  const files = [];
  const walk = directory => {
    if (!fs.existsSync(directory)) return;
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error('The Homebrew lifecycle contract cannot follow symbolic links.');
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) files.push(file);
    }
  };
  for (const directory of ['scripts', 'lib', 'test', 'tests']) walk(path.join(root, directory));
  const runtime = [cask, ...files.filter(file => /\.(?:sh|rb|[cm]?js)$/.test(file) && !/^(?:test|tests)[/\\]/.test(path.relative(root, file)))
    .map(file => fs.readFileSync(file, 'utf8'))].join('\n');
  if (!runtime.includes('out/install-cli.js') || !runtime.includes('--uninstall')) throw new Error('The Homebrew tap must route installation and removal through the shared out/install-cli.js lifecycle.');
  const testFiles = files.filter(file => /^(?:test|tests)[/\\]/.test(path.relative(root, file)) && /lifecycle/i.test(path.basename(file)) && /(?:test|spec)/i.test(path.basename(file)) && /\.(?:rb|[cm]?js)$/.test(file));
  if (!testFiles.length) throw new Error('The Homebrew tap is missing mocked lifecycle tests.');
  return { caskPath, testFiles: testFiles.sort() };
}

export function verifyTapLifecycle(root, execute = spawnSync) {
  const contract = validateTapContract(root);
  const run = (command, args) => {
    const result = execute(command, args, { cwd: root, encoding: 'utf8', env: { ...process.env, GH_TOKEN: undefined, TAP_TOKEN: undefined, GITHUB_TOKEN: undefined }, timeout: 120000 });
    if (result.status !== 0 || result.signal || result.error) throw new Error(`Homebrew lifecycle validation failed: ${command}\n${result.stderr || result.stdout || result.error || result.signal || 'unknown failure'}`);
  };
  run('ruby', ['-c', contract.caskPath]);
  const ruby = contract.testFiles.filter(file => file.endsWith('.rb'));
  const node = contract.testFiles.filter(file => !file.endsWith('.rb'));
  if (ruby.length) run('ruby', ['-Itest', '-Itests', '-e', 'ARGV.each { |file| require File.expand_path(file) }', ...ruby]);
  if (node.length) run(process.execPath, ['--test', ...node]);
  return contract;
}

function githubOutputs(values) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'preflight' && args.length === 0) {
      const result = validateReleasePrerequisites({ packageJson: JSON.parse(fs.readFileSync('package.json', 'utf8')), tag: process.env.RELEASE_TAG, tapToken: process.env.TAP_TOKEN });
      githubOutputs(result); console.log(`Release prerequisites passed for ${result.tag}.`);
    } else if (command === 'checksums' && args.length === 2) {
      const result = writeReleaseChecksums(args[0], args[1]);
      githubOutputs({ filename: result.filename, sha256: result.sha256 });
      console.log(`Verified the packaged VSIX and wrote ${result.checksumPath}.`);
    } else if (command === 'verify-published' && args.length === 3) {
      const result = verifyPublishedArtifact(args[0], args[1], args[2]);
      githubOutputs({ filename: result.filename, sha256: result.sha256 });
      console.log('Verified the immutable public VSIX and its published checksum; no assets were changed.');
    } else if (command === 'notes' && args.length === 4 && ['pending', 'complete'].includes(args[0])) {
      const [state, releaseFile, tag, output] = args;
      fs.writeFileSync(output, releaseNotes(JSON.parse(fs.readFileSync(releaseFile, 'utf8')).body, tag, state === 'pending'));
    } else if (command === 'verify-tap' && args.length === 1) {
      verifyTapLifecycle(path.resolve(args[0]));
      console.log('The Homebrew cask syntax and mocked shared-installer lifecycle tests passed.');
    } else if (command === 'tap' && args.length === 3 || command === 'promote-tap' && args.length === 4) {
      const [file, version, checksumFile, releaseCommit] = args;
      if (!validVersion(version)) throw new Error('The tap release version is invalid.');
      const entries = fs.readFileSync(checksumFile, 'utf8').trim().split(/\r?\n/).map(line => line.split(/\s+/)).filter(([, name]) => name === `inkwell-${version}.vsix`);
      if (entries.length !== 1) throw new Error('SHA256SUMS must identify exactly one matching release artifact.');
      const source = fs.readFileSync(file, 'utf8');
      const updated = command === 'promote-tap' ? promoteTapCandidate(source, version, entries[0][0], releaseCommit) : updateTapCask(source, version, entries[0][0]);
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try { fs.writeFileSync(temporary, updated, { flag: 'wx' }); fs.renameSync(temporary, file); }
      finally { fs.rmSync(temporary, { force: true }); }
      console.log('Prepared the matching Homebrew cask update.');
    } else throw new Error('Usage: release-contract.mjs preflight | checksums FILE.vsix vVERSION | verify-published FILE.vsix SHA256SUMS vVERSION | notes pending|complete RELEASE_JSON vVERSION OUTPUT | verify-tap TAP_ROOT | tap CASK VERSION SHA256SUMS | promote-tap CASK VERSION SHA256SUMS RELEASE_COMMIT');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
