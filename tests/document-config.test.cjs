const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseDocumentFrontmatter, resolveDocumentConfig, applyBlockOverrides,
  normalizeManifestDefaults, parseSize, scalarValue, listValue,
} = require('../out/document-config.js');
const { TEMPLATE_CAPABILITIES, getTemplateCapabilities } = require('../out/template-capabilities.js');
const forms = require('./fixtures/config/forms.json');
const document = (yaml, body = 'Body\n') => `---\n${yaml}\n---\n${body}`;

for (const fixture of forms) test(`YAML fixture: ${fixture.name}`, () => {
  const text = document(fixture.yaml);
  const result = resolveDocumentConfig({ text, sourcePath: '/project/paper.md', manifest: fixture.project ? { defaults: fixture.project } : undefined, editorDefaults: fixture.editor });
  if (fixture.bibliography) assert.deepEqual(result.references.bibliography, fixture.bibliography);
  if (fixture.title) assert.equal(result.documentMetadata.title, fixture.title);
  if (fixture.invalid) assert.ok(result.diagnostics.some((entry) => entry.severity === 'error'));
  else assert.equal(result.diagnostics.filter((entry) => entry.severity === 'error').length, 0);
  if (fixture.expectedFontsize) assert.equal(result.compatibility.fontsize, fixture.expectedFontsize);
});

test('real YAML parsing preserves CRLF body, folded scalars, flow objects, lists, and quoted hashes', () => {
  const body = '\r\n# Body\r\nKeep  two spaces.  \r\n';
  const text = '---\r\ntitle: "A # title" # outside comment\r\nauthor: [Alice, Bob]\r\nabstract: >-\r\n  First line\r\n  second line\r\ninkwell: {code-display: both}\r\n---\r\n' + body;
  const parsed = parseDocumentFrontmatter(text, '/p/document.md');
  assert.equal(parsed.body, body);
  assert.equal(parsed.bodyOffset, text.length - body.length);
  assert.equal(parsed.metadata.abstract, 'First line second line');
  assert.equal(scalarValue(parsed.metadata, 'title'), 'A # title');
  assert.deepEqual(listValue(parsed.metadata, 'author'), ['Alice', 'Bob']);
  assert.equal(resolveDocumentConfig({ text }).runs.display, 'both');
});

test('all source layers resolve deterministically with source locations and canonical values', () => {
  const result = resolveDocumentConfig({
    text: document('fontsize: 12pt\ninkwell:\n  code-display: both\nbibliography: [one.bib, two.bib]'), sourcePath: '/p/paper.md',
    manifestPath: '/p/.inkwell/manifest.json', manifest: { settings: { fontsize: '10pt' }, documentSettings: { fontSize: 11 }, defaults: { typography: { bodySize: '10pt', bodyFont: 'Inter' }, runs: { display: 'code' } } },
    defaultsYaml: 'fontsize: 11pt\nlinestretch: 1.3\n', defaultsPath: '/p/defaults.yaml', editorDefaults: { fontsize: '10pt', defaultCodeDisplay: 'none' },
  });
  assert.deepEqual(result.typography.bodySize, { value: 12, unit: 'pt' });
  assert.equal(result.typography.bodyFont, 'Inter');
  assert.equal(result.typography.lineSpacing, 1.3);
  assert.equal(result.runs.display, 'both');
  assert.equal(result.provenance['typography.bodySize'].source, 'document');
  assert.equal(result.provenance['typography.bodySize'].line, 2);
  assert.equal(result.provenance['typography.bodyFont'].source, 'project');
  assert.equal(result.provenance['typography.lineSpacing'].sourcePath, '/p/defaults.yaml');
  assert.equal(result.provenance['references.bibliography'].line, 5);
  assert.deepEqual(result.compatibility.bibliography, ['one.bib', 'two.bib']);
});

test('legacy manifest settings and documentSettings normalize without mutating or losing unknown fields', () => {
  const manifest = {
    schemaVersion: 1, unknownRoot: { preserve: [1, 2] },
    settings: { fontsize: '10pt', inkwell: { 'code-display': 'both' }, unknownSetting: true },
    documentSettings: { fontSize: 12, fontFamily: 'Inter', lineSpacing: 1.25, paperSize: 'a4' },
    defaults: { typography: { bodySize: '11pt', unknownTypography: 42 }, unknownDefaults: 'keep' },
  };
  const before = structuredClone(manifest);
  const normalized = normalizeManifestDefaults(manifest);
  assert.deepEqual(manifest, before);
  assert.equal(normalized.defaults.typography.bodySize, '11pt');
  assert.equal(normalized.defaults.typography.bodyFont, 'Inter');
  assert.equal(normalized.defaults.typography.lineSpacing, 1.25);
  assert.equal(normalized.defaults.typography.unknownTypography, 42);
  assert.equal(normalized.defaults.runs.display, 'both');
  assert.equal(normalized.defaults.unknownDefaults, 'keep');
  const resolved = resolveDocumentConfig({ text: 'Body', manifest });
  assert.equal(resolved.compatibility.papersize, 'a4');
  assert.equal(resolved.compatibility.unknownSetting, true);
});

test('invalid values are diagnosed at their source and cannot silently become successful controls', () => {
  const result = resolveDocumentConfig({ text: document('fontsize: enormous\ninkwell:\n  code-display: invisible\n  table-stripe: maybe\n'), sourcePath: '/paper.md', manifest: { defaults: { typography: { bodySize: '12pt' } } } });
  assert.equal(result.diagnostics.filter((entry) => entry.code === 'invalid-value').length, 3);
  assert.equal(result.diagnostics.find((entry) => entry.key === 'typography.bodySize').line, 2);
  assert.deepEqual(result.typography.bodySize, { value: 12, unit: 'pt' });
  assert.equal(result.provenance['typography.bodySize'].source, 'project');
  assert.equal(result.compatibility.fontsize, '12pt');
  assert.equal(result.runs.display, 'output');
});

test('invalid YAML, duplicate keys, aliases with cycles, and invalid section shapes produce errors', () => {
  for (const yaml of ['fontsize: [', 'fontsize: 10pt\nfontsize: 12pt', 'a: &a\n  b: *a', 'typography: 42', 'runs: false', 'top-level-division: shell-command']) {
    const result = resolveDocumentConfig({ text: document(yaml) });
    assert.ok(result.diagnostics.some((entry) => entry.severity === 'error'), yaml);
  }
  const unclosed = parseDocumentFrontmatter('---\ntitle: Missing close\nBody');
  assert.equal(unclosed.body, '---\ntitle: Missing close\nBody');
  assert.equal(unclosed.diagnostics[0].code, 'yaml-unclosed-frontmatter');
});

test('custom and unknown Pandoc metadata remains intact and no-config documents gain no defaults', () => {
  const source = document('title: Example\nheader-includes:\n  - \\newcommand{\\foo}{bar}\ncustom:\n  nested: [one, two]\n');
  const result = resolveDocumentConfig({ text: source });
  assert.deepEqual(result.compatibility, result.documentMetadata);
  assert.deepEqual(resolveDocumentConfig({ text: 'Body' }).compatibility, {});
  assert.deepEqual(resolveDocumentConfig({ text: document('inkwell:\n  tables:\n    custom: preserve\n    preset: booktabs') }).compatibility.inkwell.tables.custom, 'preserve');
});

for (const yaml of [
  'references: [{id: inline-paper, type: article-journal, title: "A # native CSL record", author: [{family: Goldberg, given: Eli}]}]',
  'references:\n  - id: inline-paper\n    type: article-journal\n    title: "A # native CSL record"\n    author:\n      - family: Goldberg\n        given: Eli',
]) {
  test(`native Pandoc CSL references remain metadata (${yaml.includes('\n') ? 'block' : 'flow'} list)`, () => {
    const text = document(yaml + '\ninkwell:\n  references:\n    scope: section');
    const expected = parseDocumentFrontmatter(text).metadata.references;
    const result = resolveDocumentConfig({ text });
    assert.deepEqual(result.diagnostics.filter((entry) => entry.severity === 'error'), []);
    assert.deepEqual(result.documentMetadata.references, expected);
    assert.deepEqual(result.compatibility.references, expected);
    assert.deepEqual(result.metadata.references, expected);
    assert.equal(result.references.scope, 'section');
    assert.deepEqual(applyBlockOverrides(result, { display: 'both' }).compatibility.references, expected);
  });
}

test('native CSL arrays in Pandoc defaults are preserved while configuration sections require mappings', () => {
  const result = resolveDocumentConfig({ text: 'Body', defaultsYaml: 'references: [{id: source, type: book, title: Native}]' });
  assert.deepEqual(result.diagnostics.filter((entry) => entry.severity === 'error'), []);
  assert.deepEqual(result.compatibility.references, [{ id: 'source', type: 'book', title: 'Native' }]);
  const namespaced = resolveDocumentConfig({ text: document('inkwell:\n  references: [invalid-config-section]') });
  assert.ok(namespaced.diagnostics.some((entry) => entry.code === 'config-section-type' && entry.key === 'inkwell.references'));
  const canonical = resolveDocumentConfig({ text: 'Body', manifest: { defaults: { references: [] } } });
  assert.ok(canonical.diagnostics.some((entry) => entry.code === 'config-section-type' && entry.key === 'references'));
});

for (const [name, yaml, expected] of [
  ['project options', '', [{ id: 'source', type: 'book', title: 'Native' }]],
  ['document options', 'references: {heading: Local heading}', [{ id: 'source', type: 'book', title: 'Native' }]],
  ['document records', 'references: [{id: local, type: book, title: Local}]', [{ id: 'local', type: 'book', title: 'Local' }]],
  ['document empty list', 'references: []', []],
]) test(`native CSL defaults survive bibliography configuration with correct precedence (${name})`, () => {
  const result = resolveDocumentConfig({ text: document(yaml),
    defaultsYaml: 'references: [{id: source, type: book, title: Native}]',
    manifest: { defaults: { references: { heading: 'Project heading', lineSpacing: 1.5 } } } });
  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(result.compatibility.references, expected);
  assert.deepEqual(result.metadata.references, expected);
  assert.deepEqual(applyBlockOverrides(result, { display: 'both' }).compatibility.references, expected);
  assert.equal(result.references.lineSpacing, 1.5);
  assert.equal(result.references.heading, name === 'document options' ? 'Local heading' : 'Project heading');
});

test('presentation bindings survive raw validation and compatibility serialization until injection', () => {
  const text = document('fontsize: "{{size}}pt"\nlinestretch: "{{spacing}}"\ninkwell:\n  tables: "{{table_style}}"');
  const result = resolveDocumentConfig({ text, sourcePath: '/p/bindings.md' });
  assert.deepEqual(result.diagnostics.filter((entry) => entry.severity === 'error'), []);
  assert.equal(result.compatibility.fontsize, '{{size}}pt');
  assert.equal(result.compatibility.linestretch, '{{spacing}}');
  assert.equal(result.compatibility.inkwell.tables, '{{table_style}}');
  assert.deepEqual(result.deferredBindings.map((binding) => binding.key), ['typography.bodySize', 'typography.lineSpacing', 'tables.preset']);
  assert.equal(result.deferredBindings[0].sourcePath, '/p/bindings.md');
  assert.equal(result.deferredBindings[0].line, 2);
  assert.deepEqual(result.deferredBindings[0].tokens, ['{{size}}']);
  assert.deepEqual(result.typography.bodySize, { value: 11, unit: 'pt' }, 'unresolved bindings never masquerade as typed size values');
  const block = applyBlockOverrides(result, { display: 'both' });
  assert.equal(block.compatibility.fontsize, '{{size}}pt');
  assert.deepEqual(block.deferredBindings, result.deferredBindings);
  const styledBlock = applyBlockOverrides(result, { 'code-font-size': '{{code_size}}' });
  assert.ok(styledBlock.deferredBindings.some((binding) => binding.key === 'typography.codeSize'));
  assert.equal(styledBlock.compatibility.inkwell['code-font-size'], '{{code_size}}');
});

test('template capabilities cannot strip bindings before their values are known', () => {
  const text = document('template: rmxaa\nfontsize: "{{size}}"\nmainfont: "{{font}}"');
  const raw = resolveDocumentConfig({ text });
  assert.equal(raw.compatibility.fontsize, '{{size}}');
  assert.equal(raw.compatibility.mainfont, '{{font}}');
  assert.equal(raw.diagnostics.some((entry) => entry.code === 'template-capability'), false);
  const injected = resolveDocumentConfig({ text: text.replace('{{size}}', '12pt').replace('{{font}}', 'Inter') });
  assert.equal(injected.deferredBindings.length, 0);
  assert.equal(injected.diagnostics.filter((entry) => entry.code === 'template-capability').length, 2);
  assert.deepEqual(injected.typography.bodySize, { value: 9, unit: 'pt' });
});

test('resolved presentation bindings receive ordinary type validation', () => {
  const text = document('fontsize: "{{size}}"\nlinestretch: "{{spacing}}"');
  const valid = resolveDocumentConfig({ text: text.replace('{{size}}', '12pt').replace('{{spacing}}', '1.2') });
  assert.equal(valid.deferredBindings.length, 0);
  assert.deepEqual(valid.typography.bodySize, { value: 12, unit: 'pt' });
  assert.equal(valid.typography.lineSpacing, 1.2);
  for (const value of ['enormous', '{{not a supported binding}}']) {
    const invalid = resolveDocumentConfig({ text: document(`fontsize: "${value}"`) });
    assert.ok(invalid.diagnostics.some((entry) => entry.code === 'invalid-value'));
  }
});

test('unresolved execution and tool-selection bindings remain errors before processes start', () => {
  for (const yaml of ['inkwell:\n  python-env: "{{env}}"', 'inkwell:\n  run-timeout: "{{timeout}}"', 'inkwell:\n  code-display: "{{display}}"', 'inkwell:\n  inputs: ["{{input_file}}"]', 'template: "{{template}}"']) {
    const result = resolveDocumentConfig({ text: document(yaml) });
    assert.ok(result.diagnostics.some((entry) => entry.severity === 'error'), yaml);
    assert.equal(result.deferredBindings.length, 0);
  }
});

test('viewer state is excluded from metadata used for TeX and from config fingerprints', () => {
  const base = resolveDocumentConfig({ text: document('fontsize: 12pt') });
  const changed = resolveDocumentConfig({ text: document('fontsize: 12pt\nzoom: 2\ninkwell:\n  preview:\n    fontScale: 1.8'), editorDefaults: { preview: { fontScale: 2 }, 'inkwell.preview.fontScale': 2 } });
  assert.equal(changed.compatibility.zoom, undefined);
  assert.equal(changed.compatibility.inkwell?.preview, undefined);
  assert.equal(changed.fingerprint, base.fingerprint);
});

test('scalar, list, and key-order differences normalize to identical cache fingerprints', () => {
  const a = resolveDocumentConfig({ text: document('bibliography: refs.bib\nfontsize: 12pt') });
  const b = resolveDocumentConfig({ text: document('fontsize: "12pt"\nbibliography: [refs.bib]') });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, resolveDocumentConfig({ text: document('fontsize: 11pt\nbibliography: refs.bib') }).fingerprint);
});

test('template locks replace requested values with one actionable diagnostic per option', () => {
  const result = resolveDocumentConfig({ text: document('template: rmxaa\nfontsize: 12pt\nmainfont: Inter\ninkwell:\n  heading-scale: 2\n  tables: grid') });
  assert.deepEqual(result.typography.bodySize, { value: 9, unit: 'pt' });
  assert.equal(result.typography.bodyFont, undefined);
  assert.equal(result.typography.headingScale, undefined);
  assert.equal(result.tables.preset, 'booktabs');
  assert.equal(result.compatibility.fontsize, undefined);
  assert.equal(result.compatibility.mainfont, undefined);
  assert.equal(result.diagnostics.filter((entry) => entry.code === 'template-capability').length, 4);
  assert.ok(result.diagnostics.every((entry) => entry.message.includes('template')));
});

test('every shipped template declares body, heading, sizing, table, column, and engine capabilities', () => {
  const names = ['default', ...fs.readdirSync(path.join(__dirname, '../templates'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)];
  assert.deepEqual(Object.keys(TEMPLATE_CAPABILITIES).sort(), names.sort());
  const fields = ['typography.bodyFont', 'typography.bodySize', 'typography.headingFont', 'typography.headingWeight', 'typography.headingScale', 'typography.headingColor', 'typography.codeSize', 'typography.captionSize', 'typography.tableSize', 'typography.referenceSize', 'tables.preset', 'tables.captionPosition', 'columns', 'engine'];
  for (const name of names) for (const field of fields) assert.ok(getTemplateCapabilities(name).options[field], `${name}: ${field}`);
  assert.equal(resolveDocumentConfig({ text: document('template: custom-journal') }).diagnostics[0].code, 'unknown-template-capabilities');
});

test('block attributes override runs without mutating document config or its provenance', () => {
  const base = resolveDocumentConfig({ text: document('inkwell:\n  code-display: both\n  inputs: [data.csv]\nbibliography-scope: section\ntop-level-division: chapter'), editorDefaults: { defaultCodeDisplay: 'code' } });
  const changed = applyBlockOverrides(base, { display: 'none', inputs: ['other.csv'], caption: 'Plot' });
  assert.equal(base.runs.display, 'both');
  assert.equal(changed.runs.display, 'none');
  assert.deepEqual(changed.runs.inputs, ['other.csv']);
  assert.equal(changed.runs.caption, 'Plot');
  assert.equal(changed.provenance['runs.display'].source, 'block');
  assert.deepEqual(changed.provenance['references.scope'], base.provenance['references.scope']);
  assert.equal(changed.compatibility['bibliography-scope'], 'section');
  assert.equal(changed.compatibility['top-level-division'], 'chapter');
  assert.notEqual(changed.fingerprint, base.fingerprint);
});

test('point, CSS, and named font sizes have explicit units', () => {
  assert.deepEqual(parseSize(12), { value: 12, unit: 'pt' });
  assert.deepEqual(parseSize('0.9em'), { value: 0.9, unit: 'em' });
  assert.deepEqual(parseSize('small'), { value: 'small', unit: 'latex' });
  assert.deepEqual(parseSize({ value: 11, unit: 'pt' }), { value: 11, unit: 'pt' });
  assert.equal(parseSize('11pt; color: red'), undefined);
  assert.equal(parseSize(-1), undefined);
});
