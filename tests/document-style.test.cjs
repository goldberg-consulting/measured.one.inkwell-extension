const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDocumentConfig, parseDocumentFrontmatter } = require('../out/document-config');
const { getTemplateCapabilities } = require('../out/template-capabilities');
const { documentStyleControls, validateDocumentStyleValue, planDocumentStyleEdit, planManifestStyleEdit } = require('../out/document-style');
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
  assert.equal(after.metadata.fontsize, '10pt');
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

test('the canonical final alias wins while every legacy alias remains intact', () => {
  const text = '---\ntypography: {bodySize: 11pt, unknown: true}\nfontsize: 10pt\nfontSize: 10pt\ninkwell: {typography: {bodySize: 10pt}}\n---\nBody';
  const planned = planDocumentStyleEdit(text, [{ key: 'typography.bodySize', value: '12pt' }], config(text));
  const parsed = parseDocumentFrontmatter(planned.after).metadata;
  assert.deepEqual(parsed.inkwell, { typography: { bodySize: '10pt' } });
  assert.equal(parsed.fontsize, '10pt'); assert.equal(parsed.fontSize, '10pt');
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
  for (const text of ['---\ninvalid: [\n---\nBody', '---\nfontsize: 10pt\nfontsize: 11pt\n---\nBody', '---\ntypography: nope\n---\nBody']) {
    assert.throws(() => planDocumentStyleEdit(text, [{ key: 'typography.bodySize', value: '12pt' }], config(text)), /YAML|mapping/);
  }
  const anchored = '---\ntypography: {bodySize: &size 10pt}\nunknown: *size\n---\nBody';
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
