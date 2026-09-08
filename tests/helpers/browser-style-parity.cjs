const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { fixtures } = require('./style-contract.cjs');
const reviewed = require('../fixtures/style/capabilities.json');

// These physical sizes/families are independent anchors, not values obtained
// from buildTypographyCss or a newly generated snapshot. TeX points are 1/72.27
// inch; CSS pixels are 1/96 inch. Named classes own their documented defaults.
const defaults = {
  default: [10.95, 10.95, 'Latin Modern Roman', 14.4, 19.04],
  'eth-report': [12, 10.95, 'Inter', 12, 17.9945],
  'hipster-cv': [10, 8, 'Latin Modern Roman', 14.4, 12],
  'kth-letter': [10.95, 10, 'Times', 14.4, 13.6],
  ludus: [10, 9, 'Source Sans 3', 14.4, 12],
  rho: [9, 8, 'STIX Two Text', 10.95, 10.95],
  rmxaa: [9, 8, 'STIX Two Text', 10.95, 10.95],
  tmsce: [10.95, 10, 'Latin Modern Roman', 14.4, 13.6],
  tufte: [10, 9, 'Palatino', 14.4, 12],
  'tufte-book-vdqi': [10, 9, 'Palatino', 14.4, 12],
};
function cases() {
  return fixtures().map(fixture => {
    const expected = reviewed.find(item => item.id === fixture.id);
    assert.ok(expected, `Missing reviewed style fixture ${fixture.id}`);
    if (fixture.id.endsWith('-capabilities')) {
      const type = expected.typography;
      assert.deepEqual([type.bodySizePt, type.codeSizePt, type.bodyFont, type.headingSizesPt[0], type.bodyBaselinePt], defaults[fixture.template], fixture.id);
    }
    if (fixture.id.includes('-typography-')) {
      assert.equal(expected.typography.bodySizePt, { 10: 10, 11: 10.95, 12: 12 }[fixture.id.split('-').at(-1)]);
      assert.equal(expected.typography.bodyFont, 'Times New Roman');
      assert.equal(expected.typography.headingFont, 'Arial');
      assert.equal(expected.typography.monoFont, 'Courier New');
      assert.equal(expected.typography.headingWeight, 'normal');
      assert.equal(expected.typography.codeSizePt, 8);
      assert.equal(expected.typography.captionSizePt, 9);
      assert.equal(expected.typography.referenceSizePt, 7);
      assert.equal(expected.table.fontSizePt, 10);
    }
    return { ...fixture, expected };
  });
}

// Only editor/workspace services are adapted. HTML, semantic tables, layout
// CSS, reference resolution, and Pandoc's actual reference filters all come
// from the checkout's compiled provider modules. The VSIX only ships bundled
// entrypoints, so the browser separately loads its exact packaged client/media.
// The report attributes these two inputs explicitly. No expected CSS is injected.
function createStyleProvider(directory, extensionRoot) {
  const load = name => require(path.join(extensionRoot, 'out', name));
  const { resolveDocumentConfig } = load('document-config');
  const { resolveBibliographyConfiguration } = load('bibliography-service');
  const { CitationPandocEngine } = load('citation-pandoc');
  const engine = new CitationPandocEngine({ environment: () => process.env });
  const messages = [];
  const uri = file => ({ fsPath: file, toString: () => `file://${file}` });
  const vscode = { Uri: { file: uri }, window: {}, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
  const entry = path.join(extensionRoot, 'out/preview.js');
  const original = Module._load;
  Module._load = function(request, parent, ...args) {
    if (request === 'vscode') return vscode;
    if (parent?.filename === entry) {
      if (request === './compiler') return { readLastSuccessfulOutput: () => undefined, detectMode: () => 'pandoc', isCompilable: () => true };
      if (request === './runner') return { parseCodeBlocks: () => [] };
      if (request === './inject') return { prepareForPreview: text => text };
      if (request === './inkwell-output') return { getInkwellOutputChannel: () => ({ appendLine() {} }) };
      if (request === './config') return {
        getInkwellProjectRoot: () => directory, getInkwellOutputsDir: () => directory,
        getDocumentConfig: (text, sourcePath) => resolveDocumentConfig({ text, sourcePath }),
        getResolvedReferences: (config, sourceFile) => resolveBibliographyConfiguration(config, sourceFile, directory),
      };
      if (request === './citations') return { renderCitations: async (body, options) => {
        let failure;
        const result = await engine.render(body, options.resolvedReferences, directory, reason => { failure = reason; });
        assert.ok(result, `Style parity requires actual Pandoc reference rendering: ${failure}`);
        assert.equal(result.engine, 'pandoc');
        assert.deepEqual([...result.missingKeys], []);
        return result;
      } };
    }
    return original.call(this, request, parent, ...args);
  };
  let Provider;
  try { delete require.cache[require.resolve(entry)]; Provider = require(entry).InkwellPreviewProvider; }
  finally { Module._load = original; }
  const provider = new Provider({ extensionPath: extensionRoot });
  provider.panel = { title: '', webview: { postMessage: async message => { messages.push(message); return true; }, asWebviewUri: value => value } };
  provider.initialized = true;
  fs.writeFileSync(path.join(directory, 'references.bib'), '@book{reference,author={Doe, Jane},title={Parity Reference One},year={2026}}\n@book{second,author={Roe, John},title={Parity Reference Two},year={2025}}\n');
  return async fixture => {
    const text = fixture.text.replace('---\n', '---\nbibliography: references.bib\n') +
      '\n## Second heading\n\n### Third heading\n\n#### Fourth heading\n\n##### Fifth heading\n\n###### Sixth heading\n\n' +
      '```python\nanswer = 42\n```\n\n' +
      '| Name | Value |\n|---|---|\n| Alpha | 12 |\n| Beta | 34 |\n\n: Parity caption {#tbl:parity}\n\n' +
      `Body parity ${fixture.id}. [@second]\n`;
    const source = path.join(directory, fixture.id + '.md');
    fs.writeFileSync(source, text);
    const document = { uri: uri(source), version: 1, getText: () => text };
    provider.currentDocument = document;
    messages.length = 0;
    await provider.sendContentUpdate(document);
    const result = messages.find(message => message.type === 'updateContent');
    assert.ok(result, `${fixture.id}: provider did not publish content: ${JSON.stringify(messages)}`);
    assert.match(result.html, /Parity reference one/i);
    assert.match(result.html, /Parity reference two/i);
    assert.match(result.html, /--inkwell-reference-indent/);
    return result;
  };
}

// Serialized for execution inside the real browser, after the actual client
// consumes its provider message and enhances the draft/print document.
function measure(selector) {
  const parent = document.querySelector(selector);
  const read = selector => {
    const element = parent.querySelector(selector);
    if (!element) throw new Error(`Missing style parity element ${selector}`);
    const style = getComputedStyle(element);
    return Object.fromEntries(['fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'color', 'lineHeight', 'marginLeft', 'textIndent', 'marginBottom', 'paddingTop', 'paddingLeft', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'backgroundColor', 'captionSide', 'textAlign'].map(name => [name, style[name]]));
  };
  return { body: read('p'), headings: [1, 2, 3, 4, 5, 6].map(level => read('h' + level)), code: read('pre code'),
    table: read('table.inkwell-table'), header: read('table th'), numeric: read('table tbody td:nth-child(2)'),
    stripe: read('table tbody tr:nth-child(2)'), caption: read('table caption'),
    references: read('.csl-bib-body'), entry: read('.csl-entry'),
    pageWidth: parent.querySelector('.page-sheet') ? getComputedStyle(parent.querySelector('.page-sheet')).width : null };
}

function assertStyles(actual, expected, pane) {
  const { typography: type, table, normalized } = expected;
  const context = `${expected.id} ${pane}`;
  const px = points => points * 96 / 72.27;
  const close = (value, wanted, name, tolerance = 0.016) => assert.ok(Math.abs(parseFloat(value) - wanted) <= tolerance, `${context} ${name}: ${value}, expected ${wanted}px`);
  const family = (value, wanted, name) => assert.equal(value.split(',')[0].trim().replace(/^['"]|['"]$/g, ''), wanted, `${context} ${name}`);
  const color = hex => hex === 'transparent' ? 'rgba(0, 0, 0, 0)' : `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`;
  close(actual.body.fontSize, px(type.bodySizePt), 'body size');
  close(actual.body.lineHeight, px(type.bodyBaselinePt), 'body baseline');
  family(actual.body.fontFamily, type.bodyFont, 'body family');
  actual.headings.forEach((heading, index) => {
    close(heading.fontSize, px(type.headingSizesPt[index]), `h${index + 1} size`);
    family(heading.fontFamily, type.headingFont, `h${index + 1} family`);
    assert.equal(heading.fontWeight, type.headingWeight === 'normal' ? '400' : '700', `${context} heading weight`);
    assert.equal(heading.fontStyle, 'normal', `${context} heading style`);
    assert.equal(heading.color, type.headingColor === '#000000' ? actual.body.color : color(type.headingColor), `${context} heading color`);
  });
  close(actual.code.fontSize, px(type.codeSizePt), 'code size');
  family(actual.code.fontFamily, type.monoFont, 'code family');
  close(actual.table.fontSize, px(table.fontSizePt), 'table size');
  close(actual.header.paddingLeft, px(table.paddingHorizontalPt), 'cell horizontal padding');
  close(actual.header.paddingTop, px(table.paddingVerticalPt), 'cell vertical padding');
  assert.equal(actual.header.fontWeight, table.headerWeight === 'normal' ? '400' : '700', `${context} header weight`);
  assert.equal(actual.header.backgroundColor, color(table.headerBackground), `${context} header background`);
  assert.equal(actual.stripe.backgroundColor, color(table.stripe ? table.stripeColor : 'transparent'), `${context} stripe`);
  // CSS borders are snapped to whole device pixels at this 1x browser scale.
  close(actual.table.borderTopWidth, table.ruleThicknessPt ? Math.max(1, Math.floor(px(table.ruleThicknessPt))) : 0, 'table rule');
  assert.equal(actual.table.borderTopStyle, table.preset === 'plain' ? 'none' : 'solid', `${context} rule style`);
  if (table.preset !== 'plain') assert.equal(actual.table.borderTopColor, table.ruleColor === '#000000' ? actual.table.color : color(table.ruleColor), `${context} rule color`);
  assert.equal(actual.numeric.textAlign, table.numericAlignment === 'inherit' ? 'left' : table.numericAlignment, `${context} numeric alignment`);
  close(actual.caption.fontSize, px(type.captionSizePt), 'caption size');
  assert.equal(actual.caption.captionSide, table.captionPosition === 'below' ? 'bottom' : 'top', `${context} caption position`);
  assert.equal(actual.caption.fontStyle, table.captionStyle, `${context} caption style`);
  close(actual.references.fontSize, px(type.referenceSizePt), 'references size');
  family(actual.references.fontFamily, type.bodyFont, 'reference family');
  close(actual.references.lineHeight, px(type.referenceSizePt * 1.2 * normalized.references.lineSpacing), 'reference baseline');
  const referenceLength = value => parseFloat(value) * (value.endsWith('em') ? type.referenceSizePt : 1);
  close(actual.entry.marginLeft, px(referenceLength(normalized.references.hangingIndent)), 'reference hanging indent');
  close(actual.entry.textIndent, -px(referenceLength(normalized.references.hangingIndent)), 'reference first line indent');
  close(actual.entry.marginBottom, px(referenceLength(normalized.references.entrySpacing)), 'reference entry space');
  if (pane === 'print') close(actual.pageWidth, 8.5 * 96, 'physical letter paper width');
}

module.exports = { cases, createStyleProvider, measure, assertStyles };
