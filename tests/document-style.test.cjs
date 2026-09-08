const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDocumentConfig, parseDocumentFrontmatter } = require('../out/document-config');
const { getTemplateCapabilities } = require('../out/template-capabilities');
const { documentStyleControls, validateDocumentStyleValue, planDocumentStyleEdit, planManifestStyleEdit, planFrontmatterSettingsEdit } = require('../out/document-style');
const config = text => resolveDocumentConfig({ text, sourcePath: '/isolated/doc.md' });

test('document style editing preserves BOM, CRLF, YAML comments, unknown data and the exact body', () => {
  const original = '\uFEFF---  \r\n# author comment\r\ntitle: "Keep # this" # title comment\r\nmainfont: \'Original Font\'\r\nfontsize: 10pt # legacy stays\r\nunknown:\r\n  list: [1, false, null]\r\n  prose: |\r\n    untouched paragraph\r\n---  \r\n# Body\r\n\r\n```yaml\r\nuntouched: body\r\n```\r\n';
  const planned = planDocumentStyleEdit(original, [{ key: 'typography.bodySize', value: '12pt' }], config(original));
  assert.equal(planned.before, original);
  assert.ok(planned.after.startsWith('\uFEFF---  \r\n'));
  assert.doesNotMatch(planned.after, /(?<!\r)\n/);
  for (const comment of ['# author comment', '# title comment', '# legacy stays']) assert.ok(planned.after.includes(comment));
  const before = parseDocumentFrontmatter(original), after = parseDocumentFrontmatter(planned.after);
  assert.equal(after.body, before.body);
  assert.deepEqual(after.metadata.unknown, before.metadata.unknown);
  assert.equal(after.metadata.title, 'Keep # this');
  assert.equal(after.metadata.mainfont, 'Original Font');
  assert.equal(after.metadata.fontsize, '12pt');
  assert.equal(planned.after, original.replace('fontsize: 10pt', 'fontsize: 12pt'));
  assert.deepEqual(config(planned.after).typography.bodySize, { value: 12, unit: 'pt' });
});

test('inserting frontmatter preserves an existing BOM and all original document content', () => {
  const text = '\uFEFF# Existing\r\nBody without final newline';
  const planned = planDocumentStyleEdit(text, [{ key: 'typography.bodySize', value: 11 }], config(text));
  assert.equal(planned.start, 1); assert.equal(planned.end, 1);
  assert.ok(planned.after.startsWith('\uFEFF---\r\n'));
  assert.equal(parseDocumentFrontmatter(planned.after).body, text.slice(1));
  assert.deepEqual(config(planned.after).typography.bodySize, { value: 11, unit: 'pt' });
});

test('the documented Pandoc key and stronger existing alias change without rewriting other aliases', () => {
  const text = '---\ntypography: {bodySize: 11pt, unknown: true}\nfontsize: 10pt\nfontSize: 10pt\ninkwell: {typography: {bodySize: 10pt}}\n---\nBody';
  const planned = planDocumentStyleEdit(text, [{ key: 'typography.bodySize', value: '12pt' }], config(text));
  const parsed = parseDocumentFrontmatter(planned.after).metadata;
  assert.deepEqual(parsed.inkwell, { typography: { bodySize: '10pt' } });
  assert.equal(parsed.fontsize, '12pt'); assert.equal(parsed.fontSize, '10pt');
  assert.equal(planned.after, text.replace('bodySize: 11pt', 'bodySize: 12pt').replace('fontsize: 10pt', 'fontsize: 12pt'));
  assert.equal(parsed.typography.unknown, true);
  assert.deepEqual(config(planned.after).typography.bodySize, { value: 12, unit: 'pt' });
});

test('existing dotted canonical keys are updated instead of creating an ineffective nested override', () => {
  const text = '---\n"typography.bodySize": 10pt # keep comment\ntypography: {bodySize: 11pt}\n---\nBody';
  const planned = planDocumentStyleEdit(text, [{ key: 'typography.bodySize', value: '12pt' }], config(text));
  assert.ok(planned.after.includes('# keep comment'));
  assert.deepEqual(config(planned.after).typography.bodySize, { value: 12, unit: 'pt' });
  assert.equal(parseDocumentFrontmatter(planned.after).metadata.typography.bodySize, '11pt');
});

test('shared YAML maps retain unknown alias values when typography is overridden', () => {
  const text = '---\ntypography: &style {bodySize: 10pt}\nunknown: *style\n---\nBody';
  const planned = planDocumentStyleEdit(text, [{ key: 'typography.bodySize', value: '12pt' }], config(text));
  assert.deepEqual(parseDocumentFrontmatter(planned.after).metadata.unknown, { bodySize: '10pt' });
  assert.deepEqual(config(planned.after).typography.bodySize, { value: 12, unit: 'pt' });
});

test('malformed YAML, duplicate keys and shared anchored scalar edits fail before changing text', () => {
  for (const text of ['---\ninvalid: [\n---\nBody', '---\nfontsize: 10pt\nfontsize: 11pt\n---\nBody']) {
    assert.throws(() => planDocumentStyleEdit(text, [{ key: 'typography.bodySize', value: '12pt' }], config(text)), /YAML|mapping/);
  }
  const anchored = '---\nfontsize: &size 10pt\nunknown: *size\n---\nBody';
  assert.throws(() => planDocumentStyleEdit(anchored, [{ key: 'typography.bodySize', value: '12pt' }], config(anchored)), /anchor/);
});

test('capability controls report effective locked values and refuse unsupported writes', () => {
  const fixed = config('---\ntemplate: rho\nfontsize: 12pt\n---\nBody');
  const body = documentStyleControls(fixed).find(field => field.key === 'typography.bodySize');
  assert.equal(body.locked, true); assert.ok(body.reason); assert.equal(body.value, '9pt');
  assert.throws(() => validateDocumentStyleValue(fixed, 'typography.bodySize', '12pt'), /locked.*Rho/);
  assert.throws(() => planDocumentStyleEdit('Body', [{ key: 'typography.bodySize', value: '12pt' }], fixed), /locked/);
  assert.throws(() => planManifestStyleEdit('{}', [{ key: 'typography.bodySize', value: '12pt' }], fixed), /locked/);
});

test('style values use shared typed validation and cannot introduce deferred bindings', () => {
  const ordinary = config('Body');
  assert.deepEqual(validateDocumentStyleValue(ordinary, 'typography.bodySize', '11'), { key: 'typography.bodySize', value: '11pt' });
  for (const value of ['0pt', 'unknown-size', '{{size}}', '99pt']) assert.throws(() => validateDocumentStyleValue(ordinary, 'typography.bodySize', value));
  assert.throws(() => validateDocumentStyleValue(ordinary, 'typography.notASetting', 'value'), /Unknown/);
  const caps = structuredClone(getTemplateCapabilities('default'));
  caps.options['typography.headingScale'] = { support: 'supported' };
  const editable = resolveDocumentConfig({ text: 'Body', templateCapabilities: caps });
  assert.deepEqual(validateDocumentStyleValue(editable, 'typography.headingScale', '1.25'), { key: 'typography.headingScale', value: 1.25 });
});

test('all supported typography controls normalize through the same document parser', () => {
  const changes = Object.entries({ bodyFont: 'TeX Gyre Pagella', bodySize: '11pt', lineSpacing: 1.5,
    headingFont: 'TeX Gyre Heros', headingWeight: 700, headingScale: 1.25, headingColor: 'rgb(35, 69, 103)',
    codeSize: '10pt', captionSize: '9pt', tableSize: '10pt', referenceSize: '10pt', sansFont: 'TeX Gyre Heros', monoFont: 'DejaVu Sans Mono',
  }).map(([name, value]) => ({ key: `typography.${name}`, value }));
  const planned = planDocumentStyleEdit('Body', changes, config('Body'));
  const result = config(planned.after);
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.typography.bodyFont, 'TeX Gyre Pagella');
  assert.equal(result.typography.headingWeight, 'bold');
  assert.equal(result.typography.headingColor, '#234567');
  assert.equal(result.typography.lineSpacing, 1.5); assert.equal(result.typography.headingScale, 1.25);
  for (const [name, value] of [['bodySize', 11], ['codeSize', 10], ['captionSize', 9], ['tableSize', 10], ['referenceSize', 10]]) {
    assert.deepEqual(result.typography[name], { value, unit: 'pt' });
  }
  for (const [key, value] of [['typography.bodyFont', 'serif; color: red'], ['typography.headingColor', '\\input{bad}'], ['typography.headingWeight', 'lighter']]) {
    assert.throws(() => validateDocumentStyleValue(config('Body'), key, value));
  }
});

test('project style planning preserves unknown/future fields, managedFiles and legacy defaults', () => {
  const original = { schemaVersion: 4, future: { nested: [false, 2] }, managedFiles: { 'guide.md': { hash: 'old', future: true } }, defaults: { fontsize: '10pt', typography: { bodySize: '11pt', future: true }, runs: { cache: false } } };
  const text = JSON.stringify(original, null, 4).replace(/\n/g, '\r\n') + '\r\n';
  const planned = planManifestStyleEdit(text, [{ key: 'typography.bodySize', value: '12pt' }], config('Body'));
  assert.equal(planned.before, text);
  assert.doesNotMatch(planned.after, /(?<!\r)\n/);
  assert.match(planned.after, /\r\n {4}"schemaVersion"/);
  const expected = structuredClone(original); expected.defaults.typography.bodySize = '12pt';
  assert.deepEqual(JSON.parse(planned.after), expected);
  assert.deepEqual(resolveDocumentConfig({ text: 'Body', manifest: JSON.parse(planned.after) }).typography.bodySize, { value: 12, unit: 'pt' });
  for (const malformed of ['{broken', 'null', '[]', '{"defaults":true}', '{"defaults":{"typography":[]}}']) {
    assert.throws(() => planManifestStyleEdit(malformed, [{ key: 'typography.bodySize', value: '12pt' }], config('Body')), /JSON|object/);
  }
});

for (const [name, before, after, aliases] of [
  ['bodyFont', 'Original Font', 'TeX Gyre Pagella', ['mainfont', 'fontFamily', 'body-font', 'typography.fontFamily', 'typography.bodyFontFamily']],
  ['bodySize', '10pt', '12pt', ['fontsize', 'fontSize', 'body-font-size', 'typography.fontSize', 'typography.bodyFontSize']],
  ['lineSpacing', 1.1, 1.5, ['linestretch', 'lineSpacing', 'line-height', 'typography.lineHeight']],
  ['sansFont', 'Original Sans', 'TeX Gyre Heros', ['sansfont']],
  ['monoFont', 'Original Mono', 'TeX Gyre Cursor', ['monofont']],
  ['headingFont', 'Original Heading', 'TeX Gyre Heros', ['inkwell.heading-font', 'heading-font']],
  ['headingWeight', 'normal', 'bold', ['inkwell.heading-weight', 'heading-weight']],
  ['headingScale', 1.1, 1.3, ['inkwell.heading-scale', 'heading-scale']],
  ['headingColor', '#123456', '#234567', ['inkwell.heading-color', 'heading-color']],
  ['codeSize', 'small', '10pt', ['inkwell.code-font-size', 'code-font-size', 'typography.codeFontSize']],
  ['captionSize', 'small', '9pt', ['inkwell.caption-font-size', 'caption-font-size', 'typography.captionFontSize']],
  ['tableSize', 'small', '9pt', ['inkwell.table-font-size', 'table-font-size', 'tables.fontSize', 'typography.tableFontSize']],
  ['referenceSize', 'small', '9pt', ['reference-font-size', 'bibliography-font-size', 'inkwell.reference-font-size', 'references.fontSize', 'typography.referenceFontSize']],
]) test(`project edits apply ${name} through every accepted spelling without changing unrelated settings`, () => {
  const key = `typography.${name}`;
  const kebab = value => value.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  const canonical = name === 'tableSize' ? 'inkwell.tables.font-size'
    : name === 'referenceSize' ? 'inkwell.references.font-size' : `inkwell.${kebab(key)}`;
  const spellings = [...new Set([...aliases, key, `inkwell.${key}`, kebab(key), canonical,
    ...aliases.filter(value => /^(typography|tables|references)\./.test(value)).flatMap(value => [kebab(value), `inkwell.${kebab(value)}`])])];
  const desired = resolveDocumentConfig({ text: '', manifest: { defaults: { typography: { [name]: after } } } }).typography[name];
  for (const spelling of spellings) for (const nested of [false, true]) {
    const original = { schemaVersion: 1, scaffoldVersion: 4, future: { value: [false, 42] },
      managedFiles: { 'guide.md': { hash: 'keep' } }, defaults: { unknown: { keep: [1, 2] }, runs: { cache: false } } };
    let target = original.defaults;
    const parts = nested ? spelling.split('.') : [spelling];
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)] = before;
    const text = JSON.stringify(original);
    const edit = planManifestStyleEdit(text, [{ key, value: after }], config('Body'));
    const changed = JSON.parse(edit.after);
    const effective = resolveDocumentConfig({ text: '', manifest: changed });
    assert.deepEqual(effective.typography[name], desired, `${spelling}, nested=${nested}`);
    assert.equal(effective.diagnostics.length, 0, `${spelling}, nested=${nested}`);
    assert.deepEqual(changed.future, original.future);
    assert.deepEqual(changed.managedFiles, original.managedFiles);
    assert.deepEqual(changed.defaults.unknown, original.defaults.unknown);
    assert.deepEqual(changed.defaults.runs, original.defaults.runs);
    assert.equal(edit.before, text);
  }
});

test('project canonical overrides preserve weaker aliases and other typography fields', () => {
  const original = { defaults: { typography: { bodySize: '9pt', bodyFont: 'Keep Font' },
    inkwell: { typography: { 'body-size': '10pt', 'heading-color': '#123456' } } } };
  const edit = planManifestStyleEdit(JSON.stringify(original), [{ key: 'typography.bodySize', value: '12pt' }], config('Body'));
  const expected = structuredClone(original);
  expected.defaults.inkwell.typography['body-size'] = '12pt';
  assert.deepEqual(JSON.parse(edit.after), expected);
});

test('project dotted canonical keys stay authoritative over nested keys', () => {
  const original = { defaults: { 'inkwell.typography.body-size': '10pt',
    inkwell: { typography: { 'body-size': '9pt' } } } };
  const edit = planManifestStyleEdit(JSON.stringify(original), [{ key: 'typography.bodySize', value: '12pt' }], config('Body'));
  const expected = structuredClone(original);
  expected.defaults['inkwell.typography.body-size'] = '12pt';
  assert.deepEqual(JSON.parse(edit.after), expected);
  assert.deepEqual(resolveDocumentConfig({ text: '', manifest: expected }).typography.bodySize, { value: 12, unit: 'pt' });
});

test('project font overrides preserve a legacy scalar table preset', () => {
  const original = { defaults: { inkwell: { tables: 'grid' }, 'typography.table-size': 'small' } };
  const edit = planManifestStyleEdit(JSON.stringify(original), [{ key: 'typography.tableSize', value: '9pt' }], config('Body'));
  const expected = structuredClone(original);
  expected.defaults['inkwell.tables.font-size'] = '9pt';
  assert.deepEqual(JSON.parse(edit.after), expected);
  const result = resolveDocumentConfig({ text: '', manifest: expected });
  assert.equal(result.tables.preset, 'grid');
  assert.deepEqual(result.typography.tableSize, { value: 9, unit: 'pt' });
});

test('project style edits replace shadowing bindings with the chosen concrete value', () => {
  const original = { defaults: { inkwell: { typography: { 'body-size': '{{size}}' } } } };
  const edit = planManifestStyleEdit(JSON.stringify(original), [{ key: 'typography.bodySize', value: '12pt' }], config('Body'));
  const result = resolveDocumentConfig({ text: '', manifest: JSON.parse(edit.after) });
  assert.deepEqual(result.typography.bodySize, { value: 12, unit: 'pt' });
  assert.equal(result.deferredBindings.length, 0);
});


test('one scalar source edit preserves exact quoting, key order, comments and end markers', () => {
  const original = `\uFEFF--- \r\n# keep this spacing\r\ninkwell:\r\n    typography:\r\n        "heading-color" : '#123456'  # keep this too\r\n        code-size: "small"\r\nother : [true,  2, 'three']\r\n... \r\nBody without final newline`;
  const edit = planDocumentStyleEdit(original, [{ key: 'typography.headingColor', value: '#234567' }], config(original));
  assert.equal(edit.after, original.replace("'#123456'", "'#234567'"));
  assert.equal(original.slice(0, edit.start) + edit.replacement + original.slice(edit.end), edit.after);
  const repeat = planDocumentStyleEdit(edit.after, [{ key: 'typography.headingColor', value: '#234567' }], config(edit.after));
  assert.equal(repeat.after, edit.after); assert.equal(repeat.replacement, '');
});

test('new Inkwell settings use nested kebab keys and preserve native CSL reference records', () => {
  const original = `---\ntitle: 'No reformat'\nreferences:\n  - id: example\n    title: "An inline reference"\n# trailing comment\n---\nBody`;
  const edit = planFrontmatterSettingsEdit(original, [
    { key: 'typography.codeSize', value: 'small' },
    { key: 'typography.tableSize', value: '9pt' },
    { key: 'references.heading', value: 'Works cited' },
  ], '/isolated/doc.md');
  const insertion = 'inkwell:\n  typography:\n    code-size: small\n  tables:\n    font-size: 9pt\n  references:\n    heading: Works cited\n';
  // The original trailing comment stays attached to the document, after the new setting.
  assert.equal(edit.after, original.replace('# trailing comment', insertion + '# trailing comment'));
  const metadata = parseDocumentFrontmatter(edit.after).metadata;
  assert.deepEqual(metadata.references, [{ id: 'example', title: 'An inline reference' }]);
  assert.equal(metadata.inkwell.references.heading, 'Works cited');
  assert.deepEqual(config(edit.after).typography.tableSize, { value: 9, unit: 'pt' });
});

test('existing block and flow maps receive minimal insertions without normalizing their bytes', () => {
  const cases = [
    ["inkwell: { typography: { code-size: 'small', }, future: [1,  2] }", "inkwell: { typography: { code-size: 'small', heading-color: '#234567', }, future: [1,  2] }"],
    ['inkwell: { typography: {}, future: true }', "inkwell: { typography: {heading-color: '#234567'}, future: true }"],
    ['inkwell: { typography: {future} }', "inkwell: { typography: {future, heading-color: '#234567'} }"],
    ['{title: "Keep", inkwell: {}}', `{title: "Keep", inkwell: {typography: { heading-color: '#234567' }}}`],
    ["inkwell:\n    typography:\n        code-size: 'small'\n    future: true", "inkwell:\n    typography:\n        code-size: 'small'\n        heading-color: '#234567'\n    future: true"],
  ];
  for (const [before, after] of cases) {
    const original = `---\n${before}\n---\nBody`;
    const edit = planDocumentStyleEdit(original, [{ key: 'typography.headingColor', value: '#234567' }], config(original));
    assert.equal(edit.after, `---\n${after}\n---\nBody`);
    assert.equal(config(edit.after).typography.headingColor, '#234567');
  }
});

test('aliases and anchored maps get isolated overrides, keeping shared metadata unchanged', () => {
  for (const frontmatter of [
    "shared: &style {heading-color: '#123456'}\ninkwell: { typography: *style }\nunknown: *style",
    "inkwell: &settings {typography: {heading-color: '#123456'}}\nunknown: *settings",
    "inkwell: { typography: &style {heading-color: '#123456'} }\nunknown: *style",
    "inkwell: { typography: {heading-color: &color '#123456'} }\nunknown: *color",
  ]) {
    const original = `---\n${frontmatter}\n---\nBody`;
    const edit = planDocumentStyleEdit(original, [{ key: 'typography.headingColor', value: '#234567' }], config(original));
    assert.ok(edit.after.includes(frontmatter));
    assert.deepEqual(parseDocumentFrontmatter(edit.after).metadata.unknown, parseDocumentFrontmatter(original).metadata.unknown);
    assert.equal(config(edit.after).typography.headingColor, '#234567');
    assert.match(edit.after, /inkwell\.typography\.heading-color: '#234567'/);
  }
});

test('exact dotted canonical overrides are edited without creating ineffective nested settings', () => {
  const original = `---\n"inkwell.typography.heading-color" : "#123456" # preserve\ninkwell: { typography: { heading-color: '#654321' } }\n---\nBody`;
  const edit = planDocumentStyleEdit(original, [{ key: 'typography.headingColor', value: '#234567' }], config(original));
  assert.equal(edit.after, original.replace('"#123456"', '"#234567"'));
  assert.equal(config(edit.after).typography.headingColor, '#234567');
});

test('a selected alias value can be detached without changing its anchor target', () => {
  const original = '---\nshared: &size 10pt\nfontsize: *size # keep\nunknown: *size\n---\nBody';
  const edit = planDocumentStyleEdit(original, [{ key: 'typography.bodySize', value: '12pt' }], config(original));
  assert.equal(edit.after, original.replace('fontsize: *size', 'fontsize: 12pt'));
  assert.equal(parseDocumentFrontmatter(edit.after).metadata.unknown, '10pt');
});

test('bibliography list changes preserve scalar quotation and comments and use the Pandoc key', () => {
  const original = `---\n"bibliography":\n  - 'first.bib' # primary\n  - "second.bib" # secondary\nunknown: [1,  2]\n---\nBody`;
  const edit = planFrontmatterSettingsEdit(original, [{ key: 'references.bibliography', value: ['first.bib', 'revised.bib'] }], '/isolated/doc.md');
  assert.equal(edit.after, original.replace('"second.bib"', '"revised.bib"'));
  const appended = planFrontmatterSettingsEdit(original, [{ key: 'references.bibliography', value: ['first.bib', 'second.bib', 'third.bib'] }], '/isolated/doc.md');
  assert.equal(appended.after, original.replace('unknown:', '  - third.bib\nunknown:'));
  const flow = '---\nbibliography: [\'first.bib\', ] # keep trailing comma\n---\nBody';
  const flowAppend = planFrontmatterSettingsEdit(flow, [{ key: 'references.bibliography', value: ['first.bib', 'second.bib'] }], '/isolated/doc.md');
  assert.equal(flowAppend.after, flow.replace("'first.bib'", "'first.bib', second.bib"));
  const empty = planFrontmatterSettingsEdit(original, [{ key: 'references.bibliography', value: [] }], '/isolated/doc.md');
  assert.deepEqual(parseDocumentFrontmatter(empty.after).metadata.bibliography, []);
  assert.match(empty.after, /# primary/); assert.match(empty.after, /# secondary/);
  assert.ok(empty.after.endsWith('unknown: [1,  2]\n---\nBody'));
});

test('new Pandoc settings keep their public top-level spelling', () => {
  const values = { 'typography.bodySize': '11pt', 'typography.bodyFont': 'TeX Gyre Pagella',
    'typography.sansFont': 'TeX Gyre Heros', 'typography.monoFont': 'TeX Gyre Cursor',
    'typography.lineSpacing': 1.15, 'references.bibliography': ['refs.bib'], 'references.csl': 'journal.csl', 'references.links': true };
  const edit = planFrontmatterSettingsEdit('Body', Object.entries(values).map(([key, value]) => ({ key, value })), '/isolated/doc.md');
  assert.deepEqual(Object.keys(parseDocumentFrontmatter(edit.after).metadata), ['fontsize', 'mainfont', 'sansfont', 'monofont', 'linestretch', 'bibliography', 'csl', 'link-citations']);
});

test('block scalar and null setting edits retain their original comments', () => {
  const block = '---\ninkwell:\n  references:\n    heading: |- # author wording\n      Old heading\nunknown: "still here"\n---\nBody';
  const edit = planFrontmatterSettingsEdit(block, [{ key: 'references.heading', value: 'New heading' }], '/isolated/doc.md');
  assert.equal(edit.after, block.replace('|- # author wording\n      Old heading\n', 'New heading # author wording\n'));
  for (const nullValue of ['fontsize: # keep', 'fontsize:']) {
    const original = `---\n${nullValue}\n---\nBody`;
    const changed = planFrontmatterSettingsEdit(original, [{ key: 'typography.bodySize', value: '11pt' }], '/isolated/doc.md');
    assert.equal(parseDocumentFrontmatter(changed.after).metadata.fontsize, '11pt');
    if (nullValue.includes('#')) assert.ok(changed.after.includes('# keep'));
  }
});
