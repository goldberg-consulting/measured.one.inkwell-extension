import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPreviewAssetPaths } from './build-preview-assets.mjs';

export const ASSET_MANIFEST_PATH = 'out/assets-manifest.json';
export const RUNTIME_TREES = ['templates', 'filters', 'csl', 'media', 'examples'];
export const RUNTIME_BUNDLES = ['out/extension.js', 'out/doctor-cli.js', 'out/install-cli.js', 'out/smoke-cli.js'];
export const CORE_ASSETS = ['package.json', ...RUNTIME_BUNDLES, 'guide.md', '.cursor/agents/inkwell-guide.md',
  'requirements-latex.txt', 'examples/requirements.txt', 'schemas/doctor.schema.json', 'media/icon.png', 'media/preview.css', 'media/preview.js'];
const privateParts = new Set(['.git', '.github', '.husky', '.inkwell', '.codex', '.agents', 'node_modules',
  '__pycache__', '.venv', 'venv', '.ds_store', '.ssh', '.aws', '.azure', '.config', '.cache', '.vscode']);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function isSafeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !/[\x00-\x1f\x7f:]/.test(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..');
}

export function isReleaseVersion(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/);
  return Boolean(match && (!match[4] || match[4].split('.').every(part => /^[0-9A-Za-z-]+$/.test(part) && !/^0\d+$/.test(part))));
}

export function isPrivatePath(value) {
  const normalized = value.toLowerCase();
  const parts = normalized.split('/');
  return parts.some(part => privateParts.has(part) || /^\.env(?:\.|$)/.test(part))
    || ['src', 'tests', 'benchmarks'].includes(parts[0])
    || (parts[0] === '.cursor' && normalized !== '.cursor/agents/inkwell-guide.md')
    || /\.(?:pem|key|p12|pfx|vsix)$/i.test(value);
}

/** A release can load scripts/styles only from its packaged resource tree. */
export function verifyRuntimeResourceUrls(relative, bytes) {
  if (!/\.(?:[cm]?js|css|html)$/i.test(relative)) return;
  // Unescape quotes from HTML shells embedded in a bundled JavaScript string.
  const source = bytes.toString('utf8').replace(/\\(["'])/g, '$1');
  const remote = '(?:https?:)?//';
  const patterns = [
    new RegExp(`<script\\b[^>]*\\bsrc\\s*=\\s*["']\\s*${remote}`, 'i'),
    new RegExp(`<link\\b(?=[^>]*\\brel\\s*=\\s*["'](?:stylesheet|modulepreload)["'])[^>]*\\bhref\\s*=\\s*["']\\s*${remote}`, 'i'),
    new RegExp(`\\b(?:import|importScripts)\\s*\\(\\s*["']${remote}`, 'i'),
    new RegExp(`\\bimport\\s*["']${remote}`, 'i'),
    new RegExp(`\\b(?:import|export)\\s+[^;\\n]*?\\bfrom\\s*["']${remote}`, 'i'),
    new RegExp(`@import\\s+(?:url\\(\\s*)?["']?${remote}`, 'i'),
  ];
  if (patterns.some(pattern => pattern.test(source))) throw new Error(`Remote runtime script/style URL is forbidden: ${relative}`);
}

/** Validate the vendor's independent provenance against the bytes being shipped. */
export function verifyPreviewAssets(readAsset) {
  const provenanceBytes = readAsset('media/vendor/versions.json');
  if (!provenanceBytes) throw new Error('Missing required preview vendor provenance.');
  const provenance = JSON.parse(provenanceBytes.toString('utf8'));
  const required = readPreviewAssetPaths(undefined, provenance);
  for (const relative of required) {
    const bytes = readAsset(relative);
    if (!bytes?.length) throw new Error(`Missing required preview asset: ${relative}`);
    const expected = provenance.files[relative.slice('media/vendor/'.length)];
    if (relative.startsWith('media/vendor/') && expected && (bytes.length !== expected.size
        || crypto.createHash('sha256').update(bytes).digest('hex') !== expected.sha256)) {
      throw new Error(`Preview vendor hash/size mismatch: ${relative}`);
    }
  }
  return required;
}

/** Read the explicit runtime list without executing extension code or requiring a tsc build. */
export function readBundledAssetPaths(root = repositoryRoot) {
  const source = fs.readFileSync(path.join(root, 'src/bundled-assets.ts'), 'utf8');
  const match = source.match(/export const BUNDLED_ASSET_PATHS\b[^=]*=\s*(\[[\s\S]*?\]);/);
  if (!match) throw new Error('Cannot locate BUNDLED_ASSET_PATHS in src/bundled-assets.ts.');
  const paths = JSON.parse(match[1].replace(/,\s*]/g, ']'));
  if (!Array.isArray(paths) || paths.some(item => !isSafeRelativePath(item))) throw new Error('Invalid bundled asset path list.');
  return paths;
}

function regularFile(root, relative) {
  if (!isSafeRelativePath(relative) || isPrivatePath(relative)) throw new Error(`Unsafe asset path: ${relative}`);
  let current = root;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links cannot enter the asset contract: ${relative}`);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Asset is not a regular file: ${relative}`);
  }
  const stat = fs.statSync(current);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Required asset is missing or empty: ${relative}`);
  return current;
}

/** Inventory only runtime trees, skipping private directories before descending into them. */
export function buildAssetManifest(root = repositoryRoot) {
  root = path.resolve(root);
  const previewPaths = verifyPreviewAssets(relative => fs.readFileSync(regularFile(root, relative)));
  const files = new Set([...CORE_ASSETS, ...readBundledAssetPaths(root), ...previewPaths]);
  const walk = relative => {
    if (isPrivatePath(relative)) return;
    const full = path.join(root, relative);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links cannot enter the asset contract: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(full).sort()) walk(`${relative}/${entry}`);
    } else if (stat.isFile()) {
      files.add(relative);
    } else throw new Error(`Asset is not a regular file: ${relative}`);
  };
  for (const tree of RUNTIME_TREES) walk(tree);
  for (const bundle of RUNTIME_BUNDLES) if (fs.existsSync(path.join(root, bundle))) files.add(bundle);
  const packageJson = JSON.parse(fs.readFileSync(regularFile(root, 'package.json'), 'utf8'));
  if (packageJson.name !== 'inkwell' || packageJson.publisher !== 'measure-one'
      || !isReleaseVersion(packageJson.version)) {
    throw new Error('Expected the measure-one.inkwell package with a valid release version.');
  }
  if (packageJson.main !== './out/extension.js' && packageJson.main !== 'out/extension.js') throw new Error('Unexpected extension entry point.');
  const manifest = { schemaVersion: 1, extensionVersion: packageJson.version, publisher: packageJson.publisher,
    name: packageJson.name, files: {} };
  const names = new Set();
  for (const relative of [...files].sort()) {
    if (relative.startsWith('media/vendor/') && !previewPaths.includes(relative)) throw new Error(`Unlisted preview vendor asset: ${relative}`);
    const canonical = relative.normalize('NFC').toLowerCase();
    if (names.has(canonical)) throw new Error(`Colliding asset path: ${relative}`);
    names.add(canonical);
    const bytes = fs.readFileSync(regularFile(root, relative));
    verifyRuntimeResourceUrls(relative, bytes);
    manifest.files[relative] = { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  }
  return manifest;
}

export function writeAssetManifest(root = repositoryRoot) {
  const manifest = buildAssetManifest(root);
  const target = path.join(root, ASSET_MANIFEST_PATH);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  try {
    if (args.includes('--help')) {
      console.log('Usage: node scripts/build-asset-manifest.mjs [--root PATH] [--json]');
    } else {
      let root = repositoryRoot;
      for (let index = 0; index < args.length; index++) {
        if (args[index] === '--json') continue;
        if (args[index] === '--root' && args[index + 1]) root = path.resolve(args[++index]);
        else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
      }
      const manifest = writeAssetManifest(root);
      const result = { ok: true, manifest: path.join(root, ASSET_MANIFEST_PATH), extensionVersion: manifest.extensionVersion,
        assetCount: Object.keys(manifest.files).length };
      console.log(json ? JSON.stringify(result) : `Asset contract written: ${result.assetCount} files for ${manifest.publisher}.${manifest.name}@${manifest.extensionVersion}.`);
    }
  } catch (error) {
    const result = { ok: false, error: error.message };
    (json ? console.log : console.error)(json ? JSON.stringify(result) : `Asset contract failed: ${result.error}`);
    process.exitCode = 1;
  }
}
