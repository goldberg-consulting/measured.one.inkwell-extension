const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDocumentConfig } = require('../out/document-config.js');
const { generatePreambleText } = require('../out/preamble.js');
const doc = (yaml) => `---\n${yaml}\n---\n# Heading\n\nBody\n`;

test('shared units resolve before template body-size constraints', () => {
  const config = resolveDocumentConfig({ text: doc('fontsize: 16px\ncode-font-size: 80%\ncaption-font-size: 0.75em\ntable-font-size: 9pt\nreference-font-size: small') });
  assert.equal(config.diagnostics.length, 0);
  assert.deepEqual(config.typography.bodySize, { value: 12, unit: 'pt' });
  const effective = require('../out/style-model.js').resolveTypography(config);
  assert.equal(effective.bodySizePt, 12);
  assert.equal(effective.codeSizePt, 9.6);
  assert.equal(effective.captionSizePt, 9);
  assert.equal(effective.tableSizePt, 9);
  assert.equal(effective.referenceSizePt, 10.95);
});

test('Default and ETH expose working heading and caption adapters', () => {
  for (const template of ['default', 'eth-report']) {
    const text = doc(`template: ${template}\nheading-font: Latin Modern Sans\nheading-weight: 400\nheading-scale: 1.2\nheading-color: '#369'\ncaption-font-size: 8pt`);
    const config = resolveDocumentConfig({ text });
    assert.deepEqual(config.diagnostics, []);
    assert.equal(config.typography.headingWeight, 'normal');
    assert.equal(config.typography.headingColor, '#336699');
    const tex = generatePreambleText(text, config);
    assert.match(tex, /inkwellheadingfont/);
    assert.match(tex, /inkwellcaption/);
    assert.match(tex, template === 'default' ? /titleformat/ : /setkomafont/);
    if (template === 'eth-report') assert.doesNotMatch(tex, /titlesec/);
  }
});

test('table sizing is scoped to body AST and never hooks template tabular', () => {
  const text = doc('table-font-size: small');
  const tex = generatePreambleText(text);
  assert.match(tex, /inkwellbodytablesize/);
  assert.doesNotMatch(tex, /AtBeginEnvironment\{(?:tabular|longtable)\}|rowcolors/);
});

test('unsafe fonts and unrepresentable colors/weights are rejected', () => {
  for (const yaml of ['heading-font: "x}{bad"', 'mainfont: "x; font-size: 999pt"', 'heading-color: "url(x)"', 'heading-weight: 300']) {
    const config = resolveDocumentConfig({ text: doc(yaml) });
    assert.ok(config.diagnostics.some(d => d.severity === 'error'), yaml);
  }
});

test('unstyled documents keep the generated preamble empty and viewer state is irrelevant', () => {
  assert.equal(generatePreambleText('Body\n'), '');
  const config = resolveDocumentConfig({ text: doc('fontsize: 11pt') });
  const { resolveTypography, buildTypographyCss } = require('../out/style-model.js');
  assert.equal(resolveTypography(config).bodySizePt, 10.95);
  const before = buildTypographyCss(config);
  assert.equal(buildTypographyCss({ ...config, viewer: { fontScale: 2 } }), before);
  assert.doesNotMatch(before, /:root|body\s*\{|<|>/);
});

test('class options and custom heading hierarchies cannot claim default adapter parity', () => {
  const sized = resolveDocumentConfig({ text: doc('classoption: [12pt]\nfontsize: 10pt') });
  assert.deepEqual(sized.typography.bodySize, { value: 12, unit: 'pt' });
  assert.equal(sized.diagnostics.filter(d => d.key === 'typography.bodySize').length, 1);
  assert.match(sized.capabilities.options['typography.bodySize'].valueLabel, /classoption/);
  assert.deepEqual(resolveDocumentConfig({ text: doc('classoption: [10pt]\nfontsize: 12pt') }).typography.bodySize, { value: 12, unit: 'pt' });
  assert.deepEqual(resolveDocumentConfig({ text: doc('classoption: [10pt]') }).typography.bodySize, { value: 11, unit: 'pt' });
  assert.deepEqual(resolveDocumentConfig({ text: doc('template: rho\nclassoption: [a4paper]') }).typography.bodySize, { value: 10, unit: 'pt' });
  for (const selector of ['documentclass: report', 'top-level-division: chapter']) {
    const text = doc(`${selector}\nheading-scale: 1.5`);
    const config = resolveDocumentConfig({ text });
    assert.equal(config.diagnostics.filter(d => d.key === 'typography.headingScale').length, 1);
    assert.match(config.capabilities.typographyNotice, /class-owned/);
    assert.doesNotMatch(generatePreambleText(text, config), /titleformat|setkomafont/);
  }
});

test('default stretch becomes the actual CSS baseline ratio and uncolored headings inherit theme text', () => {
  const { resolveTypography, buildTypographyCss } = require('../out/style-model');
  const config = resolveDocumentConfig({ text: 'Body' });
  assert.equal(resolveTypography(config).lineSpacing, 1.4);
  assert.equal(resolveTypography(config).bodyBaselinePt, 19.04);
  assert.match(buildTypographyCss(config), /--inkwell-line-spacing:1.738813/);
  assert.match(buildTypographyCss(config), /--inkwell-heading-color:inherit/);
});

test('manual font scaling retains author metadata and disables inaccurate size controls', () => {
  const text = doc('mainfont: Times New Roman\nmainfontoptions: [Scale=MatchLowercase]\nfontsize: 12pt');
  const config = resolveDocumentConfig({ text });
  assert.deepEqual(config.compatibility.mainfontoptions, ['Scale=MatchLowercase']);
  assert.equal(config.compatibility.mainfont, 'Times New Roman');
  assert.equal(config.compatibility.fontsize, '12pt');
  assert.equal(config.diagnostics.filter(d => d.code === 'font-scale-parity').length, 1);
  assert.equal(config.capabilities.options['typography.bodySize'].support, 'locked');
  assert.equal(config.capabilities.options['typography.headingScale'].support, 'locked');
  assert.equal(config.capabilities.options['typography.captionSize'].support, 'locked');
  assert.match(generatePreambleText(text, config), /Scale=MatchLowercase/);
  assert.doesNotMatch(generatePreambleText(text, config), /Scale=1/);
});

test('journal 9pt named sizes use extarticle metrics instead of proportional guesses', () => {
  const { resolveTypography } = require('../out/style-model');
  const config = resolveDocumentConfig({ text: doc('template: rho\ncode-font-size: small') });
  assert.equal(resolveTypography(config).codeSizePt, 8);
  assert.equal(resolveTypography(config).bodyBaselinePt, 10.95);
});
