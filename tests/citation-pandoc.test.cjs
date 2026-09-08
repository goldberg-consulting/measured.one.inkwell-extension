const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { CitationPandocEngine } = require('../out/citation-pandoc');
const { resolveDocumentConfig } = require('../out/document-config');
const { resolveBibliographyConfiguration, bibliographyService, bibliographyMetadata } = require('../out/bibliography-service');
const { executeRunProcess } = require('../out/run-process');
const binary = process.env.INKWELL_PANDOC || 'pandoc';
const available = cp.spawnSync(binary, ['--version'], { encoding: 'utf8' }).status === 0;
const success = stdout => ({ exitCode: 0, stdout, stderr: '', signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false });

function fixture(t, yaml = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-citation-ast-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'doc.md');
  fs.writeFileSync(path.join(root, 'refs.bib'), '@book{alpha,author={Doe, Jane},title={AlphaTitle},year={2026}}\n@book{beta,author={Roe, John},title={BetaTitle},year={2025}}');
  const config = resolveDocumentConfig({ text: `---\nbibliography: refs.bib\n${yaml}\n---\n`, sourcePath: source });
  const references = resolveBibliographyConfiguration(config, source, root);
  const calls = [];
  const engine = new CitationPandocEngine({ findBinary: () => binary, environment: () => process.env,
    run: async (...args) => { calls.push(args); return executeRunProcess(...args); } });
  return { root, source, references, engine, calls };
}

test('Pandoc AST renders narrative, suppressed, grouped, locators and mixed missing citations', { skip: !available }, async t => {
  const f = fixture(t);
  const result = await f.engine.render('@alpha argues [-@alpha, p. 3]. See [compare @alpha, chap. 2; @beta, pp. 4-5; @missing].\n\n`@notacitation`\n', f.references, f.root);
  assert.ok(result); assert.equal(result.engine, 'pandoc'); assert.equal(result.referencesEmbedded, true);
  assert.deepEqual([...result.resolvedKeys].sort(), ['alpha', 'beta']); assert.deepEqual([...result.missingKeys], ['missing']);
  assert.match(result.body, /AlphaTitle/); assert.match(result.body, /BetaTitle/); assert.match(result.body, /missing\?/);
  assert.match(result.body, /compare/); assert.match(result.body, /chap/); assert.match(result.body, /notacitation/);
  assert.doesNotMatch(result.body, /\{=html\}/);
});

test('reference heading and placement slot each render one list at the intended location', { skip: !available }, async t => {
  for (const slot of ['## References', '::: {#refs}\n:::', '## References\n\n::: {#refs}\n:::']) {
    const f = fixture(t, 'references: {heading: Sources}');
    const result = await f.engine.render(`[@alpha]\n\n${slot}\n\nAfterMarker`, f.references, f.root);
    assert.ok(result);
    assert.equal((result.body.match(/>Sources<\/h2>/g) || []).length, 1);
    assert.equal((result.body.match(/id="refs"/g) || []).length, 1);
    assert.ok(result.body.indexOf('AlphaTitle') < result.body.indexOf('AfterMarker'));
  }
});

test('nocite renders uncited entries and section scope gives each list unique anchors', { skip: !available }, async t => {
  const f = fixture(t, 'nocite: "@*"');
  const all = await f.engine.render('Body without citations', f.references, f.root);
  assert.match(all.body, /AlphaTitle/); assert.match(all.body, /BetaTitle/);
  const section = fixture(t, 'bibliography-scope: section');
  const result = await section.engine.render('# First\n\n[@alpha]\n\n## References\n\n# Second\n\n[@alpha; @beta]\n\n## References', section.references, section.root);
  assert.ok(result);
  assert.equal((result.body.match(/AlphaTitle/g) || []).length, 2);
  assert.equal((result.body.match(/class="[^"\n]*references-heading/g) || []).length, 2);
  const ids = [...result.body.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('identical in-flight renders coalesce and warm content starts zero processes', { skip: !available }, async t => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.engine.render('[@alpha]', f.references, f.root), f.engine.render('[@alpha]', f.references, f.root)]);
  assert.equal(a.body, b.body); assert.equal(f.calls.length, 2, 'one version probe plus one Pandoc render');
  const before = f.calls.length; await f.engine.render('[@alpha]', f.references, f.root); assert.equal(f.calls.length, before);
  const cache = fs.readdirSync(path.join(f.root, '.inkwell/.cache/preview-cites')).find(file => file.endsWith('.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, '.inkwell/.cache/preview-cites', cache))).engine, 'pandoc');
});

test('negative probe expires and explicit invalidation enables a session installation immediately', async t => {
  const f = fixture(t); let present = false, now = 0, probes = 0;
  const engine = new CitationPandocEngine({ environment: () => ({ PATH: '/unchanged' }), findBinary: () => present ? '/mock/pandoc' : undefined,
    now: () => now, run: async (_binary, args) => { probes++; return success(args.includes('--version') ? 'pandoc 3.9\n' : '<span data-cites="alpha">[1]</span>'); } });
  assert.equal(await engine.render('[@alpha]', f.references, f.root), undefined);
  present = true; assert.equal(await engine.render('[@alpha]', f.references, f.root), undefined);
  engine.invalidate(); assert.equal((await engine.render('[@alpha]', f.references, f.root)).engine, 'pandoc'); assert.equal(probes, 2);
  present = false; engine.invalidate(); assert.equal(await engine.render('[@beta]', f.references, f.root), undefined);
  present = true; now = 2001; assert.equal((await engine.render('[@beta]', f.references, f.root)).engine, 'pandoc');
});

test('explicit source lists exclude discovery and earlier files win actual preview and PDF citeproc', { skip: !available }, async t => {
  const f = fixture(t);
  const first = path.join(f.root, 'first.bib'), second = path.join(f.root, 'second.bib');
  fs.writeFileSync(first, '@book{duplicate,title={FirstFileWinner},author={One, A},year={2026}}');
  fs.writeFileSync(second, '@book{duplicate,title={SecondFileLoser},author={Two, B},year={2025}}');
  const config = resolveDocumentConfig({ text: '---\nbibliography: [first.bib, second.bib]\ninkwell:\n  references:\n    font-size: 9pt\n    entry-spacing: 0.4em\n    hanging-indent: 2em\n    page-break: always\n---\n', sourcePath: f.source });
  const refs = resolveBibliographyConfiguration(config, f.source, f.root);
  const result = await f.engine.render('[@duplicate; @alpha]', refs, f.root);
  assert.ok(result); assert.match(result.body, /FirstFileWinner/); assert.doesNotMatch(result.body, /SecondFileLoser/);
  assert.deepEqual([...result.missingKeys], ['alpha']); assert.ok(Math.abs(Number(result.body.match(/--inkwell-reference-entry-space:([\d.]+)pt/)[1]) - 3.6 * 72 / 72.27) < 1e-6);
  const { bibliographyMetadata } = require('../out/bibliography-service');
  const { stringify } = require('yaml');
  const input = `---\n${stringify(bibliographyMetadata(refs))}---\n\n[@duplicate]\n`;
  const proc = cp.spawnSync(binary, ['-f', 'markdown', '-t', 'latex', '--lua-filter', path.resolve('filters/reference-prepare.lua'), '--citeproc', '--lua-filter', path.resolve('filters/reference-render.lua')], { input, encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr); assert.match(proc.stdout, /FirstFileWinner/); assert.doesNotMatch(proc.stdout, /SecondFileLoser/);
  assert.match(proc.stdout, /\\clearpage/); assert.match(proc.stdout, /\\setlength\{\\cslhangindent\}\{18(?:\.0)?pt\}/);
  assert.match(proc.stdout, /\\begin\{CSLReferences\}[\s\S]*?\\setlength\{\\itemsep\}\{3\.6pt\}/);
});

test('nonadjacent and nested reference placements retain text and render exactly one heading and list', { skip: !available }, async t => {
  const { stringify } = require('yaml');
  for (const body of [
    '[@alpha]\n\n## References\n\nExplanationMarker\n\n::: {#refs}\n:::\n',
    '[@alpha]\n\n::: {#refs}\nSlotCommentMarker\n:::\n\nBetweenMarker\n\n::: {#refs}\nSecondCommentMarker\n:::\n',
    '[@alpha]\n\n::: {.wrapper}\n## References\n\nExplanationMarker\n\n::: {#refs}\nSlotCommentMarker\n:::\n:::\n',
  ]) {
    const f = fixture(t, 'inkwell:\n  references:\n    heading: Sources\n    page-break: always');
    const result = await f.engine.render(body, f.references, f.root);
    assert.ok(result); assert.equal((result.body.match(/>Sources<\/h2>/g) || []).length, 1);
    assert.equal((result.body.match(/id="refs"/g) || []).length, 1);
    assert.equal((result.body.match(/AlphaTitle/g) || []).length, 1);
    assert.doesNotMatch(result.body, /inkwell-reference-placement/);
    for (const marker of body.match(/\w+Marker/g) || []) assert.equal(result.body.split(marker).length - 1, 1, marker);
    const input = `---\n${stringify(bibliographyMetadata(f.references))}---\n\n${body}`;
    const pdf = cp.spawnSync(binary, ['-f', 'markdown', '-t', 'latex', '--lua-filter', path.resolve('filters/reference-prepare.lua'), '--citeproc', '--lua-filter', path.resolve('filters/reference-render.lua')], { input, encoding: 'utf8' });
    assert.equal(pdf.status, 0, pdf.stderr); assert.equal((pdf.stdout.match(/\\clearpage/g) || []).length, 1);
    assert.equal((pdf.stdout.match(/AlphaTitle/g) || []).length, 1);
    assert.equal((pdf.stdout.match(/\\begin\{CSLReferences\}/g) || []).length, 1);
    for (const marker of body.match(/\w+Marker/g) || []) assert.equal(pdf.stdout.split(marker).length - 1, 1, marker);
  }
});

test('HTML-encoded citation keys are decoded before missing and resolved classification', { skip: !available }, async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'refs.bib'), '@book{a&b,title={AmpersandTitle},author={Doe, Jane},year={2026}}');
  const result = await f.engine.render('[@a&b; @missing&key]', f.references, f.root);
  assert.deepEqual([...result.resolvedKeys], ['a&b']);
  assert.deepEqual([...result.missingKeys], ['missing&key']);
  assert.equal(result.resolvedKeys.has('missing&key'), false);
});

test('braced URL citation keys preserve punctuation and HTML entities in classification', { skip: !available }, async t => {
  const f = fixture(t), valid = 'https://example.org/a?x=1&y=2', missing = 'https://example.org/missing?x=3&y=4';
  fs.writeFileSync(path.join(f.root, 'refs.bib'), `@book{${valid},title={URLKeyTitle},author={Doe, Jane},year={2026}}`);
  const result = await f.engine.render(`[@{${valid}}; @{${missing}}]`, f.references, f.root);
  assert.deepEqual([...result.resolvedKeys], [valid]); assert.deepEqual([...result.missingKeys], [missing]);
  assert.match(result.body, /URLKeyTitle/);
});

test('changed bibliography content cannot publish or poison the original citation cache', { skip: !available }, async t => {
  const f = fixture(t), bib = path.join(f.root, 'refs.bib'), original = fs.readFileSync(bib, 'utf8');
  let calls = 0;
  const engine = new CitationPandocEngine({ run: async (...args) => {
    if (!args[1].includes('--version') && ++calls === 1) fs.writeFileSync(bib, original.replace('AlphaTitle', 'WrongChangedTitle'));
    return executeRunProcess(...args);
  } });
  const failures = [];
  assert.equal(await engine.render('[@alpha]', f.references, f.root, reason => failures.push(reason)), undefined);
  assert.match(failures[0], /changed during citation rendering/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, '.inkwell/.cache/preview-cites')), [], 'failed work leaves no cache or staging inputs');
  fs.writeFileSync(bib, original); bibliographyService.invalidate();
  const result = await engine.render('[@alpha]', f.references, f.root);
  assert.equal(calls, 2); assert.match(result.body, /AlphaTitle/); assert.doesNotMatch(result.body, /WrongChangedTitle/);
});

test('Pandoc reads immutable bibliography snapshots even when the original changes and reverts mid-render', { skip: !available }, async t => {
  const f = fixture(t), bib = path.join(f.root, 'refs.bib'), original = fs.readFileSync(bib, 'utf8');
  const engine = new CitationPandocEngine({ run: async (...args) => {
    if (args[1].includes('--version')) return executeRunProcess(...args);
    fs.writeFileSync(bib, original.replace('AlphaTitle', 'TransientWrongTitle'));
    try { return await executeRunProcess(...args); } finally { fs.writeFileSync(bib, original); }
  } });
  const result = await engine.render('[@alpha]', f.references, f.root);
  assert.ok(result); assert.match(result.body, /AlphaTitle/); assert.doesNotMatch(result.body, /TransientWrongTitle/);
});

test('changed CSL content invalidates a completed render before it reaches the cache', { skip: !available }, async t => {
  const f = fixture(t), style = path.join(f.root, 'custom.csl');
  fs.copyFileSync(f.references.csl, style);
  const config = resolveDocumentConfig({ text: '---\nbibliography: refs.bib\ncsl: custom.csl\n---\n', sourcePath: f.source });
  const refs = resolveBibliographyConfiguration(config, f.source, f.root);
  const engine = new CitationPandocEngine({ run: async (...args) => {
    if (!args[1].includes('--version')) fs.appendFileSync(style, '\n<!-- concurrent style edit -->\n');
    return executeRunProcess(...args);
  } });
  assert.equal(await engine.render('[@alpha]', refs, f.root), undefined);
  assert.deepEqual(fs.readdirSync(path.join(f.root, '.inkwell/.cache/preview-cites')), []);
});

test('citation caches reject symlink escapes before reads or writes', async t => {
  const f = fixture(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-citation-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'user.txt'), 'Keep exact');
  fs.mkdirSync(path.join(f.root, '.inkwell')); fs.symlinkSync(outside, path.join(f.root, '.inkwell/.cache'));
  const engine = new CitationPandocEngine({ findBinary: () => '/mock/pandoc', run: async () => success('pandoc 3.9\n') });
  await assert.rejects(engine.render('[@alpha]', f.references, f.root), /escapes the project root/);
  assert.deepEqual(fs.readdirSync(outside), ['user.txt']);
  assert.equal(fs.readFileSync(path.join(outside, 'user.txt'), 'utf8'), 'Keep exact');
});

test('a cache-file symlink introduced during rendering cannot replace its outside target', async t => {
  const f = fixture(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-citation-target-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const victim = path.join(outside, 'user.json'); fs.writeFileSync(victim, 'User bytes');
  const engine = new CitationPandocEngine({ findBinary: () => '/mock/pandoc', run: async (_binary, args) => {
    if (args.includes('--version')) return success('pandoc 3.9\n');
    const staging = path.dirname(args.at(-1));
    const fingerprint = path.basename(staging).split('.')[0];
    fs.symlinkSync(victim, path.join(path.dirname(staging), `${fingerprint}.json`));
    return success('<span data-cites="alpha">AlphaTitle</span>');
  } });
  assert.equal(await engine.render('[@alpha]', f.references, f.root), undefined);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'User bytes');
});

test('invalidating during an in-flight render starts fresh work and prevents obsolete cache publication', async t => {
  const f = fixture(t); let releaseOld, startedOld, renders = 0;
  const oldStarted = new Promise(resolve => { startedOld = resolve; });
  const oldReleased = new Promise(resolve => { releaseOld = resolve; });
  const engine = new CitationPandocEngine({ findBinary: () => '/mock/pandoc', run: async (_binary, args) => {
    if (args.includes('--version')) return success('pandoc 3.9\n');
    renders++;
    if (renders === 1) { startedOld(); await oldReleased; return success('<span data-cites="alpha">ObsoleteTitle</span>'); }
    return success('<span data-cites="alpha">CurrentTitle</span>');
  } });
  const old = engine.render('[@alpha]', f.references, f.root); await oldStarted;
  engine.invalidate();
  const fresh = await engine.render('[@alpha]', f.references, f.root);
  releaseOld(); assert.equal(await old, undefined);
  assert.match(fresh.body, /CurrentTitle/); assert.equal(renders, 2);
  const warm = await engine.render('[@alpha]', f.references, f.root);
  assert.match(warm.body, /CurrentTitle/); assert.equal(renders, 2);
});
