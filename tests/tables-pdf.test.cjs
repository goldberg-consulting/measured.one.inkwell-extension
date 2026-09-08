const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const Module = require('node:module');
const { selectPackagedCompiler, checkPdfGolden } = require('./helpers/pdf-goldens.cjs');
const { resolveDocumentConfig } = require('../out/document-config');
const { resolveTableStyle } = require('../out/table-model');
const { resolveTypography, TEX_POINT_TO_CSS_POINT } = require('../out/style-model');

test('actual PDF table presets preserve layout tables, physical sizes and caption order', { skip: process.env.INKWELL_TABLES_PDF !== '1', timeout: 240000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-tables-pdf-'));
  t.diagnostic(`Table PDF evidence: ${root}`);
  process.env.INKWELL_HEADLESS = '1';
  const headless = require('../out/headless-vscode'); headless.configureHeadlessWorkspace(root);
  const originalLoad = Module._load;
  Module._load = function (name, ...args) { return name === 'vscode' ? headless : originalLoad.call(this, name, ...args); };
  let compile; try { ({ compile } = require('../out/compiler')); } finally { Module._load = originalLoad; }
  compile = selectPackagedCompiler(root, compile);
  fs.mkdirSync(path.join(root, '.inkwell'));
  fs.writeFileSync(path.join(root, '.inkwell/manifest.json'), '{"schemaVersion":4,"defaults":{},"managedFiles":{}}');
  const evidence = [];
  for (const template of ['default', 'eth-report']) for (const preset of ['booktabs', 'grid', 'plain', 'zebra', 'compact']) {
    const below = ['plain', 'zebra'].includes(preset);
    const payload = { schemaVersion: 1, headers: ['HeadingMarker', 'Number'], rows: [['TableMarker\nSecondLineMarker', '1,234.5'], ['LastMarker', '-.5e+2%']], caption: 'CaptionMarker', label: 'tbl:measurement', attributes: {} };
    const text = `---\ntemplate: ${template}\ntitle: Table verification\nauthor: Researcher\nfontsize: 11pt\ntable-font-size: 9pt\ntables:\n  preset: ${preset}\n  headerBackground: '#ddeeff'\n  ruleColor: '#336699'\n  numericAlignment: right\n  captionPosition: ${below ? 'below' : 'above'}\n  captionStyle: ${below ? 'italic' : 'normal'}\nheader-includes:\n  - |\n    \\AtBeginDocument{\\begin{tabular}{|l|}\\hline LayoutBefore\\\\\\hline\\end{tabular}}\n---\n\nBodyMarker\n\n\`\`\`inkwell-table-data\n${JSON.stringify(payload)}\n\`\`\`\n\n\\begin{tabular}{|l|}\\hline LayoutAfter\\\\\\hline\\end{tabular}\n`;
    const file = path.join(root, `${template}-${preset}.md`); fs.writeFileSync(file, text);
    const result = await compile({ uri: headless.Uri.file(file), languageId: 'markdown', version: 1, isUntitled: false, getText: () => text });
    fs.writeFileSync(path.join(root, `${template}-${preset}.result.json`), JSON.stringify(result, null, 2));
    assert.equal(result.success, true, `${template}-${preset}: ${result.message}; ${result.logPath}`);
    checkPdfGolden({ id: `tables-${template}-${preset}`, template, sourcePath: file, pdfPath: result.pdfPath, logPath: result.logPath });
    const probe = cp.spawnSync(process.env.INKWELL_PDF_PYTHON || 'python3', ['-c', `import fitz,json,sys\ndoc=fitz.open(sys.argv[1])\nprint(json.dumps(dict(spans=[dict(s,page=i+1) for i,p in enumerate(doc) for b in p.get_text('dict')['blocks'] if 'lines' in b for l in b['lines'] for s in l['spans']],drawings=[dict(page=i+1,color=d['color'],fill=d['fill'],width=d['width'],rect=list(d['rect']),items=[list(item[0:1])+[list(v) if hasattr(v,'x') or hasattr(v,'x0') else v for v in item[1:]] for item in d['items']]) for i,p in enumerate(doc) for d in p.get_drawings()]),default=str))`, result.pdfPath], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const actual = JSON.parse(probe.stdout);
    const config = resolveDocumentConfig({ text });
    const { style } = resolveTableStyle(config); const typography = resolveTypography(config);
    const span = marker => { const matches = actual.spans.filter(s => new RegExp(`(?<![A-Za-z])${marker}(?![A-Za-z])`).test(s.text)); assert.ok(matches.length, `${template}-${preset}: missing ${marker}`); return matches[0]; };
    const cell = span('TableMarker'), nextLine = span('SecondLineMarker'), caption = span('CaptionMarker');
    assert.ok(Math.abs(cell.size - style.fontSizePt * TEX_POINT_TO_CSS_POINT) < .08, `${template}-${preset}: table size ${cell.size}`);
    assert.ok(Math.abs(nextLine.origin[1] - cell.origin[1] - style.fontSizePt * 1.2 * TEX_POINT_TO_CSS_POINT) < .1, `${template}-${preset}: table line height`);
    assert.equal(caption.page, cell.page);
    assert.equal(caption.origin[1] > cell.origin[1], below, `${template}-${preset}: caption position`);
    for (const marker of ['LayoutBefore', 'LayoutAfter']) {
      const layout = span(marker);
      assert.ok(Math.abs(layout.size - typography.bodySizePt * TEX_POINT_TO_CSS_POINT) < .08, `${template}-${preset}: ${marker} font changed`);
      const nearby = actual.drawings.filter(d => d.page === layout.page && d.rect[1] < layout.bbox[3] + 8 && d.rect[3] > layout.bbox[1] - 8 && d.rect[0] <= layout.bbox[2] + 8 && d.rect[2] >= layout.bbox[0] - 8);
      assert.ok(nearby.some(d => d.color && d.color.every(v => Math.abs(v) < .001)), `${marker} retains black rules`);
      assert.ok(nearby.every(d => !d.color || d.color.every(v => Math.abs(v) < .001)), `${marker} has no table color leakage`);
    }
    const blue = actual.drawings.filter(d => d.color && d.color.every((v, i) => Math.abs(v - [.2, .4, .6][i]) < .001));
    if (preset === 'plain') assert.equal(blue.length, 0, 'plain has no visible table rules');
    else assert.ok(blue.length >= 3, `${preset} has actual PDF rules`);
    const vertical = blue.some(d => d.items.some(item => item[0] === 'l' && Math.abs(item[1][0] - item[2][0]) < .01 && Math.abs(item[1][1] - item[2][1]) > 1));
    assert.equal(vertical, preset === 'grid', 'only grid has vertical cell rules');
    const header = span('HeadingMarker'); assert.match(header.font, /Bold|B-/i);
    assert.ok(actual.drawings.some(d => d.fill && d.fill.every((v, i) => Math.abs(v - [221 / 255, 238 / 255, 1][i]) < .001)), 'header background reaches the PDF');
    evidence.push({ template, preset, pdfPath: result.pdfPath, style, measured: { cell, nextLine, caption, ruleCount: blue.length, verticalRules: vertical } });
    fs.writeFileSync(path.join(root, 'measurements.json'), JSON.stringify(evidence, null, 2));
  }
});

test('wide generated tables retain the four existing two-column bridges', { skip: process.env.INKWELL_TABLES_PDF !== '1', timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-table-bridges-'));
  t.diagnostic(`Two-column table evidence: ${root}`);
  process.env.INKWELL_HEADLESS = '1';
  const headless = require('../out/headless-vscode'); headless.configureHeadlessWorkspace(root);
  const originalLoad = Module._load;
  Module._load = function (name, ...args) { return name === 'vscode' ? headless : originalLoad.call(this, name, ...args); };
  let compile; try { ({ compile } = require('../out/compiler')); } finally { Module._load = originalLoad; }
  compile = selectPackagedCompiler(root, compile);
  fs.mkdirSync(path.join(root, '.inkwell'));
  fs.writeFileSync(path.join(root, '.inkwell/manifest.json'), '{"schemaVersion":4,"defaults":{},"managedFiles":{}}');
  const evidence = [];
  for (const template of ['rho', 'rmxaa', 'ludus', 'hipster-cv']) {
    const payload = { schemaVersion: 1, headers: ['Identifier', 'Description'], rows: Array.from({ length: 4 }, (_, i) => [`RowMarker${i}`, 'This deliberately wide cell contains enough ordinary words to require wrapping safely inside the available column width.']), caption: 'BridgeCaption', label: 'tbl:bridge', attributes: {} };
    const text = `---\ntemplate: ${template}\ntitle: Table bridge verification\nabstract: A table wrapping verification fixture.\nkeywords: table, wrapping\nauthor: Researcher\nfirst-name: Test\nlast-name: Researcher\n---\n\n# BeforeMarker\n\nText before the table.\n\n\`\`\`inkwell-table-data\n${JSON.stringify(payload)}\n\`\`\`\n\n# AfterMarker\n\nText after the table.\n`;
    const file = path.join(root, `${template}.md`); fs.writeFileSync(file, text);
    const result = await compile({ uri: headless.Uri.file(file), languageId: 'markdown', version: 1, isUntitled: false, getText: () => text });
    fs.writeFileSync(path.join(root, `${template}.result.json`), JSON.stringify(result, null, 2));
    assert.equal(result.success, true, `${template}: ${result.message}; ${result.logPath}`);
    checkPdfGolden({ id: `table-bridge-${template}`, template, sourcePath: file, pdfPath: result.pdfPath, logPath: result.logPath });
    const probe = cp.spawnSync(process.env.INKWELL_PDF_PYTHON || 'python3', ['-c', `import fitz,json,sys\nd=fitz.open(sys.argv[1])\nprint(json.dumps(dict(pages=len(d),text='\\n'.join(p.get_text() for p in d),bounds=[list(p.rect) for p in d],spans=[dict(s,page=i) for i,p in enumerate(d) for b in p.get_text('dict')['blocks'] if 'lines' in b for l in b['lines'] for s in l['spans']])))`, result.pdfPath], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const actual = JSON.parse(probe.stdout);
    for (const marker of ['BeforeMarker', 'AfterMarker', 'BridgeCaption', ...Array.from({ length: 4 }, (_, i) => `RowMarker${i}`)]) assert.ok(actual.text.includes(marker), `${template}: missing ${marker}`);
    assert.ok(actual.pages <= 3, `${template}: unexpected page explosion`);
    for (const span of actual.spans.filter(s => s.text.includes('deliberately') || s.text.includes('ordinary words'))) assert.ok(span.bbox[0] >= 0 && span.bbox[2] <= actual.bounds[span.page][2] + 1, `${template}: table text outside page`);
    assert.doesNotMatch(fs.readFileSync(result.logPath, 'utf8'), /Overfull \\hbox \([1-9]\d{2,}/);
    evidence.push({ template, pdfPath: result.pdfPath, pages: actual.pages });
    fs.writeFileSync(path.join(root, 'measurements.json'), JSON.stringify(evidence, null, 2));
  }
});

test('styled native cells retain images, math, links, citations and semantic generated captions', { skip: process.env.INKWELL_TABLES_PDF !== '1', timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-table-rich-'));
  t.diagnostic(`Rich table evidence: ${root}`);
  process.env.INKWELL_HEADLESS = '1';
  const headless = require('../out/headless-vscode'); headless.configureHeadlessWorkspace(root);
  const originalLoad = Module._load;
  Module._load = function (name, ...args) { return name === 'vscode' ? headless : originalLoad.call(this, name, ...args); };
  let compile; try { ({ compile } = require('../out/compiler')); } finally { Module._load = originalLoad; }
  compile = selectPackagedCompiler(root, compile);
  fs.mkdirSync(path.join(root, '.inkwell'));
  fs.writeFileSync(path.join(root, '.inkwell/manifest.json'), '{"schemaVersion":4,"defaults":{},"managedFiles":{}}');
  fs.copyFileSync(path.resolve(__dirname, '../media/icon.png'), path.join(root, 'cell.png'));
  const evidence = [];
  for (const template of ['default', 'eth-report']) {
    const generated = { schemaVersion: 1, headers: ['A'], rows: [['**LiteralMarker**']], caption: '*CaptionEmphasis* cites [@cell-source].', label: 'tbl:generated', attributes: {} };
    const text = `---\ntemplate: ${template}\ntitle: Rich tables\nauthor: Researcher\ntables:\n  preset: grid\nreferences:\n  - id: cell-source\n    type: book\n    title: SourceMarker\n    author: [{family: Researcher}]\n    issued: {date-parts: [[2026]]}\n---\n\n| Rich content | Image |\n|--|--|\n| **BoldMarker** and $x^2$ with [LinkMarker](https://example.com/table) cite [@cell-source]. | ![ImageMarker](cell.png){width=12px} |\n\n: RichCaption {#tbl:rich}\n\n\`\`\`inkwell-table-data\n${JSON.stringify(generated)}\n\`\`\`\n`;
    const file = path.join(root, `${template}.md`); fs.writeFileSync(file, text);
    const result = await compile({ uri: headless.Uri.file(file), languageId: 'markdown', version: 1, isUntitled: false, getText: () => text });
    fs.writeFileSync(path.join(root, `${template}.result.json`), JSON.stringify(result, null, 2));
    assert.equal(result.success, true, `${template}: ${result.message}; ${result.logPath}`);
    checkPdfGolden({ id: `table-rich-${template}`, template, sourcePath: file, pdfPath: result.pdfPath, logPath: result.logPath });
    const probe = cp.spawnSync(process.env.INKWELL_PDF_PYTHON || 'python3', ['-c', `import fitz,json,sys\nd=fitz.open(sys.argv[1])\nprint(json.dumps(dict(text='\\n'.join(p.get_text() for p in d),images=sum(len(p.get_images()) for p in d),links=[l for p in d for l in p.get_links() if 'uri' in l],spans=[s for p in d for b in p.get_text('dict')['blocks'] if 'lines' in b for l in b['lines'] for s in l['spans']]),default=str))`, result.pdfPath], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const actual = JSON.parse(probe.stdout);
    for (const marker of ['BoldMarker', 'LinkMarker', 'SourceMarker', 'LiteralMarker', 'CaptionEmphasis']) assert.ok(actual.text.includes(marker), `${template}: missing ${marker}`);
    assert.doesNotMatch(actual.text, /\[@cell-source\]/);
    assert.ok(actual.images > 0, 'native table image is embedded');
    assert.ok(actual.links.some(link => link.uri === 'https://example.com/table'), 'native table link is clickable');
    assert.match(actual.spans.find(span => span.text.includes('BoldMarker')).font, /Bold|B-/i);
    assert.match(actual.spans.find(span => span.text.includes('CaptionEmphasis')).font, /Italic|Oblique|I-/i);
    evidence.push({ template, pdfPath: result.pdfPath, images: actual.images, links: actual.links.map(link => link.uri) });
    fs.writeFileSync(path.join(root, 'measurements.json'), JSON.stringify(evidence, null, 2));
  }
});
