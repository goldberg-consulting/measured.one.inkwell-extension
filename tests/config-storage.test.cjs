const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, ...rest) {
  if (request === 'vscode') return { Uri: { file: fsPath => ({ fsPath }) },
    workspace: { getWorkspaceFolder: () => undefined, getConfiguration: () => ({ get: () => undefined }) } };
  return originalLoad.call(this, request, ...rest);
};
const { saveManifestField, getDocumentConfig, getResolvedReferences } = require('../out/config');
Module._load = originalLoad;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-config-storage-'));
  const inkwell = path.join(root, '.inkwell');
  fs.mkdirSync(inkwell);
  fs.mkdirSync(path.join(root, 'nested'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, inkwell, manifest: path.join(inkwell, 'manifest.json'), source: path.join(root, 'nested', 'doc.md') };
}
function snapshot(root) {
  const result = {};
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) result[path.relative(root, full)] = {
        sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
        mtimeMs: fs.statSync(full).mtimeMs,
      };
    }
  };
  visit(root);
  return result;
}

test('saving a manifest field atomically preserves every unknown JSON value', t => {
  const f = fixture(t);
  const original = { schemaVersion: 4, template: 'default', unknown: { nested: [1, false, null, { text: 'keep # this' }] }, defaults: { typography: { bodySize: '12pt' } } };
  fs.writeFileSync(f.manifest, JSON.stringify(original));
  const before = fs.readFileSync(f.manifest);
  const rename = fs.renameSync;
  let published = false;
  fs.renameSync = function(source, destination) {
    if (destination === f.manifest) {
      published = true;
      assert.equal(path.dirname(source), path.dirname(destination));
      assert.deepEqual(fs.readFileSync(destination), before);
      assert.deepEqual(JSON.parse(fs.readFileSync(source, 'utf8')), { ...original, template: 'rho' });
    }
    return rename.apply(this, arguments);
  };
  try { saveManifestField(f.root, 'template', 'rho'); } finally { fs.renameSync = rename; }
  assert.equal(published, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.manifest, 'utf8')), { ...original, template: 'rho' });
  assert.deepEqual(fs.readdirSync(f.inkwell), ['manifest.json']);
});

test('a failed atomic manifest publication preserves original bytes and removes its temporary file', t => {
  const f = fixture(t);
  fs.writeFileSync(f.manifest, '{"template":"default","unknown":42}\n');
  const before = fs.readFileSync(f.manifest);
  const rename = fs.renameSync;
  fs.renameSync = function(_source, destination) {
    if (destination === f.manifest) throw new Error('mock publication failure');
    return rename.apply(this, arguments);
  };
  try { assert.throws(() => saveManifestField(f.root, 'template', 'rho'), /mock publication failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(f.manifest), before);
  assert.deepEqual(fs.readdirSync(f.inkwell), ['manifest.json']);
});

for (const original of ['{malformed', '[]', 'null', '"scalar"', '42']) {
  test(`malformed/non-object manifest ${JSON.stringify(original)} is backed up and refused without changing bytes`, t => {
    const f = fixture(t);
    fs.writeFileSync(f.manifest, original);
    assert.throws(() => saveManifestField(f.root, 'template', 'rho'), /malformed.*backup:/);
    assert.equal(fs.readFileSync(f.manifest, 'utf8'), original);
    const backups = fs.readdirSync(f.inkwell).filter(name => name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(f.inkwell, backups[0]), 'utf8'), original);
    const after = snapshot(f.root);
    assert.throws(() => saveManifestField(f.root, 'template', 'rho'));
    assert.deepEqual(snapshot(f.root), after, 'repeated refusal reuses the existing identical backup');
  });
}

test('missing declared reference diagnostics retain document key locations and nested path context', t => {
  const f = fixture(t);
  const text = '---\ntitle: Test\nbibliography: missing.bib\ncsl: missing.csl\n---\nBody';
  const resolved = getResolvedReferences(getDocumentConfig(text, f.source), f.source);
  assert.equal(resolved.bibliography[0], path.join(f.root, 'nested', 'missing.bib'));
  assert.equal(resolved.csl, path.join(f.root, 'nested', 'missing.csl'));
  const bib = resolved.diagnostics.find(diagnostic => diagnostic.code === 'bibliography-missing');
  const csl = resolved.diagnostics.find(diagnostic => diagnostic.code === 'csl-missing');
  assert.deepEqual([bib.sourcePath, bib.line, bib.column], [f.source, 3, 1]);
  assert.deepEqual([csl.sourcePath, csl.line, csl.column], [f.source, 4, 1]);
});

test('missing defaults.yaml references retain defaults file locations and project path context', t => {
  const f = fixture(t);
  const defaults = path.join(f.root, 'defaults.yaml');
  fs.writeFileSync(defaults, '# defaults\nmetadata:\n  bibliography: absent.bib\n  csl: absent.csl\n');
  const resolved = getResolvedReferences(getDocumentConfig('# Body', f.source), f.source);
  assert.equal(resolved.bibliography[0], path.join(f.root, 'absent.bib'));
  assert.equal(resolved.csl, path.join(f.root, 'absent.csl'));
  const bib = resolved.diagnostics.find(diagnostic => diagnostic.code === 'bibliography-missing');
  const csl = resolved.diagnostics.find(diagnostic => diagnostic.code === 'csl-missing');
  assert.deepEqual([bib.sourcePath, bib.line, bib.column], [defaults, 3, 3]);
  assert.deepEqual([csl.sourcePath, csl.line, csl.column], [defaults, 4, 3]);
});

test('shared config and reference reads perform zero project writes, including malformed manifests', t => {
  const f = fixture(t);
  fs.writeFileSync(f.manifest, '{"template":"default","unknown":{"keep":true}}\n');
  fs.writeFileSync(path.join(f.root, 'defaults.yaml'), 'bibliography: missing.bib\n');
  const text = '---\ninkwell: {code-display: both}\n---\nBody';
  const before = snapshot(f.root);
  for (let index = 0; index < 2; index++) getResolvedReferences(getDocumentConfig(text, f.source), f.source);
  assert.deepEqual(snapshot(f.root), before);
  fs.writeFileSync(f.manifest, '{broken');
  const malformedBefore = snapshot(f.root);
  const resolved = getDocumentConfig(text, f.source);
  assert.ok(resolved.diagnostics.some(diagnostic => diagnostic.code === 'manifest-invalid'));
  assert.deepEqual(snapshot(f.root), malformedBefore);
});
