import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { ASSET_MANIFEST_PATH, CORE_ASSETS, buildAssetManifest, readBundledAssetPaths, writeAssetManifest, isReleaseVersion } from '../scripts/build-asset-manifest.mjs';
import { readZipEntries, verifyVsix } from '../scripts/verify-vsix.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = 'v0.5.0';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-vsix-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, bytes) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
    return full;
  };
  write('src/bundled-assets.ts', fs.readFileSync(path.join(repo, 'src/bundled-assets.ts')));
  for (const relative of new Set([...CORE_ASSETS, ...readBundledAssetPaths(repo)])) write(relative, `fixture:${relative}\n`);
  write('package.json', JSON.stringify({ publisher: 'measure-one', name: 'inkwell', version: '0.5.0', main: './out/extension.js' }));
  write('media/vendor/pdfjs/pdf.mjs', 'export const local = true;\n');
  write('examples/demo-default.pdf', '%PDF-1.4 reference example\n');
  write('templates/nested/new/support.sty', 'nested support\n');
  write('out/doctor-cli.js', 'console.log("doctor");\n');
  write('out/install-cli.js', 'console.log("installer");\n');
  const manifest = writeAssetManifest(root);
  const entries = () => [
    ['[Content_Types].xml', '<Types/>'],
    ['extension.vsixmanifest', '<PackageManifest><Metadata><Identity Id="inkwell" Publisher="measure-one" Version="0.5.0"/></Metadata></PackageManifest>'],
    ...Object.keys(manifest.files).map(relative => [`extension/${relative}`, fs.readFileSync(path.join(root, relative))]),
    [`extension/${ASSET_MANIFEST_PATH}`, fs.readFileSync(path.join(root, ASSET_MANIFEST_PATH))],
  ];
  return { root, write, manifest, entries };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build deliberately controllable ZIP fixtures without a system zip utility. */
function zip(entries, { deflated = false, mode = 0o100644 } = {}) {
  const localParts = [], directoryParts = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name), bytes = Buffer.from(content), data = deflated ? deflateRawSync(bytes) : bytes;
    const checksum = crc32(bytes), method = deflated ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    localParts.push(local, nameBytes, data); directoryParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(directoryParts), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

test('asset contract is deterministic and inventories recursive runtime assets without private files', t => {
  const f = fixture(t);
  f.write('examples/.inkwell/outputs/private.txt', 'private run data');
  f.write('node_modules/private.js', 'private dependency');
  f.write('.cursor/skills/private/SKILL.md', 'private skill');
  f.write('out/accidental-tsc-output.js', 'not a bundle');
  assert.deepEqual(buildAssetManifest(f.root), f.manifest);
  for (const relative of ['media/vendor/pdfjs/pdf.mjs', 'examples/demo-default.pdf', 'templates/nested/new/support.sty', 'out/doctor-cli.js', 'out/install-cli.js']) {
    assert.match(f.manifest.files[relative].sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(f.manifest.files[ASSET_MANIFEST_PATH], undefined);
  assert.equal(Object.keys(f.manifest.files).some(relative => /private|accidental/.test(relative)), false);
});

test('asset generation fails when an explicitly required example is missing', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, 'examples/demo-rmxaa.md'));
  assert.throws(() => buildAssetManifest(f.root), /demo-rmxaa/);
});

test('asset generation rejects symlinks instead of following runtime files outside its root', t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, 'package.json'), path.join(f.root, 'media/linked.json'));
  assert.throws(() => buildAssetManifest(f.root), /Symbolic links/);
});

for (const deflated of [false, true]) test(`verifies a complete ${deflated ? 'deflated' : 'stored'} VSIX from its actual bytes`, t => {
  const f = fixture(t);
  const result = verifyVsix(zip(f.entries(), { deflated }), { tag });
  assert.equal(result.ok, true);
  assert.equal(result.assetCount, Object.keys(f.manifest.files).length);
  assert.equal(result.identity, 'measure-one.inkwell');
});

for (const change of ['missing', 'tampered']) test(`rejects a ${change} packaged asset`, t => {
  const f = fixture(t), target = 'extension/templates/nested/new/support.sty';
  const entries = change === 'missing' ? f.entries().filter(([name]) => name !== target)
    : f.entries().map(([name, bytes]) => [name, name === target ? 'changed bytes' : bytes]);
  assert.throws(() => verifyVsix(zip(entries), { tag }), /Missing packaged asset|Asset hash\/size mismatch/);
});

test('rejects a release tag mismatch and a missing tag', t => {
  const f = fixture(t), archive = zip(f.entries());
  for (const wrong of ['0.5.0', 'v0.4.0', 'refs/tags/v0.5.0', undefined]) assert.throws(() => verifyVsix(archive, { tag: wrong }), /Release tag must be exactly v0.5.0/);
});

for (const relative of ['examples/demo-default.md', 'out/doctor-cli.js', 'out/install-cli.js', 'out/smoke-cli.js']) test(`a missing ${relative} cannot be hidden by deleting its contract entry too`, t => {
  const f = fixture(t);
  const changed = structuredClone(f.manifest); delete changed.files[relative];
  const entries = f.entries().filter(([name]) => name !== `extension/${relative}`).map(([name, bytes]) =>
    [name, name === `extension/${ASSET_MANIFEST_PATH}` ? JSON.stringify(changed) : bytes]);
  assert.throws(() => verifyVsix(zip(entries), { tag }), /Required asset is absent from contract/);
});

for (const name of ['extension/../escape', '/absolute', 'C:/drive', 'extension\\outside', 'extension//empty']) {
  test(`rejects unsafe ZIP path ${JSON.stringify(name)}`, () => assert.throws(() => readZipEntries(zip([[name, 'data']])), /Unsafe ZIP path/));
}
test('rejects duplicate and case-colliding ZIP paths', () => {
  for (const name of ['extension/a', 'extension/A']) assert.throws(() => readZipEntries(zip([['extension/a', 'one'], [name, 'two']])), /Duplicate ZIP path/);
});
test('rejects file/directory ancestor collisions across case and Unicode normalization', () => {
  for (const [file, child] of [['extension/Foo', 'extension/foo/child'], ['extension/café', 'extension/cafe\u0301/child']]) {
    assert.throws(() => readZipEntries(zip([[file, 'file'], [child, 'child']])), /file\/directory collision/);
  }
});
test('release versions require valid numeric and prerelease components', () => {
  for (const value of ['0.5.0', '1.0.0-rc.1']) assert.equal(isReleaseVersion(value), true);
  for (const value of ['01.0.0', '0.5', '0.5.0-rc..1', '0.5.0-01', '0.5.0\n', undefined]) assert.equal(isReleaseVersion(value), false);
});
test('rejects ZIP symlinks and local/central filename disagreement', () => {
  assert.throws(() => readZipEntries(zip([['extension/link', 'target']], { mode: 0o120777 })), /symbolic link/);
  const archive = zip([['extension/file', 'data']]); archive[30] = 'x'.charCodeAt(0);
  assert.throws(() => readZipEntries(archive), /local\/central mismatch/);
});
test('rejects corrupt ZIP content and invalid archive bounds', () => {
  const archive = zip([['extension/file', 'data']]); archive[30 + 'extension/file'.length] ^= 1;
  assert.throws(() => readZipEntries(archive), /checksum\/size mismatch/);
  assert.throws(() => readZipEntries(archive.subarray(0, archive.length - 1)), /end record/);
});

for (const relative of ['src/private.ts', 'out/runner.js', 'examples/.inkwell/private.txt', '.cursor/skills/private.md', 'media/unlisted.js']) {
  test(`rejects unintended packaged file ${relative}`, t => {
    const f = fixture(t);
    assert.throws(() => verifyVsix(zip([...f.entries(), [`extension/${relative}`, 'unintended']]), { tag }), /must not ship|Unexpected executable|absent from contract/);
  });
}

test('VSIX identity must match the packaged extension identity and version', t => {
  const f = fixture(t);
  const entries = f.entries().map(([name, bytes]) => [name, name === 'extension.vsixmanifest'
    ? '<Identity Id="other" Publisher="measure-one" Version="0.5.0"/>' : bytes]);
  assert.throws(() => verifyVsix(zip(entries), { tag }), /Identity does not match/);
});

test('CLI reports machine-readable success/failure with matching exit statuses', t => {
  const f = fixture(t), file = f.write('fixture.vsix', zip(f.entries()));
  const script = path.join(repo, 'scripts/verify-vsix.mjs');
  const success = spawnSync(process.execPath, [script, file, '--tag', tag, '--json'], { encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr); assert.equal(JSON.parse(success.stdout).ok, true);
  const failure = spawnSync(process.execPath, [script, file, '--tag', 'wrong', '--json'], { encoding: 'utf8' });
  assert.equal(failure.status, 1); assert.equal(JSON.parse(failure.stdout).ok, false);
  const generated = spawnSync(process.execPath, [path.join(repo, 'scripts/build-asset-manifest.mjs'), '--root', f.root, '--json'], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stdout); assert.equal(JSON.parse(generated.stdout).assetCount, Object.keys(f.manifest.files).length);
});
