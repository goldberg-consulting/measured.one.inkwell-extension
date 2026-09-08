const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const Module = require('node:module');
const { selectPackagedCompiler, checkPdfGolden } = require('./helpers/pdf-goldens.cjs');
const { resolveDocumentConfig } = require('../out/document-config');
const { resolveTypography, TEX_POINT_TO_CSS_POINT } = require('../out/style-model');

// Opt-in real compiler checks: CI machines with Pandoc/TeX/PyMuPDF run this gate.
// Every document, project manifest, PDF, and log is contained in a temporary tree.
test('actual Default and ETH PDFs agree with shared point sizes and preserve layout tables', { skip: process.env.INKWELL_TYPOGRAPHY_PDF !== '1', timeout: 240000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-typography-pdf-'));
  t.diagnostic(`Typography PDF evidence: ${root}`);
  process.env.INKWELL_HEADLESS = '1';
  const headless = require('../out/headless-vscode');
  headless.configureHeadlessWorkspace(root);
  const originalLoad = Module._load;
  Module._load = function (name, ...rest) { return name === 'vscode' ? headless : originalLoad.call(this, name, ...rest); };
  let compile;
  try { ({ compile } = require('../out/compiler')); } finally { Module._load = originalLoad; }
  compile = selectPackagedCompiler(root, compile);
  fs.mkdirSync(path.join(root, '.inkwell'));
  fs.writeFileSync(path.join(root, '.inkwell/manifest.json'), '{"schemaVersion":4,"defaults":{},"managedFiles":{}}');
  const evidence = [];
  for (const template of ['default', 'eth-report']) for (const classSize of [10, 11, 12]) {
    const sharedUnits = classSize === 12;
    const text = `---\ntemplate: ${template}\ntitle: Typography verification\nauthor: Researcher\nmainfont: Times New Roman\nsansfont: Arial\nmonofont: Courier New\nfontsize: ${sharedUnits ? "16px" : classSize + "pt"}\nheading-font: Arial\nheading-weight: ${classSize === 11 ? 700 : 400}\nheading-scale: 1.2\nheading-color: '#336699'\ncode-font-size: ${sharedUnits ? "0.6666666667em" : "8pt"}\ncaption-font-size: ${sharedUnits ? "75%" : "9pt"}\ntable-font-size: ${sharedUnits ? "0.8333333333rem" : "10pt"}\nreference-font-size: ${sharedUnits ? "small" : "7pt"}\nheader-includes:\n  - |\n    \\AtBeginDocument{\\begin{tabular}{l}LayoutMarker\\\\\\end{tabular}}\nreferences:\n  - id: style-marker\n    type: book\n    title: ReferenceMarker\n    author: [{family: Researcher}]\n    issued: {date-parts: [[2026]]}\n---\n\n# HeadingMarker\n\nBodyMarker cites [@style-marker].\n\n## SubheadingMarker\n\n### MinorHeadingMarker\n\nBaselineMarkerOne  \nBaselineMarkerTwo\n\n\`\`\`python\nCodeMarker\n\`\`\`\n\n\`\`\`\nRawCodeMarker\n\`\`\`\n\n| Column | Value |\n|:--|:--|\n| TableMarker | Value |\n\n: CaptionMarker {#tbl:style}\n`;
    const file = path.join(root, `${template}-${classSize}.md`); fs.writeFileSync(file, text);
    const result = await compile({ uri: headless.Uri.file(file), languageId: 'markdown', version: 1, isUntitled: false, getText: () => text });
    fs.writeFileSync(path.join(root, `${template}-${classSize}.result.json`), JSON.stringify(result, null, 2));
    assert.equal(result.success, true, `${result.message}; ${result.logPath}`);
    checkPdfGolden({ id: `typography-${template}-${classSize}`, template, sourcePath: file, pdfPath: result.pdfPath, logPath: result.logPath });
    const probe = cp.spawnSync(process.env.INKWELL_PDF_PYTHON || 'python3', ['-c', `import fitz,json,sys\ndoc=fitz.open(sys.argv[1])\nprint(json.dumps([dict(s,page=i+1) for i,p in enumerate(doc) for b in p.get_text('dict')['blocks'] if 'lines' in b for l in b['lines'] for s in l['spans']]))`, result.pdfPath], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const spans = JSON.parse(probe.stdout);
    const config = resolveDocumentConfig({ text });
    const effective = resolveTypography(config);
    const expected = { BodyMarker: effective.bodySizePt, LayoutMarker: effective.bodySizePt, HeadingMarker: effective.headingSizesPt[0], SubheadingMarker: effective.headingSizesPt[1], MinorHeadingMarker: effective.headingSizesPt[2], CodeMarker: effective.codeSizePt, RawCodeMarker: effective.codeSizePt, TableMarker: effective.tableSizePt, CaptionMarker: effective.captionSizePt, ReferenceMarker: effective.referenceSizePt };
    const measured = {};
    for (const [marker, points] of Object.entries(expected)) {
      const matches = spans.filter(span => new RegExp(`(?<![A-Za-z])${marker}(?![A-Za-z])`).test(span.text));
      assert.ok(matches.length, `${template}-${classSize} missing marker ${marker}`);
      measured[marker] = matches.map(span => ({ size: span.size, font: span.font, color: span.color, page: span.page }));
      for (const span of matches) assert.ok(Math.abs(span.size - points * TEX_POINT_TO_CSS_POINT) < 0.08,
        `${template}-${classSize} ${marker}: PDF ${span.size}bp; model ${points}TeXpt (${points * TEX_POINT_TO_CSS_POINT}bp), font ${span.font}`);
    }
    const baselineOne = spans.find(span => span.text.includes('BaselineMarkerOne'));
    const baselineTwo = spans.find(span => span.text.includes('BaselineMarkerTwo'));
    assert.ok(baselineOne && baselineTwo);
    const measuredBaseline = baselineTwo.origin[1] - baselineOne.origin[1];
    assert.ok(Math.abs(measuredBaseline - effective.bodyBaselinePt * TEX_POINT_TO_CSS_POINT) < 0.08, `${template}-${classSize}: baseline ${measuredBaseline}, expected ${effective.bodyBaselinePt * TEX_POINT_TO_CSS_POINT}`);
    assert.ok(measured.HeadingMarker.every(span => /Arial/i.test(span.font) && /Bold/i.test(span.font) === (classSize === 11)), 'heading uses requested normal/bold sans face');
    assert.ok(measured.HeadingMarker.every(span => span.color === 0x336699), 'heading RGB survives actual PDF conversion');
    assert.ok(measured.BodyMarker.every(span => /TimesNewRoman/i.test(span.font)), 'body uses requested Roman face');
    assert.ok(measured.CodeMarker.every(span => /CourierNew/i.test(span.font)), 'code uses requested Mono face');
    evidence.push({ template, classSize, pdfPath: result.pdfPath, expectedTeXPoints: expected, expectedBaselineTeXPoints: effective.bodyBaselinePt, measuredBaseline, measured });
    fs.writeFileSync(path.join(root, 'measurements.json'), JSON.stringify(evidence, null, 2));
  }
});
