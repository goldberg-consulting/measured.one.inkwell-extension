import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ASSET_MANIFEST_PATH, CORE_ASSETS, RUNTIME_BUNDLES, RUNTIME_TREES,
  isPrivatePath, isSafeRelativePath, isReleaseVersion, readBundledAssetPaths } from './build-asset-manifest.mjs';

const MAX_ARCHIVE = 512 * 1024 * 1024;
const MAX_FILE = 256 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
const crcTable = Array.from({ length: 256 }, (_, number) => {
  for (let bit = 0; bit < 8; bit++) number = (number >>> 1) ^ ((number & 1) ? 0xedb88320 : 0);
  return number >>> 0;
});
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

/** Inspect stored/deflated ZIP entries in memory; no archive pathname reaches the filesystem. */
export function readZipEntries(bytes) {
  requireCondition(Buffer.isBuffer(bytes) && bytes.length >= 22 && bytes.length <= MAX_ARCHIVE, 'Invalid or oversized ZIP archive.');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  requireCondition(end >= 0, 'ZIP end record is missing.');
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  requireCondition(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0
    && bytes.readUInt16LE(end + 8) === count, 'Multi-disk ZIP archives are unsupported.');
  requireCondition(count !== 0xffff && directorySize !== 0xffffffff && directoryOffset !== 0xffffffff, 'ZIP64 archives are unsupported.');
  requireCondition(directoryOffset + directorySize === end, 'Invalid ZIP central directory bounds.');
  const entries = new Map(), names = new Set(), ranges = [];
  let cursor = directoryOffset, total = 0;
  for (let index = 0; index < count; index++) {
    requireCondition(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50, 'Invalid ZIP directory entry.');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16), compressedSize = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42), external = bytes.readUInt32LE(cursor + 38);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    requireCondition(next <= end && nameLength > 0 && bytes.readUInt16LE(cursor + 34) === 0, 'Invalid ZIP entry bounds.');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
    const directory = name.endsWith('/'), normalized = directory ? name.slice(0, -1) : name;
    requireCondition(isSafeRelativePath(normalized), `Unsafe ZIP path: ${name}`);
    const collisionKey = normalized.normalize('NFC').toLowerCase();
    requireCondition(!names.has(collisionKey), `Duplicate ZIP path: ${name}`);
    names.add(collisionKey);
    requireCondition((external >>> 16 & 0xf000) !== 0xa000, `ZIP symbolic link is forbidden: ${name}`);
    requireCondition(!(flags & 1) && !(flags & 64) && [0, 8].includes(method), `Unsupported ZIP encryption/compression: ${name}`);
    requireCondition(size <= MAX_FILE && (total += size) <= MAX_TOTAL, 'ZIP uncompressed size exceeds the limit.');
    requireCondition(local + 30 <= directoryOffset && bytes.readUInt32LE(local) === 0x04034b50, `Invalid ZIP local header: ${name}`);
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtraLength;
    requireCondition(start + compressedSize <= directoryOffset && bytes.subarray(local + 30, local + 30 + localNameLength).equals(rawName)
      && bytes.readUInt16LE(local + 6) === flags && bytes.readUInt16LE(local + 8) === method, `ZIP local/central mismatch: ${name}`);
    if (!(flags & 8)) requireCondition(bytes.readUInt32LE(local + 14) === checksum && bytes.readUInt32LE(local + 18) === compressedSize
      && bytes.readUInt32LE(local + 22) === size, `ZIP local sizes/checksum mismatch: ${name}`);
    ranges.push([local, start + compressedSize]);
    const compressed = bytes.subarray(start, start + compressedSize);
    const content = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.min(MAX_FILE, size + 1) });
    requireCondition(content.length === size && crc32(content) === checksum, `ZIP checksum/size mismatch: ${name}`);
    requireCondition(!directory || size === 0, `ZIP directory has content: ${name}`);
    if (!directory) entries.set(name, content);
    cursor = next;
  }
  requireCondition(cursor === end, 'ZIP directory entry count mismatch.');
  ranges.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < ranges.length; index++) requireCondition(ranges[index][0] >= ranges[index - 1][1], 'Overlapping ZIP entries.');
  const fileKeys = new Set([...entries.keys()].map(name => name.normalize('NFC').toLowerCase()));
  for (const name of entries.keys()) {
    const pieces = name.normalize('NFC').toLowerCase().split('/');
    while (pieces.length > 1) { pieces.pop(); requireCondition(!fileKeys.has(pieces.join('/')), `ZIP file/directory collision: ${name}`); }
  }
  return entries;
}

function jsonEntry(entries, name) {
  const bytes = entries.get(name);
  requireCondition(bytes && bytes.length <= 8 * 1024 * 1024, `Missing or oversized JSON entry: ${name}`);
  const value = JSON.parse(bytes.toString('utf8'));
  requireCondition(value && typeof value === 'object' && !Array.isArray(value), `Invalid JSON object: ${name}`);
  return value;
}

function xmlIdentity(bytes) {
  requireCondition(bytes && bytes.length < 1024 * 1024, 'Missing or oversized extension.vsixmanifest.');
  const text = bytes.toString('utf8');
  requireCondition(!/<!DOCTYPE|<!ENTITY/i.test(text), 'VSIX manifest entities are unsupported.');
  const identity = [...text.matchAll(/<Identity\b([^>]*)\/?\s*>/g)];
  requireCondition(identity.length === 1, 'VSIX manifest must have exactly one Identity.');
  const pairs = [...identity[0][1].matchAll(/([\w:]+)\s*=\s*(["'])(.*?)\2/g)].map(match => [match[1], match[3]]);
  requireCondition(new Set(pairs.map(([name]) => name)).size === pairs.length, 'Duplicate VSIX Identity attribute.');
  const attributes = Object.fromEntries(pairs);
  return attributes;
}

export function verifyVsix(file, { tag, requiredPaths = readBundledAssetPaths() } = {}) {
  const archive = Buffer.isBuffer(file) ? file : (() => {
    requireCondition(fs.statSync(file).size <= MAX_ARCHIVE, 'VSIX exceeds the archive size limit.');
    return fs.readFileSync(file);
  })();
  const entries = readZipEntries(archive);
  const packageJson = jsonEntry(entries, 'extension/package.json');
  requireCondition(packageJson.name === 'inkwell' && packageJson.publisher === 'measure-one', 'Unexpected package identity; expected measure-one.inkwell.');
  requireCondition(isReleaseVersion(packageJson.version), 'Invalid package version.');
  requireCondition(tag === `v${packageJson.version}`, `Release tag must be exactly v${packageJson.version}; received ${tag ?? '(missing)'}.`);
  requireCondition(['./out/extension.js', 'out/extension.js'].includes(packageJson.main), 'Unexpected extension entry point.');
  const identity = xmlIdentity(entries.get('extension.vsixmanifest'));
  requireCondition(identity.Id === packageJson.name && identity.Publisher === packageJson.publisher && identity.Version === packageJson.version, 'VSIX Identity does not match package.json.');
  requireCondition(entries.has('[Content_Types].xml'), 'Missing VSIX content types.');
  const manifest = jsonEntry(entries, `extension/${ASSET_MANIFEST_PATH}`);
  requireCondition(manifest.schemaVersion === 1 && manifest.extensionVersion === packageJson.version && manifest.publisher === packageJson.publisher
    && manifest.name === packageJson.name && manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files), 'Asset manifest identity/schema mismatch.');
  for (const relative of [...CORE_ASSETS, ...requiredPaths]) requireCondition(Object.hasOwn(manifest.files, relative), `Required asset is absent from contract: ${relative}`);
  const allowedOut = new Set([...RUNTIME_BUNDLES, ASSET_MANIFEST_PATH]);
  for (const [relative, expected] of Object.entries(manifest.files)) {
    requireCondition(isSafeRelativePath(relative) && !isPrivatePath(relative) && relative !== ASSET_MANIFEST_PATH, `Unsafe asset contract path: ${relative}`);
    requireCondition(expected && /^[a-f0-9]{64}$/.test(expected.sha256) && Number.isSafeInteger(expected.size) && expected.size > 0, `Invalid asset hash/size: ${relative}`);
    const bytes = entries.get(`extension/${relative}`);
    requireCondition(bytes, `Missing packaged asset: ${relative}`);
    requireCondition(bytes.length === expected.size && crypto.createHash('sha256').update(bytes).digest('hex') === expected.sha256, `Asset hash/size mismatch: ${relative}`);
  }
  for (const name of entries.keys()) {
    if (['extension.vsixmanifest', '[Content_Types].xml'].includes(name)) continue;
    requireCondition(name.startsWith('extension/'), `Unexpected archive root entry: ${name}`);
    const relative = name.slice('extension/'.length);
    requireCondition(!isPrivatePath(relative), `Private/source file must not ship: ${relative}`);
    requireCondition(!relative.startsWith('out/') || allowedOut.has(relative), `Unexpected executable/build output: ${relative}`);
    const needsContract = RUNTIME_TREES.some(tree => relative.startsWith(`${tree}/`)) || relative.startsWith('out/')
      || /\.(?:js|mjs|cjs|wasm|sh|py|rb|exe|dll|dylib|so)$/i.test(relative);
    requireCondition(!needsContract || relative === ASSET_MANIFEST_PATH || Object.hasOwn(manifest.files, relative), `Runtime asset is absent from contract: ${relative}`);
  }
  return { ok: true, identity: `${packageJson.publisher}.${packageJson.name}`, version: packageJson.version, tag,
    assetCount: Object.keys(manifest.files).length, archiveSha256: crypto.createHash('sha256').update(archive).digest('hex') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), json = args.includes('--json');
  try {
    if (args.includes('--help')) console.log('Usage: node scripts/verify-vsix.mjs FILE.vsix --tag vVERSION [--json]');
    else {
      let file, tag;
      for (let index = 0; index < args.length; index++) {
        if (args[index] === '--json') continue;
        if (args[index] === '--tag' && args[index + 1]) tag = args[++index];
        else if (!args[index].startsWith('-') && !file) file = args[index];
        else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
      }
      requireCondition(file, 'A VSIX file is required.');
      const result = verifyVsix(file, { tag });
      console.log(json ? JSON.stringify(result) : `Verified ${result.identity}@${result.version}: ${result.assetCount} asset hashes, tag ${result.tag}.`);
    }
  } catch (error) {
    const result = { ok: false, error: error.message };
    (json ? console.log : console.error)(json ? JSON.stringify(result) : `VSIX verification failed: ${result.error}`);
    process.exitCode = 1;
  }
}
