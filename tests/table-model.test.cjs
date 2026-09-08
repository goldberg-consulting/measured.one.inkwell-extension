const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDocumentConfig } = require('../out/document-config');
const { resolveTableStyle, tablePdfOptions, buildTableCss } = require('../out/table-model');
const { isNumericTableValue, parseTableWidth } = require('../out/table-values');
const config = text => resolveDocumentConfig({ text: `---\n${text}\n---\nBody` });

test('table presets derive defaults while explicit document and table values retain precedence', () => {
  const base = config('tables:\n  preset: zebra\n  stripe: false\n  density: comfortable');
  const { style, diagnostics } = resolveTableStyle(base, { 'table-preset': 'compact', 'table-header-weight': 'normal' });
  assert.equal(style.preset, 'compact'); assert.equal(style.stripe, false); assert.equal(style.density, 'comfortable');
  assert.equal(style.headerWeight, 'normal'); assert.equal(style.paddingHorizontalPt, 8);
  assert.deepEqual(diagnostics, []);
  assert.equal(resolveTableStyle(config('tables: {preset: zebra}')).style.stripe, true);
  assert.equal(resolveTableStyle(config('tables: {preset: compact}')).style.density, 'compact');
  assert.equal(resolveTableStyle(base, { 'table-stripe': 'true' }).style.stripe, true);
  assert.equal(resolveTableStyle(base, { 'table-preset': 'grid', 'table-style': 'plain' }).style.preset, 'grid');
  assert.equal(resolveTableStyle(base, { 'table-caption-position': 'below', 'caption-style': 'above' }).style.captionPosition, 'below');
});

test('nested, legacy and table-local fields share point, color and weight semantics', () => {
  const base = config('fontsize: 12pt\ninkwell:\n  table-header-bg: navy\n  table-font-size: small\ntables:\n  ruleThickness: 0.7pt\n  paddingHorizontal: 0.5em\n  alignment: [left, right]');
  const result = resolveTableStyle(base, { 'table-font-size': '8pt', 'table-header-weight': '400', 'table-rule-color': 'rgb(51, 102, 153)' });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.style.headerBackground, '#000080'); assert.equal(result.style.fontSizePt, 8);
  assert.equal(result.style.paddingHorizontalPt, 6); assert.equal(result.style.ruleThicknessPt, 0.7);
  assert.equal(result.style.ruleColor, '#336699'); assert.equal(result.style.headerWeight, 'normal');
  assert.deepEqual(result.style.alignment, ['left', 'right']);
  const css = buildTableCss(result.style);
  assert.match(css, /--inkwell-table-font-size:7\.970112pt/); assert.doesNotMatch(css, /:root|\bbody\s*\{/);
});

test('fixed templates retain native styles and issue one warning for each unavailable table choice', () => {
  for (const template of ['rho', 'rmxaa', 'hipster-cv', 'ludus', 'tufte']) {
    const result = resolveTableStyle(config(`template: ${template}`), { 'table-preset': 'grid', 'table-caption-position': 'below' });
    assert.equal(result.style.preset, 'booktabs'); assert.equal(result.style.captionPosition, 'above');
    assert.equal(result.diagnostics.filter(item => item.key === 'tables.preset').length, 1);
    assert.equal(result.diagnostics.filter(item => item.key === 'tables.captionPosition').length, 1);
  }
});

test('invalid table values cannot become CSS or PDF instructions', () => {
  const result = resolveTableStyle(config('title: Safe'), { 'table-header-background': 'red;}body{display:none', 'table-width': '200%', 'table-rule-thickness': '-1pt' });
  assert.equal(result.diagnostics.filter(item => item.severity === 'error').length, 3);
  assert.doesNotMatch(buildTableCss(result.style), /display:none|200%|-1pt/);
  const size = resolveTableStyle(config('table-rule-thickness: 20pt'));
  assert.equal(size.diagnostics.filter(item => item.code === 'table-size-range').length, 1);
});

test('PDF options include capability restrictions and attribute schema with correct implied preset defaults', () => {
  const options = tablePdfOptions(config('tables: {preset: zebra}'));
  assert.equal(options.enabled, true); assert.equal(options.defaults.stripe, true);
  assert.deepEqual(options.allowed.overflow, ['wrap']);
  assert.ok(options.attributeSchema.find(rule => rule.configKey === 'tables.ruleColor'));
  assert.equal(options.namedSizes.small, 10); assert.equal(options.bodySizePt, 10.95);
  assert.equal(tablePdfOptions(config('template: rho')).supported.preset, false);
});

test('width and numeric parsing preserve literal values without coercion', () => {
  assert.equal(parseTableWidth('50%'), '50%'); assert.equal(parseTableWidth('2in'), '144.54pt');
  for (const value of ['-2pt', 'calc(2in)', '101%', '1e999', '\\linewidth']) assert.equal(parseTableWidth(value), undefined);
  for (const value of ['0', '0012', '-12.5', '+.5', '1,000.50', '2e-3', '-2.5%', ' 12 ']) assert.equal(isNumericTableValue(value), true, value);
  for (const value of ['', 'NaN', 'Infinity', '1,00', 'USD 2', '{{total}}', '{python} 1+1', '1,000,00']) assert.equal(isNumericTableValue(value), false, value);
});
