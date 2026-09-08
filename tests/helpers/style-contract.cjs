const { resolveDocumentConfig } = require('../../out/document-config');
const { resolveTypography, buildTypographyCss } = require('../../out/style-model');
const { resolveTableStyle, buildTableCss, tablePdfOptions } = require('../../out/table-model');
const { generatePreambleText } = require('../../out/preamble');

const templates = ['default', 'eth-report', 'hipster-cv', 'kth-letter', 'ludus', 'rho', 'rmxaa', 'tmsce', 'tufte', 'tufte-book-vdqi'];
function fixtures() {
  const cases = templates.map(template => ({ id: `${template}-capabilities`, template, settings: '' }));
  for (const template of ['default', 'eth-report']) {
    for (const size of [10, 11, 12]) cases.push({ id: `${template}-typography-${size}`, template,
      settings: `fontsize: ${size}pt\nmainfont: Times New Roman\nsansfont: Arial\nmonofont: Courier New\ninkwell:\n  typography:\n    heading-font: Arial\n    heading-weight: normal\n    heading-scale: 1.2\n    heading-color: '#336699'\n    code-size: 8pt\n    caption-size: 9pt\n  tables: {font-size: 10pt}\n  references: {font-size: 7pt, hanging-indent: 2em, entry-spacing: 6pt}\n` });
    for (const preset of ['booktabs', 'grid', 'plain', 'zebra', 'compact']) for (const position of ['above', 'below']) {
      cases.push({ id: `${template}-${preset}-${position}`, template,
        settings: `inkwell:\n  tables:\n    preset: ${preset}\n    font-size: 9pt\n    caption-position: ${position}\n    numeric-alignment: right\n    header-background: '#ddeeff'\n    rule-color: '#336699'\n` });
    }
    for (const density of ['compact', 'normal', 'comfortable']) for (const stripe of [false, true]) {
      cases.push({ id: `${template}-${density}-stripe-${stripe}`, template,
        settings: `inkwell:\n  tables:\n    preset: grid\n    density: ${density}\n    stripe: ${stripe}\n    width: 100%\n    font-size: small\n` });
    }
  }
  return cases.map(item => ({ ...item, text: `---\ntemplate: ${item.template}\n${item.settings}---\n\n# Heading\n\nBody [@reference].\n` }));
}
function describe(fixture) {
  const config = resolveDocumentConfig({ text: fixture.text });
  const table = resolveTableStyle(config);
  const options = tablePdfOptions(config);
  return { id: fixture.id, template: config.template,
    normalized: { typography: config.typography, tables: config.tables, references: config.references, engine: config.engine, columns: config.columns },
    capabilities: config.capabilities.options,
    diagnostics: config.diagnostics.map(item => ({ code: item.code, key: item.key, severity: item.severity })),
    typography: resolveTypography(config), table: table.style,
    typographyCss: buildTypographyCss(config), tableCss: buildTableCss(table.style),
    latexMacros: generatePreambleText(fixture.text, config), tablePdfOptions: { defaults: options.defaults, explicit: options.explicit, supported: options.supported, bodySizePt: options.bodySizePt, classSizePt: options.classSizePt } };
}
module.exports = { fixtures, describe };
