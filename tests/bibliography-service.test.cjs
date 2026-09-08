const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDocumentConfig } = require('../out/document-config');
const { BibliographyService, indexBibtex, resolveBibliographyConfiguration } = require('../out/bibliography-service');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-bibliography-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'chapters/document.md');
  const write = (relative, text) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  return { root, source, write, config: yaml => resolveDocumentConfig({ text: `---\n${yaml}\n---\n`, sourcePath: source }) };
}
const bib = (key, title = key) => `@book{${key}, author={Doe, Jane}, title={${title}}, year={2026}}\n`;

test('one immutable reference configuration resolves path forms, provenance, typography and explicit empty discovery', t => {
  const f = fixture(t), declared = f.write('chapters/local.bib', bib('local'));
  const alpha = f.write('references/a.bib', bib('a')), zeta = f.write('references/z.bib', bib('z'));
  const csl = f.write('chapters/local.csl', '<style/>');
  for (const form of ['local.bib', '[local.bib]', '\n  - local.bib']) {
    const resolved = resolveBibliographyConfiguration(f.config(`bibliography: ${form}\ncsl: local.csl\nreferences:\n  scope: section\n  heading: Sources\n  hangingIndent: false\n  lineSpacing: 1.2\n  entrySpacing: 2\n  pageBreak: true\n  fontSize: 9pt`), f.source, f.root);
    assert.deepEqual(resolved.bibliography, [declared]); assert.equal(resolved.csl, csl);
    assert.equal(resolved.sources[0].provenance.source, 'document'); assert.equal(resolved.sources.length, 1);
    assert.equal(resolved.scope, 'section'); assert.equal(resolved.referencesHeading, 'Sources');
    assert.equal(resolved.hangingIndent, '0pt'); assert.equal(resolved.lineSpacing, 1.2); assert.equal(resolved.entrySpacing, '2.4em');
    assert.equal(resolved.pageBreak, 'always'); assert.equal(resolved.fontSizePt, 9);
    assert.ok(Object.isFrozen(resolved)); assert.ok(Object.isFrozen(resolved.sources[0]));
  }
  assert.deepEqual(resolveBibliographyConfiguration(f.config(''), f.source, f.root).bibliography, [alpha, zeta]);
  assert.deepEqual(resolveBibliographyConfiguration(f.config('bibliography: []'), f.source, f.root).bibliography, []);
});

test('index understands escaped delimiters, nested braces, quotes, parentheses, comments and macro values', async () => {
  const source = `% @book{ignored,title={Comment}}\n@string{publisher = "Publisher"}\n@book(real, title={Outer {Nested} \\{brace\\} @book{fake,} and field=literal}, author="Doe, Jane", year=2026, publisher=publisher # " House")\n@article{second,title="Escaped \\" quote",year={2025}}`;
  const index = await indexBibtex(source, '/references/test.bib');
  assert.deepEqual(index.entries.map(entry => entry.key), ['real', 'second']);
  assert.equal(index.entries[0].line, 3); assert.equal(index.entries[0].column, 1);
  assert.match(index.entries[0].title, /Nested/); assert.equal(index.entries[0].year, '2026');
  assert.deepEqual(index.diagnostics, []);
});

test('malformed entries and all duplicate definitions have deterministic source diagnostics', async t => {
  const f = fixture(t), first = f.write('first.bib', bib('duplicate', 'First'));
  const last = f.write('references/last.bib', bib('duplicate', 'Last') + '@book{broken,title={Unclosed');
  const service = new BibliographyService(), snapshot = await service.resolve(f.config('bibliography: [first.bib, references/last.bib]'), f.source, f.root, 'pandoc 3.9');
  const duplicates = snapshot.diagnostics.filter(item => item.code === 'bibliography-duplicate');
  assert.deepEqual(duplicates.map(item => item.sourcePath), [first, last]);
  assert.equal(duplicates[0].related[0].sourcePath, last);
  assert.match(duplicates[0].message, /first file/);
  assert.equal(snapshot.entries.filter(item => item.key === 'duplicate').at(0).title, 'First');
  assert.equal(snapshot.diagnostics.find(item => item.code === 'bibliography-malformed').line, 2);
});

test('content, CSL, version and targeted invalidation determine cache identity despite restored mtime', async t => {
  const f = fixture(t), file = f.write('refs.bib', bib('key', 'Alpha'));
  const csl = f.write('style.csl', '<style>first</style>');
  const service = new BibliographyService(), config = f.config('bibliography: refs.bib\ncsl: style.csl');
  const first = await service.resolve(config, f.source, f.root, 'pandoc 3.9');
  const warm = await service.resolve(config, f.source, f.root, 'pandoc 3.9');
  assert.equal(first.fingerprint, warm.fingerprint); assert.equal(first.entries[0], warm.entries[0]);
  const stat = fs.statSync(file); f.write('refs.bib', bib('key', 'Bravo')); fs.utimesSync(file, stat.atime, stat.mtime);
  const edited = await service.resolve(config, f.source, f.root, 'pandoc 3.9');
  assert.notEqual(edited.contentHashes[file], first.contentHashes[file]);
  assert.notEqual(edited.fingerprint, first.fingerprint);
  f.write('style.csl', '<style>other</style>'); service.invalidate(csl);
  const styled = await service.resolve(config, f.source, f.root, 'pandoc 3.9');
  assert.notEqual(styled.cslHash, edited.cslHash);
  assert.notEqual((await service.resolve(config, f.source, f.root, 'pandoc 3.10')).fingerprint, styled.fingerprint);
  assert.ok(Object.isFrozen(styled.entries[0]));
});

test('5000-entry indexing yields to the host and warm lookup requires no parsing or child process', async t => {
  const f = fixture(t); f.write('large.bib', Array.from({ length: 5000 }, (_, index) => bib(`key${index}`)).join(''));
  const service = new BibliographyService(), config = f.config('bibliography: large.bib');
  let ticks = 0; const timer = setInterval(() => ticks++, 1);
  const start = performance.now();
  let snapshot;
  try { snapshot = await service.resolve(config, f.source, f.root); } finally { clearInterval(timer); }
  assert.equal(snapshot.entries.length, 5000); assert.ok(ticks > 3, `host received ${ticks} timer opportunities`);
  const warmStart = performance.now(), warm = await service.resolve(config, f.source, f.root);
  assert.equal(warm.entries[4999], snapshot.entries[4999]);
  assert.equal(warm.entries.find(entry => entry.key === 'key4567').key, 'key4567');
  t.diagnostic(`Index cold=${(warmStart-start).toFixed(1)}ms warm=${(performance.now()-warmStart).toFixed(1)}ms hostTicks=${ticks}`);
});

test('lookup uses the last definition within the first file while diagnosing every definition', async t => {
  const f = fixture(t), first = f.write('first.bib', bib('same', 'FirstWithinFile') + bib('same', 'LastWithinFirstFile'));
  f.write('second.bib', bib('same', 'LaterFile'));
  const snapshot = await new BibliographyService().resolve(f.config('bibliography: [first.bib, second.bib]'), f.source, f.root);
  const chosen = require('../out/bibliography-service').preferredBibliographyEntry(snapshot.entries);
  assert.equal(chosen.title, 'LastWithinFirstFile'); assert.equal(chosen.sourcePath, first);
  const diagnostics = snapshot.diagnostics.filter(item => item.code === 'bibliography-duplicate');
  assert.equal(diagnostics.length, 3); assert.ok(diagnostics.every(item => item.message.includes(`${first}:2`)));
});
